/**
 * superviseRetry.test.js — `reflex supervise`: the bounded retry of a resume that hit the
 * agent-device daemon timeout.
 *
 * No device and no real run: `runPlan`, `resumeRun`, `runAgent` and `sleep` are stubbed, so every
 * timeout of the scripted daemon can be timed exactly. The retry only wraps resumes, and only for
 * that one error, a bounded number of times, after a pause: a timeout is an environment hiccup, not
 * a verdict about the knowledge.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const workspace = require('../../src/util/workspace');
const { superviseRun } = require('../../src/supervisor/supervise');

const PLAN = 'plans/example/run.plan.md';
const NOW = () => Date.parse('2026-10-05T10:00:00Z');
/** The default pause between two resume attempts. */
const DEFAULT_DELAY_MS = 15000;

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

/** Several scenarios share one temp workspace: put the knowledge back so the next agent edit is a real change again. */
const resetKnowledge = () => write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), NORMAL_YML);

const SHARED_EXCEPTIONS_YML = `# The shared policy tier: never written by the runner, never by an agent.
- id: maintenance_window
  when: { allText: ["Maintenance"] }
  do: { blocked: "UAT is down" }
`;

let root;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-supervise-retry-')));
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

function readJson(target, relative) {
  return JSON.parse(fs.readFileSync(path.join(target, relative), 'utf8'));
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

/** The agent-device daemon gave up on the request of the run it started. No report dir: nothing was written. */
function daemonTimeout(runId, error = 'Daemon request timed out') {
  return { exitCode: 1, summary: { runId, status: 'error', error } };
}

/** A resume that stopped for an agent again, whatever it says in `error`: a stop is not a failure. */
function stoppedAgain(runId, error) {
  const reportDir = reportDirOf(runId);
  fs.mkdirSync(reportDir, { recursive: true });
  if (!fs.existsSync(path.join(reportDir, 'resume.json'))) stopScript({ runId });
  return { summary: { runId, status: 'needs_agent', error, reportDir, resume: path.join(reportDir, 'resume.json') }, exitCode: 3 };
}

/**
 * The three stubs of the supervisor, all recording what they were given, plus the sleep: it records
 * the delays instead of waiting them out, so a 15 second pause costs nothing in a test.
 * `agent` may edit files under `root` and returns `{ code, timedOut }`; `resumes` scripts resumeRun.
 */
function makeDeps({ run, resumes = [], agent = null }) {
  const calls = { run: [], resume: [], agent: [], sleep: [] };
  return {
    calls,
    deps: {
      runPlan: async (options) => {
        calls.run.push(options);
        return typeof run === 'function' ? run(options, calls.run.length - 1) : run;
      },
      resumeRun: async (runId, options) => {
        calls.resume.push({ runId, options });
        return typeof resumes === 'function' ? resumes(calls.resume.length - 1) : resumes[Math.min(calls.resume.length - 1, resumes.length - 1)];
      },
      runAgent: agent ? async (command, env, options) => {
        calls.agent.push({ command, env, options });
        return agent(calls.agent.length - 1, { command, env, options });
      } : undefined,
      now: NOW,
      sleep: async (ms) => {
        calls.sleep.push(ms);
      },
    },
  };
}

/** The common case: the agent fixes the knowledge, so the loop resumes and the retries are about the daemon. */
async function stoppedThenFixed(runId, resumes, options = {}) {
  const { calls, deps } = makeDeps({
    run: stopScript({ runId }),
    resumes,
    agent: () => {
      write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), FIXED_NORMAL_YML);
      return { code: 0, timedOut: false };
    },
  });
  const result = await superviseRun({ planPath: PLAN, agentCmd: 'the-agent', deps, ...options });
  return { result, calls };
}

test('one daemon timeout then a pass: the resume is retried once, after the default 15 second pause', async () => {
  const runId = 'r-retry-once';
  const { calls, deps } = makeDeps({
    run: stopScript({ runId }),
    resumes: [daemonTimeout(runId), passScript(runId)],
    agent: () => {
      write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), FIXED_NORMAL_YML);
      return { code: 0, timedOut: false };
    },
  });

  const result = await superviseRun({ planPath: PLAN, agentCmd: 'the-agent', deps });

  assert.equal(result.runStatus, 'pass', 'the retry got a real answer out of the daemon');
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, 'awaiting_approval', 'the agent changed the knowledge, so the edit waits for a human');
  assert.deepEqual(result.changed, [{ file: 'screens/app1/core/home/normal.yml', kind: 'modified', forbidden: false }]);
  assert.equal(result.rounds, 1);
  assert.equal(calls.resume.length, 2, 'the timeout is retried once');
  assert.deepEqual(calls.resume[1], { runId, options: { actor: 'human' } }, 'the retry resumes the same run with the same options');
  assert.deepEqual(calls.sleep, [DEFAULT_DELAY_MS], 'one pause, the default resumeRetryDelayMs, and no more');
  assert.equal(calls.agent.length, 1, 'the agent is never asked twice for one round');
});

