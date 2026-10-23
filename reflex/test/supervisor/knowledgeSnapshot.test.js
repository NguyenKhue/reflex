/**
 * knowledgeSnapshot.test.js — snapshot, diff and restore of the knowledge tree. No device, no runner: the
 * temp workspace holds the shapes a real one has (an app tier, the shared policy tier, a second app and the
 * counters under `.agentic/`). Approval is modelled as "delete the snapshot", rejection as `restoreKnowledge`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { snapshotKnowledge, diffKnowledge, restoreKnowledge } = require('../../src/supervisor/knowledgeSnapshot');

const SCREEN_MD = (id) => `---
id: ${id}
identify:
  allText: ["Home"]
inputs: []
---
Fixture screen ${id} of the snapshot test app. Nothing here can carry a secret.
`;

const NORMAL_YML = `# One hop from Home to the login screen, learned by the runner.
- to: core/login
  intent: "Open the login screen from the primary entry"
  steps:
    - { tool: tap_text, args: { text: "SIGN_IN", exact: true } }
  status: learned
  stats: { ok: 2, fail: 0, streak: 2, lastOk: '2026-10-04' }
`;

const APP_EXCEPTIONS_YML = `# A mini-app rule the runner learned: press back out of the rate sheet.
- id: rate_us
  when: { allText: ["Rate"] }
  do: { back: true }
  status: learned
`;

const SHARED_EXCEPTIONS_YML = `# The shared policy tier: hand-written policy, never written by the runner.
- id: maintenance_window
  when: { allText: ["Maintenance"] }
  do: { blocked: "UAT is down" }
`;

const OTHER_SCREEN_MD = `---
id: core/x
---
A screen of a second app, which a snapshot of app1 must never touch.
`;

let root;
let dest;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-snapshot-')));
  // dest lives outside root, the way reports/<runId>/knowledge-before/ does.
  dest = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-snapshot-dest-')));
  write(root, path.join('screens', 'app1', 'core', 'home', 'screen.md'), SCREEN_MD('core/home'));
  write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), NORMAL_YML);
  write(root, path.join('screens', 'app1', '_app', 'exceptions.yml'), APP_EXCEPTIONS_YML);
  write(root, path.join('screens', '_shared', 'exceptions.yml'), SHARED_EXCEPTIONS_YML);
  write(root, path.join('screens', 'other', 'core', 'x', 'screen.md'), OTHER_SCREEN_MD);
  write(root, path.join('.agentic', 'stats.json'), `{"app1": {"ok": 2, "fail": 0}}\n`);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dest, { recursive: true, force: true });
});

function write(target, relative, contents) {
  const file = path.join(target, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function read(target, relative) {
  return fs.readFileSync(path.join(target, relative), 'utf8');
}

/** A whole directory as `{ relativePath: content }`, for a byte-for-byte comparison of two trees. */
function mapOf(dir) {
  const map = {};
  const walk = (current, prefix) => {
    if (!fs.existsSync(current)) return map;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, relative);
      else map[relative] = fs.readFileSync(full, 'utf8');
    }
    return map;
  };
  return walk(dir, '');
}

test('snapshotKnowledge copies the app tier and the shared tier, leaves other apps out and replaces a stale dest', () => {
  write(dest, 'stale.txt', 'left over from an earlier run\n');
  write(dest, path.join('app1', 'stale.md'), 'left over from an earlier run\n');

  const returned = snapshotKnowledge(root, 'app1', dest);

  assert.equal(returned, dest, 'the destination is returned so a caller can log it');
  assert.equal(read(dest, path.join('app1', 'core', 'home', 'normal.yml')), NORMAL_YML);
  assert.equal(read(dest, path.join('app1', 'core', 'home', 'screen.md')), SCREEN_MD('core/home'));
  assert.equal(read(dest, path.join('app1', '_app', 'exceptions.yml')), APP_EXCEPTIONS_YML);
  assert.equal(read(dest, path.join('_shared', 'exceptions.yml')), SHARED_EXCEPTIONS_YML);
  assert.equal(fs.existsSync(path.join(dest, 'other')), false, 'another app is not part of the snapshot');
  assert.equal(fs.existsSync(path.join(dest, '.agentic')), false, 'the counters are not part of the snapshot');
  assert.equal(fs.existsSync(path.join(dest, 'stale.txt')), false, 'a stale dest is replaced, not merged into');
  assert.equal(fs.existsSync(path.join(dest, 'app1', 'stale.md')), false);
  assert.deepEqual(mapOf(path.join(dest, 'app1')), mapOf(path.join(root, 'screens', 'app1')));
});

