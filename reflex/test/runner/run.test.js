/**
 * run.test.js — runPlan / resumeRun end to end on a state-machine device: marker, exit codes,
 * status.json, resume.json (by leg), kept session, the blocked status, and the resume rules.
 *
 * The plan is a chain of screen legs; the fixture workspace's `screens/example/core/` tree is
 * what the device fixture renders, so the loop walks it without ever asking a model.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const workspace = require('../../src/util/workspace');
const { runPlan, resumeRun } = require('../../src/runner/run');
const { createMockJev } = require('../../src/jev/jevClient');
const { createScreenDevice, chooseByDescription } = require('../fixtures/screens');
const { writeStore } = require('../fixtures/screenStore');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'workspace');

const SCREENS = {
  home: ['Acme Example', 'Đăng nhập', 'authState: LOGIN'],
  homeRenamed: ['Acme Example', 'Đăng nhập ngay', 'authState: LOGIN'],
  login: ['Đăng nhập Acme', { label: 'Số điện thoại', editable: true }, 'Tiếp tục'],
  password: ['Nhập mật khẩu'],
  maintenance: ['Bảo trì hệ thống đang diễn ra'],
};
const MOVES = {
  home: { 'Đăng nhập': 'login' },
  homeRenamed: { 'Đăng nhập ngay': 'login' },
  login: { 'Tiếp tục': 'password' },
};

const PLAN = `---
name: run_fixture
app: example
goal: "Reach the password screen"
inputs:
  - { name: phone, required: true }
options: { legTimeoutMs: 5000, caseWaitMs: 250, stepTimeoutMs: 2000 }
start: { launch: relaunch }
flow:
  - { at: core/home, to: core/password, intent: "Walk from Home to the password screen" }
verify:
  - { tool: assert_text, args: { text: "Nhập mật khẩu", exact: true, timeout: 5 } }
---
| id | phone |
|---|---|
| a | 0900000005 |
| b | 0900000006 |
`;

let root;
let out;
const savedCwd = process.cwd();

/** Same legs, but the end-state assertion can never hold: the row must come out `fail`. */
const FAILING_VERIFY_PLAN = PLAN
  .replace('name: run_fixture', 'name: run_verify_fail')
  .replace('text: "Nhập mật khẩu", exact: true, timeout: 5', 'text: "Không có trên màn hình này", exact: true, timeout: 5');

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acme-run-')));
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.writeFileSync(path.join(root, 'plans', 'example', 'run.plan.md'), PLAN);
  fs.writeFileSync(path.join(root, 'plans', 'example', 'verify_fail.plan.md'), FAILING_VERIFY_PLAN);
  workspace.reset();
  workspace.setOverride(root);
  out = '';
});

afterEach(() => {
  process.chdir(savedCwd);
  workspace.reset();
});

function markers() {
  return out.split('\n').filter((line) => line.startsWith('REFLEX_JSON ')).map((line) => JSON.parse(line.slice('REFLEX_JSON '.length)));
}

function deviceDeps(start) {
  const backend = createScreenDevice({ screens: SCREENS, moves: MOVES, start });
  const created = [];
  return {
    backend,
    created,
    deps: {
      createBackend: (opts) => {
        created.push(opts);
        return backend;
      },
      createJev: () => null,
      print: (line) => { out += `${line}\n`; },
    },
  };
}

/** Add a case to a screen of the copied workspace — the fix an agent would make after a stop. */
function addCase(screen, caseYaml) {
  fs.appendFileSync(path.join(root, 'screens', 'example', 'core', screen, 'normal.yml'), caseYaml);
}

/** A Jev that answers with one description per call; it throws if it is asked more often. */
function jevQueue(descriptions) {
  return createMockJev((state, questions, call) => {
    if (call >= descriptions.length) throw new Error(`unexpected Jev call #${call + 1}`);
    return chooseByDescription(descriptions[call])(state, questions);
  });
}

function depsWithJev(start, jev, moves = MOVES, screens = SCREENS) {
  const backend = createScreenDevice({ screens, moves, start });
  return {
    backend,
    deps: {
      createBackend: () => backend,
      createJev: () => jev,
      print: (line) => { out += `${line}\n`; },
    },
  };
}

