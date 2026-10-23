/**
 * screenCommands.test.js — `screen capture | list | identify` against the state-machine device:
 * what lands in `screens/`, what may never land there (a value the app printed, an editable
 * field's label), how an existing `screen.md` grows, and how the CLI/MCP surface it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const workspace = require('../../src/util/workspace');
const { screenCapture, screenList, screenIdentify } = require('../../src/cli/screenCommands');
const { loadStore } = require('../../src/screens/store');
const { parseFrontMatter } = require('../../src/plan/loader');
const { validateIdentify } = require('../../src/screens/schema');
const handlers = require('../../src/mcp/handlers');
const { createScreenDevice } = require('../fixtures/screens');
const { writeStore } = require('../fixtures/screenStore');

const BIN = path.join(__dirname, '..', '..', 'bin', 'reflex.js');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'workspace');
/** The manifest marker the tool reads, written over the copy so the temp root is a workspace. */
const MANIFEST = {
  name: 'fixture',
  reportsDir: 'reports',
  defaults: { platform: 'android', account: { phone: '0900000000', password: '123456' } },
  apps: { example: { android: { package: 'com.example.app', activity: 'com.example.app.MainActivity' } } },
};
/** A phone the app prints back on screen — the value that must never leave the device. */
const PHONE = '0900000005';

const SCREENS = {
  // A signed-in wallet screen: one printed account value, one editable field (on Android its
  // label IS its value), one test id, and prose worth keeping as an `identify` hint.
  profile: ['Acme Example', 'Ví Acme', `Số ví: ${PHONE}`, { label: 'Số điện thoại', editable: true }, { label: 'btn_continue' }],
  home: ['Acme Example', 'Đăng nhập'],
  stranger: ['Màn hình chưa ai đặt tên'],
  // Nothing a screen could be recognized by: a clock and an amount are both refused.
  blank: ['9:41', 'Tổng: 1.000.000đ'],
  // A React-Native style screen whose only handle is a test id.
  bare: [{ label: '', identifier: 'btn_only' }],
};

let root;
let savedPhone;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-screen-')));
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.writeFileSync(path.join(root, 'reflex.workspace.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  workspace.reset();
  workspace.setOverride(root);
  savedPhone = process.env.REFLEX_TEST_PHONE;
  // The filter knows the RESOLVED account: the env value wins over the manifest default.
  process.env.REFLEX_TEST_PHONE = PHONE;
});
afterEach(() => {
  if (savedPhone === undefined) delete process.env.REFLEX_TEST_PHONE;
  else process.env.REFLEX_TEST_PHONE = savedPhone;
  workspace.reset();
});

