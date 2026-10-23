/**
 * supervise.test.js — `reflex supervise`: the wrapper loop, the handoff it writes, the provisional
 * knowledge edits it keeps, and the human's approve/reject/status.
 *
 * No device and no real run: `runPlan`, `resumeRun` and `runAgent` are stubbed, so every state of the
 * loop can be reached on demand. The one exception is the default agent runner, which is exercised with
 * a real child process to prove the agent cannot read the human's secrets.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const workspace = require('../../src/util/workspace');
const { superviseRun, approveRun, rejectRun, statusRun, scrubEnv, AGENT_ENV_ALLOW } = require('../../src/supervisor/supervise');

const BIN = path.join(__dirname, '..', '..', 'bin', 'reflex.js');
const PLAN = 'plans/example/run.plan.md';
const NOW = () => Date.parse('2026-10-05T10:00:00Z');
const LATER = () => Date.parse('2026-10-05T11:00:00Z');

const SCREEN_MD = `---
id: core/home
identify:
  allText: ["Home"]
inputs: []
---
The home screen of the supervise fixture app.
`;

const NORMAL_YML = `# One hop from Home, written by the app's author.
- to: core/x
  intent: "Open the next screen"
  steps:
    - { tool: tap_text, args: { text: "NEXT", exact: true } }
  status: verified
  stats: { ok: 1, fail: 0, streak: 1, lastOk: '2026-10-04' }
`;

/** What a learning agent would leave behind: a corrected hop. */
const FIXED_NORMAL_YML = NORMAL_YML.replace("lastOk: '2026-10-04'", "lastOk: '2026-10-05'");

const SHARED_EXCEPTIONS_YML = `# The shared policy tier: never written by the runner, never by an agent.
- id: maintenance_window
  when: { allText: ["Maintenance"] }
  do: { blocked: "UAT is down" }
`;

let root;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-supervise-')));
  write(root, 'reflex.workspace.json', `${JSON.stringify({ name: 't', apps: { app1: { android: { package: 'p.app1' } } } }, null, 2)}\n`);
  write(root, path.join('screens', 'app1', 'core', 'home', 'screen.md'), SCREEN_MD);
  write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), NORMAL_YML);
  write(root, path.join('screens', '_shared', 'exceptions.yml'), SHARED_EXCEPTIONS_YML);
  workspace.reset();
  workspace.setOverride(root);
});

afterEach(() => {
  workspace.reset();
  fs.rmSync(root, { recursive: true, force: true });
});

