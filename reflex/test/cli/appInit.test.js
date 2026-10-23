/**
 * appInit.test.js — `reflex app init`: a new app lands in the manifest with its `screens/<key>/_app/` notes,
 * everything is validated before the first write, an existing app is never overwritten, the result is immediately
 * usable by the runner, and the CLI keeps the marker / exit-code contract.
 * No device: every test works in its own temp workspace written by hand.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { appInit } = require('../../src/cli/appCommands');
const { loadStore } = require('../../src/screens/store');
const { resolveApp } = require('../../src/runner/app');
const workspace = require('../../src/util/workspace');

const BIN = path.join(__dirname, '..', '..', 'bin', 'reflex.js');

const MANIFEST = {
  name: 't',
  defaults: { platform: 'android' },
  apps: { old: { android: { package: 'com.example.old' } } },
};

const BAD_KEY = 'app init requires an app key: lowercase letters, digits and underscores, starting with a letter (got ';
const NO_TARGET = 'app init requires --package <android package> and/or --bundle-id <ios bundle id>';
const badId = (value) => `"${value}" is not a valid package / bundle id (expected dotted names such as com.example.app)`;
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

let root;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-appinit-')));
  writeManifest(root, 'reflex.workspace.json');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeManifest(target, name, contents = MANIFEST) {
  fs.writeFileSync(path.join(target, name), `${JSON.stringify(contents, null, 2)}\n`);
}

function manifestText(name = 'reflex.workspace.json') {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

function manifestOf(name = 'reflex.workspace.json') {
  return JSON.parse(manifestText(name));
}

/** Every file below the workspace root, so "nothing was written" is checked without guessing paths. */
function treeOf() {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else files.push(relative);
    }
  };
  walk(root, '');
  return files;
}

function cli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
  const markers = result.stdout.split('\n').filter((line) => line.startsWith('REFLEX_JSON '));
  return {
    code: result.status,
    markers,
    marker: markers.length ? JSON.parse(markers[markers.length - 1].slice('REFLEX_JSON '.length)) : null,
    stderr: result.stderr,
  };
}

test('success: the app is registered and its three _app notes are written, the rest of the manifest untouched', () => {
  const result = appInit({
    key: 'settings',
    package: 'com.android.settings',
    activity: '.Settings',
    bundleId: 'com.apple.Preferences',
    root,
  });
  assert.equal(result.ok, true);
  assert.equal(result.app, 'settings');
  assert.equal(result.manifest, 'reflex.workspace.json');
  assert.deepEqual(result.created, [
    path.join('screens', 'settings', '_app', 'context.md'),
    path.join('screens', 'settings', '_app', 'exceptions.yml'),
    path.join('screens', 'settings', '_app', 'routes.yml'),
  ]);

  const manifest = manifestOf();
  assert.deepEqual(manifest.apps.settings, {
    android: { package: 'com.android.settings', activity: '.Settings' },
    ios: { bundleId: 'com.apple.Preferences' },
  });
  // The apps that were already registered, and everything else, are left as they were.
  assert.deepEqual(manifest.apps.old, { android: { package: 'com.example.old' } });
  assert.deepEqual(manifest.defaults, { platform: 'android' });
  assert.equal(manifest.name, 't');

  assert.ok(read(path.join('screens', 'settings', '_app', 'context.md')).startsWith('# settings — notes'));
  assert.equal(read(path.join('screens', 'settings', '_app', 'exceptions.yml')), '[]\n');
  assert.equal(read(path.join('screens', 'settings', '_app', 'routes.yml')), '[]\n');
});

test('package only and bundle id only: the entry carries just the platform that was named', () => {
  appInit({ key: 'androidonly', package: 'com.example.androidonly', root });
  const androidEntry = manifestOf().apps.androidonly;
  assert.deepEqual(androidEntry, { android: { package: 'com.example.androidonly' } });
  assert.equal('activity' in androidEntry.android, false);
  assert.equal('ios' in androidEntry, false);

  appInit({ key: 'iosonly', bundleId: 'com.example.iosonly', root });
  const iosEntry = manifestOf().apps.iosonly;
  assert.deepEqual(iosEntry, { ios: { bundleId: 'com.example.iosonly' } });
  assert.equal('android' in iosEntry, false);
});

