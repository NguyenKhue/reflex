/**
 * run.js — run a flow plan (every row, or one `--case`) on agent-device, or resume a run that
 * stopped with `needs_agent`.
 *
 * A plan is a chain of screen legs (`at → to`); `runLegs` walks them against the workspace's
 * `screens/` knowledge base, which is where the "how" lives. One device session serves every
 * row. `start.launch` decides what happens to the app before a row starts (`fresh` wipes it,
 * `relaunch` restarts it, `attach` leaves it alone); a resume always attaches, because the
 * whole point is that the stuck screen is still in front of the user.
 *
 * A `needs_agent` stop keeps that session alive (named by the runId) and writes `resume.json`
 * with the leg it stopped on, so the agent can fix the plan or the knowledge base and continue
 * without logging in again. Output contract: exactly one `REFLEX_JSON <json>` line on stdout;
 * progress on stderr. The caller (CLI) owns process.exit — the agent-device client keeps handles
 * open.
 */
const fs = require('fs');
const path = require('path');
const workspace = require('../util/workspace');
const { MARKER } = require('../util/markers');
const { loadPlan } = require('../plan/loader');
const { validatePlan } = require('../plan/validate');
const { resolveRowData } = require('../plan/data');
const { resolveApp, appKey } = require('./app');
const { executeChecklistRecipe, reportArgs } = require('./recipe');
const { runLegs } = require('./flow');
const { loadStore } = require('../screens/store');
const { createLearner, secretsOf, redactText } = require('../screens/learn');
const { flush } = require('../screens/writer');
const { writeStatus, stableHash } = require('./status');
const { jevThreshold } = require('../util/env');
const { visibleTexts, publicText } = require('../device/screenState');
const { planSensitivity, sensitiveLegsFrom } = require('../supervisor/sensitivity');

const SCREENSHOT_MODES = new Set(['all', 'fail', 'none']);
const DAEMON_IDLE_MS = '1800000';
/** The run status of a row: the worst one wins, in this order. */
const STATUS_ORDER = ['needs_agent', 'fail', 'blocked', 'pass'];

function log(message) {
  process.stderr.write(`[reflex] ${message}\n`);
}

