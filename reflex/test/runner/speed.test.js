/**
 * speed.test.js — the shortcuts that make an agent-device replay faster: a step `when`,
 * the tap that skips the UI quiet-wait, the adb text input and jev-run's auto-settle rule.
 *
 * No device, no adb binary, no network: the backend takes an injected `execFile`, the
 * sessions are mock-backed and every timeout is in milliseconds, so the suite is instant.
 */
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { executeChecklistRecipe, validateChecklistRecipe } = require('../../src/runner/recipe');
const { createDeviceBackend, createMockBackend, normalizeSnapshot } = require('../../src/device/deviceBackend');
const { createDeviceSession, DEVICE_TOOL_SPECS } = require('../../src/device/deviceTools');
const { autoSettle } = require('../../src/runner/recipe');
const fixtures = require('../fixtures/device');

const APP = fixtures.APP;
const SERIAL = '09261FDD4005PG';

/** A session whose named tools are the given async functions, recording every call. */
function sessionOf(tools) {
  const calls = [];
  const session = {};
  for (const [name, fn] of Object.entries(tools)) {
    session[name] = async (args) => {
      calls.push({ name, args });
      return fn(args);
    };
  }
  session.calls = calls;
  return session;
}

function mockSession(raw) {
  const backend = createMockBackend({ snapshots: [raw], appId: APP });
  return { backend, session: createDeviceSession({ backend, pollMs: 1, reportDir: os.tmpdir() }) };
}

/** A backend whose adb calls are recorded instead of executed (clientFactory never hits a device). */
function adbBackend({ platform = 'android', fastInput = platform === 'android' } = {}) {
  const calls = { press: [], fill: [], adb: [] };
  const client = {
    interactions: {
      press: async (args) => { calls.press.push(args); },
      fill: async (args) => { calls.fill.push(args); }
    }
  };
  const backend = createDeviceBackend({
    platform,
    serial: platform === 'android' ? SERIAL : undefined,
    udid: platform === 'ios' ? '00008030-001' : undefined,
    appId: APP,
    clientFactory: () => client,
    adbPath: 'adb',
    fastInput,
    minCharDelayMs: 1,
    settleQuietMs: 111,
    actionTimeoutMs: 222,
    execFile: (file, argv) => {
      calls.adb.push({ file, argv });
      return '';
    }
  });
  return { backend, calls };
}

/** The prefilled phone field of the login fixture, as the session sees it. */
function loginField() {
  return normalizeSnapshot(fixtures.loginRaw(), APP).nodes.find((node) => node.ref === 'e51');
}

// ── A. a step `when` ─────────────────────────────────────────────────────────────────

test('a step `when` runs only while the condition holds', async () => {
  const session = sessionOf({ tap_text: () => ({ ok: true, found: true }), wait_text: () => ({ ok: true, found: true }) });
  const recipe = [
    { tool: 'tap_text', when: { value: '{auth_state}', notMatch: 'LOGGED' }, args: { text: 'Đăng nhập' }, saveAs: 'login_tap' },
    { tool: 'wait_text', args: { text: 'Home' } },
  ];

  const run = await executeChecklistRecipe(session, recipe, { auth_state: 'GUEST' }, { toolSpecs: DEVICE_TOOL_SPECS });

  assert.equal(run.ok, true);
  assert.deepEqual(run.steps.map((step) => step.tool), ['tap_text', 'wait_text']);
  assert.deepEqual(session.calls.map((call) => call.name), ['tap_text', 'wait_text']);
  assert.equal(run.steps[0].notApplicable, undefined);
});