function write(target, relative, contents) {
  const file = path.join(target, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function read(target, relative) {
  return fs.readFileSync(path.join(target, relative), 'utf8');
}

function readJson(target, relative) {
  return JSON.parse(read(target, relative));
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

function reportDirOf(runId) {
  return path.join(root, 'reports', runId);
}

/** What a stopped run leaves in `reports/<runId>/`: the report dir and its resume.json. */
function stopScript({ runId = 'r-stop', legIndex = 1 } = {}) {
  const reportDir = reportDirOf(runId);
  fs.mkdirSync(reportDir, { recursive: true });
  const resume = {
    runId,
    appKey: 'app1',
    plan: path.join(root, PLAN),
    planName: 'supervise_fixture',
    platform: 'android',
    serial: 'emu',
    legIndex,
    leg: { at: 'core/home', to: 'core/x', intent: 'Walk to the next screen' },
    screen: 'core/home',
    reason: 'no_jev',
    error: 'no route from core/home to core/x',
    visibleText: ['Home', 'NEXT'],
    sensitive: { remaining: [], blocksAgent: false },
  };
  fs.writeFileSync(path.join(reportDir, 'resume.json'), `${JSON.stringify(resume, null, 2)}\n`);
  return { summary: { runId, status: 'needs_agent', reportDir, resume: path.join(reportDir, 'resume.json') }, exitCode: 3 };
}

/** What a finished run leaves: a report dir, no stop. */
function passScript(runId = 'r-pass') {
  const reportDir = reportDirOf(runId);
  fs.mkdirSync(reportDir, { recursive: true });
  return { summary: { runId, status: 'pass', reportDir }, exitCode: 0 };
}

/**
 * The three stubs of the supervisor, all recording what they were given.
 * `agent` may edit files under `root` and returns `{ code, timedOut }`; `resumes` scripts resumeRun.
 */
function makeDeps({ run, resumes = [], agent = null }) {
  const calls = { run: [], resume: [], agent: [] };
  let resumeIndex = 0;
  return {
    calls,
    deps: {
      runPlan: async (options) => {
        calls.run.push(options);
        return typeof run === 'function' ? run(options, calls.run.length - 1) : run;
      },
      resumeRun: async (runId, options) => {
        calls.resume.push({ runId, options });
        const scripted = typeof resumes === 'function' ? resumes(calls.resume.length - 1) : resumes[Math.min(resumeIndex, resumes.length - 1)];
        resumeIndex += 1;
        return scripted;
      },
      runAgent: agent ? async (command, env, options) => {
        calls.agent.push({ command, env, options });
        return agent(calls.agent.length - 1, { command, env, options });
      } : undefined,
      now: NOW,
    },
  };
}

/** The common case: the agent fixes the knowledge and the resume passes, so edits wait for a human. */
async function fixedThenPassed(runId, { agent } = {}) {
  const stop = stopScript({ runId });
  const { calls, deps } = makeDeps({
    run: stop,
    resumes: [passScript(runId)],
    agent: agent || (() => {
      write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), FIXED_NORMAL_YML);
      return { code: 0, timedOut: false };
    }),
  });
  const result = await superviseRun({ planPath: PLAN, agentCmd: 'the-agent', deps });
  return { result, calls, deps, reportDir: reportDirOf(runId) };
}

function cli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, REFLEX_PROJECT_DIR: root } });
  const markers = result.stdout.split('\n').filter((line) => line.startsWith('REFLEX_JSON '));
  return {
    code: result.status,
    markers,
    marker: markers.length ? JSON.parse(markers[markers.length - 1].slice('REFLEX_JSON '.length)) : null,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test('a run that passes ends as finished with nothing pending', async () => {
  const { calls, deps } = makeDeps({ run: passScript('r-pass') });

  const result = await superviseRun({ planPath: PLAN, agentCmd: 'the-agent', deps });

  assert.equal(result.state, 'finished');
  assert.equal(result.exitCode, 0);
  assert.equal(result.runId, 'r-pass');
  assert.equal(result.runStatus, 'pass');
  assert.equal(result.rounds, 0);
  assert.deepEqual(result.changed, []);
  assert.equal(result.reportDir, reportDirOf('r-pass'));
  // A run that never stopped needs no handover and no snapshot.
  assert.equal(fs.existsSync(path.join(reportDirOf('r-pass'), 'knowledge-before')), false);
  assert.equal(fs.existsSync(path.join(reportDirOf('r-pass'), 'handoff.md')), false);
  assert.equal(fs.existsSync(path.join(reportDirOf('r-pass'), 'handoff.json')), false);
  assert.deepEqual(readJson(reportDirOf('r-pass'), 'supervisor.json'), {
    v: 1,
    runId: 'r-pass',
    state: 'finished',
    runStatus: 'pass',
    rounds: 0,
    changed: [],
    startedAt: new Date(NOW()).toISOString(),
    approvedAt: null,
    rejectedAt: null,
  });
  assert.equal(calls.run.length, 1);
  assert.equal(calls.run[0].planPath, PLAN);
  assert.equal(calls.run[0].actor, 'human');
  assert.deepEqual(calls.agent, []);
  assert.deepEqual(calls.resume, []);
});

test('a stop with no agent command writes the handoff, takes the snapshot and waits for an agent', async () => {
  const { calls, deps } = makeDeps({ run: stopScript({ runId: 'r-hold' }) });

  const result = await superviseRun({ planPath: PLAN, deps });

  assert.equal(result.state, 'awaiting_agent');
  assert.equal(result.exitCode, 3, 'the exit code of a stopped run is the one of the run');
  assert.equal(result.runId, 'r-hold');
  assert.equal(result.rounds, 0);
  assert.deepEqual(result.changed, []);
  const reportDir = reportDirOf('r-hold');
  assert.equal(readJson(reportDir, 'handoff.json').runId, 'r-hold');
  assert.ok(read(reportDir, 'handoff.md').includes('r-hold'), read(reportDir, 'handoff.md'));
  assert.ok(fs.existsSync(path.join(reportDir, 'knowledge-before', 'app1', 'core', 'home', 'screen.md')), 'the snapshot is taken before any agent edits');
  assert.ok(fs.existsSync(path.join(reportDir, 'knowledge-before', '_shared', 'exceptions.yml')));
  assert.equal(readJson(reportDir, 'supervisor.json').state, 'awaiting_agent');
  assert.deepEqual(calls.agent, [], 'there was no agent command, so no agent ran');
  assert.deepEqual(calls.resume, []);
});

test('the agent edits the knowledge and the resumed run passes: awaiting_approval with the diff kept', async () => {
  const { result, calls, reportDir } = await fixedThenPassed('r-fix');

  assert.equal(result.state, 'awaiting_approval');
  assert.equal(result.runStatus, 'pass');
  assert.equal(result.exitCode, 0);
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.changed, [{ file: 'screens/app1/core/home/normal.yml', kind: 'modified', forbidden: false }]);
  assert.ok(read(reportDir, 'knowledge-diff.md').includes('+++ after/screens/app1/core/home/normal.yml'), read(reportDir, 'knowledge-diff.md'));
  assert.ok(read(reportDir, 'knowledge-diff.md').includes('reflex supervise approve <runId>'));
  // The knowledge is still provisional: the snapshot that would undo it is on disk.
  assert.ok(fs.existsSync(path.join(reportDir, 'knowledge-before', 'app1', 'core', 'home', 'normal.yml')));
  assert.equal(readJson(reportDir, 'supervisor.json').state, 'awaiting_approval');

  assert.equal(calls.resume.length, 1);
  assert.deepEqual(calls.resume[0], { runId: 'r-fix', options: { actor: 'human' } });
  assert.equal(calls.agent.length, 1);
  const agentCall = calls.agent[0];
  assert.equal(agentCall.command, 'the-agent');
  assert.equal(agentCall.options.cwd, root, 'the agent works in the workspace root');
  assert.ok(Number.isFinite(agentCall.options.timeoutMs) && agentCall.options.timeoutMs > 0, String(agentCall.options.timeoutMs));
  assert.equal(fs.existsSync(agentCall.env.REFLEX_HANDOFF), true, 'REFLEX_HANDOFF names a file that exists');
  assert.equal(agentCall.env.REFLEX_RUN_ID, 'r-fix');
  assert.equal(agentCall.env.REFLEX_REPORT_DIR, reportDir);
});