test('nothing changed: the diff is empty in every field', () => {
  snapshotKnowledge(root, 'app1', dest);

  const result = diffKnowledge(root, 'app1', dest);

  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.forbidden, []);
  assert.equal(result.diffText, '');
});

test('an edited, an added and a removed file under the app tier are listed with their kinds, sorted by file', () => {
  snapshotKnowledge(root, 'app1', dest);
  write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), NORMAL_YML.replace("lastOk: '2026-10-04'", "lastOk: '2026-10-05'"));
  write(root, path.join('screens', 'app1', 'core', 'home', 'added.md'), '# a hop the agent added\n');
  fs.rmSync(path.join(root, 'screens', 'app1', 'core', 'home', 'screen.md'));

  const result = diffKnowledge(root, 'app1', dest);

  assert.deepEqual(result.changed, [
    { file: 'screens/app1/core/home/added.md', kind: 'added', forbidden: false },
    { file: 'screens/app1/core/home/normal.yml', kind: 'modified', forbidden: false },
    { file: 'screens/app1/core/home/screen.md', kind: 'removed', forbidden: false },
  ]);
  assert.deepEqual(result.forbidden, []);
  assert.ok(result.changed.every((item) => item.forbidden === false));
  // The render a human reads: every hunk is labelled before/<file> and after/<file>.
  assert.ok(result.diffText.includes('--- before/screens/app1/core/home/normal.yml'), result.diffText);
  assert.ok(result.diffText.includes('+++ after/screens/app1/core/home/normal.yml'), result.diffText);
  assert.ok(result.diffText.includes("-  stats: { ok: 2, fail: 0, streak: 2, lastOk: '2026-10-04' }"), result.diffText);
  assert.ok(result.diffText.includes("+  stats: { ok: 2, fail: 0, streak: 2, lastOk: '2026-10-05' }"), result.diffText);
  // An added file diffs against /dev/null, so its side is all +.
  assert.ok(result.diffText.includes('+++ after/screens/app1/core/home/added.md'), result.diffText);
  assert.ok(result.diffText.includes('+# a hop the agent added'), result.diffText);
  // A removed file diffs against /dev/null too, so its side is all -.
  assert.ok(result.diffText.includes('--- before/screens/app1/core/home/screen.md'), result.diffText);
  assert.ok(result.diffText.includes('-id: core/home'), result.diffText);
});

test('a change under _shared is forbidden; another app and the counters are not reported at all', () => {
  snapshotKnowledge(root, 'app1', dest);
  write(root, path.join('screens', '_shared', 'exceptions.yml'), SHARED_EXCEPTIONS_YML.replace('maintenance_window', 'maintenance_window_v2'));
  write(root, path.join('screens', 'other', 'core', 'x', 'screen.md'), 'rewritten by another run\n');
  write(root, path.join('.agentic', 'stats.json'), `{"app1": {"ok": 9, "fail": 1}}\n`);

  const result = diffKnowledge(root, 'app1', dest);

  assert.equal(result.changed.length, 1, 'only the _shared edit is a change of this app');
  assert.deepEqual(result.changed[0], { file: 'screens/_shared/exceptions.yml', kind: 'modified', forbidden: true });
  assert.deepEqual(result.forbidden, result.changed, 'the forbidden array is the _shared subset');
  assert.ok(result.diffText.includes('--- before/screens/_shared/exceptions.yml'), result.diffText);
  assert.ok(result.diffText.includes('+++ after/screens/_shared/exceptions.yml'), result.diffText);
  assert.ok(!result.diffText.includes('screens/other'), result.diffText);
  assert.ok(!result.diffText.includes('stats.json'), result.diffText);
  assert.ok(!result.diffText.includes('.agentic'), result.diffText);
});