test('a step `when` that is false is skipped without a session call and without saveAs', async () => {
  const session = sessionOf({ tap_text: () => ({ ok: true, found: true }), wait_text: () => ({ ok: true, found: true }) });
  const recipe = [
    { tool: 'tap_text', when: { value: '{auth_state}', notMatch: 'LOGGED' }, args: { text: 'Đăng nhập' }, saveAs: 'login_tap' },
    { tool: 'wait_text', args: { text: 'Home' } },
  ];
  const data = { auth_state: 'LOGGED_IN' };

  const run = await executeChecklistRecipe(session, recipe, data, { toolSpecs: DEVICE_TOOL_SPECS });

  assert.equal(run.ok, true);
  assert.deepEqual(run.steps[0], {
    index: 0,
    tool: 'tap_text',
    args: {},
    ok: true,
    duration_ms: 0,
    result: { ok: true, notApplicable: true, reason: 'when' },
    notApplicable: true
  });
  // The skipped step neither touched the device nor wrote a captured value …
  assert.deepEqual(session.calls.map((call) => call.name), ['wait_text']);
  assert.equal(data.login_tap, undefined);
  // … and the rest of the recipe still ran.
  assert.equal(run.steps[1].tool, 'wait_text');
});

test('a step `when` combines match and notMatch', async () => {
  const recipe = [{ tool: 'tap_text', when: { value: '{state}', match: 'GUEST|FRESH', notMatch: 'BLOCKED' }, args: { text: 'Đăng nhập' } }];
  const tools = { tap_text: () => ({ ok: true, found: true }) };

  const runs = await executeChecklistRecipe(sessionOf(tools), recipe, { state: 'FRESH' }, { toolSpecs: DEVICE_TOOL_SPECS });
  const blocked = await executeChecklistRecipe(sessionOf(tools), recipe, { state: 'BLOCKED FRESH' }, { toolSpecs: DEVICE_TOOL_SPECS });
  const unmatched = await executeChecklistRecipe(sessionOf(tools), recipe, { state: 'LOGGED' }, { toolSpecs: DEVICE_TOOL_SPECS });

  assert.equal(runs.steps[0].notApplicable, undefined);
  assert.equal(blocked.steps[0].notApplicable, true);
  assert.equal(unmatched.steps[0].notApplicable, true);
});

test('a `when` naming a missing data field fails the step instead of skipping it', async () => {
  const session = sessionOf({ tap_text: () => ({ ok: true, found: true }) });
  const run = await executeChecklistRecipe(session, [
    { tool: 'tap_text', when: { value: '{auth_state}', match: 'GUEST' }, args: { text: 'Đăng nhập' } },
    { tool: 'tap_text', args: { text: 'Home' } },
  ], {}, { toolSpecs: DEVICE_TOOL_SPECS });

  assert.equal(run.ok, false);
  assert.equal(run.failed_step.index, 0);
  assert.match(run.failed_step.error, /checklist requires data field "auth_state"/);
  assert.equal(run.steps.length, 1);
  assert.equal(session.calls.length, 0);
});

