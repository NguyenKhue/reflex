/**
 * supervise.js — `reflex supervise`: run a plan, and when it stops for an agent, hand it over and keep the agent's knowledge edits provisional.
 *
 * It is meant to be started by a human or by CI: it may resume legs that enter credentials (the secrets come from THEIR environment),
 * and the agent it launches is given a scrubbed environment, so it can never read those secrets. The agent's edits to the app's knowledge are
 * snapshotted before it starts and diffed afterwards: a human approves them (`approve`) or throws them away (`reject`, a byte-for-byte restore).
 * Anything under `screens/_shared/` (policy) is forbidden: the whole change is restored on the spot.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const workspace = require('../util/workspace');
const { buildHandoff, writeHandoff } = require('./handoff');
const { snapshotKnowledge, diffKnowledge, restoreKnowledge } = require('./knowledgeSnapshot');
const { parseMarker } = require('../util/markers');

const SUPERVISOR_FILE = 'supervisor.json';
const SNAPSHOT_DIR = 'knowledge-before';
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
/** The only variables of the caller's environment an agent process inherits. */
const AGENT_ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'ANDROID_SERIAL', 'ANDROID_HOME', 'ANDROID_SDK_ROOT'];
const FAILING = new Set(['rejected_forbidden', 'agent_failed', 'agent_timeout', 'error_no_resume']);

const BIN = path.join(__dirname, '..', '..', 'bin', 'reflex.js');

/**
 * Runs and resumes happen in a CHILD process, like a human or CI would start them. In the same process a second run after a stop timed out on
 * the agent-device daemon (the client of the first run keeps its session and handles open): seen on an emulator on 2026-10-05, repeatable.
 */
function childArgs(kind, options = {}) {
  const args = kind === 'resume'
    ? ['resume', String(options.runId), ...(options.planPath ? ['--plan', String(options.planPath)] : [])]
    : ['run', String(options.planPath)];
  if (kind === 'run') {
    if (options.caseId) args.push('--case', String(options.caseId));
    if (options.platform) args.push('--platform', String(options.platform));
    if (options.serial) args.push('--serial', String(options.serial));
    if (options.udid) args.push('--udid', String(options.udid));
    if (options.app) args.push('--app', String(options.app));
    if (options.screenshots) args.push('--screenshots', String(options.screenshots));
    if (options.useJev === false) args.push('--no-jev');
    if (options.jevThreshold !== undefined && options.jevThreshold !== null) args.push('--jev-threshold', String(options.jevThreshold));
    if (options.learn === false) args.push('--no-learn');
    if (options.runId) args.push('--run-id', String(options.runId));
    if (options.maxJevCalls) args.push('--max-jev-calls', String(options.maxJevCalls));
  }
  if (options.actor === 'agent') args.push('--agent');
  args.push('--workspace', workspace.root());
  return args;
}

/** `{ summary, exitCode }` from the last REFLEX_JSON line of a child's stdout. */
function parseChildResult(stdout, status) {
  const lines = String(stdout || '').split('\n').filter(Boolean);
  let summary = null;
  for (let index = lines.length - 1; index >= 0 && !summary; index -= 1) summary = parseMarker(lines[index]);
  return {
    summary: summary || { status: 'error', error: 'the child process printed no REFLEX_JSON marker' },
    exitCode: Number.isInteger(status) ? status : 1,
  };
}

function runChild(kind, options) {
  const result = spawnSync(process.execPath, [BIN, ...childArgs(kind, options)], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 2], maxBuffer: 64 * 1024 * 1024,
  });
  return parseChildResult(result.stdout, result.status);
}

function scrubEnv(env, { keep = [], extra = {} } = {}) {
  const allowed = new Set([...AGENT_ENV_ALLOW, ...keep]);
  const out = {};
  for (const [name, value] of Object.entries(env || {})) {
    if (allowed.has(name) && value !== undefined) out[name] = value;
  }
  return { ...out, ...extra };
}

/** The agent's own output goes to stderr (fd 2): stdout stays the single REFLEX_JSON marker line. */
function runAgentDefault(command, env, { cwd, timeoutMs }) {
  const result = spawnSync('/bin/sh', ['-c', command], { cwd, env, timeout: timeoutMs, stdio: ['ignore', 2, 2] });
  return {
    code: result.status,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    error: result.error ? result.error.message : null,
  };
}