test('an agent that touches the shared policy tier loses every edit of the round', async () => {
  const before = {
    app1: mapOf(path.join(root, 'screens', 'app1')),
    shared: mapOf(path.join(root, 'screens', '_shared')),
  };
  const { calls, deps } = makeDeps({
    run: stopScript({ runId: 'r-forbidden' }),
    resumes: [passScript('r-forbidden')],
    agent: () => {
      write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), FIXED_NORMAL_YML);
      write(root, path.join('screens', 'app1', 'core', 'home', 'extra.md'), '# a hop the agent added\n');
      write(root, path.join('screens', '_shared', 'exceptions.yml'), '# policy the agent tried to change\n');
      return { code: 0, timedOut: false };
    },
  });

  const result = await superviseRun({ planPath: PLAN, agentCmd: 'the-agent', deps });

  assert.equal(result.state, 'rejected_forbidden');
  assert.equal(result.exitCode, 1, 'a forbidden edit is a failure, whatever the run says');
  assert.deepEqual(result.changed, []);
  assert.deepEqual(mapOf(path.join(root, 'screens', 'app1')), before.app1, 'the app tier is back byte for byte');
  assert.deepEqual(mapOf(path.join(root, 'screens', '_shared')), before.shared);
  assert.equal(fs.existsSync(path.join(root, 'screens', 'app1', 'core', 'home', 'extra.md')), false);
  assert.deepEqual(calls.resume, [], 'a run is never resumed after a forbidden edit');
  assert.equal(readJson(reportDirOf('r-forbidden'), 'supervisor.json').state, 'rejected_forbidden');
});

test('three dead ends of the agent end the loop: it changed nothing, it failed, it timed out', async () => {
  const silent = await superviseRun({
    planPath: PLAN,
    agentCmd: 'the-agent',
    deps: makeDeps({ run: stopScript({ runId: 'r-silent' }), resumes: [passScript('r-silent')], agent: () => ({ code: 0, timedOut: false }) }).deps,
  });
  assert.equal(silent.state, 'no_change');
  assert.equal(silent.exitCode, 3);

  const failedRun = makeDeps({ run: stopScript({ runId: 'r-fail' }), resumes: [passScript('r-fail')], agent: () => ({ code: 2, timedOut: false }) });
  const failed = await superviseRun({ planPath: PLAN, agentCmd: 'the-agent', deps: failedRun.deps });
  assert.equal(failed.state, 'agent_failed');
  assert.equal(failed.exitCode, 1);
  assert.deepEqual(failedRun.calls.resume, [], 'a failed agent is never resumed');

  const slowRun = makeDeps({ run: stopScript({ runId: 'r-slow' }), resumes: [passScript('r-slow')], agent: () => ({ code: null, timedOut: true }) });
  const slow = await superviseRun({ planPath: PLAN, agentCmd: 'the-agent', deps: slowRun.deps });
  assert.equal(slow.state, 'agent_timeout');
  assert.equal(slow.exitCode, 1);
  assert.deepEqual(slowRun.calls.resume, []);
});

