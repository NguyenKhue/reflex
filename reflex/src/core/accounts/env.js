/**
 * env.js — the default account provider: where a test account's phone / password / PIN come from.
 *
 * REFLEX_TEST_* wins (D4); anything else falls through to the workspace chain that existed before
 * (the manifest's defaults.account). A value is never put in an error message: they are phones,
 * passwords and PINs.
 */
function envKey(prefix, name, platform) {
  const base = `${prefix}${String(name).toUpperCase()}`;
  return platform ? `${base}_${String(platform).toUpperCase()}` : base;
}

function present(value) {
  return value !== undefined && value !== null && value !== '' ? String(value) : undefined;
}

function createEnvAccountProvider({ workspace, env = process.env, prefixes = ['REFLEX_TEST_'] } = {}) {
  return {
    get(name, { platform } = {}) {
      for (const prefix of prefixes) {
        const specific = platform ? present(env[envKey(prefix, name, platform)]) : undefined;
        if (specific !== undefined) return specific;
        const shared = present(env[envKey(prefix, name)]);
        if (shared !== undefined) return shared;
      }
      let account = {};
      try {
        account = (workspace && workspace.defaults(platform).account) || {};
      } catch (_) {
        account = {}; // no workspace root: the plan's own data has to carry the value
      }
      return present(account[name]);
    },
  };
}

module.exports = { createEnvAccountProvider };