test('validateChecklistRecipe rejects a malformed `when` before any session opens', () => {
  const recipe = (when) => [{ tool: 'tap_text', when, args: { text: 'Đăng nhập' } }];
  const check = (when) => () => validateChecklistRecipe(recipe(when), { toolSpecs: DEVICE_TOOL_SPECS });

  assert.doesNotThrow(check({ value: '{auth_state}', notMatch: 'LOGGED' }));
  assert.doesNotThrow(check({ value: '{auth_state}', match: 'GUEST', notMatch: 'LOGGED' }));
  assert.throws(check('LOGGED'), /checklist step 1: invalid "when"/);
  assert.throws(check(['LOGGED']), /checklist step 1: invalid "when" \(expected a mapping/);
  assert.throws(check({ match: 'LOGGED' }), /invalid "when" \("value" must be a string\)/);
  assert.throws(check({ value: 7, match: 'LOGGED' }), /invalid "when" \("value" must be a string\)/);
  assert.throws(check({ value: '{auth_state}' }), /invalid "when" \("match" or "notMatch" is required\)/);
  assert.throws(check({ value: '{auth_state}', notMatch: 7 }), /invalid "when" \("match" or "notMatch" is required\)/);
  assert.throws(check({ value: '{auth_state}', match: 'GUEST', notMatch: 7 }), /invalid "when" \("notMatch" must be a string\)/);
  assert.throws(check({ value: '{auth_state}', match: '([' }), /invalid "when" \("match" is not a valid regexp/);
  // The step number is the one the runner reports.
  assert.throws(
    () => validateChecklistRecipe([{ tool: 'tap_text', args: { text: 'x' } }, ...recipe({ value: '{a}', notMatch: '(' })], { toolSpecs: DEVICE_TOOL_SPECS }),
    /checklist step 2: invalid "when"/
  );
});

test('a recipe without `when` behaves exactly as before', async () => {
  const session = sessionOf({ tap_text: () => ({ ok: true, found: true }) });
  const run = await executeChecklistRecipe(session, [{ tool: 'tap_text', args: { text: 'Đăng nhập' } }], {}, { toolSpecs: DEVICE_TOOL_SPECS });

  assert.equal(run.ok, true);
  assert.equal(run.steps[0].notApplicable, undefined);
  assert.equal(run.steps[0].result.found, true);
  assert.equal(session.calls.length, 1);
});

// ── B. a tap without the settle wait ────────────────────────────────────────────────

test('tap_text and tap_if_present_text forward settle to the backend', async () => {
  const { backend, session } = mockSession(fixtures.homeRaw());

  await session.tap_text({ text: 'Đăng nhập', timeout: 50 });
  await session.tap_text({ text: 'Đăng nhập', timeout: 50, settle: false });
  await session.tap_if_present_text({ text: 'Đăng nhập', timeout: 50, settle: false });

  assert.deepEqual(backend.actions.map((action) => action.kind), ['press', 'press', 'press']);
  // The default is unchanged (settle on); only an explicit false turns the wait off.
  assert.deepEqual(backend.actions.map((action) => action.settle), [true, false, false]);
});

test('DEVICE_TOOL_SPECS documents settle on both tap tools', () => {
  for (const name of ['tap_text', 'tap_if_present_text']) {
    const spec = DEVICE_TOOL_SPECS.find((item) => item.name === name);
    assert.equal(spec.args.settle, true, `${name} must document settle`);
  }
});

// ── C. fast ADB text input ──────────────────────────────────────────────────────────

test('an ASCII fill types through adb without the client and never echoes the value', async () => {
  const { backend, calls } = adbBackend();

  const result = await backend.fill(loginField(), '0900000099');

  assert.deepEqual(result, { ok: true });
  assert.equal(JSON.stringify(result).includes('0900000099'), false);
  // Focus without settling, then one adb call per key: the caret to the end, the 10 prefilled
  // characters deleted one by one, and the value typed one key at a time.
  assert.deepEqual(calls.press, [{ platform: 'android', serial: SERIAL, ref: '@e51~s7', settle: false, timeoutMs: 222 }]);
  assert.equal(calls.fill.length, 0);
  assert.deepEqual(calls.adb, [
    { file: 'adb', argv: ['-s', SERIAL, 'shell', 'input', 'keyevent', 'KEYCODE_MOVE_END'] },
    ...Array.from({ length: 10 }, () => ({ file: 'adb', argv: ['-s', SERIAL, 'shell', 'input', 'keyevent', 'KEYCODE_DEL'] })),
    ...'0900000099'.split('').map((key) => ({ file: 'adb', argv: ['-s', SERIAL, 'shell', 'input', 'text', key] }))
  ]);
});

test('the adb path clears only what the field already holds', async () => {
  const empty = adbBackend();
  await empty.backend.fill({ ref: 'e51', pinned: '@e51~s7', editable: true, hintShowing: false, value: '', text: '' }, '');
  // Nothing to delete and nothing to type: only the focus press is needed.
  assert.equal(empty.calls.adb.length, 0);
  assert.equal(empty.calls.press.length, 1);

  const hint = adbBackend();
  await hint.backend.fill({ ref: 'e51', pinned: '@e51~s7', editable: true, hintShowing: true, value: 'Số điện thoại', text: 'Số điện thoại' }, '0900000099');
  // A placeholder is not content, so it is not deleted.
  assert.deepEqual(hint.calls.adb, '0900000099'.split('').map((key) => ({ file: 'adb', argv: ['-s', SERIAL, 'shell', 'input', 'text', key] })));
});

test('a non-ASCII fill keeps the client path', async () => {
  const { backend, calls } = adbBackend();

  assert.deepEqual(await backend.fill(loginField(), 'Mật khẩu 1'), { ok: true });

  assert.equal(calls.adb.length, 0);
  assert.deepEqual(calls.fill, [{
    platform: 'android',
    serial: SERIAL,
    ref: '@e51~s7',
    text: 'Mật khẩu 1',
    delayMs: 1,
    settle: true,
    settleQuietMs: 111,
    timeoutMs: 222
  }]);
});

test('a fill that is not an editable field on Android keeps the client path', async () => {
  const { backend, calls } = adbBackend();
  const label = normalizeSnapshot(fixtures.homeRaw(), APP).nodes.find((node) => node.ref === 'e17');

  await backend.fill(label, '0900000099');

  assert.equal(calls.adb.length, 0);
  assert.equal(calls.fill.length, 1);
  assert.equal(calls.fill[0].ref, '@e17~s7');
});

test('iOS and fastInput:false never use adb for typing', async () => {
  const ios = adbBackend({ platform: 'ios' });
  await ios.backend.fill({ ref: 'e51', pinned: '@e51~s7', editable: true, hintShowing: false, value: '', text: 'Số điện thoại' }, '0900000099');
  assert.equal(ios.calls.adb.length, 0);
  assert.deepEqual(ios.calls.fill, [{
    platform: 'ios',
    udid: '00008030-001',
    ref: '@e51~s7',
    text: '0900000099',
    delayMs: 1,
    verify: false,
    settle: true,
    settleQuietMs: 111,
    timeoutMs: 222
  }]);

  const off = adbBackend({ fastInput: false });
  await off.backend.fill(loginField(), '0900000099');
  assert.equal(off.calls.adb.length, 0);
  assert.equal(off.calls.fill.length, 1);
});

test('a press still settles by default and skips the wait when asked', async () => {
  const { backend, calls } = adbBackend();

  await backend.press({ ref: 'e17', pinned: '@e17~s7' });
  await backend.press({ ref: 'e17', pinned: '@e17~s7' }, { settle: false });

  assert.deepEqual(calls.press, [
    { platform: 'android', serial: SERIAL, ref: '@e17~s7', settle: true, settleQuietMs: 111, timeoutMs: 222 },
    { platform: 'android', serial: SERIAL, ref: '@e17~s7', settle: false, timeoutMs: 222 }
  ]);
});

// ── D. jev-run auto no-settle ───────────────────────────────────────────────────────

test('autoSettle drops the wait of a tap whose next step waits anyway', () => {
  const recipe = [
    { tool: 'tap_text', args: { text: '▶ Run all' } },
    { tool: 'wait_stable_texts', args: { pattern: '\\d+ pass' } },
    { tool: 'capture_texts', args: { pattern: 'pass' } },
    { tool: 'tap_if_present_text', args: { text: 'Xác nhận' } },
    { tool: 'wait_any_text', args: { texts: ['A', 'B'] } },
    { tool: 'tap_text', args: { text: 'Chuyển tiền' } },
    { tool: 'back' },
    { tool: 'tap_text', args: { text: 'Đóng' } },
    { tool: 'assert_text', args: { text: 'Home' } },
  ];

  const fast = autoSettle(recipe);

  assert.notEqual(fast, recipe);
  assert.deepEqual(fast.map((step) => step.args?.settle), [false, undefined, undefined, undefined, undefined, undefined, undefined, false, undefined]);
  // An untouched step keeps its identity; a rewritten one keeps every other key.
  assert.equal(fast[1], recipe[1]);
  assert.equal(fast[7].args.text, 'Đóng');
  assert.equal(recipe[0].args.settle, undefined);
});

test('autoSettle keeps the settle of a tap whose wait is followed by a pointer action', () => {
  // The live failure: the second screen was still sliding in when its button was tapped.
  const recipe = [
    { tool: 'tap_text', args: { text: 'api-contract' } },
    { tool: 'wait_text', args: { text: '▶ Run all' } },
    { tool: 'tap_text', args: { text: '▶ Run all' } },
    { tool: 'tap_text', args: { text: 'Đăng nhập' } },
    { tool: 'wait_text', args: { text: 'Đăng nhập Acme' } },
    { tool: 'fill', args: { index: 0, text: '{phone}' } },
    { tool: 'tap_text', args: { text: 'Tiếp tục' } },
    { tool: 'fill_otp_from_api', args: { phone: '{phone}' } },
  ];

  const fast = autoSettle(recipe);

  assert.deepEqual(fast.map((step) => step.args?.settle), [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
});

test('autoSettle keeps an explicit settle and a step `when`', () => {
  const recipe = [
    { tool: 'tap_text', args: { text: 'Đăng nhập', settle: true } },
    { tool: 'wait_text', args: { text: 'Home' } },
    { tool: 'tap_text', when: { value: '{auth_state}', notMatch: 'LOGGED' }, args: { text: 'Đăng nhập' } },
    { tool: 'assert_text', args: { text: 'Home' } },
  ];

  const fast = autoSettle(recipe);

  // An explicit settle always wins, even in front of a waiting step.
  assert.equal(fast[0].args.settle, true);
  assert.equal(fast[0], recipe[0]);
  assert.equal(fast[2].args.settle, false);
  assert.deepEqual(fast[2].when, { value: '{auth_state}', notMatch: 'LOGGED' });
  assert.equal(recipe[2].args.settle, undefined);
});

test('autoSettle leaves recipes without a fast path alone', () => {
  const recipe = [
    { tool: 'back', args: {} },
    { tool: 'tap_text', args: { text: 'X' } },
    { tool: 'screenshot', args: { name: 'screen' } },
  ];

  const fast = autoSettle(recipe);

  assert.deepEqual(fast, recipe);
  assert.equal(fast[1], recipe[1]);
  assert.deepEqual(autoSettle([]), []);
  assert.deepEqual(autoSettle(null), []);
});

test('a paced adb fill deletes and types one key per call', async () => {
  const { backend, calls } = adbBackend();

  await backend.fill({ ref: 'e51', pinned: '@e51~s7', editable: true, hintShowing: false, value: '12', text: '12' }, '34', { charDelayMs: 1 });

  const key = (...rest) => ({ file: 'adb', argv: ['-s', SERIAL, 'shell', 'input', ...rest] });
  assert.deepEqual(calls.adb, [
    key('keyevent', 'KEYCODE_MOVE_END'),
    key('keyevent', 'KEYCODE_DEL'),
    key('keyevent', 'KEYCODE_DEL'),
    key('text', '3'),
    key('text', '4')
  ]);
});

test('a bulk adb fill clears with one call and types the whole value with one', async () => {
  const { backend, calls } = adbBackend();

  const result = await backend.fill({ ref: 'e51', pinned: '@e51~s7', editable: true, hintShowing: false, value: '12', text: '12' }, 'ab@c.de', { bulk: true });

  assert.deepEqual(result, { ok: true });
  assert.equal(JSON.stringify(result).includes('ab@c.de'), false);
  assert.deepEqual(calls.adb, [
    { file: 'adb', argv: ['-s', SERIAL, 'shell', 'input', 'keyevent', 'KEYCODE_MOVE_END', 'KEYCODE_DEL', 'KEYCODE_DEL'] },
    { file: 'adb', argv: ['-s', SERIAL, 'shell', 'input', 'text', 'ab@c.de'] }
  ]);
});