test('the loop is bounded by maxRounds, and --no-resume stops after the first edit', async () => {
  const loop = makeDeps({
    run: stopScript({ runId: 'r-loop' }),
    resumes: () => stopScript({ runId: 'r-loop' }),
    agent: (index) => {
      write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), `${FIXED_NORMAL_YML}\n- to: core/y\n  intent: "round ${index}"\n`);
      return { code: 0, timedOut: false };
    },
  });

  const result = await superviseRun({ planPath: PLAN, agentCmd: 'the-agent', maxRounds: 2, deps: loop.deps });

  assert.equal(result.state, 'max_rounds');
  assert.equal(result.rounds, 2);
  assert.equal(loop.calls.agent.length, 2, 'the agent runs once per round, never more');
  assert.equal(loop.calls.resume.length, 2, 'each round resumes once');
  // One snapshot for the whole run: everything the agent wrote across rounds is reversible.
  assert.ok(fs.existsSync(path.join(reportDirOf('r-loop'), 'knowledge-before', 'app1', 'core', 'home', 'normal.yml')));

  const held = makeDeps({
    run: stopScript({ runId: 'r-held' }),
    resumes: [passScript('r-held')],
    agent: () => {
      write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), FIXED_NORMAL_YML);
      return { code: 0, timedOut: false };
    },
  });

  const waiting = await superviseRun({ planPath: PLAN, agentCmd: 'the-agent', resume: false, deps: held.deps });

  assert.equal(waiting.state, 'awaiting_approval');
  assert.equal(waiting.rounds, 1);
  assert.deepEqual(held.calls.resume, [], 'the run waits for the human instead of resuming');
  assert.deepEqual(waiting.changed, [{ file: 'screens/app1/core/home/normal.yml', kind: 'modified', forbidden: false }]);
});

test('approve keeps the edits, drops the snapshot and cannot be done twice', async () => {
  const { reportDir } = await fixedThenPassed('r-approve');

  const approved = approveRun('r-approve', { now: LATER });

  assert.equal(approved.state, 'approved');
  assert.equal(approved.approvedAt, new Date(LATER()).toISOString());
  assert.equal(approved.runId, 'r-approve');
  assert.equal(fs.existsSync(path.join(reportDir, 'knowledge-before')), false, 'an approved run no longer has anything to undo');
  assert.equal(read(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml')), FIXED_NORMAL_YML, 'the edit is kept');
  assert.equal(readJson(reportDir, 'supervisor.json').state, 'approved');
  assert.equal(statusRun('r-approve').state, 'approved');

  assert.throws(() => approveRun('r-approve'), { message: 'run "r-approve" is "approved", not awaiting_approval' });
  assert.throws(() => approveRun('r-nope'), { message: 'no supervisor state for run "r-nope"' });
});

test('reject restores the knowledge byte for byte and removes what the agent added', async () => {
  const { reportDir } = await fixedThenPassed('r-reject', {
    agent: () => {
      write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), FIXED_NORMAL_YML);
      write(root, path.join('screens', 'app1', 'core', 'home', 'extra.md'), '# a hop the agent added\n');
      return { code: 0, timedOut: false };
    },
  });

  const rejected = rejectRun('r-reject', { now: LATER });

  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.rejectedAt, new Date(LATER()).toISOString());
  assert.deepEqual(rejected.changed, []);
  assert.equal(fs.existsSync(path.join(reportDir, 'knowledge-before')), false);
  assert.equal(read(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml')), NORMAL_YML, 'the edited file is back byte for byte');
  assert.equal(fs.existsSync(path.join(root, 'screens', 'app1', 'core', 'home', 'extra.md')), false, 'the added file is gone');
  assert.equal(readJson(reportDir, 'supervisor.json').state, 'rejected');
  assert.equal(statusRun('r-reject').state, 'rejected');

  assert.throws(() => rejectRun('r-reject'), { message: 'run "r-reject" has no knowledge snapshot to restore (state: rejected)' });
});

test('actor: agent reaches runPlan and resumeRun, so the guards of T2 apply', async () => {
  const { calls, deps } = makeDeps({
    run: stopScript({ runId: 'r-actor' }),
    resumes: [passScript('r-actor')],
    agent: () => {
      write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), FIXED_NORMAL_YML);
      return { code: 0, timedOut: false };
    },
  });

  const result = await superviseRun({ planPath: PLAN, agentCmd: 'the-agent', actor: 'agent', deps });

  assert.equal(calls.run[0].actor, 'agent');
  assert.deepEqual(calls.resume[0], { runId: 'r-actor', options: { actor: 'agent' } });
  assert.equal(result.state, 'awaiting_approval');
});

