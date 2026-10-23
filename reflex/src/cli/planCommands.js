/**
 * planCommands.js — the non-device commands: context show/build and plan validate. Each returns
 * the marker payload; the CLI prints it.
 *
 * `plan validate` loads the SAME knowledge base a run would use, so a typo in a screen id or a
 * broken `normal.yml` is reported here instead of halfway through a live run. A tree that
 * cannot be loaded is a validation error (one marker line, exit 1), never a crash.
 */
const fs = require('fs');
const path = require('path');
const workspace = require('../util/workspace');
const { loadPlan, parseFrontMatter } = require('../plan/loader');
const { validatePlan } = require('../plan/validate');
const { loadStore } = require('../screens/store');
const { buildContext } = require('../context/build');
const { appKey } = require('../runner/app');
const { planSensitivity } = require('../supervisor/sensitivity');

function resolvePath(file) {
  const root = workspace.tryRoot();
  if (root && !path.isAbsolute(file) && fs.existsSync(path.resolve(root, file))) return path.resolve(root, file);
  return path.resolve(file);
}

function relative(file) {
  const root = workspace.tryRoot();
  return root ? path.relative(root, file) : file;
}

/** Every `*.plan.md` of `dir`: only the front-matter fields an agent needs to pick one. */
function listPlans(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.plan.md')).sort().map((name) => {
    const file = path.join(dir, name);
    try {
      const { meta } = parseFrontMatter(fs.readFileSync(file, 'utf8'), file);
      return { file: relative(file), name: meta.name || null, goal: meta.goal || null, status: meta.status || 'draft' };
    } catch (error) {
      return { file: relative(file), error: error.message };
    }
  });
}

function countByStatus(items) {
  const counts = { verified: 0, learned: 0, draft: 0 };
  for (const item of items || []) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}

/** App notes + what the knowledge base knows, so an agent can see what is missing. */
function contextShow({ app }) {
  if (!app) throw new Error('context show requires --app <key>');
  const root = workspace.root();
  const file = path.join(root, 'screens', String(app), '_app', 'context.md');
  const context = fs.existsSync(file) ? relative(file) : null;
  let screens = [];
  let error = null;
  try {
    const store = loadStore(root, app);
    screens = [...store.screens.values()].map((screen) => ({
      id: screen.id,
      cases: countByStatus(screen.normal),
      exceptions: screen.exceptions.length,
    }));
  } catch (loadError) {
    error = loadError.message || String(loadError);
  }
  return {
    app,
    context,
    contextText: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
    screens,
    plans: listPlans(path.join(root, 'plans', String(app))),
    ...(error ? { error } : {}),
  };
}

function contextBuild({ app, src }) {
  if (!app || !src) throw new Error('context build requires --app <key> --src <path to the app source>');
  const { outDir, glossary } = buildContext({ app, src, root: workspace.root() });
  return { app, outDir: relative(outDir), screens: glossary.screens.length, srcCommit: glossary.srcCommit };
}

/** Load the screens tree a run would use; a broken tree becomes a validation error. */
function loadStoreFor(plan) {
  try {
    return { store: loadStore(workspace.root(), appKey(plan)) };
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

function planValidate({ plan }) {
  if (!plan) throw new Error('plan validate requires a plan path');
  const loaded = loadPlan(resolvePath(plan), { root: workspace.root() });
  const { store, error: storeError } = loadStoreFor(loaded);
  const verdict = validatePlan(loaded, { store: store || null });
  const errors = storeError ? [storeError, ...verdict.errors] : verdict.errors;
  return {
    ok: errors.length === 0,
    errors,
    warnings: verdict.warnings,
    plan: loaded.name,
    file: loaded.file,
    legs: loaded.flow.length,
    rows: loaded.rows.length,
    sensitive: planSensitivity(loaded, store || null),
  };
}

module.exports = { contextShow, contextBuild, planValidate };