function stamp(ms) {
  const d = new Date(ms);
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

function newRunId(planName, ms = Date.now()) {
  return `${planName}_${stamp(ms)}`;
}

function defaultDeps(deps = {}) {
  return {
    createBackend: deps.createBackend || ((opts) => require('../core/builtins').createDefaultRegistry().create('device', 'agent-device', opts)),
    // REFLEX_DECIDER=opencode swaps Jev for a free opencode model behind the same ask() shape; otherwise Jev when its key is set.
    createJev: deps.createJev || (() => {
      if (process.env.REFLEX_DECIDER === 'opencode') return require('../jev/opencodeClient').createOpencodeClient();
      return process.env.TYPESAFE_API_KEY ? require('../jev/jevClient').createJevClient() : null;
    }),
    // An OTP source exists only when the workspace names one (REFLEX_OTP_URL); otherwise fill_otp_from_api fails with a clear message.
    createSession: deps.createSession || ((opts) => require('../device/deviceTools').createDeviceSession({
      ...opts,
      otpProvider: opts.otpProvider || (process.env.REFLEX_OTP_URL ? require('../core/builtins').createDefaultRegistry().create('otp', 'http') : null),
    })),
    print: deps.print || ((line) => process.stdout.write(`${line}\n`)),
  };
}

function resolvePlanPath(planPath) {
  const raw = String(planPath || '');
  if (!raw) throw new Error('a plan path is required');
  const root = workspace.tryRoot();
  if (root && !path.isAbsolute(raw) && fs.existsSync(path.resolve(root, raw))) return path.resolve(root, raw);
  return path.resolve(raw);
}

function printMarker(summary, deps) {
  deps.print(`${MARKER} ${JSON.stringify(summary)}`);
}

/** Visible texts for resume.json: an editable node's label IS its value on Android, so skip those. */
function publicScreen(snapshot) {
  const safe = { ...snapshot, nodes: ((snapshot && snapshot.nodes) || []).filter((node) => !node.editable) };
  return visibleTexts(safe);
}

function levelCounts(entries) {
  const counts = { L0: 0, L1: 0, L2: 0, L3: 0 };
  for (const entry of entries) if (counts[entry.level] !== undefined) counts[entry.level] += 1;
  return counts;
}

/** The store is loaded once per run; a broken tree is a plan error, not a crash. */
function loadStoreFor(plan) {
  try {
    return { store: loadStore(workspace.root(), appKey(plan)) };
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

function worstStatus(statuses) {
  for (const status of STATUS_ORDER) if (statuses.includes(status)) return status;
  return 'pass';
}

function applyLaunch(backend, mode, package_) {
  if (mode === 'attach') return Promise.resolve();
  if (mode === 'fresh') {
    return backend.resetApp({ app: package_ }).then(() => backend.open({ app: package_, relaunch: false }));
  }
  return backend.open({ app: package_, relaunch: true });
}

/**
 * Values of the OTHER data rows, keyed by row id. Decision 3 of the design: Jev may not pick a
 * button whose label is another row's value (choosing "50.000đ" when the plan's data says
 * "100.000đ" would change the test data). Only labels are ever compared — a value never leaves
 * this process. Computed once per run, because a row that cannot resolve contributes nothing.
 */
function rowValuesOf(plan, rows, platform) {
  const values = new Map();
  for (const row of rows) {
    try {
      const resolved = Object.values(resolveRowData(plan, row, { workspace, platform }))
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => value.trim());
      values.set(row.id, resolved);
    } catch (_) { /* an unresolvable row cannot contribute labels */ }
  }
  return values;
}

/** Everything every OTHER row carries — what a press label may not be. */
function forbiddenFor(rowValues, rowId) {
  const forbidden = new Set();
  for (const [id, values] of rowValues) {
    if (String(id) === String(rowId)) continue;
    for (const value of values) forbidden.add(value);
  }
  return forbidden;
}

/** flow entries → the report's step shape (the report knows nothing about legs). */
function legEntries(plan, entries) {
  return entries.map((entry, index) => {
    const leg = plan.flow[entry.leg] || {};
    return {
      index,
      phase: 'legs',
      intent: `${leg.at || '?'} → ${leg.to || '?'}: ${entry.what || ''}`,
      tool: entry.action || entry.case || entry.rule || 'leg',
      level: entry.level,
      ok: entry.ok,
      duration_ms: entry.duration_ms || 0,
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.confidence === undefined ? {} : { confidence: entry.confidence }),
      ...(entry.warning ? { warning: true } : {}),
    };
  });
}

/** The plan's `verify` checklist → the report's step shape (phase `verify`, always L0). */
function verifyEntries(steps, offset) {
  return (steps || []).map((step, index) => ({
    index: offset + index,
    phase: 'verify',
    intent: `verify ${index + 1} (${step.tool})`,
    tool: step.tool,
    level: 'L0',
    ok: step.ok !== false,
    duration_ms: step.duration_ms || 0,
    ...(step.error ? { error: step.error } : {}),
  }));
}

function failureMessage(entry) {
  if (!entry) return 'leg failed';
  return entry.error || 'leg failed';
}

async function screenshotTo(session, name) {
  try {
    const shot = await session.screenshot({ name });
    return shot && shot.ok && shot.path ? shot.path : null;
  } catch (_) {
    return null;
  }
}

/**
 * Report entries with workspace-relative paths: the report must not depend on where the
 * workspace lives on this machine.
 */
function relativize(entries) {
  let root = null;
  try {
    root = workspace.root();
  } catch (_) {
    root = null;
  }
  return entries.map((entry) => ({
    ...entry,
    file: entry.file && root ? path.relative(root, entry.file) : entry.file,
  }));
}

/** What the run refused to learn, and why — reported even when the write itself failed. */
function knowledgeEvents(learners) {
  return relativize(learners.flatMap((learner) => learner.events()));
}

/**
 * Everything a run learned, and everything it refused to learn, for the report. The write itself
 * must never throw into the verdict: a knowledge file is an improvement, the run's result is the
 * contract.
 */
async function writeKnowledge(learners) {
  if (!learners.length) return [];
  const { applied, skipped } = await flush(learners.flatMap((learner) => learner.ops()));
  return relativize([...applied, ...skipped, ...knowledgeEvents(learners)]);
}

/**
 * Shared engine of runPlan and resumeRun.
 * `start` = { rowIndex, legIndex, captures } for a resume; `threshold` is the Jev confidence
 * gate (resolved before any session opens); `learn` is the per-row learner switch (`--no-learn`).
 */
async function execute({
  plan, store, rows, platform, target, runId, reportDir, screenshots, useJev, maxJevCalls, threshold, learn,
  serial, udid, deps, start = null, startedAt,
}) {
  const key = appKey(plan);
  const summary = {
    runId,
    plan: plan.name,
    planFile: plan.file,
    app: target.package,
    platform,
    device: null,
    status: 'error',
    total: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    duration_ms: 0,
    rows: [],
    jev: null,
    reportDir,
    report_path: null,
    resume: null,
    knowledge: [],
    ...(start ? { resumedFrom: { legIndex: start.legIndex, rowId: rows[start.rowIndex] && rows[start.rowIndex].id } } : {}),
  };
  const items = [];
  // One learner per row, flushed once after the last row: a row that stops for the agent must
  // still leave what it proved on disk for the resume to use.
  const learners = [];
  let backend = null;
  let keepSession = false;
  let jev = null;

  try {
    if (!process.env.AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS) process.env.AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS = DAEMON_IDLE_MS;
    backend = deps.createBackend({ platform, serial, udid, session: runId, appId: target.package });
    summary.device = backend.meta();
    jev = useJev ? deps.createJev() : null;
    const session = deps.createSession({ backend, jev, reportDir, appDefaults: { package: target.package, activity: target.activity } });
    // Checklist `screenshot` steps only touch the device in `all` mode; failure evidence uses `session`.
    const recipeSession = screenshots === 'all' ? session : { ...session, screenshot: async () => ({ ok: true, omitted: true }) };
    const budget = { jevCalls: 0, maxJevCalls };
    // One resolution per row, reused for every row's "do not press another row's value" set.
    const rowValues = rowValuesOf(plan, plan.rows, platform);

    if (start) {
      await backend.open({ app: target.package, relaunch: false });
      const snapshot = await backend.snapshot();
      const foreground = snapshot.appBundleId ? snapshot.appBundleId === target.package : snapshot.nodes.length > 0;
      if (!foreground) throw Object.assign(new Error('resume_lost_app: the app is no longer in the foreground — run the plan again'), { lostApp: true });
    }

    for (let rowIndex = start ? start.rowIndex : 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const rowStartedAt = Date.now();
      const resuming = start && rowIndex === start.rowIndex;
      const data = resolveRowData(plan, row, { workspace, platform });
      const inputKeys = new Set(Object.keys(data));
      if (resuming) Object.assign(data, start.captures || {});
      // `--no-learn` means exactly that: no learner, so nothing at all is written (not even stats).
      const learner = learn
        ? createLearner({
          store,
          runId,
          data,
          plan,
          inputNames: plan.inputs.map((input) => input.name),
          captureNames: Object.keys(data).filter((name) => !inputKeys.has(name)),
        })
        : null;
      if (learner) learners.push(learner);
      log(`── row ${row.id}${resuming ? ` (resume at leg ${start.legIndex + 1})` : ''} ──`);
      if (!resuming) await applyLaunch(backend, plan.start.launch, target.package);

      const values = forbiddenFor(rowValues, row.id);
      // Input values the app prints back (the phone on its login screens) never leave the process.
      const secrets = secretsOf(data, plan.inputs.map((input) => input.name), []);
      const redact = (text) => redactText(text, secrets);
      const ctx = {
        redact,
        session,
        recipeSession,
        backend,
        jev,
        store,
        plan,
        data,
        inputs: plan.inputs.map((input) => input.name),
        // Jev may not press a button that carries ANOTHER row's value.
        exclude: (action) => action.kind === 'press' && values.has(String(publicText(action.node) || '').trim()),
        threshold,
        budget,
        learner,
        onEntry: (entry) => {
          const mark = entry.ok ? '✓' : '✗';
          const leg = plan.flow[entry.leg] || {};
          log(`${mark} leg ${entry.leg + 1} [${entry.level}] ${leg.at || '?'} → ${leg.to || '?'}: ${entry.what || ''}${entry.error ? ` — ${entry.error}` : ''}`);
          writeStatus(reportDir, {
            state: 'running',
            row: row.id,
            leg: entry.leg,
            screen: entry.screen || null,
            level: entry.level,
            ok: entry.ok,
            what: entry.what || null,
          });
        },
      };

      const outcome = await runLegs(ctx, plan.flow, { startIndex: resuming ? start.legIndex : 0 });
      let entries = legEntries(plan, outcome.entries);
      const warnings = outcome.warnings || [];
      let rowStatus = outcome.status;
      // `verify` is the plan's own end-state assertion: deterministic tools only, never Jev.
      // A step that cannot even be interpolated (a field this row never defines) is a FAIL of
      // the assertion, exactly like a checklist step that threw.
      if (rowStatus === 'pass' && plan.verify.length) {
        const verifyStartedAt = Date.now();
        let verified;
        try {
          verified = await executeChecklistRecipe(recipeSession, plan.verify, data, { stepTimeoutMs: plan.options.stepTimeoutMs });
        } catch (error) {
          verified = {
            ok: false,
            steps: [{ index: 0, tool: plan.verify[0].tool, ok: false, duration_ms: Date.now() - verifyStartedAt, error: error.message || String(error) }],
          };
        }
        entries = entries.concat(verifyEntries(verified.steps, entries.length));
        if (!verified.ok) rowStatus = 'fail';
      }

      const artifacts = [];
      // The LAST failure is what stopped the row; earlier ones may have been recovered (a case that
      // failed before another case or Jev got through).
      const failed = [...entries].reverse().find((entry) => entry.ok === false && !entry.warning) || null;
      let error = null;
      if (rowStatus !== 'pass') {
        error = failed
          ? `${failed.phase} (${failed.intent}) ${rowStatus === 'needs_agent' ? 'needs the agent' : rowStatus === 'blocked' ? 'is blocked' : 'failed'}: ${failureMessage(failed)}`
          : 'leg failed';
        if (screenshots !== 'none') {
          const shot = await screenshotTo(session, rowStatus === 'needs_agent' ? 'stuck' : `failure_${String(row.id).replace(/[^A-Za-z0-9_-]+/g, '_')}`);
          if (shot) {
            artifacts.push(shot);
            if (failed) failed.screenshot = shot;
          }
        }
      }

      // Secret inputs (plan `secret: true`, password/pin/otp) and phone numbers never reach the report:
      // the Test Data table masks them, and a capture that echoes one (a recipient name inside
      // "recipient=…") shows the input name instead.
      const hidden = new Set([...plan.inputs.filter((input) => input.secret).map((input) => input.name),
        ...Object.keys(data).filter((name) => inputKeys.has(name) && /(password|pin|otp|phone)/i.test(name))]);
      const hideSecrets = (text) => redactText(text, secretsOf(data, [...hidden], []).filter((s) => hidden.has(s.name)));
      const reportData = Object.fromEntries(Object.entries(reportArgs(data)).map(([name, value]) => [name,
        hidden.has(name) ? '••••••' : inputKeys.has(name) ? value : hideSecrets(String(value))]));
      const captures = Object.fromEntries(Object.entries(reportData).filter(([name]) => !inputKeys.has(name)));
      items.push({
        id: row.id,
        flow: plan.name,
        status: rowStatus,
        error,
        duration_ms: Date.now() - rowStartedAt,
        data: reportData,
        captures,
        steps: entries,
        artifacts,
        levels: levelCounts(entries),
        warnings,
      });

      if (rowStatus === 'needs_agent') {
        const k = outcome.stoppedAt === null ? 0 : outcome.stoppedAt;
        const leg = plan.flow[k] || {};
        let screen = [];
        try {
          screen = publicScreen(await backend.snapshot()).map(redact);
        } catch (_) { /* evidence only */ }
        const identified = [...(outcome.entries || [])].reverse().find((entry) => entry.leg === k && entry.screen);
        const resume = {
          runId,
          plan: plan.file,
          planName: plan.name,
          prefixHash: stableHash(plan.flow.slice(0, k)),
          legIndex: k,
          leg: { at: leg.at || null, to: leg.to || null, intent: leg.intent || null },
          screen: identified ? identified.screen : null,
          rowId: row.id,
          rowIndex,
          rowIds: rows.map((item) => item.id),
          captures,
          error: failed ? failed.error : null,
          reason: outcome.reason || null,
          visibleText: screen,
          screenshot: artifacts[0] || null,
          platform,
          serial: serial || null,
          udid: udid || null,
          app: target,
          appKey: key,
          cwd: process.cwd(),
          screenshots,
          useJev,
          learn,
          jevThreshold: threshold,
          maxJevCalls,
          // Which remaining legs would enter credentials: it tells the agent whether IT may resume.
          sensitive: (() => {
            const remaining = sensitiveLegsFrom(plan, store || null, k);
            return { remaining, blocksAgent: remaining.length > 0 };
          })(),
          createdAt: new Date().toISOString(),
        };
        summary.resume = path.join(reportDir, 'resume.json');
        fs.writeFileSync(summary.resume, `${JSON.stringify(resume, null, 2)}\n`);
        keepSession = true;
        break; // later rows wait until the agent resolved this one
      }
    }

    summary.total = items.length;
    summary.passed = items.filter((item) => item.status === 'pass').length;
    summary.blocked = items.filter((item) => item.status === 'blocked').length;
    summary.failed = items.filter((item) => item.status !== 'pass' && item.status !== 'blocked').length;
    summary.status = worstStatus(items.map((item) => item.status));
  } catch (error) {
    summary.status = 'error';
    summary.error = error.message || String(error);
    log(`ERROR: ${summary.error}`);
  } finally {
    if (backend && !keepSession) {
      try { await backend.close(); } catch (_) { /* a dead session must not change the verdict */ }
    }
    // The write happens once, here: after the last row, also when a row failed, was blocked or
    // stopped for the agent. A failure to write is a warning — never a change of the verdict.
    try {
      summary.knowledge = await writeKnowledge(learners);
    } catch (error) {
      log(`warning: knowledge was not written: ${error.message || error}`);
      summary.knowledge = knowledgeEvents(learners);
    }
  }

  summary.rows = items.map((item) => ({
    id: item.id,
    status: item.status,
    error: item.error,
    levels: item.levels,
    ...(Object.keys(item.captures).length ? { captures: item.captures } : {}),
  }));
  summary.jev = jev ? jev.stats() : null;
  summary.duration_ms = Date.now() - startedAt;
  // The ledger is a convenience: a failure to write it must never change the verdict (same rule as the report and knowledge writes).
  try {
    require('../metrics/ledger').appendRun(workspace.root(), summary);
  } catch (error) {
    log(`warning: run ledger not written: ${error.message || error}`);
  }

  try {
    const { writeReport } = require('../report/report');
    summary.report_path = writeReport({ title: `${plan.name} (reflex)`, kind: 'spec', summary, items, reportDir, knowledge: summary.knowledge });
    log(`report: ${summary.report_path}`);
  } catch (error) {
    // A report failure must never turn a decided verdict into an error.
    log(`report generation failed: ${error.message}`);
  }

  const exitCode = summary.status === 'pass' ? 0 : (summary.status === 'needs_agent' ? 3 : 1);
  writeStatus(reportDir, { state: summary.status === 'needs_agent' ? 'needs_agent' : (summary.status === 'error' ? 'error' : 'done'), result: summary });
  printMarker(summary, deps);
  return { summary, exitCode };
}

function invalid(summary, deps) {
  printMarker(summary, deps);
  return { summary, exitCode: 1 };
}

async function runPlan({
  planPath, caseId, platform, serial, udid, app, screenshots = 'fail', useJev = true,
  runId, maxJevCalls = 30, jevThreshold: thresholdFlag, learn = true, deps = {}, actor = 'human',
} = {}) {
  const startedAt = Date.now();
  const resolvedDeps = defaultDeps(deps);
  // The gate has to be known before a session opens: an invalid one is a CLI error, not a run.
  let threshold;
  try {
    threshold = jevThreshold(thresholdFlag);
  } catch (error) {
    return invalid({ status: 'invalid', errors: [error.message], warnings: [] }, resolvedDeps);
  }
  let plan;
  try {
    plan = loadPlan(resolvePlanPath(planPath), { root: workspace.root() });
  } catch (error) {
    return invalid({ status: 'invalid', errors: [error.message], warnings: [] }, resolvedDeps);
  }
  const { store, error: storeError } = loadStoreFor(plan);
  const verdict = validatePlan(plan, { store: store || null });
  const errors = storeError ? [storeError, ...verdict.errors] : verdict.errors;
  for (const warning of verdict.warnings) log(`warning: ${warning}`);
  if (errors.length) {
    return invalid({ status: 'invalid', plan: plan.name, planFile: plan.file, errors, warnings: verdict.warnings }, resolvedDeps);
  }
  // An agent caller may never type a credential: refuse here, before any directory or session exists.
  if (actor === 'agent') {
    const sensitivity = planSensitivity(plan, store || null);
    if (sensitivity.sensitive) {
      const numbers = sensitivity.legs.map((leg) => leg.index + 1).join(', ');
      return invalid({
        status: 'refused',
        plan: plan.name,
        planFile: plan.file,
        error: `requires_human: plan "${plan.name}" has sensitive leg(s) ${numbers} that enter credentials; start it yourself or from CI: reflex run <plan file>`,
        sensitiveLegs: sensitivity.legs,
      }, resolvedDeps);
    }
  }
  if (!SCREENSHOT_MODES.has(screenshots)) return invalid({ status: 'invalid', errors: ['--screenshots must be all|fail|none'], warnings: [] }, resolvedDeps);

  let rows = plan.rows;
  if (caseId) {
    rows = rows.filter((row) => row.id === String(caseId));
    if (!rows.length) return invalid({ status: 'invalid', plan: plan.name, errors: [`plan has no row with id "${caseId}" (rows: ${plan.rows.map((row) => row.id).join(', ')})`], warnings: [] }, resolvedDeps);
  }
  const resolvedPlatform = String(platform || workspace.defaults().platform || 'android').toLowerCase();
  if (!plan.platforms.includes(resolvedPlatform)) {
    return invalid({ status: 'invalid', plan: plan.name, errors: [`plan does not support platform "${resolvedPlatform}"`], warnings: [] }, resolvedDeps);
  }
  let target;
  try {
    target = resolveApp(plan, { app }, resolvedPlatform);
  } catch (error) {
    return invalid({ status: 'invalid', plan: plan.name, errors: [error.message], warnings: [] }, resolvedDeps);
  }

  const id = runId || newRunId(plan.name, startedAt);
  const reportDir = path.join(workspace.reportsDir(), id);
  fs.mkdirSync(reportDir, { recursive: true });
  writeStatus(reportDir, { runId: id, state: 'running', pid: process.pid, plan: plan.file, startedAt: new Date(startedAt).toISOString() });
  log(`${plan.name} | legs=${plan.flow.length} | rows=${rows.length} | launch=${plan.start.launch} | platform=${resolvedPlatform} | app=${target.package} | run=${id}`);

  return execute({
    plan, store, rows, platform: resolvedPlatform, target, runId: id, reportDir, screenshots, useJev, maxJevCalls,
    threshold, learn, serial, udid, deps: resolvedDeps, startedAt,
  });
}

async function resumeRun(runId, { planPath, deps = {}, actor = 'human' } = {}) {
  const startedAt = Date.now();
  const resolvedDeps = defaultDeps(deps);
  const reportDir = path.join(workspace.reportsDir(), String(runId));
  const resumeFile = path.join(reportDir, 'resume.json');
  if (!fs.existsSync(resumeFile)) return invalid({ status: 'error', runId, error: `no resume.json for run "${runId}" (${resumeFile})` }, resolvedDeps);
  const resume = JSON.parse(fs.readFileSync(resumeFile, 'utf8'));

  let plan;
  try {
    plan = loadPlan(planPath ? resolvePlanPath(planPath) : resume.plan, { root: workspace.root() });
  } catch (error) {
    return invalid({ status: 'invalid', runId, errors: [error.message], warnings: [] }, resolvedDeps);
  }
  const { store, error: storeError } = loadStoreFor(plan);
  const verdict = validatePlan(plan, { store: store || null });
  const errors = storeError ? [storeError, ...verdict.errors] : verdict.errors;
  if (errors.length) return invalid({ status: 'invalid', runId, plan: plan.name, errors, warnings: verdict.warnings }, resolvedDeps);
  const k = resume.legIndex;
  if (stableHash(plan.flow.slice(0, k)) !== resume.prefixHash) {
    return invalid({ status: 'error', runId, error: `resume_prefix_changed: legs before ${k + 1} were edited — run the plan again` }, resolvedDeps);
  }
  if (k >= plan.flow.length) return invalid({ status: 'error', runId, error: `resume leg ${k + 1} no longer exists in the plan` }, resolvedDeps);
  // The rest of the run must not enter credentials for an agent caller; the refusal is total, so no
  // status is written and the run stays exactly where it stopped.
  if (actor === 'agent') {
    const sensitiveLegs = sensitiveLegsFrom(plan, store || null, k);
    if (sensitiveLegs.length) {
      const numbers = sensitiveLegs.map((leg) => leg.index + 1).join(', ');
      return invalid({
        status: 'refused',
        runId,
        plan: plan.name,
        error: `requires_human: resuming run "${runId}" from leg ${k + 1} would run sensitive leg(s) ${numbers}; resume it yourself: reflex resume ${runId}`,
        sensitiveLegs,
      }, resolvedDeps);
    }
  }
  // Only the rows the original run selected (a `--case` run stays a one-row run).
  const rows = Array.isArray(resume.rowIds) ? plan.rows.filter((row) => resume.rowIds.includes(row.id)) : plan.rows;
  const rowIndex = rows.findIndex((row) => row.id === resume.rowId);
  if (rowIndex < 0) return invalid({ status: 'error', runId, error: `row "${resume.rowId}" is no longer in the plan` }, resolvedDeps);
  if (resume.cwd && process.cwd() !== resume.cwd && fs.existsSync(resume.cwd)) {
    // agent-device scopes sessions to the caller's worktree: resume from where the run started.
    log(`warning: switching cwd to ${resume.cwd} (the run started there)`);
    process.chdir(resume.cwd);
  }
  // The threshold of the original run is part of its verdict, so a resume keeps it.
  const threshold = Number.isFinite(resume.jevThreshold) ? resume.jevThreshold : jevThreshold(undefined);
  writeStatus(reportDir, { state: 'running', pid: process.pid, resumedAt: new Date(startedAt).toISOString() });
  log(`${plan.name} | resume run=${runId} at leg ${k + 1} (row ${resume.rowId})`);

  return execute({
    plan,
    store,
    rows,
    platform: resume.platform,
    target: resume.app,
    runId: String(runId),
    reportDir,
    screenshots: resume.screenshots || 'fail',
    useJev: resume.useJev !== false,
    maxJevCalls: resume.maxJevCalls || 30,
    threshold,
    learn: resume.learn !== false,
    serial: resume.serial || undefined,
    udid: resume.udid || undefined,
    deps: resolvedDeps,
    start: { rowIndex, legIndex: k, captures: resume.captures || {} },
    startedAt,
  });
}

module.exports = { runPlan, resumeRun, newRunId, stamp };
