/**
 * deviceTools.test.js — the deterministic device vocabulary over a mock backend.
 * pollMs is 1 and every timeout is in milliseconds, so the suite stays instant.
 */
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockBackend, normalizeSnapshot } = require('../../src/device/deviceBackend');
const { createMockJev } = require('../../src/jev/jevClient');
const { createDeviceSession, DEVICE_TOOL_SPECS, DEVICE_ASSERTIONS } = require('../../src/device/deviceTools');
const fixtures = require('../fixtures/device');

const APP = fixtures.APP;
const LOG_PATTERN = 'HARNESS|SUMMARY pass=10 fail=0 total=10';

function backendFor(raw) {
  return createMockBackend({ snapshots: [raw], appId: APP, logcat: LOG_PATTERN });
}

function sessionFor(raw, extra = {}) {
  const backend = backendFor(raw);
  return { backend, session: createDeviceSession({ backend, pollMs: 1, reportDir: os.tmpdir(), ...extra }) };
}

/**
 * A mock backend whose snapshot() walks a list of screens and stays on the last one —
 * the shape a live screen with changing counters or extra scrolled rows has.
 */
function sequenceBackend(raws) {
  const screens = raws.map((raw) => normalizeSnapshot(raw, APP));
  const backend = createMockBackend({ snapshots: [screens[0]], appId: APP, logcat: LOG_PATTERN });
  let index = 0;
  backend.snapshot = async () => screens[Math.min(index++, screens.length - 1)];
  return backend;
}

function sequenceSession(raws, extra = {}) {
  const backend = sequenceBackend(raws);
  return { backend, session: createDeviceSession({ backend, pollMs: 1, reportDir: os.tmpdir(), ...extra }) };
}

const OTP_CODE = '2468';

/** OTP screen: a title plus the OTP box (no text, value or label in the tree). */
function otpRaw() {
  return fixtures.snapshot([
    statusBar(),
    fixtures.node('e90', 'Nhập mã xác thực', 100),
    fixtures.node('e91', '', 200, { type: 'android.widget.EditText', editable: true }),
    fixtures.node('e92', 'Xác nhận', 300, { type: 'android.widget.Button' })
  ]);
}

/** Trusted-device branch: the OTP screen never shows, the password one does. */
function passwordRaw() {
  return fixtures.snapshot([
    statusBar(),
    fixtures.node('e93', 'Nhập mật khẩu', 100),
    fixtures.node('e94', '', 200, { type: 'android.widget.EditText', editable: true, password: true })
  ]);
}

function statusBar() {
  return fixtures.node('e99', '9:41', 12, { bundleId: fixtures.SYSTEMUI, hittable: false });
}

/** One "▶ Run all" area as it counts up: the totals row of a running test suite. */
function countersScreen(pass, fail, idle) {
  return fixtures.snapshot([
    statusBar(),
    fixtures.node('c1', '▶ Run all', 150, { type: 'android.widget.Button' }),
    fixtures.node('c2', `${pass} pass`, 200),
    fixtures.node('c3', `${fail} fail`, 240),
    fixtures.node('c4', `${idle} idle`, 280)
  ]);
}

/** The max-api-v2 area: its totals row, then one tally block per module. */
function modulesRaw() {
  return fixtures.snapshot([
    statusBar(),
    fixtures.node('m1', 'max-api-v2', 100),
    fixtures.node('m2', '324 pass', 200),
    fixtures.node('m3', '1 fail', 240),
    fixtures.node('m4', '321 idle', 280),
    fixtures.node('m5', 'module alpha', 340),
    fixtures.node('m6', '3 pass', 380),
    fixtures.node('m7', '0 fail', 420),
    fixtures.node('m8', 'module beta', 460),
    fixtures.node('m9', '5 pass', 500),
    fixtures.node('m10', '2 fail', 540)
  ]);
}

/** The Home performance panel: label rows with unrelated text between the values. */
function perfRaw() {
  return fixtures.snapshot([
    statusBar(),
    fixtures.node('p1', 'HIỆU NĂNG', 80),
    fixtures.node('p2', 'CPU', 140),
    fixtures.node('p3', 'app / toàn máy · 8 lõi', 180),
    fixtures.node('p4', '7.7 %', 220),
    fixtures.node('p5', 'jank', 300),
    fixtures.node('p6', '75 frame trong cửa sổ', 340),
    fixtures.node('p7', '95 %', 380),
    fixtures.node('p8', 'thread', 460),
    fixtures.node('p9', '82', 500)
  ]);
}

