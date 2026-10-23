/**
 * workspace.js — resolve the USE-CASE WORKSPACE reflex operates on.
 *
 * The tool is generic; everything app/team-owned (plans, examples, blocks, context packs,
 * reports) lives in a workspace marked by a `reflex.workspace.json` manifest at its root.
 *
 * Resolution order (first hit wins):
 *   1. setOverride(dir)                       — the CLI `--workspace <dir>` flag
 *   2. env REFLEX_PROJECT_DIR
 *   3. ~/.reflex/app-testing/js_repo.txt — first non-empty line, used only if it is a workspace
 *   4. walk up from process.cwd()
 *   5. a sibling `workspace/` of cwd or any of its ancestors
 * An explicit choice (1, 2) that is not a workspace is an error; the implicit ones are skipped.
 *
 * Every accessor is lazy + memoized: requiring this module NEVER touches the filesystem,
 * so workspace-optional commands (doctor on a fresh machine) still load.
 *
 * Config (accounts, tokens, thresholds) lives in the gitignored `<workspace>/.env`, loaded
 * once by the CLI; the manifest holds only what is safe to commit.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// The one manifest name that marks a use-case workspace.
const MANIFEST_NAMES = ['reflex.workspace.json'];
const MANIFEST_LABEL = 'reflex.workspace.json';
const SIBLING_NAME = 'workspace';

const DEFAULTS = {
  reportsDir: 'reports',
  defaults: {},
};

let _root; // undefined = not resolved yet; null = resolved-and-missing
let _manifest;
let _override = null;

function manifestPath(dir) {
  if (!dir) return null;
  for (const name of MANIFEST_NAMES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function isWorkspace(dir) {
  return manifestPath(dir) !== null;
}

/** The single environment prefix the tool reads. */
function envOf(name) {
  return process.env[`REFLEX_${name}`] || '';
}

function findUp(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (isWorkspace(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findSibling(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, SIBLING_NAME);
    if (isWorkspace(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function expandHome(value) {
  const home = envOf('HOME') || os.homedir();
  return value === '~' || value.startsWith('~/') ? path.join(home, value.slice(1)) : value;
}

function pointerFile() {
  const home = envOf('HOME') || os.homedir();
  const file = path.join(home, '.reflex', 'app-testing', 'js_repo.txt');
  if (!fs.existsSync(file)) return null;
  const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  if (!line) return null;
  const dir = path.resolve(expandHome(line));
  return isWorkspace(dir) ? dir : null;
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

/** Workspace root dir or null. Throws only for an explicit choice that is not a workspace. */
function tryRoot() {
  if (_root !== undefined) return _root;
  if (_override) {
    const abs = path.resolve(_override);
    if (!isWorkspace(abs)) throw new Error(`--workspace ${_override} does not contain ${MANIFEST_LABEL}`);
    _root = abs;
    return _root;
  }
  const envDir = (process.env.REFLEX_PROJECT_DIR || '').trim();
  if (envDir) {
    const abs = path.resolve(expandHome(envDir));
    if (!isWorkspace(abs)) {
      // An explicit env pointing at a non-workspace is a config error worth surfacing.
      throw new Error(`REFLEX_PROJECT_DIR=${envDir} does not contain ${MANIFEST_LABEL}. Point it at a use-case workspace root.`);
    }
    _root = abs;
    return _root;
  }
  _root = pointerFile() || findUp(process.cwd()) || findSibling(process.cwd());
  return _root;
}

/** Workspace root dir. Throws an actionable error when unresolvable. */
function root() {
  const dir = tryRoot();
  if (!dir) {
    throw new Error(
      `No use-case workspace found from ${process.cwd()}. ` +
      'Pass --workspace <dir>, set REFLEX_PROJECT_DIR, or cd into a directory containing reflex.workspace.json.'
    );
  }
  return dir;
}

/** Parsed manifest (committed only), with defaults filled in. */
function manifest() {
  if (_manifest) return _manifest;
  const dir = root();
  const base = JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'));
  _manifest = deepMerge(DEFAULTS, base);
  return _manifest;
}

function reportsDir() {
  return path.resolve(root(), manifest().reportsDir || DEFAULTS.reportsDir);
}

function stateDir() {
  return path.join(root(), '.reflex');
}

/** Workspace defaults (platform, account…) merged with env overrides. */
/**
 * `platform` picks a per-platform account first (`REFLEX_TEST_PHONE_ANDROID`, `REFLEX_TEST_PASSWORD_IOS`, …):
 * Android and iOS sharing one UAT account log each other out (a login on one device invalidates the
 * other's token), so plans running on both platforms at once need two accounts.
 */
function defaults(platform) {
  const d = manifest().defaults || {};
  const account = { ...(d.account || {}) };
  const suffix = platform ? `_${String(platform).toUpperCase()}` : '';
  const env = (name) => (suffix && process.env[`${name}${suffix}`]) || process.env[name];
  if (env('REFLEX_TEST_PHONE')) account.phone = env('REFLEX_TEST_PHONE');
  if (env('REFLEX_TEST_PASSWORD')) {
    account.password = env('REFLEX_TEST_PASSWORD');
    account.pin = account.pin || env('REFLEX_TEST_PASSWORD');
  }
  if (env('REFLEX_TEST_PIN')) account.pin = env('REFLEX_TEST_PIN');
  return { ...d, account };
}

/** `--workspace <dir>`: wins over every other source. */
function setOverride(dir) {
  _override = dir ? String(dir) : null;
  _root = undefined;
  _manifest = undefined;
}

/** For tests / long-lived processes that change cwd or env. */
function reset() {
  _root = undefined;
  _manifest = undefined;
  _override = null;
}

module.exports = {
  MANIFEST_NAME: MANIFEST_NAMES[0],
  tryRoot,
  root,
  manifest,
  defaults,
  reportsDir,
  stateDir,
  setOverride,
  reset,
};
