/**
 * flow.js — run a plan's flow one screen leg at a time: `at → to`.
 *
 * A leg is a state machine, not a script. Every turn it asks the same questions in the same
 * order — which screen is this? does a known exception rule apply? am I already at `to`? is
 * there a known one-hop case? — and only when all of them come up empty does it ask Jev, ONE
 * action at a time (the code re-identifies the screen after every action and keeps its own
 * repeat detection, so Jev's loop is not trusted for either).
 *
 * Two rules shape the details: a Jev "arrived" is only a claim (step 1 decides), and the leg's
 * `checks` are assertions — they run on the destination screen and NEVER escalate to Jev, so a
 * failing check stays a FAIL instead of being navigated away.
 *
 * Learning (phase 3) is reachable only through the optional `ctx.learner` hooks: `legStart`,
 * `legOwnSteps`, `visitStart`, `caseRan`, `caseOutcome`, `ruleOutcome`, `jevAction`, `verdict`,
 * `legPassed`, `legEnd`. The loop only reports what it saw (which screen, which case ran, which
 * action produced which screen); what that means for the knowledge base is the learner's job.
 * With `learner === null` this module is a pure reader: it writes no knowledge.
 */
const recipe = require('./recipe');
const { screenIndex, matchWhen } = require('../screens/match');
const { identifyScreen } = require('../screens/identify');
const { exceptionTiers, candidateScreens, casesFor, groupOf } = require('../screens/store');
const { askOnce } = require('../jev/resolver');
const { screenSignature } = require('../device/screenState');

const DEFAULTS = { legTimeoutMs: 60000, maxJevCallsPerLeg: 6, caseWaitMs: 10000, stepTimeoutMs: 120000, unknownGraceMs: 3000 };
const POLL_MS = 250;
const WAIT_MS = 800;
/** In-app back button, first one that exists; the system back button is the fallback. */
const BACK_TEXTS = ['‹', 'btn_navigation_back'];
const BACK_TIMEOUT_MS = 300;
const CONTEXT_MAX_CHARS = 2000;
const SNAPSHOT_ATTEMPTS = 3;
const SNAPSHOT_RETRY_MS = 400;
const ERROR_LIMIT = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function failureMessage(outcome) {
  const step = outcome && outcome.failed_step;
  if (step && step.error) return String(step.error);
  if (outcome && outcome.skipped) return 'step reported skipped';
  return 'step failed';
}

function optionsOf(plan) {
  return { ...DEFAULTS, ...((plan && plan.options) || {}) };
}

/** `0` is a meaningful budget ("no Jev", "no waiting"), so only a non-number falls back. */
function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Resolved input NAMES of the plan — never their values. */
function inputNames(ctx) {
  if (Array.isArray(ctx.inputs)) return ctx.inputs.slice();
  return ((ctx.plan && ctx.plan.inputs) || [])
    .map((input) => (typeof input === 'string' ? input : input && input.name))
    .filter(Boolean);
}

/**
 * Run one checklist with the leg's settle/skip rules. `executeChecklistRecipe` throws while
 * interpolating args that name a data field this row never defines — a broken step, which has
 * to become a failed outcome, not an exception that escapes the whole run.
 */
async function runRecipe(ctx, steps, stepTimeoutMs) {
  try {
    return await recipe.executeChecklistRecipe(ctx.recipeSession, recipe.autoSettle(steps), ctx.data, { stepTimeoutMs });
  } catch (error) {
    return { ok: false, failed_step: { error: error && error.message ? error.message : String(error) }, steps: [] };
  }
}

/** The context of the destination's group: its mini app's notes, or the app's for `core`. */
function contextOf(store, screenId) {
  const group = store.groups.get(groupOf(screenId));
  const context = (group && group.context) || store.appTier.context || null;
  return context ? String(context).trim().slice(0, CONTEXT_MAX_CHARS) : null;
}

/**
 * A snapshot that survives agent-device's transient failures: mid-transition the Android helper
 * can report "insufficient foreground app content" for a moment, which must not end the run.
 */
async function snapshotOf(ctx) {
  let lastError;
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      return await ctx.backend.snapshot();
    } catch (error) {
      lastError = error;
      await sleep(SNAPSHOT_RETRY_MS);
    }
  }
  throw lastError;
}

