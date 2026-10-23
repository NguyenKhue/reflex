/**
 * knowledgeReview.test.js — `reflex knowledge review`: which items the runner learned, how they are
 * filtered and sorted, that no secret-ish text leaks, and the CLI contract (one REFLEX_JSON line, exit 0).
 * No device: the workspace below is written by hand with the shapes a real store produces.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { knowledgeReview, formatReview, STATUS_FILTERS } = require('../../src/cli/knowledgeCommands');

const BIN = path.join(__dirname, '..', '..', 'bin', 'reflex.js');

const SCREEN_MD = (id, allText) => `---
id: ${id}
identify:
  allText: ["${allText}"]
inputs: []
---
Fixture screen ${id} of the review test app. One line of intent, nothing that can carry a secret.
`;

// Three cases to the SAME screen: a screen may offer several ways across, so the cases share `to`
// and differ by intent and by step text. SECRET_BUTTON stands in for a tap that may be a secret placeholder.
const NORMAL_YML = `# Three ways from Home to the login screen.
- to: core/login
  intent: "Open the login screen from the primary entry"
  steps:
    - { tool: tap_text, args: { text: "SECRET_BUTTON", exact: true } }
  status: learned
  stats: { ok: 2, fail: 0, streak: 2, lastOk: '2026-10-04' }

- to: core/login
  intent: "Open the login screen from the secondary entry"
  steps:
    - { tool: tap_text, args: { text: "SECONDARY_ENTRY", exact: true } }
  status: draft

- to: core/login
  intent: "Open the login screen from the profile menu"
  steps:
    - { tool: tap_text, args: { text: "PROFILE_MENU", exact: true } }
  status: verified
  stats: { ok: 5, fail: 0, streak: 5, lastOk: '2026-10-01' }
`;

const SCREEN_EXCEPTIONS_YML = `# A popup the runner learned to dismiss by itself.
- id: dismiss_promo
  when: { allText: ["Promo"] }
  do: { tap: "SECRET_BUTTON" }
  status: learned
  stats: { ok: 1, fail: 0, streak: 1, lastOk: '2026-10-05' }

# Hand-written policy with no status at all: the loader treats it as a draft (an unproven guess).
- id: maintenance
  when: { allText: ["Maintenance"] }
  do: { blocked: "UAT is down" }
`;

const APP_EXCEPTIONS_YML = `# A mini-app rule the runner learned: press back out of the rate sheet.
- id: rate_us
  when: { allText: ["Rate"] }
  do: { back: true }
  status: learned
`;

let root;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-review-')));
  write(root, 'reflex.workspace.json', `${JSON.stringify({ name: 't', apps: { app1: { android: { package: 'p.app1' } } } }, null, 2)}\n`);
  write(root, path.join('screens', 'app1', 'core', 'home', 'screen.md'), SCREEN_MD('core/home', 'Home'));
  write(root, path.join('screens', 'app1', 'core', 'login', 'screen.md'), SCREEN_MD('core/login', 'Login'));
  write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), NORMAL_YML);
  write(root, path.join('screens', 'app1', 'core', 'home', 'exceptions.yml'), SCREEN_EXCEPTIONS_YML);
  write(root, path.join('screens', 'app1', '_app', 'exceptions.yml'), APP_EXCEPTIONS_YML);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(target, relative, contents) {
  const file = path.join(target, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

const review = (status) => knowledgeReview({ app: 'app1', root, ...(status ? { status } : {}) });

/** A case row is only told apart from its siblings by its status (all three share `to core/login`). */
const caseWith = (result, status) => result.items.find((item) => item.kind === 'case' && item.status === status);
const ruleWith = (result, id) => result.items.find((item) => item.kind === 'exception' && item.name === id);

function cli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
  const markers = result.stdout.split('\n').filter((line) => line.startsWith('REFLEX_JSON '));
  return {
    code: result.status,
    markers,
    marker: markers.length ? JSON.parse(markers[markers.length - 1].slice('REFLEX_JSON '.length)) : null,
    stderr: result.stderr,
  };
}