/** Every file of the knowledge tree, so a test can prove that nothing was written at all. */
function knowledgeTree() {
  const dir = path.join(root, 'screens');
  const files = {};
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return files;
}

/** What the phone number may never appear in: any file the run could have written. */
function treeText() {
  return Object.entries(knowledgeTree()).map(([name, text]) => `${name}\n${text}`).join('\n');
}

test('a passing plan: exit 0, one marker, status done, session closed', async () => {
  const { backend, created, deps } = deviceDeps('home');
  // `start.launch: relaunch` restarts the fake app, so every row starts from Home.
  backend.open = async () => { backend.screen = 'home'; return { ok: true }; };
  const { summary, exitCode } = await runPlan({ planPath: 'plans/example/run.plan.md', runId: 'r1', screenshots: 'none', deps });
  assert.equal(exitCode, 0, JSON.stringify(summary));
  assert.equal(summary.status, 'pass');
  assert.equal(summary.total, 2);
  assert.equal(summary.blocked, 0);
  // home → login → password (3 leg entries) + 1 verify step, all at L0
  assert.deepEqual(summary.rows.map((row) => row.levels.L0), [4, 4]);
  assert.equal(created[0].session, 'r1');
  assert.equal(backend.closed, 1);
  assert.equal(markers().length, 1);
  assert.ok(!out.includes('0900000005'), 'a typed value leaked into stdout');
  const status = JSON.parse(fs.readFileSync(path.join(root, 'reports', 'r1', 'status.json'), 'utf8'));
  assert.equal(status.state, 'done');
  assert.equal(status.result.status, 'pass');
  assert.equal(status.result.resume, null);
});

test('a finished run appends exactly one line to the run ledger', async () => {
  const { backend, deps } = deviceDeps('home');
  backend.open = async () => { backend.screen = 'home'; return { ok: true }; };
  const ledger = path.join(root, '.agentic', 'runs.jsonl');
  // The assertion is about this run's single line, so the copy of the fixture starts with no ledger.
  fs.rmSync(ledger, { force: true });
  const { summary, exitCode } = await runPlan({ planPath: 'plans/example/run.plan.md', runId: 'r-ledger', screenshots: 'none', deps });
  assert.equal(exitCode, 0, JSON.stringify(summary));
  const lines = fs.readFileSync(ledger, 'utf8').split('\n').filter((line) => line.trim());
  assert.equal(lines.length, 1, lines.join('\n'));
  const record = JSON.parse(lines[0]);
  assert.equal(record.status, summary.status);
  assert.equal(record.runId, 'r-ledger');
});

