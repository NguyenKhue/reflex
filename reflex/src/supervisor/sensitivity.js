/**
 * sensitivity.js — which legs of a plan enter credentials.
 *
 * The agent must never enter a password, PIN or OTP, so the tool has to know which legs do. A leg is sensitive when its own
 * steps use a secret placeholder, when it is marked `sensitive: true`, or when a screen on a known path from `at` to `to`
 * takes a secret input or has a case whose steps use one. When no known path exists a decider or an agent chooses the route and
 * could walk into a credential screen, so the leg counts as sensitive if the plan declares any secret input at all.
 */
const { secretKeys } = require('../plan/data');

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SCREEN_NAME = /(^|[_/])(pin|password|otp|passcode)([_/]|$)/i;

function placeholdersOf(value, found = new Set()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER)) found.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) placeholdersOf(item, found);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) placeholdersOf(item, found);
  }
  return found;
}

function usesSecret(value, secrets) {
  for (const name of placeholdersOf(value)) if (secrets.has(name)) return true;
  return false;
}

/** from -> Set(to): the hops of every known case plus the observed routes. */
function edgesOf(store) {
  const edges = new Map();
  const add = (from, to) => {
    if (!from || !to) return;
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  };
  if (store && store.screens) {
    for (const screen of store.screens.values()) for (const item of screen.normal || []) add(screen.id, item.to);
  }
  for (const route of (store && store.routes) || []) {
    for (let i = 0; i + 1 < route.length; i += 1) add(route[i], route[i + 1]);
  }
  return edges;
}

function reverseOf(edges) {
  const back = new Map();
  for (const [from, targets] of edges) {
    for (const to of targets) {
      if (!back.has(to)) back.set(to, new Set());
      back.get(to).add(from);
    }
  }
  return back;
}

function reach(start, edges) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const node = queue.shift();
    for (const next of edges.get(node) || []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

function legSensitivity(plan, store, index) {
  const leg = plan.flow[index];
  const secrets = secretKeys(plan);
  const reasons = [];
  if (leg.sensitive === true) reasons.push('explicit');
  if (usesSecret(leg.steps, secrets) || usesSecret(leg.checks, secrets)) reasons.push('own-steps');
  if (SCREEN_NAME.test(String(leg.at || ''))) reasons.push('screen-name');
  if (store && leg.at && leg.to) {
    const edges = edgesOf(store);
    const forward = reach(leg.at, edges);
    if (!forward.has(leg.to)) {
      if ((plan.inputs || []).some((input) => secrets.has(input.name))) reasons.push('unknown-route');
    } else {
      const backward = reach(leg.to, reverseOf(edges));
      const onPath = (id) => forward.has(id) && backward.has(id);
      for (const id of forward) {
        if (id === leg.to || !onPath(id)) continue;
        const screen = store.screens.get(id);
        if (!screen) continue;
        if ((screen.inputs || []).some((name) => secrets.has(name))) reasons.push(`screen-input:${id}`);
        if ((screen.normal || []).some((item) => onPath(item.to) && usesSecret(item.steps, secrets))) reasons.push(`case-step:${id}`);
      }
    }
  }
  return { index, at: leg.at || null, to: leg.to || null, sensitive: reasons.length > 0, reasons };
}

function sensitiveLegsFrom(plan, store, fromIndex = 0) {
  const legs = [];
  for (let index = Math.max(0, fromIndex); index < (plan.flow || []).length; index += 1) {
    const result = legSensitivity(plan, store, index);
    if (result.sensitive) legs.push(result);
  }
  return legs;
}

function planSensitivity(plan, store) {
  const legs = sensitiveLegsFrom(plan, store, 0);
  return { sensitive: legs.length > 0, legs };
}

module.exports = { legSensitivity, planSensitivity, sensitiveLegsFrom };