test('meta reports the backend and the current app', async () => {
  const { session } = sessionFor(fixtures.homeRaw());

  assert.deepEqual(await session.meta(), {
    ok: true,
    backend: 'mock',
    platform: 'android',
    serial: undefined,
    udid: undefined,
    appId: APP
  });
});

test('launch_app falls back to the session app defaults', async () => {
  const { backend, session } = sessionFor(fixtures.homeRaw(), {
    appDefaults: { package: APP, activity: '.MainActivity' }
  });

  assert.deepEqual(await session.launch_app(), { ok: true, app: APP });
  assert.deepEqual(backend.actions[0], { kind: 'open', app: APP, activity: '.MainActivity', relaunch: true, extras: undefined });
  assert.deepEqual(backend.meta().appId, APP);

  await session.launch_app({ package: 'com.acme.other' });
  assert.equal(backend.actions[1].app, 'com.acme.other');
});

test('launch_app without a package fails instead of guessing', async () => {
  const { session } = sessionFor(fixtures.homeRaw());

  assert.equal((await session.launch_app()).ok, false);
  assert.match((await session.launch_app()).error, /requires a package/);
});

test('tap_text finds a folded label and taps its pinned ref', async () => {
  const { backend, session } = sessionFor(fixtures.homeRaw());

  assert.deepEqual(await session.tap_text({ text: 'Đăng nhập', timeout: 200 }), { ok: true, found: true, label: 'Đăng nhập' });
  assert.equal(backend.actions.length, 1);
  assert.equal(backend.actions[0].kind, 'press');
  assert.equal(backend.actions[0].target.ref, 'e17');

  const folded = await session.tap_text({ text: 'dang nhap', timeout: 200 });
  assert.deepEqual(folded, { ok: true, found: true, label: 'Đăng nhập' });
});

test('tap_text reports a missing element without throwing', async () => {
  const { backend, session } = sessionFor(fixtures.homeRaw());

  const result = await session.tap_text({ text: 'Không tồn tại', timeout: 5 });

  assert.equal(result.ok, false);
  assert.equal(result.found, false);
  assert.match(result.error, /no element with text "Không tồn tại"/);
  assert.equal(backend.actions.length, 0);
});

test('tap_text can target a later match by index', async () => {
  const { session } = sessionFor(fixtures.orderingRaw());

  const result = await session.tap_text({ text: 'max-api-v2', timeout: 100, index: 1 });

  assert.deepEqual(result, { ok: true, found: true, label: 'max-api-v2' });
});

test('tap_if_present_text never fails the step', async () => {
  const { backend, session } = sessionFor(fixtures.homeRaw());

  assert.deepEqual(await session.tap_if_present_text({ text: 'Không tồn tại', timeout: 5 }), { ok: true, found: false });
  assert.deepEqual(await session.tap_if_present_text({ text: 'Huỷ', timeout: 5 }), { ok: true, found: false });
  assert.deepEqual(
    await session.tap_if_present_text({ text: 'Đăng nhập', timeout: 50 }),
    { ok: true, found: true, label: 'Đăng nhập' }
  );
  assert.equal(backend.actions.filter((action) => action.kind === 'press').length, 1);
});

test('tap_text re-resolves the ref when the device rejects a superseded snapshot', async () => {
  const base = backendFor(fixtures.homeRaw());
  let thrown = false;
  const backend = {
    ...base,
    press: async (node) => {
      if (!thrown) {
        thrown = true;
        throw new Error('Ref @e1 was minted from a superseded snapshot generation');
      }
      return base.press(node);
    }
  };
  const session = createDeviceSession({ backend, pollMs: 1, reportDir: os.tmpdir() });

  assert.deepEqual(await session.tap_text({ text: 'Đăng nhập', timeout: 50 }), { ok: true, found: true, label: 'Đăng nhập' });
  assert.equal(backend.actions.filter((action) => action.kind === 'press').length, 1);
});

test('tap_text keeps a press error that is not a stale ref', async () => {
  const base = backendFor(fixtures.homeRaw());
  const backend = {
    ...base,
    press: async () => {
      throw new Error('device offline');
    }
  };
  const session = createDeviceSession({ backend, pollMs: 1, reportDir: os.tmpdir() });

  assert.deepEqual(await session.tap_text({ text: 'Đăng nhập', timeout: 50 }), { ok: false, error: 'device offline' });
});

