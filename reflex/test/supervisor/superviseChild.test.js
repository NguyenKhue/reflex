/**
 * superviseChild.test.js — the child-process path of supervise.js: how `childArgs` turns supervisor options into one
 * command line for `reflex.js`, how `parseChildResult` reads a child's stdout back, and that the pieces fit together
 * when the supervisor really spawns a child.
 *
 * Nothing here types a credential and nothing here opens a device session: the integration case spawns the real CLI on a
 * plan whose only leg is sensitive, and the child refuses it before it touches anything.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const workspace = require('../../src/util/workspace');
const { superviseRun, childArgs, parseChildResult } = require('../../src/supervisor/supervise');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'workspace');

/** The plain run plan of guards.test.js: no secret input, so no leg of it is sensitive. */
const PLAN = `---
name: run_child_plain
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

/** Its own FIRST leg is marked sensitive: the child must refuse an agent before creating a report dir. */
const GUARDED_PLAN = PLAN
  .replace('name: run_child_plain', 'name: run_child_guarded')
  .replace(
    'intent: "Walk from Home to the password screen" }',
    'intent: "Walk from Home to the password screen", sensitive: true }',
  );

const GUARDED_PLAN_PATH = 'plans/example/guarded.plan.md';

/** Every option childArgs knows about, so the expected list below is the whole command line and not a part of it. */
const EVERY_OPTION = {
  planPath: 'plans/example/login.plan.md',
  caseId: 'b',
  platform: 'android',
  serial: 'emulator-5554',
  udid: '00008030-000123456789002E',
  app: 'example',
  screenshots: 'on-stop',
  useJev: false,
  jevThreshold: 0.7,
  learn: false,
  runId: 'r-supervise-child',
  maxJevCalls: 3,
};

let root;
const savedCwd = process.cwd();

beforeEach(() => {
  // A copy of the fixture workspace, so nothing a child writes can reach the repository.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-supervise-child-')));
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.writeFileSync(path.join(root, GUARDED_PLAN_PATH), GUARDED_PLAN);
  workspace.reset();
  workspace.setOverride(root);
});

afterEach(() => {
  process.chdir(savedCwd);
  workspace.reset();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Every run directory of the workspace, so "the child created nothing" is a fact and not a guess. */
function reportDirs() {
  const dir = path.join(root, 'reports');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/** The child has to learn the workspace from `--workspace` alone, never from an env var of this process. */
async function withoutProjectEnv(fn) {
  const saved = process.env.REFLEX_PROJECT_DIR;
  delete process.env.REFLEX_PROJECT_DIR;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.REFLEX_PROJECT_DIR;
    else process.env.REFLEX_PROJECT_DIR = saved;
  }
}

test('childArgs("run", …) appends every option in the order the code appends them, ending with --workspace <root>', () => {
  assert.deepEqual(childArgs('run', EVERY_OPTION), [
    'run', 'plans/example/login.plan.md',
    '--case', 'b',
    '--platform', 'android',
    '--serial', 'emulator-5554',
    '--udid', '00008030-000123456789002E',
    '--app', 'example',
    '--screenshots', 'on-stop',
    '--no-jev',
    '--jev-threshold', '0.7',
    '--no-learn',
    '--run-id', 'r-supervise-child',
    '--max-jev-calls', '3',
    '--workspace', root,
  ]);

  const args = childArgs('run', EVERY_OPTION);
  assert.deepEqual(args.slice(-2), ['--workspace', root]);
  assert.equal(args[0], 'run');
});

test('childArgs("run", …) leaves out the flags nobody asked for', () => {
  const everyFlag = [
    '--case', '--platform', '--serial', '--udid', '--app', '--screenshots',
    '--no-jev', '--jev-threshold', '--no-learn', '--run-id', '--max-jev-calls',
  ];

  const minimal = childArgs('run', { planPath: 'plans/example/login.plan.md' });
  assert.deepEqual(minimal, ['run', 'plans/example/login.plan.md', '--workspace', root]);
  for (const flag of everyFlag) assert.ok(!minimal.includes(flag), `${flag} should not be there: ${minimal.join(' ')}`);

  // The decider and the learner stay on unless the caller turned them off with exactly `false`.
  const defaults = childArgs('run', { planPath: 'plans/example/login.plan.md', useJev: true, learn: true });
  assert.deepEqual(defaults, ['run', 'plans/example/login.plan.md', '--workspace', root]);
  assert.ok(!defaults.includes('--no-jev'), defaults.join(' '));
  assert.ok(!defaults.includes('--no-learn'), defaults.join(' '));

  // A partial set keeps its own flags and nothing else.
  const partial = childArgs('run', { planPath: 'plans/example/login.plan.md', platform: 'ios', useJev: false });
  assert.deepEqual(partial, ['run', 'plans/example/login.plan.md', '--platform', 'ios', '--no-jev', '--workspace', root]);
});

test('childArgs("resume", …) is the run id, then --plan only when there is one', () => {
  assert.deepEqual(
    childArgs('resume', { runId: 'r-supervise-child', planPath: 'plans/example/login.plan.md' }),
    ['resume', 'r-supervise-child', '--plan', 'plans/example/login.plan.md', '--workspace', root],
  );
  assert.deepEqual(
    childArgs('resume', { runId: 'r-supervise-child' }),
    ['resume', 'r-supervise-child', '--workspace', root],
  );

  // A resume carries no run options of its own: --no-jev here would describe a run that never happened.
  const withRunOptions = childArgs('resume', { runId: 'r-supervise-child', useJev: false, screenshots: 'none', maxJevCalls: 2 });
  assert.deepEqual(withRunOptions, ['resume', 'r-supervise-child', '--workspace', root]);
});

test('actor "agent" adds --agent just before --workspace, any other actor adds nothing', () => {
  for (const [kind, base] of [['run', { planPath: 'plans/example/login.plan.md' }], ['resume', { runId: 'r-supervise-child' }]]) {
    const agent = childArgs(kind, { ...base, actor: 'agent' });
    assert.deepEqual(agent.slice(-3), ['--agent', '--workspace', root], `${kind}: ${agent.join(' ')}`);

    for (const actor of ['human', 'ci', 'agent-ish', 'Agent', undefined]) {
      const args = childArgs(kind, { ...base, actor });
      assert.ok(!args.includes('--agent'), `${kind} as ${actor}: ${args.join(' ')}`);
      assert.deepEqual(args.slice(-2), ['--workspace', root], `${kind} as ${actor}: ${args.join(' ')}`);
    }
  }

  // Even with every run option present the flag stays in the same place, so the order is fixed.
  const args = childArgs('run', { ...EVERY_OPTION, actor: 'agent' });
  assert.deepEqual(args.slice(-3), ['--agent', '--workspace', root]);
  assert.deepEqual(args.slice(-5, -3), ['--max-jev-calls', '3']);
});

test('parseChildResult takes the LAST valid marker and ignores the rest of the output', () => {
  const stdout = [
    'reflex run: starting',
    'REFLEX_JSON {"status":"needs_agent","runId":"r-old","reportDir":"/old"}',
    'REFLEX_JSON {"status":"needs_agent",',
    'a library logged something of its own',
    'REFLEX_JSON {"status":"refused","runId":"r-new","error":"requires_human: nope"}',
    'REFLEX_JSON neither is this',
  ].join('\n');

  const { summary, exitCode } = parseChildResult(stdout, 3);
  assert.equal(summary.status, 'refused');
  assert.equal(summary.runId, 'r-new');
  assert.equal(summary.error, 'requires_human: nope');
  assert.equal(exitCode, 3);
});

test('no marker at all is an error, and it never claims success', () => {
  const expected = { status: 'error', error: 'the child process printed no REFLEX_JSON marker' };
  for (const stdout of ['', undefined, null, 'only logs here\nand here\n']) {
    // No status either: that is how a child that died before printing arrives, and it must not look like a pass.
    const { summary, exitCode } = parseChildResult(stdout, undefined);
    assert.deepEqual(summary, expected);
    assert.equal(exitCode, 1);
  }
});

test('a missing exit status is not an exit code: 1; a needs_agent keeps its 3', () => {
  for (const status of [null, undefined, '3', 1.5, NaN]) {
    const { exitCode } = parseChildResult('REFLEX_JSON {"status":"needs_agent","runId":"r-x"}', status);
    assert.equal(exitCode, 1, `status ${String(status)} should not become an exit code`);
  }
  assert.equal(parseChildResult('REFLEX_JSON {"status":"needs_agent","runId":"r-x"}', 3).exitCode, 3);
});

test('integration: the real child refuses a sensitive plan, and the supervisor says so', async () => {
  const result = await withoutProjectEnv(() => superviseRun({
    planPath: GUARDED_PLAN_PATH,
    actor: 'agent',
  }));

  // The refusal is a finished run, not a stop: there is nothing for an agent to take over.
  assert.equal(result.state, 'finished');
  assert.equal(result.runStatus, 'refused');
  assert.equal(result.exitCode, 1);
  assert.equal(result.reportDir, null);
  assert.equal(result.runId, null);
  assert.equal(result.rounds, 0);
  assert.deepEqual(result.changed, []);

  // The child refused before it created anything: no report dir means the refusal had no side effect.
  assert.deepEqual(reportDirs(), []);
});