test('review is the default filter: the learned and the draft items, out of every item in the store', () => {
  const result = review();
  assert.equal(result.ok, true);
  assert.equal(result.app, 'app1');
  assert.equal(result.status, 'review');
  // Six items exist: three cases, two screen rules, one _app rule.
  assert.equal(result.total, 6);
  assert.equal(result.shown, 5);
  assert.equal(result.shown, result.items.length);

  const learnedCase = caseWith(result, 'learned');
  const draftCase = caseWith(result, 'draft');
  assert.ok(learnedCase, 'the learned case is reviewed');
  assert.ok(draftCase, 'a draft case is reviewed: it is new learning, still unproven');
  assert.ok(ruleWith(result, 'dismiss_promo'), 'a learned rule is reviewed');
  assert.ok(ruleWith(result, 'rate_us'), 'a learned _app rule is reviewed');

  // A hand-written rule without a status is a `draft` (an unproven guess), so it is reviewed too.
  assert.equal(ruleWith(result, 'maintenance').status, 'draft');
  // Not in the review set: the verified case (already trusted).
  assert.equal(caseWith(result, 'verified'), undefined);
});

test('the explicit status filters select exactly their own items', () => {
  assert.deepEqual(STATUS_FILTERS, ['review', 'all', 'learned', 'draft', 'verified']);

  const all = review('all');
  assert.equal(all.shown, 6);
  assert.equal(all.total, 6);

  const verified = review('verified');
  assert.equal(verified.shown, 1);
  assert.equal(verified.items[0].kind, 'case');
  assert.equal(verified.items[0].status, 'verified');

  const learned = review('learned');
  assert.equal(learned.shown, 3);
  assert.deepEqual(learned.items.map((item) => `${item.screen}/${item.name}`).sort(), [
    '_app/rate_us',
    'core/home/dismiss_promo',
    'core/home/to core/login',
  ]);

  const draft = review('draft');
  assert.equal(draft.shown, 2);
  assert.deepEqual(draft.items.map((item) => item.name).sort(), ['maintenance', 'to core/login']);
  assert.ok(draft.items.every((item) => item.status === 'draft'));
});

test('items are sorted by most recently proven first, never-proven last', () => {
  const items = review().items;
  const promo = items.findIndex((item) => item.name === 'dismiss_promo');
  const learnedCase = items.findIndex((item) => item.kind === 'case' && item.status === 'learned');
  const draftCase = items.findIndex((item) => item.kind === 'case' && item.status === 'draft');
  // dismiss_promo was proven on 2026-10-05, the learned case on 2026-10-04.
  assert.ok(promo < learnedCase, `expected dismiss_promo before the learned case: ${JSON.stringify(items.map((item) => item.name))}`);
  // The draft case has no lastOk at all, so it goes to the end of the review list.
  assert.equal(items.length - 1, draftCase);
});

test('counters come from the knowledge files: a learned case has them, a draft case has zeros', () => {
  const result = review();
  const learnedCase = caseWith(result, 'learned');
  assert.equal(learnedCase.ok, 2);
  assert.equal(learnedCase.fail, 0);
  assert.equal(learnedCase.streak, 2);
  assert.equal(learnedCase.lastOk, '2026-10-04');
  assert.equal(learnedCase.lastFail, null);
  assert.equal(learnedCase.pinned, false);

  const draftCase = caseWith(result, 'draft');
  assert.equal(draftCase.ok, 0);
  assert.equal(draftCase.fail, 0);
  assert.equal(draftCase.streak, 0);
  assert.equal(draftCase.lastOk, null);
  assert.equal(draftCase.lastFail, null);

  const promo = ruleWith(result, 'dismiss_promo');
  assert.equal(promo.ok, 1);
  assert.equal(promo.streak, 1);
  assert.equal(promo.lastOk, '2026-10-05');
});

