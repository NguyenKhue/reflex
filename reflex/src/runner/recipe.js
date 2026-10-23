/** Deterministic step execution for reflex plans (tool + args + when + saveAs). */
const { DEVICE_TOOL_SPECS, DEVICE_ASSERTIONS } = require('../device/deviceTools');

const FORBIDDEN = new Set(['close', 'recorded_actions', 'execute_steps']);
const REPORT_SECRET_KEY = /(?:password|passcode|pin|otp|token|authorization|secret|text)/i;

// Persist only the action context needed for a readable report. Input text can
// contain a phone, account number or credential; it must never travel in a
// checklist result merely to decorate a UI label.
function reportArgs(args) {
  return Object.fromEntries(Object.entries(args || {}).filter(([key]) => !REPORT_SECRET_KEY.test(key)));
}

function interpolate(value, data) {
  if (typeof value === 'string') {
    return value.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
      // An empty string is a valid value for an optional field.  In
      // particular, Mapbank uses an empty preferred bank name to signal that
      // `bankPickMode=random` must discover a candidate on the device.  Flow
      // requiredness is enforced by resolveFlowData before this recipe runs.
      if (data[key] === undefined || data[key] === null) {
        throw new Error(`checklist requires data field "${key}"`);
      }
      return String(data[key]);
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, data));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, data)]));
  }
  return value;
}

function toolNames(toolSpecs) {
  return new Set((toolSpecs || DEVICE_TOOL_SPECS).map((spec) => spec.name));
}

/** Reject one malformed step before any session opens; `index` is 0-based. */
function validateToolStep(step, index, { toolSpecs } = {}) {
  const allowed = toolNames(toolSpecs);
  const tool = step && step.tool;
  if (!allowed.has(tool) || FORBIDDEN.has(tool)) {
    throw new Error(`checklist step ${index + 1}: unsupported tool "${tool || ''}"`);
  }
  if (step.args != null && (typeof step.args !== 'object' || Array.isArray(step.args))) {
    throw new Error(`checklist step ${index + 1}: "args" must be a mapping`);
  }
  if (step.when != null) {
    const where = `checklist step ${index + 1}: invalid "when"`;
    const when = step.when;
    if (typeof when !== 'object' || Array.isArray(when)) throw new Error(`${where} (expected a mapping with "value" and "match"/"notMatch")`);
    if (typeof when.value !== 'string') throw new Error(`${where} ("value" must be a string)`);
    const patterns = [['match', when.match], ['notMatch', when.notMatch]];
    if (!patterns.some(([, source]) => typeof source === 'string' && source)) {
      throw new Error(`${where} ("match" or "notMatch" is required)`);
    }
    // A pattern that does not compile can only be noticed mid-run, once the app has
    // already moved on, so the recipe is rejected before the first session opens.
    for (const [key, source] of patterns) {
      if (source === undefined || source === null) continue;
      if (typeof source !== 'string') throw new Error(`${where} ("${key}" must be a string)`);
      try {
        new RegExp(source);
      } catch (error) {
        throw new Error(`${where} ("${key}" is not a valid regexp: ${error.message})`);
      }
    }
  }
}

function validateChecklistRecipe(recipe, { toolSpecs } = {}) {
  if (!Array.isArray(recipe) || !recipe.length) throw new Error('flow checklist must be a non-empty array');
  recipe.forEach((step, index) => validateToolStep(step, index, { toolSpecs }));
}

/**
 * `when` gates a step on a data value: at least one of `match`/`notMatch` decides, and
 * both have to agree. The value is interpolated, so it may name a captured field.
 */
function whenCondition(when, data) {
  const value = interpolate(when.value, data);
  const match = when.match ? new RegExp(when.match) : null;
  const notMatch = when.notMatch ? new RegExp(when.notMatch) : null;
  return (!match || match.test(value)) && (!notMatch || !notMatch.test(value));
}

/**
 * Run ONE step once and never throw: a thrown tool error, a failed assertion and
 * an `ok:false` result all come back as `{ ok: false, error }` so the caller can
 * apply a recovery policy. A policy `status:'skipped'` result is reported apart.
 */