test('tap_if_present_text retries a stale ref and still never fails the step', async () => {
  const base = backendFor(fixtures.homeRaw());
  let thrown = false;
  const backend = {
    ...base,
    press: async (node) => {
      if (!thrown) {
        thrown = true;
        throw new Error('Ref @e17 was minted from a stale snapshot generation');
      }
      return base.press(node);
    }
  };
  const session = createDeviceSession({ backend, pollMs: 1, reportDir: os.tmpdir() });

  assert.deepEqual(
    await session.tap_if_present_text({ text: 'Đăng nhập', timeout: 50 }),
    { ok: true, found: true, label: 'Đăng nhập' }
  );
  assert.equal(backend.actions.filter((action) => action.kind === 'press').length, 1);
});

test('fill types into the labelled editable field without echoing the value', async () => {
  const { backend, session } = sessionFor(fixtures.loginRaw());

  const result = await session.fill({ label: 'so dien thoai', text: '0900000099', timeout: 200 });

  assert.deepEqual(result, { ok: true });
  assert.equal(JSON.stringify(result).includes('0900000099'), false);
  assert.equal(backend.actions[0].kind, 'fill');
  assert.equal(backend.actions[0].target.ref, 'e51');
  assert.equal(backend.actions[0].text, '0900000099');
});

test('fill without a label uses the topmost editable field', async () => {
  const { backend, session } = sessionFor(fixtures.loginRaw());

  assert.deepEqual(await session.fill({ text: '1234', timeout: 200 }), { ok: true });
  assert.equal(backend.actions[0].target.ref, 'e51');
});

test('fill fails cleanly when there is no editable field', async () => {
  const { session } = sessionFor(fixtures.sectionRaw());

  const missing = await session.fill({ label: 'Số điện thoại', text: '1', timeout: 5 });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no editable field/);
});

test('fill_otp_from_api types the API OTP into the empty field without echoing it', async () => {
  const phones = [];
  const { backend, session } = sessionFor(otpRaw(), {
    otpProvider: async (phone) => {
      phones.push(phone);
      return OTP_CODE;
    }
  });

  const result = await session.fill_otp_from_api({ phone: ' 0900000002 ', waitText: 'Nhap ma xac thuc', timeout: 200 });

  assert.deepEqual(result, { ok: true, found: true, attempts: 1 });
  assert.deepEqual(phones, ['0900000002']);
  assert.equal(JSON.stringify(result).includes(OTP_CODE), false);
  assert.equal(backend.actions[0].kind, 'fill');
  assert.equal(backend.actions[0].target.ref, 'e91');
  assert.equal(backend.actions[0].text, OTP_CODE);
});

test('fill_otp_from_api stops without calling the API when the screen skipped OTP', async () => {
  let calls = 0;
  const { backend, session } = sessionFor(passwordRaw(), {
    otpProvider: async () => {
      calls += 1;
      return OTP_CODE;
    }
  });

  const result = await session.fill_otp_from_api({
    phone: '0900000002',
    waitText: 'Nhập mã xác thực',
    unlessText: 'Nhập mật khẩu',
    timeout: 200
  });

  assert.deepEqual(result, { ok: true, found: false, skipped: true, matched: 'Nhập mật khẩu' });
  assert.equal(calls, 0);
  assert.equal(backend.actions.length, 0);
});

test('fill_otp_from_api on iOS Compose focuses the placeholder and types, since the tree has no field', async () => {
  const raw = fixtures.snapshot([
    statusBar(),
    fixtures.node('e90', 'Nhập mã xác thực', 100),
    fixtures.node('e95', '• • • • • •', 200),
    fixtures.node('e92', 'Xác nhận', 300, { type: 'Button' })
  ]);
  const { backend, session } = sessionFor(raw, { otpProvider: async () => OTP_CODE });
  backend.typeText = async (text) => {
    backend.actions.push({ kind: 'type', text });
    return { ok: true };
  };

  const result = await session.fill_otp_from_api({
    phone: '0900000002',
    waitText: 'Nhập mã xác thực',
    label: '• • • • • •',
    timeout: 200
  });

  assert.deepEqual(result, { ok: true, found: true, attempts: 1, focused: true });
  assert.equal(JSON.stringify(result).includes(OTP_CODE), false);
  assert.deepEqual(backend.actions.map((action) => action.kind), ['press', 'type']);
  assert.equal(backend.actions[0].target.ref, 'e95');
  assert.equal(backend.actions[1].text, OTP_CODE);
});

test('fill_otp_from_api with a placeholder label still finds the Android field by index', async () => {
  const { backend, session } = sessionFor(otpRaw(), { otpProvider: async () => OTP_CODE });

  const result = await session.fill_otp_from_api({
    phone: '0900000002',
    waitText: 'Nhập mã xác thực',
    label: '• • • • • •',
    timeout: 200
  });

  assert.deepEqual(result, { ok: true, found: true, attempts: 1 });
  assert.equal(backend.actions[0].kind, 'fill');
  assert.equal(backend.actions[0].target.ref, 'e91');
});