test('scrubEnv keeps only the allowed names, the ones --agent-env names, and the handoff variables', () => {
  const dirty = {
    PATH: '/usr/bin',
    HOME: '/home/tester',
    REFLEX_TEST_PASSWORD: 'TOPSECRET',
    REFLEX_TEST_PIN: 'TOPSECRET',
    TYPESAFE_API_KEY: 'TOPSECRET',
    BYPASS_LOGIN_OTP_TOKEN: 'TOPSECRET',
    ANTHROPIC_API_KEY: 'TOPSECRET',
    ANDROID_SERIAL: 'emu-5554',
  };

  const clean = scrubEnv(dirty, { extra: { REFLEX_RUN_ID: 'r-scrub' } });

  assert.deepEqual(Object.keys(clean).sort(), ['ANDROID_SERIAL', 'HOME', 'PATH', 'REFLEX_RUN_ID']);
  assert.equal(clean.ANDROID_SERIAL, 'emu-5554');
  assert.deepEqual(scrubEnv(null), {}, 'no environment at all is still no crash');

  const allowed = scrubEnv(dirty, { keep: ['ANTHROPIC_API_KEY'] });
  assert.equal(allowed.ANTHROPIC_API_KEY, 'TOPSECRET', 'a key reaches the agent only when a human names it');

  for (const name of AGENT_ENV_ALLOW) {
    assert.ok(!/PASSWORD|PIN|OTP|TOKEN|SECRET|KEY/i.test(name), `${name} must never be in the allow list`);
  }
});

test('the default agent runner is a real process that cannot read the human secrets, and can time out', async () => {
  const snapshot = `require('fs').writeFileSync(process.env.REFLEX_REPORT_DIR + '/env.txt', JSON.stringify({ secret: process.env.REFLEX_TEST_PASSWORD || null, handoff: !!process.env.REFLEX_HANDOFF }))`;
  const previous = process.env.REFLEX_TEST_PASSWORD;
  process.env.REFLEX_TEST_PASSWORD = 'TOPSECRET';
  try {
    // No `agent` stub: this test must go through the real default runner.
    const { deps } = makeDeps({ run: stopScript({ runId: 'r-real' }), resumes: [passScript('r-real')] });

    const result = await superviseRun({
      planPath: PLAN,
      agentCmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(snapshot)}`,
      deps,
    });

    // The agent only wrote env.txt into the report folder, never into the knowledge: nothing to approve.
    assert.equal(result.state, 'no_change');
    const seen = readJson(reportDirOf('r-real'), 'env.txt');
    assert.equal(seen.secret, null, 'the agent process never inherits the human credential');
    assert.equal(seen.handoff, true, 'it does get the handoff document');
    // The agent printed nothing above: its stdout goes to fd 2, so this process' stdout is still clean.

    const stalled = makeDeps({ run: stopScript({ runId: 'r-stall' }), resumes: [passScript('r-stall')] });
    const timedOut = await superviseRun({
      planPath: PLAN,
      agentCmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setTimeout(() => {}, 5000)')}`,
      agentTimeoutMs: 300,
      deps: stalled.deps,
    });

    assert.equal(timedOut.state, 'agent_timeout');
    assert.equal(timedOut.exitCode, 1);
    assert.deepEqual(stalled.calls.resume, []);
  } finally {
    if (previous === undefined) delete process.env.REFLEX_TEST_PASSWORD;
    else process.env.REFLEX_TEST_PASSWORD = previous;
  }
});

test('CLI: supervise status reports the state file, approve without a runId is an error', () => {
  const reportDir = reportDirOf('r-cli');
  fs.mkdirSync(reportDir, { recursive: true });
  write(reportDir, 'supervisor.json', `${JSON.stringify({
    v: 1,
    runId: 'r-cli',
    state: 'awaiting_approval',
    runStatus: 'pass',
    rounds: 1,
    changed: [],
    startedAt: new Date(NOW()).toISOString(),
    approvedAt: null,
    rejectedAt: null,
  }, null, 2)}\n`);

  const status = cli(['supervise', 'status', 'r-cli', '--json', '--workspace', root]);

  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.markers.length, 1, status.stdout);
  assert.equal(status.marker.ok, true);
  assert.equal(status.marker.runId, 'r-cli');
  assert.equal(status.marker.state, 'awaiting_approval');

  const missing = cli(['supervise', 'approve', '--json', '--workspace', root]);

  assert.equal(missing.code, 1, missing.stderr);
  assert.equal(missing.marker.error, 'supervise approve requires a runId');
});
