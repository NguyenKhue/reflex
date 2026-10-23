/**
 * writer.test.js — the file half of learning: lock, merge with what is on disk NOW, atomic write.
 *
 * Every test works on a temp workspace, because the point of the writer is what survives on
 * disk: a comment, a second run's change, a lock another process holds, an archive cap.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const YAML = require('yaml');
const { flush } = require('../../src/screens/writer');

const RUN = 'example_run_20260924_120000';
const AT = Date.parse('2026-09-24T10:00:00Z');
const now = () => AT;

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-writer-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** `<root>/screens/example/core/<screen>/<name>` — the path the learner would hand over. */
const screenFile = (screen, name = 'normal.yml') => path.join(root, 'screens', 'example', 'core', screen, name);

function seed(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const read = (file) => fs.readFileSync(file, 'utf8');
const yaml = (file) => YAML.parse(read(file));
/** The machine-local counters of one item, as `stats.js` keys them. */
const counters = (file, key) => {
  const ledgerFile = path.join(root, '.agentic', 'stats.json');
  const ledger = fs.existsSync(ledgerFile) ? JSON.parse(read(ledgerFile)) : {};
  return ledger[`${path.relative(root, file).split(path.sep).join('/')}#${key}`];
};

const CASE = (extra) => ({
  to: 'core/login',
  intent: 'Open the login screen',
  steps: [{ tool: 'tap_text', args: { text: 'Đăng nhập', exact: true } }],
  status: 'learned',
  confidence: 0.9,
  learnedFrom: RUN,
  stats: { ok: 1, fail: 0, streak: 1, lastOk: '2026-09-24' },
  ...extra,
});
const caseKey = (item) => `${item.to}|${JSON.stringify(item.steps)}`;

test('a case is appended, and a second flush merges with what the first one wrote', async () => {
  const file = screenFile('home');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const first = await flush([{ file, kind: 'addCase', item: CASE() }], { now });
  assert.deepEqual(first.skipped, []);
  assert.deepEqual(first.applied, [{ action: 'added', file, key: caseKey(CASE()) }]);
  assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock is released');

  const other = CASE({ to: 'core/signed_in', steps: [{ tool: 'back', args: {} }] });
  const second = await flush([{ file, kind: 'addCase', item: other }], { now });
  assert.deepEqual(second.applied, [{ action: 'added', file, key: caseKey(other) }]);
  assert.deepEqual(yaml(file).map((item) => item.to), ['core/login', 'core/signed_in']);

  // The same case learned twice is a use of the knowledge, not a change: it takes the outcome.
  const again = await flush([{ file, kind: 'addCase', item: CASE() }], { now });
  assert.deepEqual([again.applied, again.skipped], [[], []]);
  assert.equal('stats' in yaml(file)[0], false, 'counters never go into the committed file');
  assert.deepEqual(counters(file, caseKey(CASE())), { ok: 2, fail: 0, streak: 2, failStreak: 0, lastOk: '2026-09-24' });
});

test('an outcome that changes no status leaves the file byte-identical and counts in the ledger', async () => {
  const file = screenFile('home');
  seed(file, [
    '# One hop from Home into the login screen — do not delete.',
    '- to: core/login',
    '  intent: "Open the login screen"',
    '  steps:',
    '    # the label changes with the app version',
    '    - { tool: tap_text, args: { text: "Đăng nhập", exact: true } }',
    '  status: learned',
    '  stats: { ok: 1, fail: 0, streak: 1 }',
    '',
  ].join('\n'));
  const before = read(file);
  const key = caseKey(yaml(file)[0]);
  const result = await flush([{ file, kind: 'outcome', key, ok: true, runId: RUN }], { now });
  assert.deepEqual(result.applied, [], 'a stats bump alone is not an event');
  // Two branches that ran the same case have nothing to merge: the file did not change.
  assert.equal(read(file), before);
  // The `stats:` an older checkout left in the file is where the ledger starts counting from.
  assert.deepEqual(counters(file, key), { ok: 2, fail: 0, streak: 2, failStreak: 0, lastOk: '2026-09-24' });

  await flush([{ file, kind: 'outcome', key, ok: true, runId: RUN }], { now });
  assert.equal(counters(file, key).streak, 3, 'the ledger wins over the file once it has a value');
});

test('a status change rewrites only the status, drops a leftover stats, and keeps comments', async () => {
  const file = screenFile('home');
  seed(file, [
    '# One hop from Home into the login screen — do not delete.',
    '- to: core/login',
    '  intent: "Open the login screen"',
    '  steps:',
    '    # the label changes with the app version',
    '    - { tool: tap_text, args: { text: "Đăng nhập", exact: true } }',
    '  status: learned',
    '  stats: { ok: 2, fail: 0, streak: 2 }',
    '',
  ].join('\n'));
  const key = caseKey(yaml(file)[0]);
  const result = await flush([{ file, kind: 'outcome', key, ok: true, runId: RUN }], { now });
  assert.deepEqual(result.applied, [{ action: 'promoted', file, key }]);
  const text = read(file);
  assert.match(text, /# One hop from Home into the login screen/);
  assert.match(text, /# the label changes with the app version/);
  assert.deepEqual([yaml(file)[0].status, 'stats' in yaml(file)[0]], ['verified', false]);
  assert.equal(counters(file, key).streak, 3);
});

test('three ok runs promote a draft, and one fail demotes a verified case', async () => {
  const file = screenFile('home');
  seed(file, `- to: core/login\n  intent: x\n  steps: [{ tool: back, args: {} }]\n  status: draft\n  stats: { ok: 2, fail: 0, streak: 2 }\n`);
  const key = caseKey(yaml(file)[0]);
  const promoted = await flush([{ file, kind: 'outcome', key, ok: true, runId: RUN }], { now });
  assert.deepEqual(promoted.applied, [{ action: 'promoted', file, key }]);
  assert.equal(yaml(file)[0].status, 'verified');

  const demoted = await flush([{ file, kind: 'outcome', key, ok: false, runId: RUN }], { now });
  assert.deepEqual(demoted.applied, [{ action: 'demoted', file, key }]);
  assert.deepEqual([yaml(file)[0].status, counters(file, key).streak], ['learned', 0]);
});

test('a learned case that fails twice is removed into history.yml', async () => {
  const file = screenFile('home');
  seed(file, `# keep me\n- to: core/login\n  intent: x\n  steps: [{ tool: back, args: {} }]\n  status: learned\n  stats: { ok: 3, fail: 0, streak: 0, failStreak: 1 }\n`);
  const key = caseKey(yaml(file)[0]);
  const result = await flush([{ file, kind: 'outcome', key, ok: false, runId: RUN }], { now });
  assert.deepEqual(result.applied, [{ action: 'removed', file, key }]);
  assert.deepEqual(yaml(file), []);
  assert.match(read(file), /# keep me/, 'the file itself is still there, only the case went');
  assert.equal(counters(file, key), undefined, 'a removed case leaves no counters behind');
  const history = yaml(path.join(path.dirname(file), 'history.yml'));
  assert.equal(history.length, 1);
  assert.deepEqual(history[0], {
    at: new Date(AT).toISOString(),
    runId: RUN,
    reason: 'removed after repeated failures',
    item: {
      to: 'core/login',
      intent: 'x',
      steps: [{ tool: 'back', args: {} }],
      status: 'learned',
      stats: { ok: 3, fail: 1, streak: 0, failStreak: 2, lastFail: '2026-09-24' },
    },
  });
});

test('a replaced case is archived with its reason, and the learned one takes its place', async () => {
  const file = screenFile('home');
  seed(file, '- to: core/signed_in\n  intent: "the old way"\n  steps: [{ tool: back, args: {} }]\n  status: verified\n');
  const old = yaml(file)[0];
  const item = CASE({ to: 'core/signed_in', steps: [{ tool: 'tap_text', args: { text: 'Mới', exact: true } }] });
  const result = await flush([{
    file,
    kind: 'replaceCase',
    key: caseKey(old),
    item,
    reason: 'superseded by a case learned in the same visit',
    runId: RUN,
  }], { now });
  assert.deepEqual(result.applied, [{ action: 'replaced', file, key: caseKey(item) }]);
  assert.deepEqual(yaml(file).map((entry) => entry.intent), [item.intent]);
  const history = yaml(path.join(path.dirname(file), 'history.yml'));
  assert.deepEqual([history[0].reason, history[0].runId], ['superseded by a case learned in the same visit', RUN]);
  assert.deepEqual(history[0].item.steps, old.steps);
});

test('history keeps the last ten entries', async () => {
  const file = screenFile('home');
  const item = CASE();
  for (let index = 0; index < 12; index += 1) {
    // Each round starts from a hand-written case with its own key, so the learned one replaces it.
    const old = { to: `core/login_${index}`, intent: 'x', steps: [{ tool: 'back', args: {} }] };
    seed(file, `- to: ${old.to}\n  intent: x\n  steps: [{ tool: back, args: {} }]\n`);
    await flush([{ file, kind: 'replaceCase', key: caseKey(old), item, reason: `round ${index}`, runId: RUN }], { now });
  }
  const history = yaml(path.join(path.dirname(file), 'history.yml'));
  assert.equal(history.length, 10);
  assert.deepEqual(history.slice(0, 2).map((entry) => entry.reason), ['round 2', 'round 3']);
  assert.equal(history.at(-1).reason, 'round 11');
});

test('a lock held by another run skips that file after lockWaitMs, and writes nothing', async () => {
  const file = screenFile('home');
  seed(file, '# untouched\n- to: core/login\n  intent: x\n  steps: [{ tool: back, args: {} }]\n  status: learned\n');
  const before = read(file);
  fs.writeFileSync(`${file}.lock`, '');
  const result = await flush([{ file, kind: 'addCase', item: CASE() }], { lockWaitMs: 50, now });
  assert.deepEqual(result.applied, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].file, file);
  assert.match(result.skipped[0].reason, /locked by another run/);
  assert.equal(read(file), before);
  fs.rmSync(`${file}.lock`);
  // The same flush once the lock is gone lands normally.
  const retried = await flush([{ file, kind: 'addCase', item: CASE() }], { lockWaitMs: 50, now });
  assert.deepEqual(retried.applied.map((event) => event.action), ['added']);
});

test('a ledger held by another run still lets the files land, and says the counters were dropped', async () => {
  const file = screenFile('home');
  const ledger = path.join(root, '.agentic', 'stats.json');
  seed(ledger, '{}\n');
  fs.writeFileSync(`${ledger}.lock`, '');
  const result = await flush([{ file, kind: 'addCase', item: CASE() }], { lockWaitMs: 50, now });
  assert.deepEqual(result.applied.map((event) => event.action), ['added']);
  assert.deepEqual(result.skipped.map((entry) => entry.file), [ledger]);
  assert.match(result.skipped[0].reason, /locked by another run/);
  assert.equal(read(ledger), '{}\n');
  assert.equal(fs.existsSync(`${ledger}.lock`), true, 'another run\'s lock is not ours to release');
});

test('screens/_shared is policy: refused, and reported', async () => {
  const file = path.join(root, 'screens', '_shared', 'exceptions.yml');
  seed(file, '- id: ekyc\n  when: { anyText: ["Xác thực khuôn mặt"] }\n  do: { fail: "policy" }\n');
  const before = read(file);
  const result = await flush([{ file, kind: 'addRule', item: { id: 'learned_x', when: { anyText: ['x'] }, do: { tap: 'x' } } }], { now });
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, [{ file, reason: 'screens/_shared is hand-edited policy: the runner never writes it' }]);
  assert.equal(read(file), before);
});

test('an outcome for a file with nothing to rewrite writes nothing at all', async () => {
  const file = screenFile('empty_screen');
  const result = await flush([{ file, kind: 'outcome', key: 'core/login|[]', ok: true, runId: RUN }], { now });
  assert.deepEqual([result.applied, result.skipped], [[], []]);
  assert.equal(fs.existsSync(file), false, 'a knowledge file is never created empty');
});

test('a rule id taken by a different rule gets a suffix instead of overwriting it', async () => {
  const file = screenFile('home', 'exceptions.yml');
  seed(file, '- id: learned_cap_nhat\n  when: { allText: ["Cập nhật phiên bản"] }\n  do: { tap: "Để sau" }\n');
  const rule = { id: 'learned_cap_nhat', when: { allText: ['Bản cập nhật mới'] }, do: { tap: 'Bỏ qua' }, status: 'learned' };
  const result = await flush([{ file, kind: 'addRule', item: rule }], { now });
  assert.deepEqual(result.applied, [{ action: 'added', file, key: 'learned_cap_nhat_2' }]);
  assert.deepEqual(yaml(file).map((entry) => entry.id), ['learned_cap_nhat', 'learned_cap_nhat_2']);

  // The SAME rule again is not a new rule: it takes the outcome instead.
  const twice = await flush([{ file, kind: 'addRule', item: { ...rule, id: 'learned_cap_nhat_2' } }], { now });
  assert.deepEqual([twice.applied, twice.skipped], [[], []]);
  assert.deepEqual(yaml(file)[1].id, 'learned_cap_nhat_2');
  assert.deepEqual(counters(file, 'learned_cap_nhat_2'), { ok: 1, streak: 1, failStreak: 0, lastOk: '2026-09-24' });
});

test('routes are recorded once, by their whole path', async () => {
  const file = path.join(root, 'screens', 'example', '_app', 'routes.yml');
  const route = ['core/home', 'core/login', 'core/signed_in'];
  const first = await flush([{ file, kind: 'addRoute', path: route }], { now });
  assert.deepEqual(first.applied, [{ action: 'route', file, key: route.join('>') }]);
  const second = await flush([{ file, kind: 'addRoute', path: route }], { now });
  assert.deepEqual([second.applied, second.skipped], [[], []]);
  assert.deepEqual(yaml(file), [{ path: route }]);
});

test('a file that cannot be parsed is reported, and the other files of the flush still land', async () => {
  const broken = screenFile('broken');
  const healthy = screenFile('home');
  seed(broken, '- to: [unclosed\n');
  const result = await flush([
    { file: broken, kind: 'addCase', item: CASE() },
    { file: healthy, kind: 'addCase', item: CASE() },
  ], { now });

  assert.deepEqual(result.applied, [{ action: 'added', file: healthy, key: caseKey(CASE()) }]);
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(result.skipped[0].file, broken);
  assert.match(result.skipped[0].reason, /invalid YAML/);
  assert.equal(read(broken), '- to: [unclosed\n', 'the broken file is left alone');
  assert.equal(fs.existsSync(`${broken}.lock`), false, 'the lock is released even on a failure');
});