/** In-app back when the screen has a back button, otherwise the system back button. */
async function pressBack(ctx) {
  for (const text of BACK_TEXTS) {
    const result = await ctx.session.tap_text({ text, exact: true, timeout: BACK_TIMEOUT_MS });
    if (result && result.ok) return result;
  }
  return ctx.backend.back();
}

/**
 * Run one leg. Every exit gives the leg a status; `pass` is the only one that lets `runLegs`
 * continue to the next leg.
 */
async function runLeg(ctx, leg, legIndex, io) {
  const plan = ctx.plan || {};
  const options = optionsOf(plan);
  const legTimeoutMs = numberOr(options.legTimeoutMs, DEFAULTS.legTimeoutMs);
  const maxJevCallsPerLeg = numberOr(options.maxJevCallsPerLeg, DEFAULTS.maxJevCallsPerLeg);
  const caseWaitMs = numberOr(options.caseWaitMs, DEFAULTS.caseWaitMs);
  const stepTimeoutMs = numberOr(options.stepTimeoutMs, DEFAULTS.stepTimeoutMs);
  const unknownGraceMs = numberOr(options.unknownGraceMs, DEFAULTS.unknownGraceMs);
  const budget = ctx.budget || (ctx.budget = { jevCalls: 0, maxJevCalls: Number.POSITIVE_INFINITY });
  const deadline = Date.now() + Math.max(0, legTimeoutMs);
  const candidates = candidateScreens(ctx.store, leg);
  const candidatesSet = new Set(candidates);
  const legGroup = groupOf(leg.to);
  const planInputs = inputNames(ctx);
  const visited = [];
  const tried = new Set();
  // A case interrupted by a popup gets ONE more try once the popup is handled (spec §5).
  const retriedAfterPopup = new Set();
  const skipped = new Set();
  const warned = new Set();
  const jevActions = [];
  const seen = new Set();
  // The learner's unit is one visit to a screen: it is told what was identified, not what that
  // means. Only a NAMED screen change closes a visit — an unidentified stretch is still the
  // same visit, which is what lets a popup over an unknown screen be learned as an exception.
  let identified = null;
  let legJevCalls = 0;
  let unknownGraceUsed = false;
  let retries = 0;
  // After a `retry` the error text is usually still on screen: the rule sits out ONE turn so the
  // case (the actual retry) runs instead of the rule matching its own leftover message again.
  let retryResting = null;
  // Cases already tried on this screen are tried again after a retry rule fired.
  let lastError = null;
  let pendingRule = null;
  let pendingJev = null;
  // The raw look (below) is taken once per leg: it costs about two normal snapshots.
  let rawLooked = false;
  // A case that left the screen unchanged is blamed (counter, maybe removal) only once nothing else explains it: an
  // exception the raw look finds (a panel covering the button) takes the blame instead of the case.
  let deferredBlame = [];
  const flushBlame = () => {
    for (const item of deferredBlame) ctx.learner?.caseOutcome?.(item, false);
    deferredBlame = [];
  };

  const entry = ({ startedAt = null, error, ...fields }) => ({
    leg: legIndex,
    level: 'L0',
    screen: null,
    what: '',
    ok: true,
    ...fields,
    ...(error === undefined ? {} : { error: String(error).slice(0, ERROR_LIMIT) }),
    duration_ms: startedAt === null ? 0 : Date.now() - startedAt,
  });

  const finish = (status, reason = null) => {
    flushBlame();
    ctx.learner?.legEnd?.(status);
    return { status, reason };
  };

  // Step 0 — a leg may carry its own steps (a plan-specific action). They replace `normal.yml`
  // for this leg and are never learned from, but failing them is not fatal: cases and Jev may
  // still reach `to`, so the loop below runs either way.
  if (Array.isArray(leg.steps) && leg.steps.length) {
    ctx.learner?.legOwnSteps?.();
    const startedAt = Date.now();
    const own = await runRecipe(ctx, leg.steps, stepTimeoutMs);
    if (!own.ok) {
      lastError = failureMessage(own);
      io.record(entry({ startedAt, what: 'leg steps', screen: leg.at || null, ok: false, error: lastError }));
    }
  }

  /** Apply one exception rule; a returned status ends the leg, otherwise the loop re-identifies. */
  const applyRule = async (rule, current, startedAt, { raw = false } = {}) => {
    if (rule.do.fail || rule.do.blocked) {
      const reason = rule.do.fail || rule.do.blocked;
      io.record(entry({ startedAt, level: 'L1', screen: current, what: rule.id, rule: rule.id, ok: false, error: reason }));
      return { status: rule.do.fail ? 'fail' : 'blocked', reason };
    }
    if (rule.do.retry) {
      // The budget is per leg, not per rule: a screen that keeps asking for a retry is stuck.
      retries += 1;
      if (retries > Math.min(Number(rule.do.retry.max) || 2, 3)) {
        io.record(entry({ startedAt, level: 'L1', screen: current, what: rule.id, rule: rule.id, ok: false, error: 'retry limit' }));
        return { status: 'blocked', reason: 'retry limit' };
      }
      await sleep(Number(rule.do.retry.wait) || 0);
      retryResting = rule.id;
      tried.clear();
      io.record(entry({ startedAt, level: 'L1', screen: current, what: rule.id, rule: rule.id, ok: true }));
      return {};
    }
    if (rule.do.tap) await ctx.session.tap_text({ text: rule.do.tap, exact: true, timeout: 2000, ...(raw ? { raw: true } : {}) });
    else if (rule.do.back) await pressBack(ctx);
    pendingRule = rule;
    io.record(entry({ startedAt, level: 'L1', screen: current, what: rule.id, rule: rule.id, ok: true }));
    return {};
  };

  /** After a case: wait for a screen other than `from`, handling exceptions on the way. */
  const waitForScreen = async (from, waitMs = caseWaitMs) => {
    const end = Date.now() + Math.max(0, waitMs);
    let exceptions = 0;
    let lastRule = null;
    for (;;) {
      // Checked first: an exception rule that keeps matching must not spin past the budget.
      if (Date.now() >= end) return { id: null, exceptions, finish: null };
      const snapshot = await snapshotOf(ctx);
      const index = screenIndex(snapshot);
      const { id } = identifyScreen(snapshot, ctx.store, candidates);
      const rule = exceptionTiers(ctx.store, id, legGroup)
        .find((item) => !skipped.has(item.id) && matchWhen(index, item.when));
      if (rule) {
        // The same rule on the same screen twice in a row changed nothing, so its action is dropped for the leg.
        // A new popup of the same kind (a second mini app tripping the same debug warning) has other text, so it
        // is handled again instead of silencing the rule for the rest of the leg.
        const signature = screenSignature(snapshot);
        if (lastRule && rule.id === lastRule.id && signature === lastRule.signature) {
          skipped.add(rule.id);
          lastRule = null;
          continue;
        }
        lastRule = { id: rule.id, signature };
        exceptions += 1;
        // An exception handled while waiting does not fail the case: the screen was taken over
        // by a popup, and the case gets the rest of its budget to land.
        const applied = await applyRule(rule, id, null);
        if (applied.status) return { id: null, exceptions, finish: applied };
        // A retry means "run the case again": that happens in the main loop, not in this wait.
        if (rule.do.retry) return { id: null, exceptions, finish: null, retried: true };
        continue;
      }
      if (id && id !== from) return { id, exceptions, finish: null };
      await sleep(Math.min(POLL_MS, Math.max(1, end - Date.now())));
    }
  };

  for (;;) {
    if (Date.now() >= deadline) {
      io.record(entry({ level: 'L3', what: 'leg deadline', ok: false, error: `${legTimeoutMs}ms` }));
      return finish('needs_agent', 'leg_timeout');
    }

    // ── 1. snapshot + identify ──
    const snap = await snapshotOf(ctx);
    const index = screenIndex(snap);
    const { id: current, ambiguous } = identifyScreen(snap, ctx.store, candidates);
    if (ambiguous.length) {
      const warning = `identify ambiguous: ${ambiguous.join(', ')}`;
      if (!warned.has(warning)) {
        warned.add(warning);
        io.warn(warning, legIndex, current);
      }
    }
    // The learner sees the action together with the screen it produced (phase 3 uses the pair
    // to tell "this pressed button closed a popup" from "this button is part of the screen").
    if (pendingJev) {
      ctx.learner?.jevAction?.(pendingJev.record, pendingJev.before, snap, pendingJev.beforeId, current, pendingJev.confidence);
      pendingJev = null;
    }
    // ... and the screen itself: a change of screen ends the learner's visit to the previous one.
    if (current && current !== identified) {
      identified = current;
      ctx.learner?.visitStart?.(current, snap);
    }

    // ── 2. exceptions ──
    const rules = exceptionTiers(ctx.store, current, legGroup);
    // A rule whose action ran last turn and matches again changed nothing: it is recorded as a
    // failure once and then skipped for the rest of the leg, so the run falls through to cases
    // and Jev instead of tapping the same button forever.
    if (pendingRule) {
      const again = rules.some((rule) => rule.id === pendingRule.id && !skipped.has(rule.id) && matchWhen(index, rule.when));
      ctx.learner?.ruleOutcome?.(pendingRule, !again);
      if (again) {
        skipped.add(pendingRule.id);
        io.record(entry({ level: 'L1', screen: current, what: pendingRule.id, rule: pendingRule.id, ok: false, error: 'rule re-matched after its action' }));
      }
      pendingRule = null;
    }
    const resting = retryResting;
    retryResting = null;
    const rule = rules.find((item) => !skipped.has(item.id) && item.id !== resting && matchWhen(index, item.when));
    if (rule) {
      const applied = await applyRule(rule, current, Date.now());
      if (applied.status) return finish(applied.status, applied.reason);
      continue;
    }

    // ── 3. arrived: run the leg's checks, which are assertions and never go to Jev ──
    if (current && current === leg.to) {
      const checks = Array.isArray(leg.checks) ? leg.checks : [];
      if (checks.length) {
        const startedAt = Date.now();
        const outcome = await runRecipe(ctx, checks, stepTimeoutMs);
        if (!outcome.ok) {
          const error = failureMessage(outcome);
          io.record(entry({ startedAt, screen: current, what: 'checks', ok: false, error }));
          return finish('fail', error);
        }
        io.record(entry({ startedAt, screen: current, what: 'checks', ok: true }));
      } else {
        io.record(entry({ screen: current, what: 'arrived' }));
      }
      // The route as it was observed, `at` first: the next run can walk it in one case per hop.
      if (visited.length >= 1) ctx.learner?.legPassed?.([...visited, leg.to]);
      return finish('pass');
    }

    // ── 4./5. a known screen: try its one-hop cases, best first ──
    if (current) {
      const known = casesFor(ctx.store, current, leg.to, { visited: new Set(visited), candidates: candidatesSet })
        .filter((item) => !tried.has(item.key));
      let moved = false;
      for (const item of known) {
        tried.add(item.key);
        const startedAt = Date.now();
        const outcome = await runRecipe(ctx, item.steps, stepTimeoutMs);
        if (!outcome.ok) {
          lastError = failureMessage(outcome);
          io.record(entry({ startedAt, screen: current, what: item.to, case: item.to, ok: false, error: lastError }));
          ctx.learner?.caseOutcome?.(item, false);
          continue;
        }
        const waited = await waitForScreen(current, numberOr(item.waitMs, caseWaitMs));
        if (waited.retried) {
          moved = true;
          break;
        }
        if (waited.finish) {
          io.record(entry({ startedAt, screen: current, what: item.to, case: item.to, ok: false, error: waited.finish.reason }));
          return finish(waited.finish.status, waited.finish.reason);
        }
        if (waited.id) {
          flushBlame();
          ctx.learner?.caseOutcome?.(item, true);
          visited.push(current);
          io.record(entry({ startedAt, screen: current, what: item.to, case: item.to, ok: true }));
          moved = true;
          break;
        }
        // No new screen. That is the case's own failure, unless an exception took the screen
        // over mid-case (a UAT popup between two steps): then the case is not blamed for it.
        io.record(entry({ startedAt, screen: current, what: item.to, case: item.to, ok: false, error: waited.exceptions ? 'screen unchanged (an exception was handled)' : 'screen unchanged' }));
        if (!waited.exceptions) {
          // The steps of a case that ran here are the head of any case learned from this visit;
          // only the ones that actually succeeded belong there (`failed_step.index` counts them).
          const ran = outcome.failed_step ? Number(outcome.failed_step.index) || 0 : item.steps.length;
          ctx.learner?.caseRan?.(item, item.steps.slice(0, ran));
          deferredBlame.push(item);
        } else if (!retriedAfterPopup.has(item.key)) {
          retriedAfterPopup.add(item.key);
          tried.delete(item.key);
          moved = true; // re-identify first: the popup may have left the app on another screen
          break;
        }
      }
      if (moved) continue;
    }

    // An unknown screen right after launch or a transition is usually still loading: give it a
    // short grace (once per stretch of unknown screens) before paying for a Jev call.
    if (!current && !unknownGraceUsed) {
      unknownGraceUsed = true;
      const graceEnd = Date.now() + Math.max(0, unknownGraceMs);
      let settled = false;
      while (Date.now() < graceEnd) {
        await sleep(Math.min(POLL_MS, Math.max(1, graceEnd - Date.now())));
        const again = await snapshotOf(ctx);
        if (identifyScreen(again, ctx.store, candidates).id) { settled = true; break; }
      }
      if (settled) continue;
    }
    if (current) unknownGraceUsed = false;

    // ── 5b. stuck: one look at the FULL tree ──
    // The default Android tree collapses some nodes (a lone Minimize button of a debug panel that
    // covers the page): they exist for no rule and no decider, so a leg can be stuck behind
    // something nobody can see. Every case failed and the screen is not `to`: take the raw tree
    // once. If it lists nodes the normal one lacks, give the exception rules a second chance on it
    // (their tap then searches the raw tree), and otherwise hand THIS view to the decider.
    let jevView = snap;
    if (!rawLooked && ctx.backend.snapshot) {
      rawLooked = true;
      let rawSnap = null;
      try {
        rawSnap = await ctx.backend.snapshot({ raw: true });
      } catch (error) {
        io.warn(`raw look failed: ${String(error && error.message || error).slice(0, 120)}`, legIndex, current);
      }
      const known = new Set((snap.nodes || []).map((node) => node.text).filter(Boolean));
      const hidden = rawSnap ? (rawSnap.nodes || []).filter((node) => node.text && !known.has(node.text)) : [];
      if (hidden.length) {
        const rawIndex = screenIndex(rawSnap);
        const rawRule = rules.find((item) => !skipped.has(item.id) && matchWhen(rawIndex, item.when));
        if (rawRule) {
          const applied = await applyRule(rawRule, current, Date.now(), { raw: true });
          if (applied.status) return finish(applied.status, applied.reason);
          deferredBlame = []; // the exception explains why the cases failed: they are not blamed
          tried.clear(); // the cause is gone: the cases get one more go
          continue;
        }
        jevView = rawSnap;
      }
    }

    flushBlame();
    // ── 6. Jev: ONE action per turn, from the closed set, at most `maxJevCallsPerLeg` ──
    const room = Math.min(
      maxJevCallsPerLeg - legJevCalls,
      numberOr(budget.maxJevCalls, Number.POSITIVE_INFINITY) - numberOr(budget.jevCalls, 0),
    );
    if (!ctx.jev || room <= 0) {
      const reason = ctx.jev ? 'jev_budget' : 'no_jev';
      io.record(entry({ level: 'L3', screen: current, what: 'jev', ok: false, error: reason }));
      return finish('needs_agent', reason);
    }
    const screen = current ? ctx.store.screens.get(current) : null;
    // Jev may only fill inputs the screen itself declares — and only by NAME.
    const inputs = screen ? planInputs.filter((name) => screen.inputs.includes(name)) : planInputs;
    const state = {
      goal: plan.goal,
      leg: { from: leg.at, to: leg.to, intent: leg.intent || null },
      destination: contextOf(ctx.store, leg.to),
      currentScreen: screen && screen.body ? screen.body.slice(0, CONTEXT_MAX_CHARS) : null,
      lastError,
      recentActions: jevActions.slice(-3).map((item) => item.description),
    };
    legJevCalls += 1;
    budget.jevCalls = Number(budget.jevCalls || 0) + 1;
    const answer = await askOnce({ jev: ctx.jev, snapshot: jevView, state, inputs, exclude: ctx.exclude, redact: ctx.redact });
    if (answer.error) {
      io.record(entry({ level: 'L3', screen: current, what: 'jev', ok: false, error: answer.error }));
      return finish('needs_agent', answer.error);
    }
    const { record: actionRecord, confidence } = answer;
    jevActions.push(actionRecord);
    if (Number.isFinite(ctx.threshold) && confidence < ctx.threshold) {
      io.record(entry({ level: 'L3', screen: current, what: actionRecord.description, ok: false, confidence, error: 'below threshold' }));
      return finish('needs_agent', 'low_confidence');
    }

    // One unanswered answer on one unchanged screen is a loop, verdict or not: asking again
    // cannot help, so the run stops with the screen and the action in its report.
    const repeatKey = `${screenSignature(snap)}|${actionRecord.description}`;
    if (seen.has(repeatKey)) {
      io.record(entry({ level: 'L3', screen: current, what: actionRecord.description, ok: false, confidence, error: 'no progress' }));
      return finish('needs_agent', 'no_progress');
    }
    seen.add(repeatKey);

    if (actionRecord.kind === 'verdict') {
      if (actionRecord.verdict === 'arrived') {
        io.record(entry({ level: 'L2', screen: current, what: actionRecord.description, action: actionRecord.description, ok: true, confidence }));
        continue; // a claim only — the next pass identifies the screen and decides for itself
      }
      const status = actionRecord.verdict === 'blocked' ? 'blocked' : 'fail';
      const reason = `Jev: ${actionRecord.verdict}`;
      io.record(entry({ level: 'L2', screen: current, what: actionRecord.description, action: actionRecord.description, ok: false, confidence, error: reason }));
      ctx.learner?.verdict?.(actionRecord.verdict, snap, current, legGroup);
      return finish(status, reason);
    }

    const startedAt = Date.now();
    try {
      if (actionRecord.kind === 'press') await ctx.backend.press(answer.action.node);
      else if (actionRecord.kind === 'fill') await ctx.backend.fill(answer.action.node, ctx.data[actionRecord.input]);
      else if (actionRecord.kind === 'scroll') await ctx.backend.scroll(actionRecord.direction);
      else if (actionRecord.kind === 'back') await ctx.backend.back();
      else if (actionRecord.kind === 'wait') await sleep(WAIT_MS);
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
      io.record(entry({ startedAt, level: 'L2', screen: current, what: actionRecord.description, ok: false, confidence, error: lastError }));
      continue;
    }
    io.record(entry({ startedAt, level: 'L2', screen: current, what: actionRecord.description, action: actionRecord.description, ok: true, confidence }));
    pendingJev = { record: actionRecord, before: snap, beforeId: current, confidence };
  }
}

