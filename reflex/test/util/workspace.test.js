/**
 * workspace.test.js — the workspace resolution order: --workspace, env, pointer file, upward walk, sibling.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const workspace = require('../../src/util/workspace');

const ENV_KEYS = ['REFLEX_PROJECT_DIR', 'REFLEX_HOME'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const savedCwd = process.cwd();

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  process.chdir(savedCwd);
  workspace.reset();
});

/** A temp tree: <tmp>/<name>/reflex.workspace.json for each name, plus an empty home. */
function tree(names) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-ws-')));
  const dirs = {};
  for (const name of names) {
    dirs[name] = path.join(base, name);
    fs.mkdirSync(dirs[name], { recursive: true });
    fs.writeFileSync(path.join(dirs[name], 'reflex.workspace.json'), JSON.stringify({ name }));
  }
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const elsewhere = path.join(base, 'elsewhere', 'deep');
  fs.mkdirSync(elsewhere, { recursive: true });
  // Nothing on the real machine may leak into the resolution.
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.REFLEX_HOME = home;
  return { base, dirs, home, elsewhere };
}

test('--workspace wins over env and must be a workspace', () => {
  const { dirs } = tree(['a', 'b']);
  process.env.REFLEX_PROJECT_DIR = dirs.b;
  workspace.setOverride(dirs.a);
  assert.equal(workspace.root(), dirs.a);
  workspace.setOverride(path.dirname(dirs.a));
  assert.throws(() => workspace.root(), /--workspace .* does not contain reflex.workspace.json/);
});

test('REFLEX_PROJECT_DIR wins over the pointer file; a bad value is an error', () => {
  const { dirs, home } = tree(['a', 'b']);
  fs.mkdirSync(path.join(home, '.reflex', 'app-testing'), { recursive: true });
  fs.writeFileSync(path.join(home, '.reflex', 'app-testing', 'js_repo.txt'), `${dirs.b}\n`);
  process.env.REFLEX_PROJECT_DIR = dirs.a;
  assert.equal(workspace.root(), dirs.a);
  workspace.reset();
  process.env.REFLEX_PROJECT_DIR = path.dirname(dirs.a);
  assert.throws(() => workspace.root(), /REFLEX_PROJECT_DIR=.* does not contain reflex.workspace.json/);
});

test('the pointer file is used when env is unset and cwd has no manifest', () => {
  const { dirs, home, elsewhere } = tree(['a']);
  fs.mkdirSync(path.join(home, '.reflex', 'app-testing'), { recursive: true });
  fs.writeFileSync(path.join(home, '.reflex', 'app-testing', 'js_repo.txt'), `\n  ${dirs.a}  \n`);
  process.chdir(elsewhere);
  assert.equal(workspace.root(), dirs.a);
});

test('the upward walk finds the enclosing workspace', () => {
  const { dirs } = tree(['a']);
  const inside = path.join(dirs.a, 'plans', 'x');
  fs.mkdirSync(inside, { recursive: true });
  process.chdir(inside);
  assert.equal(workspace.root(), dirs.a);
});

test('a sibling workspace is found from a neighbouring folder', () => {
  const { dirs, base } = tree(['workspace']);
  const tool = path.join(base, 'reflex', 'src');
  fs.mkdirSync(tool, { recursive: true });
  process.chdir(tool);
  assert.equal(workspace.root(), dirs['workspace']);
});

test('nothing found is an actionable error', () => {
  const { elsewhere } = tree([]);
  process.chdir(elsewhere);
  assert.equal(workspace.tryRoot(), null);
  assert.throws(() => workspace.root(), /No use-case workspace found/);
});