async function runToolStep(session, definition, args, { stepTimeoutMs = 0, assertionSet = DEVICE_ASSERTIONS, onStepStart, index = 0 } = {}) {
  try {
    onStepStart?.({ index, tool: definition.tool });
    const toolPromise = Promise.resolve().then(() => session[definition.tool](args));
    // A UiAutomator2 command can hang in the server queue indefinitely. A
    // Promise race lets the catalog owner reclaim its session; the pending
    // command is then rejected by session teardown rather than blocking the
    // rest of the matrix forever.
    const timeout = Math.max(0, Number(stepTimeoutMs) || 0);
    let watchdog = null;
    const result = timeout
      ? await Promise.race([
        toolPromise,
        new Promise((_, reject) => {
          watchdog = setTimeout(() => {
            const error = new Error(`${definition.tool} did not respond within ${timeout}ms`);
            error.failure_kind = 'automation_session_lost';
            error.phase = 'session_watchdog';
            reject(error);
          }, timeout);
        }),
      ]).finally(() => clearTimeout(watchdog))
      : await toolPromise;
    // A payment policy may classify a documented TTAT/KQGD business outcome
    // as skipped. This is distinct from a passing action and must preserve
    // the step/result evidence for the composite report.
    if (result && result.status === 'skipped') return { skipped: true, result };
    const failedAssertion = assertionSet.has(definition.tool) && result && result.found === false;
    if (failedAssertion || (result && result.ok === false)) {
      const detail = result && typeof result.error === 'string' && result.error ? `: ${result.error}` : '';
      throw new Error(failedAssertion ? `${definition.tool} did not find a matching component${detail}` : `${definition.tool} reported failure${detail}`);
    }
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Store a step's result under its `saveAs` name: the tool's `value` when it has one. */
function applySaveAs(definition, result, data) {
  if (!definition || !definition.saveAs) return;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(definition.saveAs)) throw new Error(`invalid saveAs "${definition.saveAs}"`);
  data[definition.saveAs] = result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
}

/** Taps that may skip the UI quiet-wait, and the following tools that wait anyway. */
const TAPPING_TOOLS = new Set(['tap_text', 'tap_if_present_text']);
const WAITING_TOOLS = new Set(['wait_text', 'wait_any_text', 'wait_stable_texts', 'assert_text']);
/** Steps that touch the screen at a node's bounds: they must not land mid-transition. */
const POINTER_TOOLS = new Set(['tap_text', 'tap_if_present_text', 'fill', 'fill_otp_from_api', 'scroll', 'scroll_to_text', 'back']);

/**
 * Drop the settle wait of a tap whose very next step waits for the screen anyway: the
 * tap would otherwise wait for the UI to go quiet and that next step would wait again
 * (~1-2 s per tap on a screen that re-renders, like Home). Returns a NEW recipe: the
 * flow's own `checklist` must stay as declared, and an explicit `settle` always wins.
 *
 * Only when the step after that wait does not touch the screen: a wait passes as soon as
 * its text exists, which on a screen still sliding in is before the layout is final, and
 * a tap there lands on nothing (seen live: "api-contract" → wait "▶ Run all" → tap
 * "▶ Run all" was silently lost). The settle of the first tap is what lets the new
 * screen come to rest before the next pointer action.
 */
function autoSettle(recipe) {
  const steps = Array.isArray(recipe) ? recipe : [];
  return steps.map((step, index) => {
    const next = steps[index + 1];
    if (!step || !TAPPING_TOOLS.has(step.tool) || !next || !WAITING_TOOLS.has(next.tool)) return step;
    const afterWait = steps[index + 2];
    if (afterWait && POINTER_TOOLS.has(afterWait.tool)) return step;
    const args = step.args || {};
    if (args.settle !== undefined) return step;
    return { ...step, args: { ...args, settle: false } };
  });
}


async function executeChecklistRecipe(session, recipe, data, { onStepStart, stepTimeoutMs = 0, toolSpecs, assertions, onStepError } = {}) {
  validateChecklistRecipe(recipe, { toolSpecs });
  const assertionSet = assertions || DEVICE_ASSERTIONS;
  const steps = [];
  for (let index = 0; index < recipe.length; index++) {
    const definition = recipe[index];
    const startedAt = Date.now();

    // `when` decides whether the step runs at all, and it is evaluated BEFORE `args`:
    // a skipped step may reference data this row never defines (the login block of an
    // already-logged-in session), so interpolating its args would fail a step that
    // was never meant to run.
    let whenError = null;
    let applicable = true;
    if (definition.when != null) {
      try {
        applicable = whenCondition(definition.when, data);
      } catch (error) {
        whenError = error;
      }
    }
    if (!whenError && !applicable) {
      steps.push({
        index,
        tool: definition.tool,
        args: {},
        ok: true,
        duration_ms: 0,
        result: { ok: true, notApplicable: true, reason: 'when' },
        notApplicable: true,
      });
      continue;
    }

    // A conditional that cannot be evaluated (a missing data field) is a broken step,
    // not a silent skip: it fails exactly like a tool that threw.
    const args = whenError ? {} : interpolate(definition.args || {}, data);
    const runOptions = { stepTimeoutMs, assertionSet, onStepStart, index };
    let attempt = whenError ? { ok: false, error: whenError } : await runToolStep(session, definition, args, runOptions);

    // A failed step may be recoverable (an unexpected popup, a missed tap). The
    // policy belongs to the caller; the recipe only re-runs that same step once
    // and records whether the retry succeeded.
    if (!attempt.ok && typeof onStepError === 'function') {
      let recover = false;
      try {
        recover = await onStepError({ index, tool: definition.tool, args, error: attempt.error });
      } catch (error) {
        recover = false;
      }
      if (recover === true) {
        const retry = await runToolStep(session, definition, args, runOptions);
        attempt = retry.ok || retry.skipped ? { ...retry, recovered: true } : { ...attempt, retryError: retry.error };
      }
    }

    if (attempt.skipped) {
      const result = attempt.result;
      const entry = {
        index,
        tool: definition.tool,
        args: reportArgs(args),
        ok: false,
        status: 'skipped',
        skipped: true,
        skippedReason: result.skippedReason || 'Known business outcome',
        result,
        duration_ms: Date.now() - startedAt,
        ...(attempt.recovered ? { recovered: true } : {}),
      };
      const artifacts = Array.isArray(result?.evidence?.artifacts) ? result.evidence.artifacts : [];
      if (artifacts.length) {
        entry.artifacts = artifacts;
        entry.screenshot = result.evidence.screenshot || null;
      }
      steps.push(entry);
      return { ok: false, status: 'skipped', skipped: true, skippedReason: entry.skippedReason, failed_step: entry, steps };
    }

    if (attempt.ok && definition.saveAs) {
      try {
        applySaveAs(definition, attempt.result, data);
      } catch (error) {
        attempt = { ok: false, error };
      }
    }

    if (attempt.ok) {
      steps.push({
        index,
        tool: definition.tool,
        args: reportArgs(args),
        ok: true,
        duration_ms: Date.now() - startedAt,
        result: attempt.result,
        ...(attempt.recovered ? { recovered: true } : {}),
      });
      continue;
    }

    const error = attempt.error;
    const failureMessage = error && error.message ? error.message : String(error);
    const retryMessage = attempt.retryError && (attempt.retryError.message || String(attempt.retryError));
    const transactionEvidence = error?.transaction?.evidence || null;
    const artifacts = Array.isArray(transactionEvidence?.artifacts) ? transactionEvidence.artifacts : [];
    const entry = {
      index,
      tool: definition.tool,
      args: reportArgs(args),
      ok: false,
      duration_ms: Date.now() - startedAt,
      error: retryMessage ? `${failureMessage}; after recovery: ${retryMessage}` : failureMessage,
      ...(error?.failure_kind ? { failure_kind: error.failure_kind, phase: error.phase || null } : {}),
      ...(error?.transaction?.failure_kind ? { failure_kind: error.transaction.failure_kind, phase: error.transaction.phase || null } : {}),
      ...(artifacts.length ? { artifacts, screenshot: transactionEvidence.screenshot || null } : {}),
    };
    steps.push(entry);
    return { ok: false, failed_step: entry, steps };
  }
  return { ok: true, steps };
}

module.exports = {
  interpolate,
  reportArgs,
  whenCondition,
  validateToolStep,
  validateChecklistRecipe,
  runToolStep,
  applySaveAs,
  autoSettle,
  executeChecklistRecipe,
};