test('fill_otp_from_api retries the provider before typing', async () => {
  let calls = 0;
  const { session } = sessionFor(otpRaw(), {
    otpProvider: async () => {
      calls += 1;
      if (calls < 3) throw new Error(`flaky attempt ${calls}`);
      return OTP_CODE;
    }
  });

  const result = await session.fill_otp_from_api({ phone: '0900000002', intervalMs: 1 });

  assert.deepEqual(result, { ok: true, found: true, attempts: 3 });
  assert.equal(calls, 3);
});

test('fill_otp_from_api reports a failing OTP API without the code', async () => {
  const { backend, session } = sessionFor(otpRaw(), {
    otpProvider: async () => {
      throw new Error('UAT OTP API unreachable');
    }
  });

  const result = await session.fill_otp_from_api({ phone: '0900000002', attempts: 2, intervalMs: 1 });

  assert.equal(result.ok, false);
  assert.match(result.error, /after 2 attempt\(s\): UAT OTP API unreachable/);
  assert.equal(JSON.stringify(result).includes(OTP_CODE), false);
  assert.equal(backend.actions.length, 0);
});

test('fill_otp_from_api requires the login phone', async () => {
  const { session } = sessionFor(otpRaw(), { otpProvider: async () => OTP_CODE });

  assert.deepEqual(await session.fill_otp_from_api({}), { ok: false, error: 'fill_otp_from_api requires phone' });
  assert.deepEqual(await session.fill_otp_from_api({ phone: '   ' }), { ok: false, error: 'fill_otp_from_api requires phone' });
});

test('fill_otp_from_api fails when the OTP screen never appears', async () => {
  const { session } = sessionFor(fixtures.sectionRaw(), { otpProvider: async () => OTP_CODE });

  const result = await session.fill_otp_from_api({
    phone: '0900000002',
    waitText: 'Nhập mã xác thực',
    unlessText: 'Nhập mật khẩu',
    timeout: 5
  });

  assert.equal(result.ok, false);
  assert.equal(result.found, false);
  assert.match(result.error, /"Nhập mã xác thực" did not appear/);
});

test('wait_text, wait_any_text and assert_text poll for presence', async () => {
  const { session } = sessionFor(fixtures.sectionRaw());

  assert.deepEqual(await session.wait_text({ text: 'max-api-v2', timeout: 100 }), { ok: true, found: true });
  assert.deepEqual(await session.wait_text({ text: 'khong co', timeout: 5 }), { ok: true, found: false });
  assert.deepEqual(await session.wait_any_text({ texts: ['khong co', '▶ Run all'], timeout: 100 }), { ok: true, found: true, matched: '▶ Run all', value: '▶ Run all' });
  assert.deepEqual(await session.wait_any_text({ texts: ['khong co'], timeout: 5 }), { ok: true, found: false });
  assert.deepEqual(await session.assert_text({ text: '▶ Run all', timeout: 100 }), { ok: true, found: true });
  assert.deepEqual(await session.assert_text({ text: 'khong co', timeout: 5 }), { ok: true, found: false });
});

test('assert_absent is true only once the text is gone', async () => {
  const { session } = sessionFor(fixtures.sectionRaw());

  assert.deepEqual(await session.assert_absent({ text: 'Đăng nhập', timeout: 5 }), { ok: true, found: true });
  assert.deepEqual(await session.assert_absent({ text: 'max-api-v2', timeout: 5 }), { ok: true, found: false });
});

test('scroll and back drive the backend', async () => {
  const { backend, session } = sessionFor(fixtures.homeRaw());

  assert.deepEqual(await session.scroll({ direction: 'up' }), { ok: true });
  assert.deepEqual(await session.back(), { ok: true });
  assert.deepEqual(backend.actions.map((action) => action.kind), ['scroll', 'back']);
  assert.equal(backend.actions[0].direction, 'up');
});