test('the new app is usable at once: its store loads empty and a plan naming it resolves the package', () => {
  appInit({ key: 'settings', package: 'com.android.settings', activity: '.Settings', root });

  const store = loadStore(root, 'settings');
  assert.equal(store.screens.size, 0);
  assert.equal(store.appTier.exceptions.length, 0);
  assert.deepEqual(store.routes, []);

  workspace.setOverride(root);
  try {
    const resolved = resolveApp({ name: 'p', app: 'settings' }, {}, 'android');
    assert.equal(resolved.package, 'com.android.settings');
    assert.equal(resolved.activity, '.Settings');
  } finally {
    workspace.reset();
  }
});

test('a duplicate key and an existing screens dir are both refused with nothing written', () => {
  const before = manifestText();
  const files = treeOf();

  assert.throws(() => appInit({ key: 'old', package: 'com.example.old', root }), {
    message: 'app "old" is already in reflex.workspace.json',
  });

  fs.mkdirSync(path.join(root, 'screens', 'fresh'), { recursive: true });
  assert.throws(() => appInit({ key: 'fresh', package: 'com.example.fresh', root }), {
    message: `${path.join('screens', 'fresh')} already exists`,
  });

  assert.equal(manifestText(), before);
  // The dir the test made is still empty (no _app notes) and no file appeared anywhere; the manifest has no entry.
  assert.deepEqual(treeOf(), files);
  assert.deepEqual(fs.readdirSync(path.join(root, 'screens', 'fresh')), []);
  assert.equal(manifestOf().apps.fresh, undefined);
});

test('a bad key, a missing target and a bad id are refused before the first write', () => {
  const before = manifestText();
  const files = treeOf();

  for (const key of ['', undefined, 'Bad Key', '1x', 'a-b']) {
    assert.throws(() => appInit({ key, package: 'com.example.app', root }), {
      message: `${BAD_KEY}"${key || ''}")`,
    });
  }
  assert.throws(() => appInit({ key: 'good_key', root }), { message: NO_TARGET });
  for (const value of ['nodots', 'a..b', 'com.example.']) {
    assert.throws(() => appInit({ key: 'good_key', package: value, root }), { message: badId(value) });
  }

  assert.equal(manifestText(), before);
  assert.deepEqual(treeOf(), files);
  assert.equal(fs.existsSync(path.join(root, 'screens')), false);
});

test('a workspace without a manifest is refused before any directory is created', () => {
  fs.rmSync(path.join(root, 'reflex.workspace.json'));

  assert.throws(() => appInit({ key: 'settings', package: 'com.android.settings', root }), {
    message: /has no reflex\.workspace\.json/,
  });
  assert.equal(fs.existsSync(path.join(root, 'screens')), false);
});

test('an unreadable manifest is refused before any directory is created', () => {
  fs.writeFileSync(path.join(root, 'reflex.workspace.json'), '{ nope');

  assert.throws(() => appInit({ key: 'settings', package: 'com.android.settings', root }), {
    message: /^reflex\.workspace\.json is not valid JSON:/,
  });
  assert.equal(fs.existsSync(path.join(root, 'screens')), false);
});

test('CLI: app init --json exits 0 with one marker, and the same command again exits 1', () => {
  const first = cli(['app', 'init', 'newapp', '--package', 'com.example.newapp', '--json', '--workspace', root]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.markers.length, 1, first.markers.join('\n'));
  assert.equal(first.marker.ok, true);
  assert.equal(first.marker.app, 'newapp');
  assert.equal(first.marker.manifest, 'reflex.workspace.json');
  assert.deepEqual(manifestOf().apps.newapp, { android: { package: 'com.example.newapp' } });

  const second = cli(['app', 'init', 'newapp', '--package', 'com.example.newapp', '--json', '--workspace', root]);
  assert.equal(second.code, 1, second.stderr);
  assert.equal(second.markers.length, 1, second.markers.join('\n'));
  assert.equal(second.marker.ok, false);
  assert.ok(second.marker.error.includes('already in'), second.marker.error);
});
