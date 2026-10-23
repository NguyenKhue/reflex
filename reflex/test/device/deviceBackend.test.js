/**
 * deviceBackend.test.js — the live agent-device backend driven through an injected
 * client factory (no agent-device install, no device) plus the adb helpers through a
 * stub adb binary. Guards the thin layer that talks to the real client.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createDeviceBackend, normalizeSnapshot, isComposeField } = require('../../src/device/deviceBackend');
const fixtures = require('../fixtures/device');

const APP = fixtures.APP;
const SERIAL = '09261FDD4005PG';

function fakeClient({ snapshot = fixtures.homeRaw() } = {}) {
  const calls = { snapshot: [], open: [], press: [], fill: [], scroll: [], back: [], screenshot: [], close: [] };
  const client = {
    calls,
    apps: { open: async (args) => calls.open.push(args) },
    capture: {
      snapshot: async (args) => {
        calls.snapshot.push(args);
        return typeof snapshot === 'function' ? snapshot(args) : snapshot;
      },
      screenshot: async (args) => calls.screenshot.push(args)
    },
    interactions: {
      press: async (args) => calls.press.push(args),
      fill: async (args) => calls.fill.push(args),
      scroll: async (args) => calls.scroll.push(args)
    },
    command: { back: async (args) => calls.back.push(args) },
    sessions: { close: async (args) => calls.close.push(args) }
  };
  return client;
}

function androidBackend(client, extra = {}) {
  return createDeviceBackend({
    platform: 'android',
    serial: SERIAL,
    appId: APP,
    clientFactory: () => client,
    settleQuietMs: 111,
    actionTimeoutMs: 222,
    ...extra
  });
}

test('snapshot asks for a full capture and normalises the app screen', async () => {
  const client = fakeClient();
  const backend = androidBackend(client);

  const snap = await backend.snapshot();

  assert.deepEqual(client.calls.snapshot[0], { platform: 'android', serial: SERIAL, forceFull: true, timeoutMs: 30000 });
  assert.equal(snap.nodes.some((node) => node.text === '9:41'), false);
  assert.equal(snap.nodes.find((node) => node.ref === 'e17').pinned, '@e17~s7');
  assert.deepEqual(backend.meta(), {
    backend: 'agent-device',
    platform: 'android',
    serial: SERIAL,
    udid: undefined,
    appId: APP
  });
});

test('iOS selects the device by udid and android omits an absent serial', async () => {
  const ios = fakeClient();
  const iosBackend = createDeviceBackend({ platform: 'ios', udid: '00008030-001', appId: APP, clientFactory: () => ios });
  await iosBackend.snapshot();
  assert.deepEqual(ios.calls.snapshot[0], { platform: 'ios', udid: '00008030-001', forceFull: true, raw: true, timeoutMs: 30000 });
  assert.equal(iosBackend.meta().platform, 'ios');

  const android = fakeClient();
  await createDeviceBackend({ platform: 'android', clientFactory: () => android }).snapshot();
  assert.deepEqual(android.calls.snapshot[0], { platform: 'android', forceFull: true, timeoutMs: 30000 });
});

test('actions carry the pinned ref and the shared settle options', async () => {
  const client = fakeClient();
  const backend = androidBackend(client);
  const snap = await backend.snapshot();
  const option = snap.nodes.find((node) => node.ref === 'e17');

  await backend.press(option);
  await backend.press({ selector: 'label="Huỷ"' });
  await backend.press({ x: 10, y: 20 });
  await backend.fill(option, '0900000099');
  await backend.scroll('up');
  await backend.scroll('down', 0.5);
  await backend.back();

  const settle = { settle: true, settleQuietMs: 111, timeoutMs: 222 };
  assert.deepEqual(client.calls.press[0], { platform: 'android', serial: SERIAL, ref: '@e17~s7', ...settle });
  assert.deepEqual(client.calls.press[1], { platform: 'android', serial: SERIAL, selector: 'label="Huỷ"', ...settle });
  assert.deepEqual(client.calls.press[2], { platform: 'android', serial: SERIAL, x: 10, y: 20, ...settle });
  assert.deepEqual(client.calls.fill[0], { platform: 'android', serial: SERIAL, ref: '@e17~s7', text: '0900000099', delayMs: 150, ...settle });
  assert.equal(client.calls.scroll[0].direction, 'up');
  assert.equal(client.calls.scroll[0].amount, undefined);
  assert.equal(client.calls.scroll[1].amount, 0.5);
  assert.deepEqual(client.calls.back[0], { platform: 'android', serial: SERIAL, ...settle });

  await assert.rejects(() => backend.press(), /an action needs a target/);
  await assert.rejects(() => backend.press({}), /unsupported target/);
});

test('open passes the selection, remembers the app and validates extras', async () => {
  const client = fakeClient();
  const backend = androidBackend(client);

  assert.deepEqual(await backend.open({ app: APP, activity: '.MainActivity' }), { ok: true, app: APP });
  assert.deepEqual(client.calls.open[0], {
    platform: 'android',
    serial: SERIAL,
    app: APP,
    relaunch: true,
    timeoutMs: 120000
  });
  assert.equal(backend.meta().appId, APP);

  const ios = createDeviceBackend({ platform: 'ios', udid: '00008030-001', appId: APP, clientFactory: () => fakeClient() });
  await assert.rejects(() => ios.open({ app: APP, activity: '.MainActivity', extras: { refId: 'home' } }), /extras are Android-only/);
  // Extras without an activity are rejected before any adb call is attempted.
  await assert.rejects(() => androidBackend(fakeClient(), { adbPath: '/nonexistent/adb' }).open({ app: APP, extras: { refId: 'home' } }), /require an activity/);
});

test('launch extras are forwarded to `am start` and logcat reads the adb output', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-adb-'));
  const logFile = path.join(workDir, 'args.txt');
  const adbPath = path.join(workDir, 'adb');
  fs.writeFileSync(adbPath, `#!/bin/sh\nprintf '%s\\n' "$@" | tee -a "${logFile}"\n`);
  fs.chmodSync(adbPath, 0o755);
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const client = fakeClient();
  const backend = androidBackend(client, { adbPath });
  const recordedArgs = () => fs.readFileSync(logFile, 'utf8').trim().split('\n');

  await backend.open({ activity: '.MainActivity', extras: { refId: 'home_p2p', flag: true } });
  assert.deepEqual(client.calls.open[0].app, APP);
  assert.deepEqual(recordedArgs(), ['-s', SERIAL, 'shell', 'am', 'start', '-S', '-n', `${APP}/.MainActivity`, '-e', 'refId', 'home_p2p', '-e', 'flag', 'true']);

  fs.writeFileSync(logFile, '');
  await backend.clearLogcat();
  assert.deepEqual(recordedArgs(), ['-s', SERIAL, 'logcat', '-c']);

  fs.writeFileSync(logFile, '');
  const output = await backend.readLogcat();
  assert.deepEqual(recordedArgs(), ['-s', SERIAL, 'logcat', '-d', '-v', 'brief']);
  assert.deepEqual(output.trim().split('\n'), recordedArgs());

  const ios = createDeviceBackend({ platform: 'ios', udid: '00008030-001', clientFactory: () => fakeClient() });
  await assert.rejects(() => ios.readLogcat(), /logcat is Android-only/);
  await assert.rejects(() => ios.clearLogcat(), /logcat is Android-only/);
});

test('screenshot creates the target directory and closing a dead session is silent', async (t) => {
  const client = fakeClient();
  const backend = androidBackend(client);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-shot-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const target = path.join(workDir, 'nested', 'shot.png');

  assert.equal(await backend.screenshot(target), target);
  assert.deepEqual(client.calls.screenshot[0], { platform: 'android', serial: SERIAL, path: target });
  assert.ok(fs.existsSync(path.dirname(target)));

  client.sessions.close = async () => { throw new Error('session already closed'); };
  await backend.close();
});

// Only meaningful where the optional dependency is absent (CI / Node 20 installs).
// agent-device's `exports` map hides package.json from require.resolve, so look on disk.
const agentDeviceInstalled = fs.existsSync(path.join(__dirname, '..', '..', 'node_modules', 'agent-device', 'package.json'));

test('a missing agent-device install raises the install hint on first use', { skip: agentDeviceInstalled && 'agent-device is installed' }, async () => {
  const backend = createDeviceBackend({ platform: 'android', serial: SERIAL, appId: APP });

  await assert.rejects(() => backend.snapshot(), /agent-device is not installed — run: npm install --prefix reflex/);
  // close() never surfaces an activation failure either.
  await backend.close();
});

test('resetApp on an iOS simulator empties the data container and keeps its folders', async () => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-sim-'));
  for (const folder of ['Documents', 'Library', 'tmp']) {
    fs.mkdirSync(path.join(container, folder, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(container, folder, 'nested', 'state.json'), '{}');
  }
  const calls = [];
  const execFile = (file, argv) => {
    calls.push([file, ...argv]);
    return argv[1] === 'get_app_container' ? `${container}\n` : '';
  };
  const sim = createDeviceBackend({ platform: 'ios', udid: 'SIM-1', appId: APP, execFile, clientFactory: () => fakeClient() });

  assert.deepEqual(await sim.resetApp({ app: APP }), { ok: true, app: APP });
  for (const folder of ['Documents', 'Library', 'tmp']) assert.deepEqual(fs.readdirSync(path.join(container, folder)), []);
  assert.deepEqual(calls, [
    ['xcrun', 'simctl', 'get_app_container', 'SIM-1', APP, 'data'],
    ['xcrun', 'simctl', 'terminate', 'SIM-1', APP]
  ]);
  fs.rmSync(container, { recursive: true, force: true });
});

test('resetApp refuses an iOS target that is not a simulator', async () => {
  const execFile = () => { throw new Error('Invalid device'); };
  const device = createDeviceBackend({ platform: 'ios', udid: '00008030-001', appId: APP, execFile, clientFactory: () => fakeClient() });
  await assert.rejects(() => device.resetApp({ app: APP }), /physical devices cannot be wiped/);
  const noUdid = createDeviceBackend({ platform: 'ios', appId: APP, clientFactory: () => fakeClient() });
  await assert.rejects(() => noUdid.resetApp({ app: APP }), /needs --udid/);
});

// Shapes seen on the Acme UAT iOS simulator (iOS 26, 2026-09-24): an OTP screen presented over the
// phone screen, both still in the raw tree.
function iosTree() {
  const rect = (y, height = 874) => ({ x: 0, y, width: 402, height });
  return {
    refsGeneration: 3,
    nodes: [
      { index: 0, type: 'Application', role: 'UIApplication', rect: rect(0), ref: 'e1', label: 'Acme UAT' },
      { index: 1, parentIndex: 0, type: 'Window', role: 'UIWindow', rect: rect(0), ref: 'e2' },
      { index: 2, parentIndex: 1, type: 'Other', role: 'UITransitionView', rect: rect(0), ref: 'e3' },
      { index: 3, parentIndex: 2, type: 'Other', role: 'AccessibilityElement', identifier: 'input_phone_number', value: '0900000099', rect: rect(194, 60), ref: 'e4' },
      { index: 4, parentIndex: 2, type: 'StaticText', role: 'UILabel', label: 'Nhập SĐT', rect: rect(78, 20), ref: 'e5' },
      { index: 5, parentIndex: 1, type: 'Other', role: 'UITransitionView', rect: rect(0), ref: 'e6' },
      { index: 6, parentIndex: 5, type: 'StaticText', role: 'UILabel', label: 'Xác thực OTP của bạn', rect: rect(126, 20), ref: 'e7' },
      { index: 7, parentIndex: 5, type: 'TextField', role: 'NativeBridgeTextField', identifier: 'OTPTextInput', rect: rect(212, 48), ref: 'e8' },
      { index: 8, parentIndex: 5, type: 'SecureTextField', role: 'UITextField', rect: rect(300, 48), ref: 'e9' }
    ]
  };
}

test('iOS: the last full-window transition view covers the earlier ones', () => {
  const snap = normalizeSnapshot(iosTree(), APP);
  const labels = snap.nodes.map((node) => node.text || node.identifier).filter(Boolean);
  assert.ok(labels.includes('Xác thực OTP của bạn'));
  assert.ok(!labels.includes('Nhập SĐT'));
  assert.ok(!snap.nodes.some((node) => node.identifier === 'input_phone_number'));
});

test('iOS: text inputs are editable by element type, and an input_ test ID marks a custom field', () => {
  const snap = normalizeSnapshot(iosTree(), APP);
  const otp = snap.nodes.find((node) => node.identifier === 'OTPTextInput');
  assert.equal(otp.editable, true);
  const secure = snap.nodes.find((node) => node.type === 'SecureTextField');
  assert.equal(secure.editable, true);
  assert.equal(secure.password, true);

  // Alone on screen (no covering layer), the custom phone field is an input whose value stays private.
  const tree = iosTree();
  tree.nodes = tree.nodes.filter((node) => node.index < 5);
  const phone = normalizeSnapshot(tree, APP).nodes.find((node) => node.identifier === 'input_phone_number');
  assert.equal(phone.editable, true);
});

test('iOS: a bare Other holding only a value is a Compose text field; labelled or test-ID nodes are not', () => {
  const rect = (y) => ({ x: 0, y, width: 300, height: 40 });
  const snap = normalizeSnapshot({
    nodes: [
      { index: 0, type: 'Other', value: '••••••', rect: rect(443), ref: 'e1' },
      { index: 1, type: 'Other', label: 'Tổng', value: '10.000đ', rect: rect(500), ref: 'e2' },
      { index: 2, type: 'Other', identifier: 'card_total', value: '10.000đ', rect: rect(520), ref: 'e3' },
      { index: 3, type: 'Other', rect: rect(540), ref: 'e4' },
      // Focused, the same field is a TextView whose label repeats its value.
      { index: 4, type: 'TextView', label: '••••', value: '••••', rect: rect(560), ref: 'e5' }
    ]
  }, APP);
  assert.deepEqual(snap.nodes.map((node) => node.editable), [true, false, false, false, true]);
  assert.equal(isComposeField(snap.nodes[4]), true);
  assert.equal(isComposeField({ type: 'TextView', label: 'Ghi chú', value: 'abc', rect: rect(0) }), false);
});

test('Android trees are not pruned: they carry no transition views', () => {
  const snap = normalizeSnapshot(fixtures.homeRaw(), APP);
  assert.ok(snap.nodes.length > 0);
});

test('iOS: a wrapper sharing its native field test ID is not a second field; keyboard keys are dropped', () => {
  const rect = (y) => ({ x: 0, y, width: 300, height: 40 });
  const snap = normalizeSnapshot({
    nodes: [
      { index: 0, type: 'Other', identifier: 'input_password', rect: rect(229), ref: 'e1' },
      { index: 1, type: 'SecureTextField', identifier: 'input_password', rect: rect(204), ref: 'e2' },
      { index: 2, type: 'Key', label: '1', rect: rect(881), ref: 'e3' },
      { index: 3, type: 'Other', identifier: 'input_phone_number', rect: rect(194), ref: 'e4' }
    ]
  }, APP);
  assert.deepEqual(snap.nodes.filter((node) => node.editable).map((node) => node.ref), ['e2', 'e4']);
  assert.ok(!snap.nodes.some((node) => node.type === 'Key'));
});

test('iOS: an XCTest type failure after the keys landed is not a fill failure', async () => {
  const client = fakeClient();
  client.interactions.fill = async () => { throw new Error('XCTest recorded a failure while executing type; the action may not have been performed.'); };
  const ios = createDeviceBackend({ platform: 'ios', udid: 'SIM-1', appId: APP, clientFactory: () => client });
  assert.deepEqual(await ios.fill({ ref: 'e2', pinned: '@e2~s1', editable: true }, '0000'), { ok: true, uncertain: true });
  const android = createDeviceBackend({ platform: 'android', serial: SERIAL, appId: APP, fastInput: false, clientFactory: () => client });
  await assert.rejects(() => android.fill({ ref: 'e2', pinned: '@e2~s1', editable: true }, 'Mật khẩu'), /XCTest/);
});

test('iOS: a Compose field is tapped at its trailing edge, emptied and typed one key at a time', async () => {
  const client = fakeClient();
  const calls = [];
  client.interactions.press = async (args) => calls.push(['press', args.x, args.y]);
  // The field holds 3 characters; the first round of deletes only removes 2 of them.
  let held = 3;
  const rect = { x: 77, y: 300, width: 248, height: 48 };
  client.capture.snapshot = async () => ({ nodes: held ? [{ index: 0, type: 'TextView', value: '•'.repeat(held), rect, ref: 'e1' }] : [] });
  let deletes = 0;
  client.interactions.type = async (args) => {
    calls.push(args.text);
    if (args.text === '\b' && (deletes += 1) !== 3) held -= 1;
  };
  client.interactions.fill = async () => { throw new Error('a Compose field is not filled through XCTest'); };
  const ios = createDeviceBackend({ platform: 'ios', udid: 'SIM-1', appId: APP, clientFactory: () => client, minCharDelayMs: 1 });
  const field = normalizeSnapshot({ nodes: [{ index: 0, type: 'Other', value: '•••', rect, ref: 'e1' }] }, APP).nodes[0];
  assert.deepEqual(await ios.fill(field, '000000'), { ok: true });
  // Tap at the trailing edge, delete until the field reads empty, type the first key, send the
  // caret back to the end (the first key moved it to the start), then one key per call.
  assert.deepEqual(calls, [['press', 319, 324], '\b', '\b', '\b', '\b', '0', ['press', 319, 324], '0', '0', '0', '0', '0']);

  // A field that never empties is not typed into.
  held = 3;
  client.interactions.type = async (args) => calls.push(args.text);
  assert.deepEqual(await ios.fill(field, '000000'), { ok: false, error: 'the field could not be emptied before typing' });
});

test('iOS: a Compose field the keyboard slid up is tapped again where it is now, never where it was', async () => {
  const client = fakeClient();
  const calls = [];
  const before = { x: 77, y: 443, width: 248, height: 48 };
  const after = { x: 77, y: 301, width: 248, height: 48 };
  let focused = false;
  let value = '';
  client.capture.snapshot = async () => ({ nodes: [
    { index: 0, type: 'Other', value: focused ? value : '••••••', rect: focused ? after : before, ref: 'e1' },
    { index: 1, type: 'Button', label: 'Đăng nhập', rect: { x: 161, y: 369, width: 180, height: 50 }, ref: 'e2' }
  ].filter((node) => node.value || node.label) });
  client.interactions.press = async (args) => { calls.push(['press', args.y]); focused = true; };
  client.interactions.type = async (args) => { calls.push(args.text); value += args.text; };
  const ios = createDeviceBackend({ platform: 'ios', udid: 'SIM-1', appId: APP, clientFactory: () => client, minCharDelayMs: 1 });
  const field = normalizeSnapshot(await client.capture.snapshot(), APP).nodes[0];
  assert.deepEqual(await ios.fill(field, '12'), { ok: true });
  // Focused and empty, the field leaves the tree; once it holds the first key it is found again
  // where the keyboard moved it (325), and the caret goes to the end there.
  assert.deepEqual(calls, [['press', 467], '1', ['press', 325], '2']);
});

test('iOS: a container label joined from its children is dropped, its test ID kept', () => {
  const rect = { x: 0, y: 100, width: 300, height: 40 };
  const snap = normalizeSnapshot({
    nodes: [
      { index: 0, type: 'Other', identifier: 'com.acme.transfer/home_p2p/success', label: 'Nhập SĐT/STK tại đây Chuyển tiền đến', rect, ref: 'e1' },
      { index: 1, parentIndex: 0, type: 'StaticText', label: 'Nhập SĐT/STK tại đây', rect, ref: 'e2' },
      { index: 2, parentIndex: 0, type: 'StaticText', label: 'Chuyển tiền đến', rect, ref: 'e3' },
      { index: 3, parentIndex: 0, type: 'Button', label: 'Chuyển tiền, Chuyển tiền', rect, ref: 'e4' },
      { index: 4, parentIndex: 3, type: 'StaticText', label: 'Chuyển tiền', rect, ref: 'e5' },
      { index: 5, type: 'Other', label: 'com.acme.mobilecenter/buycardcenter/AppEntry/TouchableOpacity|50.000đ', rect, ref: 'e6' },
      { index: 6, parentIndex: 5, type: 'StaticText', label: '50.000đ', rect, ref: 'e7' }
    ]
  }, APP);
  const byRef = Object.fromEntries(snap.nodes.map((node) => [node.ref, node]));
  assert.equal(byRef.e1.text, '');
  assert.equal(byRef.e1.identifier, 'com.acme.transfer/home_p2p/success');
  assert.equal(byRef.e2.text, 'Nhập SĐT/STK tại đây');
  assert.equal(byRef.e4.text, 'Chuyển tiền, Chuyển tiền'); // a Button keeps its label: it is what gets tapped
  assert.equal(byRef.e6.text, 'com.acme.mobilecenter/buycardcenter/AppEntry/TouchableOpacity|50.000đ'); // testID|text is kept
});

test('iOS: typeText types into the focus through the client; keyboard windows are not app content', async () => {
  const client = fakeClient();
  const typed = [];
  client.interactions.type = async (args) => typed.push(args);
  const ios = createDeviceBackend({ platform: 'ios', udid: 'SIM-1', appId: APP, clientFactory: () => client });
  assert.deepEqual(await ios.typeText('09', { charDelayMs: 50 }), { ok: true });
  // One key per call, never the whole value at once.
  assert.deepEqual(typed, [{ platform: 'ios', udid: 'SIM-1', text: '0' }, { platform: 'ios', udid: 'SIM-1', text: '9' }]);
  assert.equal(createDeviceBackend({ platform: 'android', serial: SERIAL, appId: APP }).typeText, undefined);

  const snap = normalizeSnapshot({
    nodes: [
      { index: 0, type: 'Application', role: 'UIApplication', label: 'Acme UAT', ref: 'e1' },
      { index: 1, type: 'Application', role: 'UIRemoteKeyboardWindow', ref: 'e2' },
      { index: 2, parentIndex: 1, type: 'Button', label: 'Dictate', ref: 'e3' }
    ]
  }, APP);
  assert.deepEqual(snap.nodes.map((node) => node.ref), ['e1']);
});

test('iOS: the runner text check is not a verdict, and its quoted values never travel on', async () => {
  const client = fakeClient();
  let observed = '2.000';
  client.interactions.fill = async () => { throw new Error(`text entry verification failed: expected "2000", observed "${observed}"`); };
  const ios = createDeviceBackend({ platform: 'ios', udid: 'SIM-1', appId: APP, clientFactory: () => client });
  const field = { ref: 'e2', pinned: '@e2~s1', editable: true };
  for (observed of ['2.000', '', '••••••', '20']) {
    const result = await ios.fill(field, '2000');
    assert.deepEqual(result, { ok: true, uncertain: true });
  }
});
