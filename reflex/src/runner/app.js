/**
 * app.js — resolve the app a plan targets: CLI `--app`/`--activity` override, then the plan's
 * `app` front-matter (a workspace `apps.<key>.<platform>` mapping or an inline mapping).
 */
const workspace = require('../util/workspace');

function stringArg(value) {
  return value && value !== true ? String(value) : null;
}

/** Returns `{ package, activity, bundleId }` for `plan = { name, app }`. */
function resolveApp(plan, args = {}, platform = 'android') {
  const declared = plan ? plan.app : null;
  const name = plan ? plan.name : '-';
  let target = null;
  if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
    target = declared[platform] || declared;
  } else if (typeof declared === 'string' && declared) {
    const apps = workspace.manifest().apps || {};
    target = (apps[declared] || {})[platform] || null;
    if (!target) {
      throw new Error(`plan "${name}" declares app "${declared}" but the workspace manifest has no apps.${declared}.${platform}`);
    }
  }
  const source = target || {};
  const cliApp = stringArg(args.app);
  const package_ = cliApp || source.package || null;
  const bundleId = cliApp || source.bundleId || (platform === 'ios' ? source.package || null : null);
  const activity = stringArg(args.activity) || source.activity || null;
  if (platform === 'ios') {
    if (!bundleId) throw new Error(`no iOS bundle id for plan "${name}": pass --app <bundle id> or declare app.bundleId`);
    return { package: bundleId, activity, bundleId };
  }
  if (!package_) throw new Error(`no Android package for plan "${name}": pass --app <package> or declare app.package`);
  return { package: package_, activity, bundleId: null };
}

/** Context/interruption key of a plan: its `app` key, or the plan name for an inline mapping. */
function appKey(plan) {
  return typeof plan.app === 'string' && plan.app ? plan.app : plan.name;
}

module.exports = { resolveApp, appKey };
