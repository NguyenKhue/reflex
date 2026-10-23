/**
 * rename.test.js — the names the tool answers to: the `REFLEX_JSON` marker, the
 * `reflex.workspace.json` lookup, the `REFLEX_*` env names, the `~/.reflex` pointer file and the
 * `.reflex` state folder. There is one name for each of them; nothing older is read.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { MARKER, parseMarker } = require('../../src/util/markers');
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

/** A temp tree: <tmp>/<name>/ with a reflex.workspace.json, an empty home and a cwd outside any workspace. */
function tree(names) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-rename-')));
  const dirs = {};
  for (const name of names) {
    dirs[name] = path.join(base, name);
    fs.mkdirSync(dirs[name], { recursive: true });
    fs.writeFileSync(path.join(dirs[name], 'reflex.workspace.json'), JSON.stringify({ name }));
  }
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const outside = path.join(base, 'outside', 'deep');
  fs.mkdirSync(outside, { recursive: true });
  // Nothing on the real machine may leak into the resolution.
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.REFLEX_HOME = home;
  process.chdir(outside);
  workspace.reset();
  return { base, dirs, home, outside };
}

function writePointer(home, dir) {
  fs.mkdirSync(path.join(home, '.reflex', 'app-testing'), { recursive: true });
  fs.writeFileSync(path.join(home, '.reflex', 'app-testing', 'js_repo.txt'), `${dir}\n`);
}

test('the marker is REFLEX_JSON', () => {
  assert.equal(MARKER, 'REFLEX_JSON');
  assert.deepEqual(parseMarker('REFLEX_JSON {"a":1}'), { a: 1 });
});

test('parseMarker rejects anything that is not a marker line', () => {
  assert.equal(parseMarker(''), null);
  assert.equal(parseMarker(null), null);
  assert.equal(parseMarker('hello'), null);
  assert.equal(parseMarker('REFLEX_JSON {broken'), null);
  // The space after the name is part of the contract.
  assert.equal(parseMarker('REFLEX_JSON{"a":1}'), null);
});

test('a dir with only reflex.workspace.json is a workspace', () => {
  const { dirs } = tree(['a']);
  process.env.REFLEX_PROJECT_DIR = dirs.a;
  assert.equal(workspace.root(), dirs.a);
  assert.equal(workspace.manifest().name, 'a');
});

test('REFLEX_PROJECT_DIR wins over the pointer file', () => {
  const { dirs, home } = tree(['a', 'b']);
  writePointer(home, dirs.b);
  process.env.REFLEX_PROJECT_DIR = dirs.a;
  assert.equal(workspace.root(), dirs.a);
});

test('a non-workspace REFLEX_PROJECT_DIR is an error naming the env and the manifest', () => {
  const { dirs } = tree(['a']);
  process.env.REFLEX_PROJECT_DIR = path.dirname(dirs.a);
  assert.throws(
    () => workspace.root(),
    (error) => {
      assert.match(error.message, /REFLEX_PROJECT_DIR=/);
      assert.match(error.message, /reflex\.workspace\.json/);
      return true;
    }
  );
});

test('the pointer file is read from ~/.reflex', () => {
  const { dirs, home } = tree(['a']);
  writePointer(home, dirs.a);
  assert.equal(workspace.root(), dirs.a);
});

test('a pointer to a dir that is not a workspace is ignored', () => {
  const { base, home } = tree([]);
  writePointer(home, path.join(base, 'outside', 'deep'));
  assert.equal(workspace.tryRoot(), null);
  assert.throws(() => workspace.root(), /No use-case workspace found/);
});

test('stateDir is always <root>/.reflex', () => {
  const { dirs } = tree(['a']);
  process.env.REFLEX_PROJECT_DIR = dirs.a;
  assert.equal(workspace.stateDir(), path.join(dirs.a, '.reflex'));
});