test('scroll_to_text swipes until found and fails when it never appears', async () => {
  const found = sessionFor(fixtures.homeRaw());
  assert.deepEqual(await found.session.scroll_to_text({ text: 'api-contract', maxSwipes: 2 }), { ok: true, found: true, label: 'api-contract' });
  assert.equal(found.backend.actions.length, 0);

  const missing = sessionFor(fixtures.homeRaw());
  const result = await missing.session.scroll_to_text({ text: 'khong co', maxSwipes: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.found, false);
  assert.equal(missing.backend.actions.filter((action) => action.kind === 'scroll').length, 2);
});

test('logcat tools read the Android buffer', async () => {
  const { backend, session } = sessionFor(fixtures.homeRaw());

  assert.deepEqual(await session.clear_logcat(), { ok: true });
  assert.equal(backend.logcat, '');

  backend.logcat = LOG_PATTERN;
  assert.deepEqual(await session.expect_logcat({ pattern: 'SUMMARY pass=(\\d+) fail', timeout: 5 }), {
    ok: true,
    found: true,
    match: 'SUMMARY pass=10 fail'
  });
  assert.deepEqual(await session.expect_logcat({ pattern: 'khong co', timeout: 0 }), { ok: true, found: false });
  assert.equal((await session.expect_logcat({ pattern: '([', timeout: 0 })).ok, false);
});

test('jev_verify turns a noul score into a thresholded assertion', async () => {
  const states = [];
  const jev = createMockJev((state) => {
    states.push(state);
    return { verdict: { type: 'noul', noul: 0.9 } };
  });
  const { session } = sessionFor(fixtures.sectionRaw(), { jev });

  assert.deepEqual(await session.jev_verify({ expect: 'màn hình max-api-v2 đang mở', threshold: 0.8 }), {
    ok: true,
    found: true,
    probability: 0.9
  });
  assert.deepEqual(await session.jev_verify({ expect: 'màn hình max-api-v2 đang mở', threshold: 0.95 }), {
    ok: true,
    found: false,
    probability: 0.9
  });
  assert.equal(states[0].expectation, 'màn hình max-api-v2 đang mở');
  assert.ok(states[0].screen.visibleText.includes('▶ Run all'));
});

test('jev_verify and jev_recover need a Jev client', async () => {
  const { session } = sessionFor(fixtures.homeRaw());

  assert.deepEqual(await session.jev_verify({ expect: 'x' }), { ok: false, error: 'jev_verify requires TYPESAFE_API_KEY' });
  assert.deepEqual(await session.jev_recover({ goal: 'x' }), { ok: false, error: 'jev_recover requires TYPESAFE_API_KEY' });
});

test('jev_recover reports the inner run status and step count', async () => {
  const jev = createMockJev(() => ({ nextAction: { type: 'choice', choice: 'qa_pass', confidence: 0.9 } }));
  const { session } = sessionFor(fixtures.sectionRaw(), { jev });

  assert.deepEqual(await session.jev_recover({ goal: 'aboutir à la section max-api-v2' }), { ok: true, status: 'pass', steps: 1 });
});

test('screenshot writes under the report directory', async () => {
  const reportDir = path.join(os.tmpdir(), `jev-report-${process.pid}`);
  const { backend, session } = sessionFor(fixtures.homeRaw(), { reportDir });

  const result = await session.screenshot({ name: '../hack screen' });

  assert.equal(result.ok, true);
  assert.equal(result.path, result.screenshot);
  assert.match(result.path, /hack_screen_\d+\.png$/);
  assert.equal(path.dirname(result.path), path.join(reportDir, 'screenshots'));
  assert.deepEqual(backend.screenshots, [result.path]);
});

test('snapshot_text lists the visible texts', async () => {
  const { session } = sessionFor(fixtures.sectionRaw());

  const result = await session.snapshot_text();

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, ['‹', 'max-api-v2', '▶ Run all', '0 pass', 'maxapi.v2 (gốc)']);
});

test('wait_stable_texts waits for the counters to stop changing', async () => {
  const { session } = sequenceSession([
    countersScreen('0', '0', '1'),
    countersScreen('2', '0', '1'),
    countersScreen('3', '0', '1'),
    countersScreen('3', '0', '1')
  ]);

  const result = await session.wait_stable_texts({ pattern: '\\d+ (pass|fail|idle)', minMatches: 3, stableMs: 20, timeout: 2000 });

  assert.equal(result.ok, true);
  assert.equal(result.found, true);
  assert.equal(result.value, '3 pass · 0 fail · 1 idle');
  assert.ok(result.stable_ms >= 20, `stable_ms=${result.stable_ms}`);
});

test('wait_stable_texts never adopts or confirms a partial snapshot', async () => {
  const { session } = sequenceSession([
    countersScreen('3', '0', '1'),
    // From here on the tree is mid-redraw: only one of the three counters renders, so
    // that lone frame may neither become the answer nor decide that the run settled.
    fixtures.snapshot([statusBar(), fixtures.node('h1', '3 pass', 200)])
  ]);

  const result = await session.wait_stable_texts({ pattern: '\\d+ (pass|fail|idle)', minMatches: 3, stableMs: 20, timeout: 60 });

  assert.equal(result.ok, true);
  assert.equal(result.found, false);
  assert.equal(result.value, '3 pass · 0 fail · 1 idle');
});