test('a passing leg maps to a report entry per leg, and a failing verify is a FAIL', async () => {
  const { backend, deps } = deviceDeps('home');
  backend.open = async () => { backend.screen = 'home'; return { ok: true }; };
  const { summary, exitCode } = await runPlan({ planPath: 'plans/example/verify_fail.plan.md', caseId: 'a', runId: 'r6', screenshots: 'none', deps });
  assert.equal(exitCode, 1);
  assert.equal(summary.status, 'fail');
  assert.equal(summary.rows[0].status, 'fail');
  assert.match(summary.rows[0].error, /^verify \(verify 1 \(assert_text\)\) failed: /);
  // ... and every leg entry reaches the report as its own step (3 leg entries + 1 verify).
  const html = fs.readFileSync(path.join(root, 'reports', 'r6', 'index.html'), 'utf8');
  assert.equal((html.match(/class="step step-/g) || []).length, 4);
  assert.ok(html.includes('core/login') && html.includes('core/password'), 'the leg entries are missing from the report');
  assert.equal(backend.closed, 1);
});

test('a blocked leg is reported as blocked, not as a failure', async () => {
  const { backend, deps } = deviceDeps('maintenance');
  backend.open = async () => { backend.screen = 'maintenance'; return { ok: true }; };
  const { summary, exitCode } = await runPlan({ planPath: 'plans/example/run.plan.md', caseId: 'a', runId: 'r5', screenshots: 'none', deps });
  assert.equal(exitCode, 1);
  assert.equal(summary.status, 'blocked');
  assert.equal(summary.rows[0].status, 'blocked');
  assert.deepEqual([summary.passed, summary.failed, summary.blocked], [0, 0, 1]);
  // The row error names the leg and what happened there: "<at> → <to>: <what>".
  assert.match(summary.rows[0].error, /^legs \(core\/home → core\/password: service_maintenance\) is blocked: the example environment is under maintenance$/);
});

test('needs_agent keeps the session, writes a resume.json for the leg, and resume finishes after a fix', async () => {
  const first = deviceDeps('homeRenamed');
  first.backend.open = async (args) => {
    first.backend.log.push({ kind: 'open', ...args });
    if (args && args.relaunch !== false) first.backend.screen = 'homeRenamed';
    return { ok: true };
  };
  const stuck = await runPlan({ planPath: 'plans/example/run.plan.md', caseId: 'b', runId: 'r2', screenshots: 'none', deps: first.deps });
  assert.equal(stuck.exitCode, 3);
  assert.equal(stuck.summary.status, 'needs_agent');
  assert.equal(first.backend.closed, 0, 'the session must stay open for resume');
  const resume = JSON.parse(fs.readFileSync(path.join(root, 'reports', 'r2', 'resume.json'), 'utf8'));
  assert.equal(resume.legIndex, 0);
  assert.equal(resume.reason, 'no_jev');
  assert.deepEqual(resume.leg, { at: 'core/home', to: 'core/password', intent: 'Walk from Home to the password screen' });
  assert.equal(resume.screen, 'core/home');
  assert.equal(resume.jevThreshold, 0.75);
  assert.deepEqual(resume.rowIds, ['b']);
  assert.ok(resume.visibleText.includes('Đăng nhập ngay'));
  assert.ok(!JSON.stringify(resume).includes('0900000006'));

  // The agent teaches Home the renamed button (the knowledge base, not the plan: the hash holds).
  addCase('home', '- to: core/login\n  intent: "Open the login screen (renamed button)"\n  steps:\n    - { tool: tap_text, args: { text: "Đăng nhập ngay", exact: true, timeout: 100 } }\n  status: learned\n');
  const resumed = await resumeRun('r2', { deps: first.deps });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed.summary));
  assert.equal(resumed.summary.total, 1, 'a --case run stays a one-row run');
  assert.deepEqual(resumed.summary.resumedFrom, { legIndex: 0, rowId: 'b' });
  assert.ok(first.backend.log.some((entry) => entry.kind === 'open' && entry.relaunch === false));
});

test('resume refuses a plan whose earlier legs changed', async () => {
  const { deps } = deviceDeps('home');
  // A run that stopped at leg 2 (its prefix hash covers leg 1) — the prefix is stale now.
  const reportDir = path.join(root, 'reports', 'r3');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'resume.json'), `${JSON.stringify({
    runId: 'r3',
    plan: path.join(root, 'plans', 'example', 'run.plan.md'),
    prefixHash: 'stale',
    legIndex: 1,
    rowId: 'a',
    rowIds: ['a'],
    platform: 'android',
    app: { package: 'com.acme.example' },
    jevThreshold: 0.75,
  })}\n`);
  const { summary, exitCode } = await resumeRun('r3', { deps });
  assert.equal(exitCode, 1);
  assert.match(summary.error, /resume_prefix_changed/);
});

test('resume stops when the app left the foreground', async () => {
  const { backend, deps } = deviceDeps('homeRenamed');
  backend.open = async () => { backend.screen = 'homeRenamed'; return { ok: true }; };
  await runPlan({ planPath: 'plans/example/run.plan.md', caseId: 'a', runId: 'r4', screenshots: 'none', deps });
  const snapshot = backend.snapshot;
  backend.snapshot = async () => ({ ...(await snapshot()), appBundleId: 'com.android.launcher' });
  const { summary, exitCode } = await resumeRun('r4', { deps });
  assert.equal(exitCode, 1);
  assert.match(summary.error, /resume_lost_app/);
});