test('a rule reports only the KIND of action it does, and the screen it belongs to', () => {
  const all = review('all');
  assert.equal(ruleWith(all, 'dismiss_promo').does, 'tap');
  assert.equal(ruleWith(all, 'rate_us').does, 'back');
  assert.equal(ruleWith(all, 'maintenance').does, 'blocked');
  assert.equal(ruleWith(all, 'dismiss_promo').screen, 'core/home');
  assert.equal(ruleWith(all, 'maintenance').screen, 'core/home');
  assert.equal(ruleWith(all, 'rate_us').screen, '_app');
  // A case is a hop, not an action, so it has no `does`.
  assert.equal(caseWith(all, 'learned').does, undefined);
  assert.equal(caseWith(all, 'learned').name, 'to core/login');
});

test('privacy: neither the JSON nor the human lines carry a tap text, a when text or a blocked reason', () => {
  const result = review('all');
  const json = JSON.stringify(result);
  const lines = formatReview(result).join('\n');
  for (const forbidden of ['SECRET_BUTTON', 'UAT is down', 'Promo', 'Maintenance']) {
    assert.ok(!json.includes(forbidden), `${forbidden} leaked into the JSON: ${json}`);
    assert.ok(!lines.includes(forbidden), `${forbidden} leaked into the human lines: ${lines}`);
  }
});

test('a missing app and an unknown status are refused with a message that names the fix', () => {
  assert.throws(() => knowledgeReview({ root }), { message: 'knowledge review requires --app <key>' });
  assert.throws(() => knowledgeReview({ app: 'app1', status: 'nope', root }), {
    message: '--status must be one of review, all, learned, draft, verified (got "nope")',
  });
});

test('formatReview prints a header, the status markers and "last ok never" for an unproven item', () => {
  const lines = formatReview(review('all'));
  assert.equal(lines[0], '6 of 6 item(s) for app "app1" (status: all)');
  assert.equal(lines.length, 7);
  assert.ok(lines.some((line) => line.includes('  core/home  exception dismiss_promo -> tap  [learned]')), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('  core/home  exception maintenance -> blocked  [draft]')), lines.join('\n'));
  const draftLine = lines.find((line) => line.includes('case to core/login') && line.includes('[draft]'));
  assert.ok(draftLine, lines.join('\n'));
  assert.ok(draftLine.includes('last ok never'), draftLine);
  assert.ok(draftLine.includes('ok 0 / fail 0, streak 0'), draftLine);
  // A pinned item says so; a hand-written rule is a [draft], never [learned].
  assert.ok(!lines.some((line) => line.includes('pinned')), lines.join('\n'));
});

test('reflex knowledge review --json: exit 0, one marker line, the five review items', () => {
  const { code, marker, markers, stderr } = cli(['knowledge', 'review', '--app', 'app1', '--json', '--workspace', root]);
  assert.equal(code, 0, stderr);
  assert.equal(markers.length, 1, markers.join('\n'));
  assert.equal(marker.ok, true);
  assert.equal(marker.app, 'app1');
  assert.equal(marker.status, 'review');
  assert.equal(marker.shown, 5);
  assert.equal(marker.total, 6);
  assert.ok(!stderr.includes('error'), stderr);
});

test('reflex knowledge review without --json: the header goes to stderr, stdout stays the marker only', () => {
  const { code, markers, marker, stderr } = cli(['knowledge', 'review', '--app', 'app1', '--workspace', root]);
  assert.equal(code, 0, stderr);
  assert.equal(markers.length, 1, markers.join('\n'));
  assert.equal(marker.shown, 5);
  const lines = stderr.split('\n');
  assert.ok(lines.includes('5 of 6 item(s) for app "app1" (status: review)'), stderr);
  assert.ok(lines.some((line) => line.includes('exception dismiss_promo -> tap')), stderr);
});