test('wait_stable_texts keeps counting through a partial snapshot in the middle', async () => {
  const { session } = sequenceSession([
    countersScreen('3', '0', '1'),
    fixtures.snapshot([statusBar(), fixtures.node('h1', '3 pass', 200)]),
    countersScreen('3', '0', '1')
  ]);

  const result = await session.wait_stable_texts({ pattern: '\\d+ (pass|fail|idle)', minMatches: 3, stableMs: 20, timeout: 2000 });

  assert.equal(result.found, true);
  assert.equal(result.value, '3 pass · 0 fail · 1 idle');
});

test('wait_stable_texts reports found=false when the counters never settle', async () => {
  const { session } = sequenceSession([
    countersScreen('0', '0', '1'),
    countersScreen('1', '0', '1'),
    countersScreen('2', '0', '1')
  ]);

  const result = await session.wait_stable_texts({ pattern: '\\d+ (pass|fail|idle)', minMatches: 3, stableMs: 10000, timeout: 40 });

  assert.equal(result.ok, true);
  assert.equal(result.found, false);
  assert.equal(result.value, '2 pass · 0 fail · 1 idle');
});

test('wait_stable_texts rejects an invalid pattern', async () => {
  const { session } = sessionFor(fixtures.homeRaw());

  assert.deepEqual(await session.wait_stable_texts({ pattern: '([' }), { ok: false, error: 'invalid pattern: ([' });
});

test('wait_stable_texts can carry on with the counters it read at the deadline', async () => {
  const { session } = sequenceSession([
    countersScreen('0', '0', '1'),
    countersScreen('2', '0', '1'),
    countersScreen('3', '0', '1')
  ]);

  const result = await session.wait_stable_texts({
    pattern: '\\d+ (pass|fail|idle)',
    minMatches: 3,
    stableMs: 10000,
    timeout: 40,
    continueOnTimeout: true
  });

  assert.deepEqual(result, { ok: true, found: true, timed_out: true, value: '3 pass · 0 fail · 1 idle' });

  // Nothing was ever accepted, so there is no result to carry on with.
  const nothing = sessionFor(fixtures.sectionRaw());
  assert.deepEqual(
    await nothing.session.wait_stable_texts({ pattern: '^\\d+ idle$', minMatches: 3, stableMs: 10000, timeout: 20, continueOnTimeout: true }),
    { ok: true, found: false, value: '' }
  );
});

test('capture_texts collects every matching text in screen order', async () => {
  const { session } = sessionFor(modulesRaw());

  const result = await session.capture_texts({ pattern: '^\\d+ (pass|fail|idle)$' });

  assert.equal(result.ok, true);
  assert.equal(result.found, true);
  assert.deepEqual(result.items, ['324 pass', '1 fail', '321 idle', '3 pass', '0 fail', '5 pass', '2 fail']);
  assert.equal(result.value, '324 pass · 1 fail · 321 idle · 3 pass · 0 fail · 5 pass · 2 fail');
});

test('capture_texts honours startAfter and prefixes the module context', async () => {
  const { session } = sessionFor(modulesRaw());

  const result = await session.capture_texts({
    pattern: '^\\d+ (pass|fail)$',
    contextPattern: '^module ',
    startAfter: '321 idle'
  });

  assert.deepEqual(result.items, [
    'module alpha: 3 pass',
    'module alpha: 0 fail',
    'module beta: 5 pass',
    'module beta: 2 fail'
  ]);
  assert.equal(result.value, 'module alpha: 3 pass · module alpha: 0 fail · module beta: 5 pass · module beta: 2 fail');
});

test('capture_texts keeps a module tally that repeats another text on the screen', async () => {
  // The area header and a module can both read "2 fail"; so can two modules at "6/6 pass".
  const { session } = sessionFor(fixtures.snapshot([
    statusBar(),
    fixtures.node('d1', '2 fail', 100),
    fixtures.node('d2', 'MODULE CHẠY ĐƯỢC', 140),
    fixtures.node('d3', 'configuration', 180),
    fixtures.node('d4', '6/6 pass', 220),
    fixtures.node('d5', 'networking', 260),
    fixtures.node('d6', '2 fail', 300),
    fixtures.node('d7', 'observability', 340),
    fixtures.node('d8', '6/6 pass', 380)
  ]));

  const result = await session.capture_texts({
    pattern: '^(\\d+/\\d+ pass|\\d+ fail)$',
    contextPattern: '^[a-z]+$',
    startAfter: 'MODULE CHẠY ĐƯỢC'
  });

  assert.deepEqual(result.items, ['configuration: 6/6 pass', 'networking: 2 fail', 'observability: 6/6 pass']);
});