test('an invalid plan or screens tree never opens a session', async () => {
  const { created, deps } = deviceDeps('home');
  const bad = await runPlan({ planPath: 'plans/example/bad.plan.md', deps });
  assert.equal(bad.exitCode, 1);
  assert.equal(bad.summary.status, 'invalid');
  assert.ok(bad.summary.errors.length > 3);
  const noCase = await runPlan({ planPath: 'plans/example/run.plan.md', caseId: 'zzz', deps });
  assert.match(noCase.summary.errors[0], /no row with id "zzz"/);
  // A broken knowledge base is a validation error, not a crash.
  fs.writeFileSync(path.join(root, 'screens', 'example', 'core', 'home', 'screen.md'), '---\nid: core/wrong\nidentify: { allText: ["Acme Example"] }\n---\n');
  const brokenTree = await runPlan({ planPath: 'plans/example/run.plan.md', deps });
  assert.equal(brokenTree.summary.status, 'invalid');
  assert.match(brokenTree.summary.errors[0], /"id" must be "core\/home"/);
  assert.equal(created.length, 0);
});

test('an invalid Jev threshold is rejected before a session opens', async () => {
  const { created, deps } = deviceDeps('home');
  const { summary, exitCode } = await runPlan({ planPath: 'plans/example/run.plan.md', jevThreshold: '1.5', deps });
  assert.equal(exitCode, 1);
  assert.equal(summary.status, 'invalid');
  assert.match(summary.errors[0], /jev threshold must be a number in \(0, 1\]/);
  assert.equal(created.length, 0);
});

/**
 * The learning scenarios. Their knowledge tree is emptied first, so every hop has to be found by
 * Jev — which is exactly the case learning exists for: the next run must not need Jev at all.
 */
const LEARN_SCREENS = {
  home: ['Acme Example', 'Đăng nhập', 'authState: LOGIN', 'Số ví: 0900000005'],
  login: ['Đăng nhập Acme', { label: 'Số điện thoại', editable: true }, 'Tiếp tục'],
  password: ['Nhập mật khẩu'],
};
const LEARN_MOVES = { home: { 'Số ví: 0900000005': 'login' }, login: { 'Tiếp tục': 'password' } };
const PHONE_A = '0900000005';
const THROWING_JEV = () => createMockJev(() => { throw new Error('Jev must not be called'); });

/** Empty the two screens of the fixture plan, so the leg has to be resolved by Jev. */
function forgetTheWay() {
  for (const screen of ['home', 'login']) {
    fs.writeFileSync(path.join(root, 'screens', 'example', 'core', screen, 'normal.yml'), '# nothing known yet\n');
  }
}

const screenYml = (screen) => fs.readFileSync(path.join(root, 'screens', 'example', 'core', screen, 'normal.yml'), 'utf8');

test('learning: Jev gets the leg through, the run writes the cases, and the next run needs no Jev', async () => {
  forgetTheWay();
  const first = depsWithJev('home', jevQueue([
    `Tap "Số ví: {phone}"`, // Jev only ever sees the redacted label
    'Type the input "phone" into text field #1',
    'Tap "Tiếp tục"',
  ]), LEARN_MOVES, LEARN_SCREENS);
  first.backend.open = async () => { first.backend.screen = 'home'; return { ok: true }; };
  const run1 = await runPlan({ planPath: 'plans/example/run.plan.md', caseId: 'a', runId: 'r7', screenshots: 'none', deps: first.deps });

  assert.equal(run1.exitCode, 0, JSON.stringify(run1.summary));
  assert.equal(run1.summary.rows[0].status, 'pass');
  assert.equal(first.backend.log.filter((item) => item.kind === 'press').length, 2, 'one press per hop, both from Jev');
  assert.deepEqual(run1.summary.knowledge.map((event) => [event.action, event.file]), [
    ['added', 'screens/example/core/home/normal.yml'],
    ['added', 'screens/example/core/login/normal.yml'],
  ]);

  // The two cases were learned, and neither of them carries the value the run typed: a label that
  // held the phone number was written as the placeholder the plan's data resolves.
  const home = screenYml('home');
  assert.match(home, /to: core\/login/);
  assert.match(home, /status: learned/);
  assert.match(home, /text: "Số ví: \{phone\}"/);
  assert.match(screenYml('login'), /text: "\{phone\}"/);
  assert.equal(treeText().includes(PHONE_A), false, 'a typed value reached a committed file');
  // The report lists what the run changed, so a reviewer sees the learned case without a diff.
  const html = fs.readFileSync(path.join(root, 'reports', 'r7', 'index.html'), 'utf8');
  assert.match(html, /Knowledge changes/);
  assert.match(html, /screens\/example\/core\/home\/normal\.yml/);

  // Run 2: same workspace, a Jev that throws if it is ever asked.
  const second = depsWithJev('home', THROWING_JEV(), LEARN_MOVES, LEARN_SCREENS);
  second.backend.open = async () => { second.backend.screen = 'home'; return { ok: true }; };
  const run2 = await runPlan({ planPath: 'plans/example/run.plan.md', caseId: 'a', runId: 'r8', screenshots: 'none', deps: second.deps });

  assert.equal(run2.exitCode, 0, JSON.stringify(run2.summary));
  assert.equal(second.backend.screen, 'password');
  // Nothing was re-learned (a case that runs again is a use of the knowledge, not a change); what
  // the run did add is the route its two learned hops form, which the next one can walk in order.
  assert.deepEqual(run2.summary.knowledge, [{
    action: 'route',
    file: 'screens/example/_app/routes.yml',
    key: ['core/home', 'core/login', 'core/password'].join('>'),
  }]);
});

