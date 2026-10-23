/**
 * env.js — per-workspace configuration from `<workspace>/.env`.
 *
 * Everything app/team-owned (account, PIN, OTP token, Jev key, threshold) lives in the
 * gitignored `.env`, so a plan can be committed without carrying any secret.
 * `process.loadEnvFile` never overrides a variable the shell already set, which is what makes
 * a one-off `REFLEX_TEST_PHONE=… reflex run` (or CI-provided secrets) still win.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_THRESHOLD = 0.75;

/** Load `<root>/.env` into process.env. Shell values win; a missing file is not an error. */
function loadWorkspaceEnv(root) {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return { file: null, loaded: false };
  process.loadEnvFile(file); // Node >= 22: never overrides a variable the shell already set
  return { file, loaded: true };
}

/** CLI flag > JEV_CONFIDENCE_THRESHOLD (.env or shell) > 0.75; anything outside (0, 1] is an error. */
function jevThreshold(flagValue) {
  const raw = [flagValue, process.env.JEV_CONFIDENCE_THRESHOLD].find((v) => v !== undefined && v !== null && String(v).trim() !== '');
  if (raw === undefined) return DEFAULT_THRESHOLD;
  const n = Number(raw);
  if (!(n > 0 && n <= 1)) throw new Error(`jev threshold must be a number in (0, 1] (got "${raw}")`);
  return n;
}

module.exports = { loadWorkspaceEnv, jevThreshold, DEFAULT_THRESHOLD };