/**
 * `runLegs(ctx, legs, { startIndex })` -> { status, entries, stoppedAt, reason, warnings }.
 * The status of the run is the status of the first leg that does not pass; a leg that stops
 * (`fail` / `blocked` / `needs_agent`) ends the run there, so `resume` restarts at `stoppedAt`.
 */
async function runLegs(ctx, legs, { startIndex = 0 } = {}) {
  const entries = [];
  const warnings = [];
  const record = (item) => {
    entries.push(item);
    if (typeof ctx.onEntry === 'function') ctx.onEntry(item);
    return item;
  };
  const warn = (text, legIndex, screen) => {
    warnings.push(text);
    record({ leg: legIndex, level: 'L0', screen: screen || null, what: text, ok: true, warning: true, duration_ms: 0 });
  };
  const list = Array.isArray(legs) ? legs : [];
  for (let legIndex = startIndex; legIndex < list.length; legIndex += 1) {
    const leg = list[legIndex];
    const override = leg && leg.data && typeof leg.data === 'object' ? leg.data : null;
    // `leg.data` overrides row values for this leg only; captures (saveAs) made during the leg
    // still reach the legs after it, so they are copied back without the overridden keys.
    const legCtx = override ? { ...ctx, data: { ...ctx.data, ...override } } : ctx;
    // The learner's leg boundary: it buffers ops per leg and `legEnd` decides whether they may
    // be kept (a decision that never reached `to` is not knowledge).
    ctx.learner?.legStart?.(leg, legIndex);
    const outcome = await runLeg(legCtx, leg, legIndex, { record, warn });
    if (override) {
      for (const [name, value] of Object.entries(legCtx.data)) {
        if (!Object.prototype.hasOwnProperty.call(override, name)) ctx.data[name] = value;
      }
    }
    if (outcome.status !== 'pass') {
      return { status: outcome.status, entries, stoppedAt: legIndex, reason: outcome.reason, warnings };
    }
  }
  return { status: 'pass', entries, stoppedAt: null, reason: null, warnings };
}

module.exports = { runLegs, DEFAULTS };