test('learning: a leg that stopped for the agent leaves the tree byte-identical', async () => {
  forgetTheWay();
  const before = knowledgeTree();
  const { backend, deps } = depsWithJev('home', createMockJev(() => ({ nextAction: { choice: 'back', confidence: 0.5 } })), LEARN_MOVES, LEARN_SCREENS);
  backend.open = async () => { backend.screen = 'home'; return { ok: true }; };
  const { summary, exitCode } = await runPlan({ planPath: 'plans/example/run.plan.md', caseId: 'a', runId: 'r11', screenshots: 'none', deps });

  assert.equal(exitCode, 3);
  assert.equal(summary.status, 'needs_agent');
  assert.deepEqual(summary.knowledge, []);
  assert.deepEqual(knowledgeTree(), before, 'a decision nobody confirmed wrote knowledge');
});

test('--no-learn writes nothing at all, not even the stats of the cases that ran', async () => {
  const before = knowledgeTree();
  const off = depsWithJev('home', THROWING_JEV());
  off.backend.open = async () => { off.backend.screen = 'home'; return { ok: true }; };
  const skipped = await runPlan({ planPath: 'plans/example/run.plan.md', caseId: 'a', runId: 'r12', screenshots: 'none', learn: false, deps: off.deps });

  assert.equal(skipped.exitCode, 0, JSON.stringify(skipped.summary));
  assert.deepEqual(skipped.summary.knowledge, []);
  assert.deepEqual(knowledgeTree(), before, '--no-learn wrote something');

  // The same run with learning on records the route; the counters of the two cases it used go to
  // the local ledger, so their lines stay as they were (a bump there conflicted on every branch).
  const homeBefore = screenYml('home');
  const on = depsWithJev('home', THROWING_JEV());
  on.backend.open = async () => { on.backend.screen = 'home'; return { ok: true }; };
  const written = await runPlan({ planPath: 'plans/example/run.plan.md', caseId: 'a', runId: 'r13', screenshots: 'none', deps: on.deps });

  assert.equal(written.exitCode, 0, JSON.stringify(written.summary));
  assert.equal(screenYml('home'), homeBefore);
  const ledger = JSON.parse(fs.readFileSync(path.join(root, '.agentic', 'stats.json'), 'utf8'));
  const home = Object.entries(ledger).find(([key]) => key.startsWith('screens/example/core/home/normal.yml#core/login|'));
  assert.deepEqual(home && [home[1].ok, home[1].streak], [6, 6], 'the counters went to the local ledger');
  // The route is knowledge worth reporting; the stats bumps underneath it are not, or every run
  // would fill the "Knowledge changes" table with them.
  assert.deepEqual(written.summary.knowledge, [{
    action: 'route',
    file: 'screens/example/_app/routes.yml',
    key: ['core/home', 'core/login', 'core/password'].join('>'),
  }]);
  assert.notDeepEqual(knowledgeTree(), before);
});
