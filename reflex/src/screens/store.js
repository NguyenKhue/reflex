/**
 * store.js — load a `screens/<app>/` knowledge tree and answer the two questions one leg
 * asks: which exception rule applies here, and which case can move me on from this screen.
 *
 * Read-only: flushing learned changes (lock + merge) is `writer.js`. The run counters come from
 * the machine-local ledger (`stats.js`), not from the committed files.
 * Every screen id is `<group>/<screen>`; directories starting with `_` are tiers, not screens.
 */
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { parseFrontMatter } = require('../plan/loader');
const { validateIdentify, validateCase, validateException, validateRoutes } = require('./schema');
const { statsFileOf, statsKeyOf, readStats } = require('./stats');

/** A verified case wins over a learned guess, a learned one over a draft; then the longer streak. */
const STATUS_RANK = { verified: 0, learned: 1, draft: 2 };

function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function readYaml(file) {
  const text = readText(file);
  if (text === null) return undefined;
  if (!text.trim()) return null;
  try {
    return YAML.parse(text);
  } catch (error) {
    throw new Error(`${file}: invalid YAML: ${error.message}`);
  }
}

function asList(parsed, file, what) {
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) throw new Error(`${file}: expected a list of ${what}`);
  return parsed;
}

/** `${to}|${steps}` is the merge key for a case, so a duplicate would make a merge ambiguous. */
function caseKey(item) {
  return `${item.to}|${JSON.stringify(item.steps)}`;
}

function loadCases(dir, toolSpecs) {
  const file = path.join(dir, 'normal.yml');
  const seen = new Set();
  return asList(readYaml(file), file, 'cases').map((item, index) => {
    const validated = validateCase(item, `${file}: case ${index + 1}`, { toolSpecs });
    const key = caseKey(validated);
    if (seen.has(key)) throw new Error(`${file}: case ${index + 1}: duplicate case (same "to" and "steps")`);
    seen.add(key);
    return { ...validated, file, key };
  });
}

function loadRules(file) {
  const seen = new Set();
  return asList(readYaml(file), file, 'rules').map((rule, index) => {
    const at = `${file}: rule "${rule && rule.id ? rule.id : `#${index + 1}`}"`;
    const validated = validateException(rule, at);
    if (seen.has(validated.id)) throw new Error(`${at}: duplicate id`);
    seen.add(validated.id);
    return { ...validated, file, key: validated.id };
  });
}

function loadRoutes(file) {
  return validateRoutes(readYaml(file), file).map((route) => route.path);
}

function subdirs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function loadScreen(screenDir, group, name, toolSpecs) {
  const mdFile = path.join(screenDir, 'screen.md');
  if (!fs.existsSync(mdFile)) throw new Error(`${screenDir}: screen.md is required`);
  const { meta, body } = parseFrontMatter(fs.readFileSync(mdFile, 'utf8'), mdFile);
  const id = `${group}/${name}`;
  if (meta.id !== id) throw new Error(`${mdFile}: "id" must be "${id}" (got "${meta.id === undefined ? '' : meta.id}")`);
  const identify = validateIdentify(meta.identify, `${mdFile}: identify`);
  if (meta.inputs !== undefined && !(Array.isArray(meta.inputs) && meta.inputs.every((item) => typeof item === 'string' && item.trim()))) {
    throw new Error(`${mdFile}: "inputs" must be a list of input names`);
  }
  return {
    id,
    group,
    dir: screenDir,
    file: mdFile,
    identify,
    inputs: (meta.inputs || []).map(String),
    body: String(body).trim(),
    normal: loadCases(screenDir, toolSpecs),
    exceptions: loadRules(path.join(screenDir, 'exceptions.yml')),
  };
}

/**
 * `loadStore(root, app)` -> { app, root, screens, groups, appTier, shared, routes }.
 * Missing OPTIONAL files (normal.yml, exceptions.yml, context.md, routes.yml) are empty;
 * a broken file throws with its path, so `plan validate` can report it before a session opens.
 */
function loadStore(root, app, { toolSpecs } = {}) {
  if (!app) throw new Error('loadStore needs an app key');
  const screensRoot = path.join(root, 'screens');
  const appDir = path.join(screensRoot, String(app));
  if (!fs.existsSync(appDir)) throw new Error(`${appDir}: no screens directory for app "${app}"`);
  const appTierDir = path.join(appDir, '_app');
  const store = {
    app: String(app),
    root: screensRoot,
    screens: new Map(),
    groups: new Map(),
    appTier: {
      dir: appTierDir,
      context: readText(path.join(appTierDir, 'context.md')),
      exceptions: loadRules(path.join(appTierDir, 'exceptions.yml')),
    },
    shared: loadRules(path.join(screensRoot, '_shared', 'exceptions.yml')),
    routes: loadRoutes(path.join(appTierDir, 'routes.yml')),
  };
  for (const group of subdirs(appDir)) {
    if (group.startsWith('_')) continue;
    const groupDir = path.join(appDir, group);
    const miniappDir = path.join(groupDir, '_miniapp');
    store.groups.set(group, {
      dir: groupDir,
      context: readText(path.join(miniappDir, 'context.md')),
      exceptions: loadRules(path.join(miniappDir, 'exceptions.yml')),
    });
    for (const name of subdirs(groupDir)) {
      if (name.startsWith('_')) continue;
      const screen = loadScreen(path.join(groupDir, name), group, name, toolSpecs);
      store.screens.set(screen.id, screen);
    }
  }
  overlayStats(store, root);
  return store;
}

