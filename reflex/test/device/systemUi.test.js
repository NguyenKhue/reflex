/**
 * systemUi.test.js — reading a system window (share sheet, permission dialog, picker) through `uiautomator`.
 *
 * agent-device cannot snapshot a window that is not the app; the backend then falls back to `adb shell uiautomator dump`.
 * The fixture is a real dump of the Android share chooser taken on an emulator (2026-10-05). No device, no adb: the backend's
 * `execFile` is a stub that answers the two adb calls the fallback makes.
 */
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseUiautomatorDump, parseBounds, unescapeXml } = require('../../src/device/uiautomator');
const { createDeviceBackend } = require('../../src/device/deviceBackend');

const CHOOSER_XML = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'uiautomator-chooser.xml'), 'utf8');
const NO_CONTENT = 'Android snapshot helper returned insufficient foreground app content';
const SERIAL = 'emulator-5554';

const node = (attributes) => `<node ${Object.entries({
  index: '0', text: '', 'resource-id': '', class: 'android.widget.TextView', package: 'android', 'content-desc': '',
  clickable: 'false', enabled: 'true', focused: 'false', password: 'false', bounds: '[0,0][100,50]', ...attributes,
}).map(([key, value]) => `${key}="${value}"`).join(' ')} />`;

test('the real chooser dump yields the texts the user sees, as nodes with a box and no ref', () => {
  const snapshot = parseUiautomatorDump(CHOOSER_XML, { now: 123 });
  const texts = snapshot.nodes.map((item) => item.text);
  for (const wanted of ['Share with', 'Gmail', 'Messages', 'JUST ONCE', 'ALWAYS']) {
    assert.ok(texts.includes(wanted), `${wanted} missing from ${JSON.stringify(texts)}`);
  }
  assert.equal(snapshot.source, 'uiautomator');
  assert.equal(snapshot.takenAt, 123);
  assert.equal(snapshot.appBundleId, null);
  for (const item of snapshot.nodes) {
    assert.equal(item.ref, null);
    assert.equal(item.pinned, null);
    assert.ok(item.rect.width > 0 && item.rect.height > 0, JSON.stringify(item));
  }
});

test('xml entities and numeric references are unescaped', () => {
  assert.equal(unescapeXml('Network &amp; Internet &quot;x&quot; &lt;b&gt; it&apos;s'), 'Network & Internet "x" <b> it\'s');
  assert.equal(unescapeXml('a&#10;b&#x41;'), 'a\nbA');
  const snapshot = parseUiautomatorDump(node({ text: 'Network &amp; Internet' }));
  assert.equal(snapshot.nodes[0].text, 'Network & Internet');
});

test('nodes that say nothing, have no usable box, or belong to the status bar are dropped', () => {
  const xml = [
    node({ text: 'Keep me' }),
    node({ text: '' }), // no text, description or id
    node({ text: 'Zero box', bounds: '[10,10][10,10]' }),
    node({ text: 'Broken box', bounds: 'nope' }),
    node({ text: '9:41', package: 'com.android.systemui' }),
    node({ 'content-desc': 'Navigate up' }),
    node({ 'resource-id': 'android:id/button1' }),
  ].join('\n');
  const names = parseUiautomatorDump(xml).nodes.map((item) => item.label || item.identifier);
  assert.deepEqual(names, ['Keep me', 'Navigate up', 'android:id/button1']);
});

test('flags: EditText is editable, clickable is hittable, password and disabled carry over', () => {
  const xml = [
    node({ text: 'Name', class: 'android.widget.EditText', focused: 'true' }),
    node({ text: 'Secret', class: 'android.widget.EditText', password: 'true' }),
    node({ text: 'Button', clickable: 'true', enabled: 'false' }),
  ].join('\n');
  const [name, secret, button] = parseUiautomatorDump(xml).nodes;
  assert.equal(name.editable, true);
  assert.equal(name.focused, true);
  assert.equal(secret.password, true);
  assert.equal(button.hittable, true);
  assert.equal(button.enabled, false);
  assert.equal(button.editable, false);
});