test('restoreKnowledge after a mixed change puts both trees back exactly as they were', () => {
  const before = {
    app1: mapOf(path.join(root, 'screens', 'app1')),
    shared: mapOf(path.join(root, 'screens', '_shared')),
    other: mapOf(path.join(root, 'screens', 'other')),
  };
  snapshotKnowledge(root, 'app1', dest);

  // What an agent does: an edit, an add, a delete, and one forbidden _shared edit.
  write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), `${NORMAL_YML}\n- to: core/login\n  intent: "a hop the agent added"\n`);
  write(root, path.join('screens', 'app1', 'core', 'home', 'extra.md'), '# extra\n');
  fs.rmSync(path.join(root, 'screens', 'app1', 'core', 'home', 'screen.md'));
  write(root, path.join('screens', '_shared', 'exceptions.yml'), '# policy the agent tried to change\n');

  const diff = diffKnowledge(root, 'app1', dest);
  assert.equal(diff.changed.length, 4);
  assert.deepEqual(diff.forbidden.map((item) => item.file), ['screens/_shared/exceptions.yml']);

  restoreKnowledge(root, 'app1', dest);

  assert.deepEqual(mapOf(path.join(root, 'screens', 'app1')), before.app1);
  assert.deepEqual(mapOf(path.join(root, 'screens', '_shared')), before.shared);
  assert.equal(fs.existsSync(path.join(root, 'screens', 'app1', 'core', 'home', 'extra.md')), false, 'a file added since is deleted');
  assert.ok(fs.existsSync(path.join(root, 'screens', 'app1', 'core', 'home', 'screen.md')), 'a file deleted since is back');
  assert.deepEqual(mapOf(path.join(root, 'screens', 'other')), before.other, 'another app is untouched');
  assert.deepEqual(diffKnowledge(root, 'app1', dest).changed, [], 'after a restore nothing differs any more');
});

test('restore removes a tier that did not exist when the snapshot was taken', () => {
  snapshotKnowledge(root, 'app1', dest);
  // The snapshot now claims _shared never existed.
  fs.rmSync(path.join(dest, '_shared'), { recursive: true, force: true });
  write(root, path.join('screens', '_shared', 'exceptions.yml'), '# policy the agent invented\n');
  write(root, path.join('screens', 'app2', 'core', 'home', 'screen.md'), SCREEN_MD('core/home'));

  restoreKnowledge(root, 'app1', dest);

  assert.equal(fs.existsSync(path.join(root, 'screens', '_shared')), false, 'a _shared the agent created is removed');
  assert.ok(fs.existsSync(path.join(root, 'screens', 'app1', 'core', 'home', 'screen.md')), 'the app the snapshot does have is kept');
  assert.ok(fs.existsSync(path.join(root, 'screens', 'app2')), 'a tier that is neither the app nor _shared is not ours');

  // The other direction: the app tier did not exist at snapshot time.
  fs.rmSync(path.join(dest, 'app1'), { recursive: true, force: true });
  write(root, path.join('screens', 'app1', 'core', 'home', 'new.md'), '# the agent created the whole app tier\n');

  restoreKnowledge(root, 'app1', dest);

  assert.equal(fs.existsSync(path.join(root, 'screens', 'app1')), false, 'the live app dir is removed when the snapshot has none');
});

test('binary-safe: identical bytes are no change, one changed byte is a modification', () => {
  const live = path.join(root, 'screens', 'app1', 'core', 'home', 'blob.bin');
  fs.writeFileSync(live, Buffer.from([0x00, 0xff, 0xfe, 0x0a, 0x80]));
  snapshotKnowledge(root, 'app1', dest);

  // The agent rewrites the file with exactly the same bytes: there is nothing to report.
  fs.copyFileSync(path.join(dest, 'app1', 'core', 'home', 'blob.bin'), live);
  assert.deepEqual(diffKnowledge(root, 'app1', dest).changed, [], 'equal bytes compare equal');

  // One byte changes.
  fs.writeFileSync(live, Buffer.from([0x00, 0xff, 0xfe, 0x0a, 0x81]));
  assert.deepEqual(diffKnowledge(root, 'app1', dest).changed, [
    { file: 'screens/app1/core/home/blob.bin', kind: 'modified', forbidden: false },
  ]);
});

test('approve is just deleting the snapshot: the live edits stay', () => {
  snapshotKnowledge(root, 'app1', dest);
  write(root, path.join('screens', 'app1', 'core', 'home', 'screen.md'), SCREEN_MD('core/home').replace('allText: ["Home"]', 'allText: ["Home", "Home, edited by the agent"]'));
  const edited = {
    app1: mapOf(path.join(root, 'screens', 'app1')),
    shared: mapOf(path.join(root, 'screens', '_shared')),
  };

  fs.rmSync(dest, { recursive: true, force: true });

  assert.equal(fs.existsSync(dest), false);
  assert.deepEqual(mapOf(path.join(root, 'screens', 'app1')), edited.app1, 'approval keeps the edits: nothing is restored');
  assert.deepEqual(mapOf(path.join(root, 'screens', '_shared')), edited.shared);
  assert.ok(edited.app1['core/home/screen.md'].includes('edited by the agent'));
});