test('two timeouts then a pass with the default two retries: three resumes and two pauses', async () => {
  const runId = 'r-retry-twice';
  const { calls, deps } = makeDeps({
    run: stopScript({ runId }),
    resumes: [daemonTimeout(runId), daemonTimeout(runId), passScript(runId)],
    agent: () => {
      write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), FIXED_NORMAL_YML);
      return { code: 0, timedOut: false };
    },
  });

  const result = await superviseRun({ planPath: PLAN, agentCmd: 'the-agent', deps });

  assert.equal(result.runStatus, 'pass');
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, 'awaiting_approval');
  assert.equal(calls.resume.length, 3, 'two retries on top of the first attempt');
  assert.deepEqual(calls.sleep, [DEFAULT_DELAY_MS, DEFAULT_DELAY_MS], 'a pause before each retry, never after the last attempt');
  assert.deepEqual(new Set(calls.resume.map((call) => call.runId)), new Set([runId]));
});

test('three timeouts with the default retries stop the loop: three resumes, then the run failed', async () => {
  const runId = 'r-retry-give-up';
  const { calls, deps } = makeDeps({
    run: stopScript({ runId }),
    resumes: () => daemonTimeout(runId),
    agent: () => {
      write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), FIXED_NORMAL_YML);
      return { code: 0, timedOut: false };
    },
  });

  const result = await superviseRun({ planPath: PLAN, agentCmd: 'the-agent', deps });

  assert.equal(calls.resume.length, 3, 'the retry is bounded: 1 attempt + 2 retries, never a fourth');
  assert.deepEqual(calls.sleep, [DEFAULT_DELAY_MS, DEFAULT_DELAY_MS]);
  assert.equal(calls.agent.length, 1, 'the round does not start over');
  assert.equal(result.runStatus, 'error', 'the last answer of the run is the one reported');
  assert.equal(result.exitCode, 1, 'a run that errored exits 1');
  assert.equal(result.state, 'awaiting_approval', 'the knowledge edit is still provisional after a failed resume');
  assert.deepEqual(result.changed, [{ file: 'screens/app1/core/home/normal.yml', kind: 'modified', forbidden: false }]);
  assert.equal(fs.existsSync(path.join(reportDirOf(runId), 'knowledge-before', 'app1', 'core', 'home', 'normal.yml')), true, 'the snapshot that would undo the edit is kept');
});

test('resumeRetries 0 resumes once without a pause, and custom retries and delay are honoured', async () => {
  const offRunId = 'r-retry-off';
  const off = await stoppedThenFixed(offRunId, [daemonTimeout(offRunId), passScript(offRunId)], { resumeRetries: 0 });

  assert.equal(off.calls.resume.length, 1, 'resumeRetries 0 is no retry at all');
  assert.deepEqual(off.calls.sleep, [], 'and no pause either');
  assert.equal(off.result.runStatus, 'error', 'with no retry the timeout is the final answer');
  assert.equal(off.result.exitCode, 1);

  resetKnowledge();
  const customRunId = 'r-retry-custom';
  const custom = makeDeps({
    run: stopScript({ runId: customRunId }),
    resumes: [daemonTimeout(customRunId), passScript(customRunId)],
    agent: () => {
      write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), FIXED_NORMAL_YML);
      return { code: 0, timedOut: false };
    },
  });

  const retried = await superviseRun({
    planPath: PLAN,
    agentCmd: 'the-agent',
    resumeRetries: 1,
    resumeRetryDelayMs: 7,
    deps: custom.deps,
  });

  assert.equal(retried.runStatus, 'pass');
  assert.equal(custom.calls.resume.length, 2, 'resumeRetries 1 allows exactly one retry');
  assert.deepEqual(custom.calls.sleep, [7], 'resumeRetryDelayMs 7 is the pause, not the default');

  resetKnowledge();
  const boundedRunId = 'r-retry-one-of-one';
  const bounded = makeDeps({
    run: stopScript({ runId: boundedRunId }),
    resumes: () => daemonTimeout(boundedRunId),
    agent: () => {
      write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), FIXED_NORMAL_YML);
      return { code: 0, timedOut: false };
    },
  });

  const stopped = await superviseRun({ planPath: PLAN, agentCmd: 'the-agent', resumeRetries: 1, resumeRetryDelayMs: 7, deps: bounded.deps });

  assert.equal(bounded.calls.resume.length, 2, 'one retry, even with the same timeout waiting behind it');
  assert.deepEqual(bounded.calls.sleep, [7]);
  assert.equal(stopped.runStatus, 'error');
  assert.equal(stopped.exitCode, 1);
});