test('capture_texts scrolls through pages without duplicating a text', async () => {
  const { backend, session } = sequenceSession([
    fixtures.snapshot([statusBar(), fixtures.node('s1', '3 pass', 200), fixtures.node('s2', '0 fail', 240)]),
    fixtures.snapshot([statusBar(), fixtures.node('s3', '0 fail', 200), fixtures.node('s4', '5 pass', 240)])
  ]);

  const result = await session.capture_texts({ pattern: '^\\d+ (pass|fail)$', pages: 1 });

  assert.deepEqual(result.items, ['3 pass', '0 fail', '5 pass']);
  assert.equal(backend.actions.filter((action) => action.kind === 'scroll').length, 1);
});

test('capture_texts fails only when the capture is required', async () => {
  const { session } = sessionFor(fixtures.sectionRaw());

  const missing = await session.capture_texts({ pattern: '^\\d+ idle$' });
  assert.equal(missing.ok, false);
  assert.equal(missing.found, false);
  assert.match(missing.error, /no text matched \/\^\\d\+ idle\$\//);

  assert.deepEqual(await session.capture_texts({ pattern: '^\\d+ idle$', required: false }), {
    ok: true,
    found: false,
    value: '',
    items: []
  });
  assert.equal((await session.capture_texts({ pattern: '([' })).ok, false);
  assert.equal((await session.capture_texts({ pattern: 'pass', contextPattern: '([' })).ok, false);
});

test('capture_values reads the label → value pairs of the performance panel', async () => {
  const { session } = sessionFor(perfRaw());

  const result = await session.capture_values({ fields: { cpu: 'CPU', jank: 'jank', threads: 'thread' } });

  assert.equal(result.ok, true);
  assert.equal(result.found, true);
  assert.deepEqual(result.values, { cpu: '7.7 %', jank: '95 %', threads: '82' });
  assert.deepEqual(result.missing, []);
  assert.equal(result.value, 'cpu=7.7 % · jank=95 % · threads=82');
});

test('capture_values lists the labels it could not read', async () => {
  const { session } = sessionFor(perfRaw());

  const result = await session.capture_values({ fields: { cpu: 'CPU', gpu: 'GPU' } });

  assert.equal(result.ok, false);
  assert.equal(result.found, false);
  assert.deepEqual(result.values, { cpu: '7.7 %' });
  assert.deepEqual(result.missing, ['gpu']);
  assert.equal(result.value, 'cpu=7.7 %');
  assert.equal(result.error, 'missing: gpu');

  const optional = await session.capture_values({ fields: { gpu: 'GPU' }, required: false });
  assert.equal(optional.ok, true);
  assert.equal(optional.found, false);
  assert.equal(optional.error, undefined);
});

test('capture_values validates its inputs and can skip an earlier block', async () => {
  const { session } = sessionFor(perfRaw());

  assert.deepEqual(await session.capture_values({}), { ok: false, error: 'capture_values requires a non-empty fields mapping' });
  assert.deepEqual(await session.capture_values({ fields: {} }), { ok: false, error: 'capture_values requires a non-empty fields mapping' });
  assert.deepEqual(await session.capture_values({ fields: { cpu: 'CPU' }, valuePattern: '([' }), {
    ok: false,
    error: 'invalid valuePattern: (['
  });

  // startAfter drops the label itself, so nothing can be read for it.
  const skipped = await session.capture_values({ fields: { cpu: 'CPU' }, startAfter: 'CPU' });
  assert.equal(skipped.ok, false);
  assert.deepEqual(skipped.missing, ['cpu']);
});

test('assert_value matches a captured value against a regexp', async () => {
  const { session } = sessionFor(fixtures.homeRaw());

  assert.deepEqual(await session.assert_value({ value: '324 pass · 1 fail · 321 idle', match: '(^|· )0 fail( ·|$)' }), {
    ok: true,
    found: false,
    value: '324 pass · 1 fail · 321 idle'
  });
  assert.deepEqual(await session.assert_value({ value: '324 pass · 0 fail · 321 idle', match: '(^|· )0 fail( ·|$)' }), {
    ok: true,
    found: true,
    value: '324 pass · 0 fail · 321 idle'
  });
  assert.deepEqual(await session.assert_value({ value: '0 fail', notMatch: '\\d+ fail' }), { ok: true, found: false, value: '0 fail' });
  assert.deepEqual(await session.assert_value({ match: '^$' }), { ok: true, found: true, value: '' });
  assert.deepEqual(await session.assert_value({ value: 0 }), { ok: false, error: 'assert_value requires match or notMatch' });
  assert.deepEqual(await session.assert_value({ value: '1', match: '([' }), { ok: false, error: 'invalid pattern: ([' });
});

test('DEVICE_TOOL_SPECS documents exactly the session tools', async () => {
  const { session } = sessionFor(fixtures.homeRaw());
  const names = DEVICE_TOOL_SPECS.map((spec) => spec.name).sort();

  assert.deepEqual(names, Object.keys(session).sort());
  assert.equal(new Set(names).size, names.length);
  for (const spec of DEVICE_TOOL_SPECS) {
    assert.equal(typeof spec.desc, 'string');
    assert.ok(spec.desc.length > 0);
    assert.equal(typeof spec.args, 'object');
  }
  for (const name of DEVICE_ASSERTIONS) {
    assert.ok(names.includes(name), `${name} must be a documented tool`);
  }
  assert.deepEqual([...DEVICE_ASSERTIONS].sort(), ['assert_absent', 'assert_text', 'assert_value', 'expect_logcat', 'jev_verify', 'wait_any_text', 'wait_stable_texts', 'wait_text']);
});

test('tap_within taps a fraction of an element box and refuses a bad fraction', async () => {
  const raw = fixtures.homeRaw();
  raw.nodes.push({ ...raw.nodes[1], ref: 'e99', label: 'seatCanvas', value: 'seatCanvas', rect: { x: 100, y: 200, width: 400, height: 1000 } });
  const { backend, session } = sessionFor(raw);

  assert.deepEqual(await session.tap_within({ text: 'seatCanvas', exact: true, fx: 0.5, fy: 0.25, timeout: 5 }), { ok: true, found: true });
  const press = backend.actions.find((action) => action.kind === 'press');
  assert.deepEqual(press.target, { x: 300, y: 450 });

  assert.match((await session.tap_within({ text: 'seatCanvas', fx: 2, fy: 0 })).error, /between 0 and 1/);
  const missing = await session.tap_within({ text: 'Không tồn tại', fx: 0.5, fy: 0.5, timeout: 5 });
  assert.equal(missing.ok, false);
  assert.equal(missing.found, false);
});

test('swipe_within drags between two fractions of an element box', async () => {
  const raw = fixtures.homeRaw();
  raw.nodes.push({ ...raw.nodes[1], ref: 'e98', label: 'page', value: 'page', rect: { x: 0, y: 100, width: 1000, height: 2000 } });
  const { backend, session } = sessionFor(raw);
  const swipes = [];
  backend.swipe = async (from, to) => { swipes.push([from, to]); return { ok: true }; };

  assert.deepEqual(await session.swipe_within({ text: 'page', exact: true, fx1: 0.5, fy1: 0.75, fx2: 0.5, fy2: 0.25, timeout: 5 }), { ok: true, found: true });
  assert.deepEqual(swipes, [[{ x: 500, y: 1600 }, { x: 500, y: 600 }]]);
  assert.match((await session.swipe_within({ text: 'page', fx1: 2, fy1: 0, fx2: 0, fy2: 0 })).error, /between 0 and 1/);
});

test('fill does not retype a field that already holds the value, and still types a different one', async () => {
  const raw = fixtures.homeRaw();
  raw.nodes.push({ ...raw.nodes[1], ref: 'e97', type: 'android.widget.EditText', label: 'ab@c.de', value: 'ab@c.de', editable: true, hintShowing: false });
  const { backend, session } = sessionFor(raw);

  assert.deepEqual(await session.fill({ index: 0, text: 'ab@c.de', timeout: 5 }), { ok: true, unchanged: true });
  assert.equal(backend.actions.filter((action) => action.kind === 'fill').length, 0);

  await session.fill({ index: 0, text: 'zz@c.de', timeout: 5, verify: false });
  assert.equal(backend.actions.filter((action) => action.kind === 'fill').length, 1);
});

test('keyboard presses the keyboard action key or hides it, and refuses anything else', async () => {
  const { createMockBackend } = require('../../src/device/deviceBackend');
  const { createDeviceSession } = require('../../src/device/deviceTools');
  const backend = createMockBackend({ snapshots: [{ nodes: [] }] });
  const session = createDeviceSession({ backend, pollMs: 1, reportDir: require('os').tmpdir() });
  assert.deepEqual(await session.keyboard({ action: 'enter' }), { ok: true });
  assert.deepEqual(await session.keyboard(), { ok: true });
  assert.equal((await session.keyboard({ action: 'type' })).ok, false);
  assert.deepEqual(backend.actions.filter((item) => item.kind === 'keyboard').map((item) => item.action), ['enter', 'dismiss']);
});