/**
 * The counters of this machine's runs replace a `stats:` still written in a screen file; the
 * files only carry the status those counters led to.
 */
function overlayStats(store, root) {
  const ledger = readStats(statsFileOf(root));
  const overlay = (items) => items.forEach((item, index) => {
    const stats = ledger[statsKeyOf(root, item.file, item.key)];
    if (stats && typeof stats === 'object') items[index] = { ...item, stats };
  });
  for (const screen of store.screens.values()) {
    overlay(screen.normal);
    overlay(screen.exceptions);
  }
  for (const group of store.groups.values()) overlay(group.exceptions);
  overlay(store.appTier.exceptions);
}

function groupOf(screenId) {
  return String(screenId || '').split('/')[0];
}

/**
 * Rules to check at the current screen, in the order that stops first: the policy tier for
 * every app (eKYC → fail), the screen's own rules, its mini app's, then the app's.
 * `legGroup` is used when the screen could not be identified.
 */
function exceptionTiers(store, screenId, legGroup) {
  const tiers = [...store.shared];
  const screen = screenId ? store.screens.get(screenId) : null;
  if (screen) tiers.push(...screen.exceptions);
  const group = store.groups.get(screen ? screen.group : groupOf(legGroup));
  if (group) tiers.push(...group.exceptions);
  return [...tiers, ...store.appTier.exceptions];
}

/**
 * Screens a leg may stand on: its two ends, every screen of their groups, and every `core/*`
 * screen — anything else is out of scope for this leg and must not win identification.
 */
function candidateScreens(store, leg) {
  const ids = new Set();
  const add = (id) => { if (id && store.screens.has(id)) ids.add(id); };
  add(leg && leg.at);
  add(leg && leg.to);
  for (const id of [leg && leg.at, leg && leg.to]) {
    const group = groupOf(id);
    for (const screen of store.screens.values()) if (screen.group === group) ids.add(screen.id);
  }
  for (const screen of store.screens.values()) if (screen.group === 'core') ids.add(screen.id);
  return [...ids];
}

function streakOf(item) {
  const streak = item.stats && Number(item.stats.streak);
  return Number.isFinite(streak) ? streak : 0;
}

function byRankThenStreak(a, b) {
  // `status` is validated against CASE_STATUS, so the rank is always defined; an unknown one
  // would fall through to the streak rather than throw mid-run.
  return (STATUS_RANK[a.status] - STATUS_RANK[b.status]) || (streakOf(b) - streakOf(a));
}

/**
 * Cases of `screenId` that could move the leg toward `legTo`, best first:
 *  (a) the single hop to `legTo`;
 *  (b) the screen right after `screenId` on a recorded route that ends at `legTo`;
 *  (c) any other case to a candidate screen this leg has not visited yet, same group first.
 * (c) is what makes a multi-hop leg work on the very first run, with `routes` still empty.
 */
/** True when `legTo` can be reached from `from` by following known one-hop cases (any status). */
function canReach(store, from, legTo) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const screen = store.screens.get(queue.shift());
    for (const item of screen ? screen.normal : []) {
      if (item.to === legTo) return true;
      if (!seen.has(item.to)) {
        seen.add(item.to);
        queue.push(item.to);
      }
    }
  }
  return false;
}

function casesFor(store, screenId, legTo, { visited = new Set(), candidates = new Set() } = {}) {
  const screen = screenId ? store.screens.get(screenId) : null;
  if (!screen) return [];
  const picked = [];
  const seen = new Set();
  const push = (items) => {
    for (const item of [...items].sort(byRankThenStreak)) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      picked.push(item);
    }
  };

  push(screen.normal.filter((item) => item.to === legTo));

  const nextOnRoute = new Set();
  for (const route of store.routes) {
    if (route[route.length - 1] !== legTo) continue;
    const at = route.indexOf(screenId);
    if (at >= 0 && at + 1 < route.length) nextOnRoute.add(route[at + 1]);
  }
  push(screen.normal.filter((item) => nextOnRoute.has(item.to)));

  // Exploring is only worth it when the knowledge says the destination is reachable through that hop: otherwise the
  // runner would wander across unrelated screens and stop far from where the leg started.
  const rest = screen.normal.filter((item) => candidates.has(item.to) && !visited.has(item.to) && canReach(store, item.to, legTo));
  push(rest.filter((item) => groupOf(item.to) === groupOf(legTo)));
  push(rest.filter((item) => groupOf(item.to) !== groupOf(legTo)));
  return picked;
}

module.exports = { loadStore, exceptionTiers, candidateScreens, casesFor, groupOf, STATUS_RANK };