/** A device standing on one of `SCREENS`, wired into the injected backend factory. */
function device(start) {
  const created = [];
  return {
    created,
    createBackend: () => {
      const backend = createScreenDevice({ screens: SCREENS, start });
      created.push(backend);
      return backend;
    },
  };
}

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function cli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, REFLEX_PROJECT_DIR: root } });
  const markers = result.stdout.split('\n').filter((line) => line.startsWith('REFLEX_JSON '));
  return {
    code: result.status,
    markers,
    marker: markers.length ? JSON.parse(markers[markers.length - 1].slice('REFLEX_JSON '.length)) : null,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test('screen capture writes a draft screen.md the store can load', async () => {
  const { createBackend, created } = device('profile');
  const result = await screenCapture({ as: 'core/profile', app: 'example', createBackend });

  assert.equal(result.created, true);
  assert.equal(result.file, path.join('screens', 'example', 'core', 'profile', 'screen.md'));
  assert.deepEqual(result.ids, ['btn_continue']);
  assert.equal(result.texts, 3); // "Acme Example", "Ví Acme" and the test id as a text
  assert.equal(result.dropped, 1); // the printed wallet number
  assert.equal(created[0].closed, 1); // the session is always closed

  const text = read(result.file);
  assert.match(text, /^Captured \d{4}-\d{2}-\d{2} \(draft — review identify before use\)\.$/m);
  assert.match(text, /^- Ví Acme$/m);

  // The front-matter is what a run reads: it parses, validates and identifies the same way.
  const { meta, body } = parseFrontMatter(text, result.file);
  assert.equal(meta.id, 'core/profile');
  assert.deepEqual(meta.inputs, []);
  assert.deepEqual(meta.identify, { allText: ['Acme Example', 'Ví Acme'], anyId: ['btn_continue'] });
  assert.deepEqual(validateIdentify(meta.identify, 'identify'), meta.identify);
  assert.deepEqual(result.identify, meta.identify);
  assert.match(body, /^Captured /m);
  assert.match(body, /^Texts:$/m);
  assert.match(body, /^- btn_continue$/m);
  assert.match(body, /^Test IDs:$/m);

  // The empty knowledge files the store expects, and a store that accepts the new screen.
  assert.equal(read(path.join('screens', 'example', 'core', 'profile', 'normal.yml')), '[]\n');
  assert.equal(read(path.join('screens', 'example', 'core', 'profile', 'exceptions.yml')), '[]\n');
  assert.deepEqual(loadStore(root, 'example').screens.get('core/profile').identify, meta.identify);
  const listed = screenList({ app: 'example' }).screens.find((screen) => screen.id === 'core/profile');
  assert.deepEqual(listed, { id: 'core/profile', cases: { verified: 0, learned: 0, draft: 0 }, exceptions: 0 });
});

test('a screen whose only handle is a test id still gets an identify', async () => {
  const result = await screenCapture({ as: 'core/bare', app: 'example', createBackend: device('bare').createBackend });
  assert.deepEqual(result.identify, { anyId: ['btn_only'] });
  assert.equal(result.texts, 0);
  // The empty side of a section is written out, so the agent sees what the screen gave.
  assert.match(read(result.file), /^Texts:\n- \(none\)$/m);
});

test('screen capture appends a section and never rewrites the front-matter', async () => {
  await screenCapture({ as: 'core/profile', app: 'example', createBackend: device('profile').createBackend });
  const before = read(path.join('screens', 'example', 'core', 'profile', 'screen.md'));

  const again = await screenCapture({ as: 'core/profile', app: 'example', createBackend: device('profile').createBackend });
  assert.equal(again.created, false);
  assert.equal(again.texts, 3);

  const after = read(path.join('screens', 'example', 'core', 'profile', 'screen.md'));
  assert.ok(after.startsWith(before), 'an existing body is only appended to');
  assert.equal((after.match(/^## Capture /gm) || []).length, 1);
  assert.match(after, /^## Capture \d{4}-\d{2}-\d{2}$/m);
  assert.deepEqual(parseFrontMatter(after, again.file).meta, parseFrontMatter(before, again.file).meta);
});

test('a value the app printed never reaches the file or the result', async () => {
  const result = await screenCapture({ as: 'core/profile', app: 'example', createBackend: device('profile').createBackend });
  const text = read(result.file);

  assert.ok(!text.includes(PHONE), 'the printed phone is not in the file');
  assert.ok(!JSON.stringify(result).includes(PHONE), 'the printed phone is not in the result');
  // An editable field's label is its typed value on Android: never read, never written.
  assert.ok(!text.includes('Số điện thoại'));
  assert.ok(!JSON.stringify(result).includes('Số điện thoại'));
  assert.equal(result.dropped, 1);
});

test('screen capture refuses a screen it cannot identify, and a bad input with no session', async () => {
  const blank = device('blank');
  await assert.rejects(
    () => screenCapture({ as: 'core/blank', app: 'example', createBackend: blank.createBackend }),
    /nothing on this screen can identify it/,
  );
  assert.equal(fs.existsSync(path.join(root, 'screens', 'example', 'core', 'blank', 'screen.md')), false);

  const untouched = device('profile');
  await assert.rejects(() => screenCapture({ as: 'Core/Profile', app: 'example', createBackend: untouched.createBackend }), /requires --as <group>\/<screen>/);
  await assert.rejects(() => screenCapture({ as: 'core/profile', app: 'ghost', createBackend: untouched.createBackend }), /unknown app "ghost" for android/);
  await assert.rejects(() => screenCapture({ as: 'core/profile', app: 'example', platform: 'ios', createBackend: untouched.createBackend }), /unknown app "example" for ios/);
  assert.equal(untouched.created.length, 0, 'a bad input must not cost a device session');
});

test('screen list counts every screen of the app by case status', () => {
  const result = screenList({ app: 'example' });
  assert.deepEqual(result.screens.map((screen) => screen.id), ['core/home', 'core/login', 'core/password']);
  assert.deepEqual(result.screens.find((screen) => screen.id === 'core/home').cases, { verified: 1, learned: 0, draft: 0 });
  assert.deepEqual(result.screens.find((screen) => screen.id === 'core/password'), { id: 'core/password', cases: { verified: 0, learned: 0, draft: 0 }, exceptions: 0 });
  assert.throws(() => screenList({}), /requires --app/);
});

test('screen identify names the screen the device shows, or reports a tie', async () => {
  const onHome = device('home');
  const home = await screenIdentify({ app: 'example', createBackend: onHome.createBackend });
  assert.equal(home.screen, 'core/home');
  assert.deepEqual(home.ambiguous, []);
  assert.ok(home.texts.includes('Acme Example'));
  assert.equal(onHome.created[0].closed, 1);

  assert.equal((await screenIdentify({ app: 'example', createBackend: device('stranger').createBackend })).screen, null);

  // A second screen that matches just as well (same conditions, same count) is a tie, never a
  // coin flip — the loop warns instead of driving the run from the wrong screen.
  const twin = { identify: { allText: ['Acme Example'], noneText: ['Đăng nhập Acme', 'Nhập mật khẩu'] } };
  writeStore(root, { apps: { example: { groups: { core: { screens: { home_twin: twin } } } } } });
  const tie = await screenIdentify({ app: 'example', createBackend: device('home').createBackend });
  assert.equal(tie.screen, null);
  assert.deepEqual(tie.ambiguous.slice().sort(), ['core/home', 'core/home_twin']);
});

test('screen identify redacts the values the app prints', async () => {
  const result = await screenIdentify({ app: 'example', createBackend: device('profile').createBackend });
  assert.equal(result.screen, 'core/home'); // the wallet screen still shows "Acme Example"
  assert.ok(result.texts.includes('Ví Acme'));
  assert.ok(!JSON.stringify(result).includes(PHONE));
});

test('the CLI prints one marker per screen command', () => {
  const listed = cli(['screen', 'list', '--app', 'example', '--json']);
  assert.equal(listed.code, 0);
  assert.equal(listed.markers.length, 1);
  assert.deepEqual(listed.marker.screens.map((screen) => screen.id), ['core/home', 'core/login', 'core/password']);

  const human = cli(['screen', 'list', '--app', 'example']);
  assert.equal(human.code, 0);
  assert.equal(human.markers.length, 1);
  assert.match(human.stderr, /core\/home: 1 verified, 0 learned, 0 draft, 0 exception\(s\)/);
  assert.match(human.stderr, /3 screen\(s\) for app "example"/);

  const noAs = cli(['screen', 'capture', '--app', 'example']);
  assert.equal(noAs.code, 1);
  assert.equal(noAs.markers.length, 1);
  assert.match(noAs.marker.error, /requires --as/);

  const ghost = cli(['screen', 'list', '--app', 'ghost']);
  assert.equal(ghost.code, 1);
  assert.match(ghost.marker.error, /no screens directory for app "ghost"/);

  assert.match(cli(['--help']).stdout, /screen capture --as <group\/screen>/);
});

test('the MCP tools call the same commands', async () => {
  const captured = await handlers.screenCapture(
    { as: 'core/mcp', app: 'example', serial: 'emulator-5554' },
    { createBackend: device('home').createBackend },
  );
  assert.equal(captured.created, true);
  const identified = await handlers.screenIdentify({ app: 'example', serial: 'emulator-5554' }, { createBackend: device('home').createBackend });
  assert.equal(identified.screen, 'core/home');
  await assert.rejects(() => handlers.screenIdentify({}), /requires --app/);
});