function isDaemonTimeout(outcome) {
  const summary = (outcome && outcome.summary) || {};
  return summary.status === 'error' && /Daemon request timed out/i.test(String(summary.error || ''));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeState(reportDir, state) {
  fs.writeFileSync(path.join(reportDir, SUPERVISOR_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

function diffMarkdown(runId, diff) {
  const lines = [
    `# Knowledge changes — run ${runId}`,
    '',
    'Provisional until a human approves (`reflex supervise approve <runId>`) or rejects (`reflex supervise reject <runId>`).',
    '',
  ];
  for (const item of diff.changed) lines.push(`- ${item.kind}: \`${item.file}\``);
  // Built, not written out: three backticks inside this block would end the markdown fence of the plan itself.
  const fence = '`'.repeat(3);
  lines.push('', `${fence}diff`, diff.diffText.trimEnd(), fence, '');
  return lines.join('\n');
}

async function superviseRun({
  planPath, runOptions = {}, agentCmd = null, agentEnvKeep = [], maxRounds = 2, resume = true,
  agentTimeoutMs = DEFAULT_AGENT_TIMEOUT_MS, actor = 'human', resumeRetries = 2, resumeRetryDelayMs = 15000, deps = {},
} = {}) {
  const runPlan = deps.runPlan || ((options) => runChild('run', options));
  const resumeRun = deps.resumeRun || ((runId, options) => runChild('resume', { ...options, runId }));
  const runAgent = deps.runAgent || runAgentDefault;
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  /**
   * agent-device's daemon can time out on the FIRST request of a process that starts soon after another reflex process (seen on an
   * Android 8.1 emulator on 2026-10-05: every other resume hung ~2.5 minutes, the next one worked). That is an environment hiccup, not a
   * verdict about the knowledge, so only that exact error is retried, a bounded number of times, after a pause.
   */
  const resumeWithRetry = async (runId, options) => {
    let outcome = await resumeRun(runId, options);
    for (let attempt = 0; attempt < resumeRetries && isDaemonTimeout(outcome); attempt += 1) {
      await sleep(resumeRetryDelayMs);
      outcome = await resumeRun(runId, options);
    }
    return outcome;
  };
  const root = workspace.root();

  let result = await runPlan({ ...runOptions, planPath, actor });
  let round = 0;
  let snapshotDir = null;
  let state = { v: 1, runId: null, state: 'running', runStatus: null, rounds: 0, changed: [], startedAt: new Date(now()).toISOString(), approvedAt: null, rejectedAt: null };

  const finish = (name) => {
    const summary = result.summary || {};
    state = { ...state, runId: summary.runId || state.runId, state: name, runStatus: summary.status || null, rounds: round };
    if (summary.reportDir) writeState(summary.reportDir, state);
    return { ...state, reportDir: summary.reportDir || null, exitCode: FAILING.has(name) ? 1 : result.exitCode };
  };

  for (;;) {
    const summary = result.summary || {};
    state.runId = summary.runId || state.runId;
    if (summary.status !== 'needs_agent') return finish(state.changed.length ? 'awaiting_approval' : 'finished');

    const reportDir = summary.reportDir;
    const resumeJson = readJson(summary.resume || path.join(reportDir, 'resume.json'));
    if (!resumeJson) return finish('error_no_resume');
    const app = resumeJson.appKey;
    // One snapshot per run, taken before the first agent edit: a rejection undoes every round, an approval keeps every round.
    if (!snapshotDir) snapshotDir = snapshotKnowledge(root, app, path.join(reportDir, SNAPSHOT_DIR));
    const files = writeHandoff(reportDir, buildHandoff({ resume: resumeJson, now: now() }));
    if (!agentCmd) return finish('awaiting_agent');
    if (round >= maxRounds) return finish('max_rounds');

    round += 1;
    const env = scrubEnv(process.env, {
      keep: agentEnvKeep,
      extra: { REFLEX_HANDOFF: files.markdownFile, REFLEX_RUN_ID: String(summary.runId), REFLEX_REPORT_DIR: reportDir },
    });
    const agentRun = await runAgent(agentCmd, env, { cwd: root, timeoutMs: agentTimeoutMs });
    if (agentRun.timedOut) return finish('agent_timeout');
    if (agentRun.code !== 0) return finish('agent_failed');

    const diff = diffKnowledge(root, app, snapshotDir);
    if (diff.forbidden.length) {
      restoreKnowledge(root, app, snapshotDir);
      state.changed = [];
      return finish('rejected_forbidden');
    }
    if (!diff.changed.length) return finish('no_change');
    state.changed = diff.changed;
    fs.writeFileSync(path.join(reportDir, 'knowledge-diff.md'), diffMarkdown(state.runId, diff));
    if (!resume) return finish('awaiting_approval');
    result = await resumeWithRetry(summary.runId, { actor });
  }
}

function stateOf(runId) {
  const reportDir = path.join(workspace.reportsDir(), String(runId));
  const state = readJson(path.join(reportDir, SUPERVISOR_FILE));
  if (!state) throw new Error(`no supervisor state for run "${runId}"`);
  return { reportDir, state };
}

function approveRun(runId, { now = Date.now } = {}) {
  const { reportDir, state } = stateOf(runId);
  if (state.state !== 'awaiting_approval') throw new Error(`run "${runId}" is "${state.state}", not awaiting_approval`);
  fs.rmSync(path.join(reportDir, SNAPSHOT_DIR), { recursive: true, force: true });
  const next = { ...state, state: 'approved', approvedAt: new Date(now()).toISOString() };
  writeState(reportDir, next);
  return next;
}

function rejectRun(runId, { now = Date.now } = {}) {
  const { reportDir, state } = stateOf(runId);
  const snapshotDir = path.join(reportDir, SNAPSHOT_DIR);
  if (!fs.existsSync(snapshotDir)) throw new Error(`run "${runId}" has no knowledge snapshot to restore (state: ${state.state})`);
  const resumeJson = readJson(path.join(reportDir, 'resume.json'));
  if (!resumeJson || !resumeJson.appKey) throw new Error(`run "${runId}" has no resume.json that names its app`);
  restoreKnowledge(workspace.root(), resumeJson.appKey, snapshotDir);
  fs.rmSync(snapshotDir, { recursive: true, force: true });
  const next = { ...state, state: 'rejected', changed: [], rejectedAt: new Date(now()).toISOString() };
  writeState(reportDir, next);
  return next;
}

/** The whole supervisor.json object (its `state` field is the state name). */
function statusRun(runId) {
  return stateOf(runId).state;
}

module.exports = { superviseRun, approveRun, rejectRun, statusRun, scrubEnv, AGENT_ENV_ALLOW, childArgs, parseChildResult };