test('garbage in gives no nodes and never throws; parseBounds accepts only a real box', () => {
  for (const input of ['', null, undefined, '<hierarchy>', 'not xml at all', '<node broken']) {
    assert.deepEqual(parseUiautomatorDump(input).nodes, []);
  }
  assert.deepEqual(parseBounds('[10,20][110,70]'), { x: 10, y: 20, width: 100, height: 50 });
  assert.equal(parseBounds('[10,20][10,70]'), null);
  assert.equal(parseBounds(''), null);
});

/** A backend whose client cannot see the app, with adb answering `uiautomator dump` / `cat` from `xml`. */
function backendWith({ snapshotError = new Error(NO_CONTENT), xml = CHOOSER_XML, platform = 'android', systemUiFallback, adbThrows = false } = {}) {
  const adbCalls = [];
  const pressed = [];
  const client = {
    capture: { snapshot: async () => { throw snapshotError; } },
    interactions: { press: async (args) => pressed.push(args) },
  };
  const backend = createDeviceBackend({
    platform,
    serial: SERIAL,
    udid: platform === 'ios' ? 'sim-1' : undefined,
    appId: 'com.example.app',
    clientFactory: () => client,
    ...(systemUiFallback === undefined ? {} : { systemUiFallback }),
    execFile: (bin, argv) => {
      adbCalls.push(argv);
      if (adbThrows) throw new Error('adb: device offline');
      return argv.includes('cat') ? xml : '';
    },
  });
  return { backend, adbCalls, pressed };
}

test('when agent-device cannot see the app, snapshot() reads the system window through uiautomator', async () => {
  const { backend, adbCalls } = backendWith();
  const snapshot = await backend.snapshot();
  assert.equal(snapshot.source, 'uiautomator');
  assert.ok(snapshot.nodes.some((item) => item.text === 'Gmail'));
  assert.deepEqual(adbCalls[0], ['-s', SERIAL, 'shell', 'uiautomator', 'dump', '/sdcard/reflex-window.xml']);
  assert.deepEqual(adbCalls[1], ['-s', SERIAL, 'exec-out', 'cat', '/sdcard/reflex-window.xml']);
});

test('every wording agent-device uses for "a system window is in front" triggers the fallback', async () => {
  for (const message of [
    'Android snapshot helper returned insufficient foreground app content',
    'Android snapshot helper returned insufficient application window content',
    'Android snapshot helper returned only non-application windows',
  ]) {
    const { backend } = backendWith({ snapshotError: new Error(message) });
    assert.equal((await backend.snapshot()).source, 'uiautomator', message);
  }
});

test('the fallback never runs when agent-device answers', async () => {
  const adbCalls = [];
  const client = { capture: { snapshot: async () => ({ nodes: [], refsGeneration: 1 }) } };
  const backend = createDeviceBackend({
    platform: 'android', serial: SERIAL, appId: 'com.example.app', clientFactory: () => client,
    execFile: (bin, argv) => { adbCalls.push(argv); return ''; },
  });
  const snapshot = await backend.snapshot();
  assert.equal(snapshot.source, undefined);
  assert.deepEqual(adbCalls, []);
});

test('any other snapshot error is rethrown untouched, and adb is not asked', async () => {
  const { backend, adbCalls } = backendWith({ snapshotError: new Error('snapshot timed out after 15000ms') });
  await assert.rejects(() => backend.snapshot(), { message: 'snapshot timed out after 15000ms' });
  assert.deepEqual(adbCalls, []);
});

test('the fallback can be switched off, is Android only, and an unreadable or empty dump keeps the original error', async () => {
  for (const options of [{ systemUiFallback: false }, { platform: 'ios' }, { adbThrows: true }, { xml: '<hierarchy rotation="0"></hierarchy>' }]) {
    const { backend } = backendWith(options);
    await assert.rejects(() => backend.snapshot(), { message: NO_CONTENT }, JSON.stringify(options));
  }
});

test('a node read through uiautomator is pressed by the centre of its box', async () => {
  const { backend, pressed } = backendWith();
  const snapshot = await backend.snapshot();
  const gmail = snapshot.nodes.find((item) => item.text === 'Gmail');
  await backend.press(gmail, { settle: false });
  assert.equal(pressed.length, 1);
  assert.deepEqual({ x: pressed[0].x, y: pressed[0].y }, {
    x: Math.round(gmail.rect.x + gmail.rect.width / 2),
    y: Math.round(gmail.rect.y + gmail.rect.height / 2),
  });
});
