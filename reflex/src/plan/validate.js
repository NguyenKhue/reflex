/**
 * validate.js — reject a broken plan BEFORE any device session opens.
 *
 * A flow plan is a chain of screen legs, so the checks are: the chain is unbroken, every screen
 * it names exists in the workspace's knowledge base, and every tool step is one the runner can
 * actually execute. An agent writes plans from a request, so the messages are addressed to it:
 * each says which leg and what to change. Errors block the run; warnings are printed.
 */
const { DEVICE_TOOL_SPECS } = require('../device/deviceTools');
const { validateToolStep } = require('../runner/recipe');
const { validateExpect } = require('../runner/expect');
const { SCREEN_ID } = require('../screens/schema');

const NAME = /^[a-z0-9][a-z0-9_]*$/;
const STEP_KEYS = new Set(['tool', 'args', 'when', 'saveAs', 'intent', 'expect', 'note']);
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function placeholders(value, out = new Set()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER)) out.add(match[1]);
  } else if (Array.isArray(value)) {
    value.forEach((item) => placeholders(item, out));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => placeholders(item, out));
  }
  return out;
}

function checkStep(step, label, { toolSpecs, known, errors, warnings, index }) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    errors.push(`${label}: a step must be a mapping with "tool" and "args"`);
    return;
  }
  const where = step.tool ? `${label} (${step.tool})` : label;
  if (!step.tool) {
    // Intent-only steps are gone with the step plans: a flow step is a deterministic tool call.
    errors.push(`${label}: a flow step needs a "tool"`);
    return;
  }
  if (step.tool === 'jev_recover') {
    errors.push(`${where}: jev_recover is not a tool — write tool steps, and let the leg loop ask Jev when they get stuck`);
    return;
  }
  try {
    validateToolStep(step, index, { toolSpecs });
  } catch (error) {
    errors.push(`${label}: ${error.message.replace(/^checklist step \d+: /, '')}`);
  }
  if (step.intent !== undefined && (typeof step.intent !== 'string' || !step.intent.trim() || step.intent.length > 200)) {
    errors.push(`${where}: "intent" must be a string of 1–200 characters`);
  }
  if (step.expect !== undefined) {
    try {
      validateExpect(step.expect);
    } catch (error) {
      errors.push(`${where}: ${error.message}`);
    }
    // Nothing evaluates `expect` any more: the leg loop's checks/verify ARE the assertions.
    warnings.push(`${where}: "expect" is not evaluated — use an assertion tool (assert_text, wait_text) instead`);
  }
  for (const key of Object.keys(step)) {
    if (!STEP_KEYS.has(key)) warnings.push(`${where}: unknown key "${key}"`);
  }
  const used = placeholders([step.args, step.when && step.when.value, step.expect]);
  for (const name of used) {
    if (!known.has(name)) warnings.push(`${where}: unknown field "{${name}}"`);
  }
  if (step.saveAs) known.add(step.saveAs);
}

/**
 * `validatePlan(plan, { store, toolSpecs })`. `store` is the loaded `screens/<app>/` tree; when
 * it is present every `at`/`to` must name a screen the runner can identify, which is what turns
 * a typo into a validation error instead of a `needs_agent` in the middle of a run.
 */
function validatePlan(plan, { store = null, toolSpecs = DEVICE_TOOL_SPECS } = {}) {
  const errors = [];
  const warnings = [];
  if (!NAME.test(String(plan.name || ''))) errors.push(`"name" must match ${NAME} (got "${plan.name || ''}")`);
  if (typeof plan.goal !== 'string' || !plan.goal.trim()) errors.push('"goal" is required: one English sentence for Jev');
  if (!plan.app) errors.push('"app" is required: a key of apps in reflex.workspace.json, or an inline mapping');

  const flow = Array.isArray(plan.flow) ? plan.flow : [];
  if (!flow.length) errors.push('"flow" must be a non-empty list of screen legs');

  const inputNames = new Set((plan.inputs || []).map((input) => input.name));
  // `known` grows as saveAs captures are declared, so a later leg may read what an earlier one captured.
  const known = new Set(inputNames);
  const check = (step, label, index) => checkStep(step, label, { toolSpecs, known, errors, warnings, index });

  flow.forEach((leg, index) => {
    const label = `flow leg ${index + 1} (${leg.at || '?'} → ${leg.to || '?'})`;
    for (const key of ['at', 'to']) {
      const id = leg[key];
      if (typeof id !== 'string' || !SCREEN_ID.test(id)) {
        errors.push(`${label}: "${key}" must be a screen id "<group>/<screen>" (got "${id === undefined ? '' : id}")`);
        continue;
      }
      if (store && !store.screens.has(id)) errors.push(`${label}: screen "${id}" does not exist in screens/${plan.app}/`);
    }
    const previous = flow[index - 1];
    if (previous && leg.at !== previous.to) {
      errors.push(`${label}: "at" must be the previous leg's "to" ("${previous.to}")`);
    }
    (leg.steps || []).forEach((step, i) => check(step, `${label} step ${i + 1}`, i));
    (leg.checks || []).forEach((step, i) => check(step, `${label} check ${i + 1}`, i));
    for (const key of Object.keys(leg.data || {})) {
      if (!inputNames.has(key)) errors.push(`${label}: data key "${key}" is not a declared input`);
    }
  });

  (plan.verify || []).forEach((step, index) => check(step, `verify ${index + 1}`, index));

  // A simulator can be wiped (its data container is a host folder), a physical iPhone cannot: which
  // one a run gets is only known at run time, so this is a warning and resetApp decides.
  if (plan.start && plan.start.launch === 'fresh' && !(plan.platforms || []).includes('android')) {
    warnings.push('"start.launch: fresh" on iOS works on a simulator only — use "relaunch" or "attach" on a physical device');
  }

  const ids = new Set();
  for (const row of plan.rows || []) {
    for (const column of Object.keys(row)) {
      if (column !== 'id' && !inputNames.has(column)) errors.push(`data column "${column}" is not a declared input`);
    }
    if (ids.has(row.id)) errors.push(`duplicate data row id "${row.id}"`);
    ids.add(row.id);
  }
  if (plan.rowsFromTable && plan.rows.length > 3) warnings.push(`${plan.rows.length} inline data rows: keep ≤ 3, move the rest to @data: <file.csv>`);
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

module.exports = { validatePlan, STEP_KEYS };