test('only that exact daemon error is retried: another error is a verdict, the same words in another case are not', async () => {
  const otherRunId = 'r-not-a-timeout';
  const other = makeDeps({
    run: stopScript({ runId: otherRunId }),
    resumes: () => daemonTimeout(otherRunId, 'no such app'),
    agent: () => {
      write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), FIXED_NORMAL_YML);
      return { code: 0, timedOut: false };
    },
  });

  const failed = await superviseRun({ planPath: PLAN, agentCmd: 'the-agent', deps: other.deps });

  assert.equal(other.calls.resume.length, 1, 'only the daemon timeout is retried');
  assert.deepEqual(other.calls.sleep, []);
  assert.equal(failed.runStatus, 'error');
  assert.equal(failed.exitCode, 1);

  resetKnowledge();
  const caseRunId = 'r-timeout-case';
  const wrongCase = makeDeps({
    run: stopScript({ runId: caseRunId }),
    resumes: [daemonTimeout(caseRunId, 'daemon request TIMED OUT'), passScript(caseRunId)],
    agent: () => {
      write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), FIXED_NORMAL_YML);
      return { code: 0, timedOut: false };
    },
  });

  const recovered = await superviseRun({ planPath: PLAN, agentCmd: 'the-agent', deps: wrongCase.deps });

  assert.equal(wrongCase.calls.resume.length, 2, 'the match ignores the case of the error');
  assert.deepEqual(wrongCase.calls.sleep, [DEFAULT_DELAY_MS]);
  assert.equal(recovered.runStatus, 'pass');
  assert.equal(recovered.exitCode, 0);
});

test('a stop is never a timeout, and the retry never wraps the first run', async () => {
  const stopRunId = 'r-needs-agent';
  const stopped = makeDeps({
    run: stopScript({ runId: stopRunId }),
    resumes: (index) => (index === 0 ? stoppedAgain(stopRunId, 'Daemon request timed out') : passScript(stopRunId)),
    agent: () => {
      write(root, path.join('screens', 'app1', 'core', 'home', 'normal.yml'), FIXED_NORMAL_YML);
      return { code: 0, timedOut: false };
    },
  });

  const recovered = await superviseRun({ planPath: PLAN, agentCmd: 'the-agent', deps: stopped.deps });

  assert.deepEqual(stopped.calls.sleep, [], 'needs_agent is a stop, whatever its error says, so it is never retried');
  assert.equal(stopped.calls.resume.length, 2, 'the stop went through the loop and the next round, not through a retry');
  assert.equal(stopped.calls.agent.length, 2, 'the agent was asked again after the second stop');
  assert.equal(recovered.rounds, 2);
  assert.equal(recovered.runStatus, 'pass');
  assert.equal(recovered.state, 'awaiting_approval');

  const firstRunId = 'r-first-run-timeout';
  const firstRun = makeDeps({
    run: { exitCode: 1, summary: { runId: firstRunId, status: 'error', error: 'Daemon request timed out' } },
    resumes: [passScript(firstRunId)],
    agent: () => ({ code: 0, timedOut: false }),
  });

  const ended = await superviseRun({ planPath: PLAN, agentCmd: 'the-agent', deps: firstRun.deps });

  assert.deepEqual(firstRun.calls.resume, [], 'the retry wraps resumes only, the first run is the caller\'s');
  assert.deepEqual(firstRun.calls.sleep, []);
  assert.equal(ended.state, 'finished', 'nothing was changed and nothing stopped, so the run is over');
  assert.equal(ended.runStatus, 'error');
  assert.equal(ended.exitCode, 1);
});
