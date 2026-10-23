/**
 * schema.js — validate one screen's knowledge files before any device session opens.
 *
 * Every message is addressed to the agent that wrote the file: it names the file and the
 * item, and says what to change. The validators also NORMALIZE (status defaults to draft, a
 * retry gets its max), so the store never has to fill defaults twice.
 */
const { KEYS } = require('./match');
const { validateToolStep } = require('../runner/recipe');

const CASE_STATUS = ['draft', 'learned', 'verified'];
const SCREEN_ID = /^[a-z0-9_]+\/[a-z0-9_]+$/;
const RULE_ID = /^[a-z0-9_]+$/;
const ACTIONS = ['tap', 'back', 'retry', 'fail', 'blocked'];
const RETRY_MAX_CEILING = 3;

function fail(where, message) {
  throw new Error(`${where}: ${message}`);
}

function isTextList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim());
}

function isMapping(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * identify block (a screen) and `when` (an exception): at least one condition, and no
 * condition that could never be evaluated. Unknown keys are rejected — a typo would
 * silently make a screen unrecognizable.
 */
function validateIdentify(when, where) {
  if (!isMapping(when)) fail(where, 'expected a mapping with anyId/allText/anyText/noneText');
  for (const key of Object.keys(when)) {
    if (!KEYS.includes(key)) fail(where, `unknown key "${key}" (expected ${KEYS.join(' / ')})`);
    if (!isTextList(when[key])) fail(where, `"${key}" must be a non-empty list of non-empty strings`);
  }
  if (!KEYS.some((key) => when[key] !== undefined)) fail(where, `at least one of ${KEYS.join(' / ')} is required`);
  return Object.fromEntries(KEYS.filter((key) => when[key] !== undefined).map((key) => [key, when[key].map(String)]));
}

/** The lifecycle keys a case and an exception rule share. */
function validateMeta(item, where) {
  const status = item.status === undefined || item.status === null ? 'draft' : item.status;
  if (!CASE_STATUS.includes(status)) fail(where, `"status" must be one of ${CASE_STATUS.join(' / ')} (got "${item.status}")`);
  if (item.pinned !== undefined && typeof item.pinned !== 'boolean') fail(where, '"pinned" must be true or false');
  if (item.confidence !== undefined && item.confidence !== null && !Number.isFinite(item.confidence)) {
    fail(where, '"confidence" must be a number or null');
  }
  if (item.learnedFrom !== undefined && item.learnedFrom !== null && typeof item.learnedFrom !== 'string') {
    fail(where, '"learnedFrom" must be a run id or null');
  }
  if (item.stats !== undefined && item.stats !== null && !isMapping(item.stats)) fail(where, '"stats" must be a mapping');
  return {
    status,
    ...(item.pinned !== undefined ? { pinned: item.pinned } : {}),
    ...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
    ...(item.learnedFrom !== undefined ? { learnedFrom: item.learnedFrom } : {}),
    ...(item.stats !== undefined && item.stats !== null ? { stats: item.stats } : {}),
  };
}

/** One `normal.yml` case: a one-hop transition to `to`, executed by the tool DSL. */
function validateCase(item, where, { toolSpecs } = {}) {
  if (!isMapping(item)) fail(where, 'a case must be a mapping with to/intent/steps');
  if (typeof item.to !== 'string' || !SCREEN_ID.test(item.to)) {
    fail(where, `"to" must be a screen id "<group>/<screen>" (got "${item.to === undefined ? '' : item.to}")`);
  }
  if (typeof item.intent !== 'string' || !item.intent.trim() || item.intent.length > 200) {
    fail(where, '"intent" must be a string of 1–200 characters');
  }
  if (!Array.isArray(item.steps) || !item.steps.length) fail(where, '"steps" must be a non-empty list');
  item.steps.forEach((step, index) => {
    try {
      validateToolStep(step, index, { toolSpecs });
    } catch (error) {
      fail(where, error.message.replace(/^checklist step \d+: /, ''));
    }
  });
  // A case that waits on a slow backend (a login) says how long its next screen may take.
  if (item.waitMs !== undefined && !(Number.isFinite(item.waitMs) && item.waitMs > 0 && item.waitMs <= 60000)) {
    fail(where, '"waitMs" must be a number of milliseconds between 1 and 60000');
  }
  return {
    to: item.to,
    intent: item.intent,
    steps: item.steps,
    ...(item.waitMs !== undefined ? { waitMs: item.waitMs } : {}),
    ...validateMeta(item, where),
  };
}

function validateRetry(value, where) {
  if (!isMapping(value)) fail(where, '"do.retry" must be a mapping { wait, max }');
  if (!Number.isFinite(value.wait) || value.wait < 0 || value.wait > 10000) {
    fail(where, '"do.retry.wait" must be a number of milliseconds between 0 and 10000');
  }
  if (value.max !== undefined && !(Number.isInteger(value.max) && value.max >= 1 && value.max <= RETRY_MAX_CEILING)) {
    fail(where, `"do.retry.max" must be an integer between 1 and ${RETRY_MAX_CEILING}`);
  }
  return { wait: value.wait, max: value.max === undefined ? 2 : value.max };
}

/** One `exceptions.yml` rule: what the screen looks like, and the ONE thing to do about it. */
function validateException(rule, where) {
  if (!isMapping(rule)) fail(where, 'a rule must be a mapping with id/when/do');
  if (typeof rule.id !== 'string' || !RULE_ID.test(rule.id)) fail(where, `"id" must match ${RULE_ID} (got "${rule.id}")`);
  const when = validateIdentify(rule.when, where);
  const action = rule.do;
  const keys = isMapping(action) ? Object.keys(action) : [];
  if (keys.length !== 1 || !ACTIONS.includes(keys[0])) fail(where, `"do" needs exactly one of ${ACTIONS.join(' / ')}`);
  const kind = keys[0];
  const value = action[kind];
  if (kind === 'tap' && (typeof value !== 'string' || !value.trim())) fail(where, '"do.tap" must be a text or a test id');
  if (kind === 'back' && value !== true) fail(where, '"do.back" must be true');
  if (kind === 'fail' && (typeof value !== 'string' || !value.trim())) fail(where, '"do.fail" must be a reason');
  if (kind === 'blocked' && (typeof value !== 'string' || !value.trim())) fail(where, '"do.blocked" must be a reason');
  const do_ = kind === 'retry' ? { retry: validateRetry(value, where) } : { [kind]: value };
  return { id: rule.id, when, do: do_, ...validateMeta(rule, where) };
}

/** `routes.yml`: the observed multi-hop paths, written by the runner and never by hand. */
function validateRoutes(list, where) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) fail(where, 'expected a list of routes');
  return list.map((route, index) => {
    const at = `${where} route ${index + 1}`;
    if (!isMapping(route)) fail(at, 'a route must be a mapping with "path"');
    if (!Array.isArray(route.path) || route.path.length < 2) fail(at, '"path" must be a list of at least 2 screen ids');
    route.path.forEach((id, position) => {
      if (typeof id !== 'string' || !SCREEN_ID.test(id)) fail(at, `"path[${position}]" must be a screen id (got "${id}")`);
    });
    return { path: route.path.slice() };
  });
}

module.exports = { validateIdentify, validateCase, validateException, validateRoutes, CASE_STATUS, SCREEN_ID, RULE_ID };
