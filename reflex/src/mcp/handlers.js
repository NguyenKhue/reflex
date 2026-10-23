/**
 * handlers.js — the MCP tools as plain async functions (the transport lives in server.js).
 *
 * A run can take minutes and many MCP clients time out a tool call, so runs are asynchronous:
 * `run_start` / `resume_start` spawn a detached `reflex run|resume` and return its runId at
 * once; `run_status` reads `<reportDir>/status.json` and reports `crashed` when the process died
 * without finishing.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const workspace = require('../util/workspace');
const { contextShow, planValidate } = require('../cli/planCommands');
const { snapshot } = require('../cli/snapshot');
const { screenCapture, screenIdentify } = require('../cli/screenCommands');
const { loadPlan } = require('../plan/loader');
const { readStatus, writeStatus } = require('../runner/status');
const { newRunId } = require('../runner/run');
const { appKey } = require('../runner/app');
const { loadStore } = require('../screens/store');
const { planSensitivity } = require('../supervisor/sensitivity');

const BIN = path.join(__dirname, '..', '..', 'bin', 'reflex.js');
const LIVE_STATES = new Set(['starting', 'running']);

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function spawnDetached(args, reportDir, { spawnFn = spawn } = {}) {
  const logFile = path.join(reportDir, 'run.log');
  const fd = fs.openSync(logFile, 'a');
  const child = spawnFn(process.execPath, [BIN, ...args], {
    cwd: workspace.root(),
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, REFLEX_PROJECT_DIR: workspace.root() },
  });
  fs.closeSync(fd);
  child.unref();
  return child.pid;
}

function flagArgs({ caseId, serial, platform, screenshots, noJev, noLearn, jevThreshold, maxJevCalls }) {
  const args = [];
  if (caseId) args.push('--case', String(caseId));
  if (serial) args.push('--serial', String(serial));
  if (platform) args.push('--platform', String(platform));
  if (screenshots) args.push('--screenshots', String(screenshots));
  if (noJev) args.push('--no-jev');
  if (noLearn) args.push('--no-learn');
  if (jevThreshold !== undefined && jevThreshold !== null) args.push('--jev-threshold', String(jevThreshold));
  if (maxJevCalls) args.push('--max-jev-calls', String(maxJevCalls));
  return args;
}

async function runStart({ plan, case: caseId, serial, platform, screenshots, noJev, noLearn, jevThreshold, maxJevCalls }, options = {}) {
  if (!plan) throw new Error('run_start requires plan');
  const root = workspace.root();
  const file = path.isAbsolute(plan) ? plan : path.resolve(root, plan);
  const loaded = loadPlan(file, { root });
  // Every MCP caller is an agent: a plan that would enter credentials is refused here, before any
  // report directory exists, so the tool never leaves a half-started run behind.
  let store = null;
  try { store = loadStore(root, appKey(loaded)); } catch (_) { store = null; }
  const sensitivity = planSensitivity(loaded, store);
  if (sensitivity.sensitive) {
    const numbers = sensitivity.legs.map((leg) => leg.index + 1).join(', ');
    throw new Error(`requires_human: plan "${loaded.name}" has sensitive leg(s) ${numbers} that enter credentials; start it yourself or from CI: reflex run <plan file>`);
  }
  const runId = newRunId(loaded.name);
  const reportDir = path.join(workspace.reportsDir(), runId);
  fs.mkdirSync(reportDir, { recursive: true });
  writeStatus(reportDir, { runId, state: 'starting', plan: loaded.file });
  const pid = spawnDetached(['run', file, '--run-id', runId, '--json', '--agent', ...flagArgs({ caseId, serial, platform, screenshots, noJev, noLearn, jevThreshold, maxJevCalls })], reportDir, options);
  writeStatus(reportDir, { pid });
  return { runId, reportDir, pid, next: 'poll run_status with this runId' };
}

async function resumeStart({ runId, plan }, options = {}) {
  if (!runId) throw new Error('resume_start requires runId');
  const reportDir = path.join(workspace.reportsDir(), String(runId));
  if (!fs.existsSync(path.join(reportDir, 'resume.json'))) throw new Error(`run "${runId}" has no resume.json`);
  // The runner wrote which remaining legs enter credentials: an agent may not continue this run.
  const resume = JSON.parse(fs.readFileSync(path.join(reportDir, 'resume.json'), 'utf8'));
  if (resume.sensitive && resume.sensitive.blocksAgent) {
    const numbers = (resume.sensitive.remaining || []).map((leg) => leg.index + 1).join(', ');
    throw new Error(`requires_human: resuming run "${runId}" from leg ${resume.legIndex + 1} would run sensitive leg(s) ${numbers}; resume it yourself: reflex resume ${runId}`);
  }
  writeStatus(reportDir, { state: 'starting' });
  const pid = spawnDetached(['resume', String(runId), '--json', '--agent', ...(plan ? ['--plan', String(plan)] : [])], reportDir, options);
  writeStatus(reportDir, { pid });
  return { runId, reportDir, pid, next: 'poll run_status with this runId' };
}

async function runStatus({ runId }) {
  if (!runId) throw new Error('run_status requires runId');
  const reportDir = path.join(workspace.reportsDir(), String(runId));
  const status = readStatus(reportDir);
  if (!status) throw new Error(`no status for run "${runId}"`);
  let state = status.state;
  if (LIVE_STATES.has(state) && !alive(status.pid)) state = 'crashed';
  const out = { ...status, state };
  if (state === 'crashed' || state === 'error') {
    const logFile = path.join(reportDir, 'run.log');
    if (fs.existsSync(logFile)) out.logTail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-20).join('\n');
  }
  return out;
}

module.exports = {
  contextShow: async ({ app }) => {
    const shown = contextShow({ app });
    return shown;
  },
  planValidate: async ({ plan }) => planValidate({ plan }),
  snapshot: async ({ serial, platform, app }) => snapshot({ serial, platform, app }),
  screenCapture: async ({ as, app, serial }, options = {}) => screenCapture({ as, app, serial, ...options }),
  screenIdentify: async ({ app, serial }, options = {}) => screenIdentify({ app, serial, ...options }),
  runStart,
  resumeStart,
  runStatus,
};
