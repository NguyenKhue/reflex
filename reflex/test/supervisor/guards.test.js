/**
 * guards.test.js — the agent boundary as tool behaviour: `reflex run|resume --agent` and the MCP
 * `run_start` / `resume_start` refuse a plan (or the rest of a run) that would enter credentials,
 * and `resume.json` records which remaining legs are sensitive.
 *
 * No credentials are typed anywhere here: every device is the state-machine fixture, and the
 * refusal cases must not even open a session.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const workspace = require('../../src/util/workspace');
const { runPlan, resumeRun } = require('../../src/runner/run');
const handlers = require('../../src/mcp/handlers');
const { createScreenDevice } = require('../fixtures/screens');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'workspace');
const BIN = path.join(__dirname, '..', '..', 'bin', 'reflex.js');

const SCREENS = {
  home: ['Acme Example', 'Đăng nhập', 'authState: LOGIN'],
  homeRenamed: ['Acme Example', 'Đăng nhập ngay', 'authState: LOGIN'],
  login: ['Đăng nhập Acme', { label: 'Số điện thoại', editable: true }, 'Tiếp tục'],
  password: ['Nhập mật khẩu', 'Tiếp tục'],
};
const MOVES = {
  home: { 'Đăng nhập': 'login' },
  homeRenamed: { 'Đăng nhập ngay': 'login' },
  login: { 'Tiếp tục': 'password' },
  password: { 'Tiếp tục': 'login' },
};

/** The run fixture of run.test.js: no secret input, so no leg of it is sensitive. */
const PLAN = `---
name: run_guard_plain
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

/** Its own FIRST leg is marked sensitive: an agent may not start this plan at all. */
const GUARDED_PLAN = PLAN.replace('name: run_guard_plain', 'name: run_guard_guarded').replace(
  'intent: "Walk from Home to the password screen" }',
  'intent: "Walk from Home to the password screen", sensitive: true }',
);

/** Its LAST leg is sensitive: a human may run it, an agent may not. */
const LATE_SENSITIVE_PLAN = PLAN
  .replace('name: run_guard_plain', 'name: run_guard_late')
  .replace(
    '  - { at: core/home, to: core/password, intent: "Walk from Home to the password screen" }',
    '  - { at: core/home, to: core/password, intent: "Walk from Home to the password screen" }\n  - { at: core/password, to: core/login, intent: "Submit the password", sensitive: true }',
  )
  .replace('text: "Nhập mật khẩu", exact: true', 'text: "Đăng nhập Acme", exact: true');

const GUARDED_PLAN_PATH = 'plans/example/guarded.plan.md';
const LATE_SENSITIVE_PLAN_PATH = 'plans/example/late_sensitive.plan.md';

const GUARDED_RUN_ERROR = 'requires_human: plan "run_guard_guarded" has sensitive leg(s) 1 that enter credentials; start it yourself or from CI: reflex run <plan file>';
const resumeError = (runId, from, numbers) => `requires_human: resuming run "${runId}" from leg ${from} would run sensitive leg(s) ${numbers}; resume it yourself: reflex resume ${runId}`;

let root;
let out;
const savedCwd = process.cwd();

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-guards-')));
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.writeFileSync(path.join(root, 'plans', 'example', 'run.plan.md'), PLAN);
  fs.writeFileSync(path.join(root, GUARDED_PLAN_PATH), GUARDED_PLAN);
  fs.writeFileSync(path.join(root, LATE_SENSITIVE_PLAN_PATH), LATE_SENSITIVE_PLAN);
  workspace.reset();
  workspace.setOverride(root);
  out = '';
});

afterEach(() => {
  process.chdir(savedCwd);
  workspace.reset();
  fs.rmSync(root, { recursive: true, force: true });
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

/** The device where the app was relaunched into a state the knowledge base does not know yet. */
function stuckDeps() {
  const fake = deviceDeps('homeRenamed');
  fake.backend.open = async (args) => {
    fake.backend.log.push({ kind: 'open', ...args });
    if (args && args.relaunch !== false) fake.backend.screen = 'homeRenamed';
    return { ok: true };
  };
  return fake;
}

/** Add a case to a screen of the copied workspace — the fix an agent would make after a stop. */
function addCase(screen, caseYaml) {
  fs.appendFileSync(path.join(root, 'screens', 'example', 'core', screen, 'normal.yml'), caseYaml);
}

/** Both fixes the agent of this run would have to teach the app before it can continue. */
function teachTheRenamedButtonAndThePasswordCase() {
  addCase('home', '- to: core/login\n  intent: "Open the login screen (renamed button)"\n  steps:\n    - { tool: tap_text, args: { text: "Đăng nhập ngay", exact: true, timeout: 100 } }\n  status: verified\n');
  addCase('password', '- to: core/login\n  intent: "Submit the password"\n  steps:\n    - { tool: tap_text, args: { text: "Tiếp tục", exact: true, timeout: 100 } }\n  status: verified\n');
}

function readResume(runId) {
  return JSON.parse(fs.readFileSync(path.join(root, 'reports', runId, 'resume.json'), 'utf8'));
}

/** Every run directory of the workspace, so "nothing was created" is a fact and not a guess. */
function reportDirs() {
  const dir = path.join(root, 'reports');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function fakeSpawner() {
  const calls = [];
  return {
    calls,
    spawnFn: (file, args, options) => {
      calls.push({ file, args, options });
      return { pid: 424242, unref() {} };
    },
  };
}

function fabricateResume(runId, extra = {}) {
  const dir = path.join(root, 'reports', runId);
  fs.mkdirSync(dir, { recursive: true });
  const resume = {
    runId,
    plan: path.join(root, GUARDED_PLAN_PATH),
    legIndex: 0,
    rowId: 'a',
    rowIds: ['a'],
    platform: 'android',
    ...extra,
  };
  fs.writeFileSync(path.join(dir, 'resume.json'), `${JSON.stringify(resume, null, 2)}\n`);
  return dir;
}

function cli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, REFLEX_PROJECT_DIR: root } });
  const markers = result.stdout.split('\n').filter((line) => line.startsWith('REFLEX_JSON '));
  return {
    code: result.status,
    markers,
    marker: markers.length ? JSON.parse(markers[markers.length - 1].slice('REFLEX_JSON '.length)) : null,
    stderr: result.stderr,
  };
}

test('an agent may not start a plan with a sensitive leg: refused, exit 1, nothing created', async () => {
  const { created, deps } = deviceDeps('home');
  const { summary, exitCode } = await runPlan({ planPath: GUARDED_PLAN_PATH, runId: 'r-guard-agent', screenshots: 'none', actor: 'agent', deps });

  assert.equal(exitCode, 1);
  assert.equal(summary.status, 'refused');
  assert.equal(summary.plan, 'run_guard_guarded');
  assert.equal(summary.error, GUARDED_RUN_ERROR);
  assert.equal(summary.sensitiveLegs.length, 1);
  assert.equal(summary.sensitiveLegs[0].index, 0);
  assert.ok(summary.sensitiveLegs[0].reasons.includes('explicit'), summary.sensitiveLegs[0].reasons.join(', '));
  assert.equal(markers().length, 1);
  assert.equal(markers()[0].status, 'refused');
  // The refusal comes before any side effect: no report directory, no device session.
  assert.deepEqual(reportDirs(), []);
  assert.equal(created.length, 0);
});

test('the same plan started by a human runs normally', async () => {
  const guardedRun = deviceDeps('home');
  const guarded = await runPlan({ planPath: GUARDED_PLAN_PATH, runId: 'r-guard-human', screenshots: 'none', deps: guardedRun.deps });
  assert.equal(guarded.exitCode, 0, JSON.stringify(guarded.summary));
  assert.equal(guarded.summary.status, 'pass');
  assert.equal(guardedRun.created.length, 1);

  // A plan without any sensitive leg is never refused, whoever starts it.
  const plainRun = deviceDeps('home');
  const plain = await runPlan({ planPath: 'plans/example/run.plan.md', runId: 'r-guard-plain', screenshots: 'none', deps: plainRun.deps });
  assert.equal(plain.exitCode, 0, JSON.stringify(plain.summary));
  assert.equal(plain.summary.status, 'pass');
});

test('resume.json records the sensitive legs that are left: none here, one later there', async () => {
  const plain = stuckDeps();
  const stopped = await runPlan({ planPath: 'plans/example/run.plan.md', caseId: 'b', runId: 'r-guard-plain', screenshots: 'none', deps: plain.deps });
  assert.equal(stopped.exitCode, 3);
  assert.deepEqual(readResume('r-guard-plain').sensitive, { remaining: [], blocksAgent: false });

  const late = stuckDeps();
  const alsoStopped = await runPlan({ planPath: LATE_SENSITIVE_PLAN_PATH, caseId: 'b', runId: 'r-guard-late', screenshots: 'none', deps: late.deps });
  assert.equal(alsoStopped.exitCode, 3);
  assert.equal(alsoStopped.summary.status, 'needs_agent');
  const sensitive = readResume('r-guard-late').sensitive;
  assert.equal(sensitive.blocksAgent, true);
  assert.deepEqual(sensitive.remaining, [{
    index: 1,
    at: 'core/password',
    to: 'core/login',
    sensitive: true,
    reasons: ['explicit', 'screen-name'],
  }]);
});

test('an agent may not resume a run whose rest is sensitive; a human may, and status.json stands still', async () => {
  const { backend, created, deps } = stuckDeps();
  const stopped = await runPlan({ planPath: LATE_SENSITIVE_PLAN_PATH, caseId: 'b', runId: 'r-guard-resume', screenshots: 'none', deps });
  assert.equal(stopped.exitCode, 3);
  const statusFile = path.join(root, 'reports', 'r-guard-resume', 'status.json');
  const before = fs.readFileSync(statusFile, 'utf8');

  const refused = await resumeRun('r-guard-resume', { actor: 'agent', deps });
  assert.equal(refused.exitCode, 1);
  assert.equal(refused.summary.status, 'refused');
  assert.equal(refused.summary.error, resumeError('r-guard-resume', 1, '2'));
  assert.deepEqual(refused.summary.sensitiveLegs.map((leg) => leg.index), [1]);
  // Nothing moved: the run is still exactly where it stopped, session included.
  assert.equal(fs.readFileSync(statusFile, 'utf8'), before);
  assert.equal(created.length, 1);
  assert.equal(backend.closed, 0);

  teachTheRenamedButtonAndThePasswordCase();
  const human = await resumeRun('r-guard-resume', { deps });
  assert.equal(human.summary.status, 'pass', JSON.stringify(human.summary));
  assert.equal(human.exitCode, 0);
});

test('MCP run_start refuses a sensitive plan before any report dir, and always runs as an agent', async () => {
  const spawner = fakeSpawner();
  await assert.rejects(
    () => handlers.runStart({ plan: GUARDED_PLAN_PATH }, { spawnFn: spawner.spawnFn }),
    { message: GUARDED_RUN_ERROR },
  );
  assert.equal(spawner.calls.length, 0);
  assert.deepEqual(reportDirs(), []);

  const allowed = await handlers.runStart({ plan: 'plans/example/login.plan.md' }, { spawnFn: spawner.spawnFn });
  assert.match(allowed.runId, /^example_login_basic_\d{8}_\d{6}$/);
  // The MCP server is always an agent, so it tells the spawned run so too.
  assert.equal(spawner.calls[0].args[0], BIN);
  assert.ok(spawner.calls[0].args.includes('--agent'), spawner.calls[0].args.join(' '));
  // run_start passes the plan as an absolute path inside the workspace.
  assert.ok(spawner.calls[0].args.some((arg) => arg.endsWith('plans/example/login.plan.md')), spawner.calls[0].args.join(' '));
});

test('MCP resume_start refuses a resume.json that blocks an agent, otherwise it spawns with --agent', async () => {
  const spawner = fakeSpawner();
  fabricateResume('r-guard-mcp', { sensitive: { remaining: [{ index: 1, reasons: ['explicit'] }], blocksAgent: true } });
  await assert.rejects(
    () => handlers.resumeStart({ runId: 'r-guard-mcp' }, { spawnFn: spawner.spawnFn }),
    { message: resumeError('r-guard-mcp', 1, '2') },
  );
  assert.equal(spawner.calls.length, 0);
  assert.equal(fs.existsSync(path.join(root, 'reports', 'r-guard-mcp', 'status.json')), false);

  fabricateResume('r-guard-mcp', { sensitive: { remaining: [], blocksAgent: false } });
  const started = await handlers.resumeStart({ runId: 'r-guard-mcp' }, { spawnFn: spawner.spawnFn });
  assert.ok(spawner.calls[0].args.includes('--agent'), spawner.calls[0].args.join(' '));
  assert.deepEqual(spawner.calls[0].args.slice(0, 4), [BIN, 'resume', 'r-guard-mcp', '--json']);
  assert.equal(started.pid, 424242);
});

test('CLI: reflex run --agent on a sensitive plan exits 1 with a refused marker and no device', () => {
  const result = cli(['run', GUARDED_PLAN_PATH, '--agent', '--json', '--workspace', root]);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.markers.length, 1, result.markers.join('\n'));
  assert.equal(result.marker.status, 'refused');
  assert.equal(result.marker.error, GUARDED_RUN_ERROR);
  assert.deepEqual(result.marker.sensitiveLegs.map((leg) => leg.index), [0]);
  assert.deepEqual(reportDirs(), []);
});
