/**
 * flow.test.js — the leg loop on a state-machine device and a mock Jev.
 *
 * Today's device fixture is not a real device, so the loop is tested where it decides: which
 * exception tier wins, which case is tried, when Jev is asked, what a stop looks like, and what
 * must never appear in the result (an input's VALUE).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runLegs } = require('../../src/runner/flow');
const { loadStore } = require('../../src/screens/store');
const { createLearner } = require('../../src/screens/learn');
const { flush } = require('../../src/screens/writer');
const { createDeviceSession } = require('../../src/device/deviceTools');
const { createMockJev } = require('../../src/jev/jevClient');
const { createScreenDevice, chooseByDescription } = require('../fixtures/screens');
const { writeStore } = require('../fixtures/screenStore');

const PHONE = '0900000002';

const SCREENS = {
  home: ['Acme Example', 'Đăng nhập'],
  login_phone: ['Đăng nhập Acme', { label: 'Số điện thoại', editable: true, identifier: 'phone_input' }, { label: 'Tiếp tục', identifier: 'btn_continue' }],
  login_method: ['Chọn một trong các cách xác thực', 'Nhận OTP từ tổng đài Acme'],
  signed_in: ['Acme Example', 'authState: LOGGED'],
  popup: ['Cập nhật phiên bản', 'Để sau'],
  stuck: ['Màn hình kẹt', 'Thử lại'],
  maintenance: ['Bảo trì hệ thống đang diễn ra'],
  ekyc: ['Đăng nhập Acme', 'Xác thực khuôn mặt', 'Bắt đầu'],
  home_error: ['Acme Example', 'Đăng nhập', 'Exception: errorCode 40000'],
  // A popup that is shown ON TOP of Home: Home is still the identified screen while it is up.
  home_popup: ['Acme Example', 'Đăng nhập', 'Ứng dụng có bản mới', 'Bỏ qua'],
  card: ['Mua mã thẻ', 'Viettel', 'Mobifone', 'Tiếp tục'],
  confirm: ['Xác nhận thanh toán'],
};

const MOVES = {
  home: { 'Đăng nhập': 'login_phone' },
  login_phone: { btn_continue: 'login_method' },
  login_method: { 'Nhận OTP từ tổng đài Acme': 'signed_in' },
  popup: { 'Để sau': 'login_phone' },
  ekyc: { 'Bắt đầu': 'ekyc' },
};

const tap = (text, extra = {}) => ({ tool: 'tap_text', args: { text, exact: true, ...extra } });
const FILL_PHONE = { tool: 'fill', args: { index: 0, text: '{phone}' } };
const CASE_HOME_LOGIN = { to: 'core/login_phone', intent: 'Open the login screen', steps: [tap('Đăng nhập')] };
const CASE_LOGIN_METHOD = { to: 'core/login_method', intent: 'Submit the phone number', steps: [FILL_PHONE, tap('btn_continue')] };
const CASE_METHOD_SIGNED_IN = { to: 'core/signed_in', intent: 'Confirm the OTP', steps: [tap('Nhận OTP từ tổng đài Acme')] };

const EKYC_RULE = {
  id: 'ekyc_face_verification',
  when: { anyText: ['Xác thực khuôn mặt', 'Quét khuôn mặt'] },
  do: { fail: 'identity/face/eKYC verification shown — never automated (policy)' },
  pinned: true,
};
const VERSION_POPUP = { id: 'version_popup', when: { allText: ['Cập nhật phiên bản', 'Để sau'] }, do: { tap: 'Để sau' } };
const MAINTENANCE = { id: 'service_maintenance', when: { anyText: ['Bảo trì hệ thống'] }, do: { blocked: 'UAT is under maintenance' } };
const STUCK_RETRY = { id: 'stuck_retry', when: { allText: ['Màn hình kẹt'] }, do: { tap: 'Thử lại' } };

/** The knowledge tree, with per-screen overrides: every case says exactly what it needs. */
function treeOf({ screens = {}, routes = [] } = {}) {
  const base = {
    home: { identify: { allText: ['Acme Example', 'Đăng nhập'] }, body: 'Home of the example app, signed out.', normal: [], exceptions: [] },
    login_phone: { identify: { allText: ['Đăng nhập Acme'] }, inputs: ['phone'], body: 'Phone number entry.', normal: [], exceptions: [] },
    login_method: { identify: { allText: ['Nhận OTP từ tổng đài Acme'] }, body: 'OTP / password picker.', normal: [], exceptions: [] },
    signed_in: { identify: { allText: ['authState: LOGGED'] }, body: 'Signed in.', normal: [], exceptions: [] },
  };
  for (const [id, override] of Object.entries(screens)) base[id] = { ...(base[id] || {}), ...override };
  return {
    shared: { exceptions: [EKYC_RULE] },
    apps: {
      example: {
        app: { context: 'Example app notes for Jev.', exceptions: [VERSION_POPUP, MAINTENANCE], routes },
        groups: {
          core: {
            miniapp: { exceptions: [STUCK_RETRY] },
            screens: base,
          },
        },
      },
    },
  };
}

/**
 * Records every hook call, so a test can see what the loop told the learner. The visit hooks go
 * to their own lists: `calls` is the ledger of the decisions, `visits`/`caseRuns`/`legStarts` the
 * context a learner needs to build knowledge from them.
 */
function stubLearner() {
  const calls = [];
  const visits = [];
  const caseRuns = [];
  const legStarts = [];
  return {
    calls,
    visits,
    caseRuns,
    legStarts,
    legStart: (leg, index) => legStarts.push([leg.at, leg.to, index]),
    legOwnSteps: () => calls.push(['legOwnSteps']),
    visitStart: (screenId) => visits.push(screenId),
    caseRan: (item, steps) => caseRuns.push([item.to, steps]),
    ruleOutcome: (rule, ok) => calls.push(['ruleOutcome', rule.id, ok]),
    caseOutcome: (item, ok) => calls.push(['caseOutcome', item.to, ok]),
    jevAction: (record, before, after, beforeId, afterId, confidence) => calls.push(['jevAction', record.description, beforeId, afterId, confidence]),
    legPassed: (route) => calls.push(['legPassed', route]),
    legEnd: (status) => calls.push(['legEnd', status]),
  };
}

const LEVELS = (result) => result.entries.map((item) => [item.leg, item.level, item.what, item.ok]);

const FLOW_RUN = 'flow_run_20260924_120000';
const read = (file) => fs.readFileSync(file, 'utf8');
const exists = (file) => fs.existsSync(file);
const yamlAt = (root, ...rest) => path.join(root, 'screens', 'example', ...rest);

/** A Jev that answers with the given descriptions, one per call. */
function jevQueue(descriptions) {
  return createMockJev((state, questions, call) => chooseByDescription(descriptions[call])(state, questions));
}

function setup({
  start = 'home',
  screens = {},
  routes = [],
  moves = MOVES,
  hidden = {},
  deviceScreens = SCREENS,
  jev = null,
  data = {},
  inputs = [],
  threshold = 0.75,
  exclude,
  options = {},
  budget = { jevCalls: 0, maxJevCalls: 30 },
  learn = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-flow-'));
  writeStore(root, treeOf({ screens, routes }));
  const store = loadStore(root, 'example');
  const backend = createScreenDevice({ screens: deviceScreens, moves, start, hidden });
  const session = createDeviceSession({ backend, jev, reportDir: root, pollMs: 1 });
  const plan = {
    name: 't',
    goal: 'Sign in to the example app and reach the signed-in screen',
    inputs: inputs.map((name) => ({ name })),
    options: { legTimeoutMs: 4000, maxJevCallsPerLeg: 6, caseWaitMs: 30, stepTimeoutMs: 2000, ...options },
  };
  const data_ = { ...data };
  // A real learner needs the store (it names the files it writes) and the row's values.
  const learner = learn
    ? createLearner({
      store,
      runId: FLOW_RUN,
      data: data_,
      plan,
      inputNames: inputs,
      now: () => Date.parse('2026-09-24T10:00:00Z'),
    })
    : stubLearner();
  const ctx = {
    backend,
    session,
    recipeSession: session,
    jev,
    store,
    plan,
    data: data_,
    inputs: inputs.slice(),
    exclude,
    threshold,
    budget,
    learner,
  };
  return { root, store, backend, ctx, learner, plan, run: (legs, opts) => runLegs(ctx, legs, opts) };
}


test('(1) a leg whose hops are all known passes with zero Jev calls', async () => {
  const jev = createMockJev(() => { throw new Error('Jev must not be called'); });
  const { run, backend, learner } = setup({
    jev,
    inputs: ['phone'],
    data: { phone: PHONE },
    screens: { home: { normal: [CASE_HOME_LOGIN] }, login_phone: { normal: [CASE_LOGIN_METHOD] } },
  });
  const result = await run([{ at: 'core/home', to: 'core/login_method' }]);

  assert.equal(result.status, 'pass');
  assert.equal(result.stoppedAt, null);
  assert.equal(result.reason, null);
  assert.deepEqual(result.warnings, []);
  assert.equal(backend.screen, 'login_method');
  assert.equal(jev.stats().calls, 0);
  assert.deepEqual(LEVELS(result), [
    [0, 'L0', 'core/login_phone', true],
    [0, 'L0', 'core/login_method', true],
    [0, 'L0', 'arrived', true],
  ]);
  assert.deepEqual(learner.calls, [
    ['caseOutcome', 'core/login_phone', true],
    ['caseOutcome', 'core/login_method', true],
    ['legPassed', ['core/home', 'core/login_phone', 'core/login_method']],
    ['legEnd', 'pass'],
  ]);
});

test('(2) a multi-hop leg with no recorded routes walks group (c)', async () => {
  const jev = createMockJev(() => { throw new Error('Jev must not be called'); });
  const { run, backend } = setup({
    jev,
    inputs: ['phone'],
    data: { phone: PHONE },
    screens: {
      home: { normal: [CASE_HOME_LOGIN] },
      login_phone: { normal: [CASE_LOGIN_METHOD] },
      login_method: { normal: [CASE_METHOD_SIGNED_IN] },
    },
  });
  const result = await run([{ at: 'core/home', to: 'core/signed_in' }]);

  assert.equal(result.status, 'pass');
  assert.equal(backend.screen, 'signed_in');
  assert.equal(jev.stats().calls, 0);
  assert.deepEqual(LEVELS(result).map((item) => item[2]), ['core/login_phone', 'core/login_method', 'core/signed_in', 'arrived']);
});

test('(3) a popup that appears mid-case is dismissed and the case still counts as ok', async () => {
  const { run, backend, learner } = setup({
    moves: { ...MOVES, home: { 'Đăng nhập': 'popup' } },
    screens: { home: { normal: [CASE_HOME_LOGIN] } },
  });
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);

  assert.equal(result.status, 'pass');
  assert.equal(backend.screen, 'login_phone');
  assert.deepEqual(LEVELS(result), [
    [0, 'L1', 'version_popup', true],   // handled while the case was waiting for its screen
    [0, 'L0', 'core/login_phone', true], // the case itself is not blamed
    [0, 'L0', 'arrived', true],
  ]);
  assert.deepEqual(learner.calls, [
    ['caseOutcome', 'core/login_phone', true],
    ['ruleOutcome', 'version_popup', true], // it cleared the screen, so it worked
    ['legPassed', ['core/home', 'core/login_phone']],
    ['legEnd', 'pass'],
  ]);
});

test('(3b) a case interrupted by a popup that leaves the app on the same screen is retried once', async () => {
  // First tap on "Đăng nhập" is swallowed by a popup that returns to Home; the second one works.
  const moves = { ...MOVES, home: { 'Đăng nhập': 'popup' }, popup: { 'Để sau': 'home' } };
  const { run, backend, learner } = setup({ moves, screens: { home: { normal: [CASE_HOME_LOGIN] } } });
  const press = backend.press.bind(backend);
  backend.press = async (node) => {
    const result = await press(node);
    if (node.text === 'Để sau') moves.home = { 'Đăng nhập': 'login_phone' };
    return result;
  };
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);

  assert.equal(result.status, 'pass');
  assert.equal(backend.screen, 'login_phone');
  assert.equal(backend.log.filter((item) => item.kind === 'press' && item.label === 'Đăng nhập').length, 2);
  assert.ok(!learner.calls.some((call) => call[0] === 'caseOutcome' && call[2] === false), 'the popup is not the case\'s fault');
});

test('leg.data overrides a row value for that leg only', async () => {
  const { run, backend, ctx } = setup({
    data: { phone: PHONE },
    screens: { login_phone: { normal: [CASE_LOGIN_METHOD] } },
    start: 'login_phone',
  });
  const result = await run([{ at: 'core/login_phone', to: 'core/login_method', data: { phone: '0900000001' } }]);

  assert.equal(result.status, 'pass');
  assert.deepEqual(backend.fills, ['0900000001']);
  assert.equal(ctx.data.phone, PHONE, 'the override must not leak into later legs');
});

test('a case waitMs outlasts the default case wait, and an unknown loading screen gets a grace before Jev', async () => {
  const jev = createMockJev(() => { throw new Error('Jev must not be called'); });
  const slow = { ...CASE_HOME_LOGIN, waitMs: 400 };
  const { run, backend } = setup({ jev, options: { caseWaitMs: 20, unknownGraceMs: 400 }, screens: { home: { normal: [slow] } } });
  const press = backend.press.bind(backend);
  backend.press = async (node) => {
    const result = await press(node);
    // A slow backend: first a blank loading screen, the destination 150 ms later.
    if (backend.screen === 'login_phone') {
      backend.screen = 'loading';
      setTimeout(() => { backend.screen = 'login_phone'; }, 150);
    }
    return result;
  };
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);

  assert.equal(result.status, 'pass');
  assert.equal(jev.stats().calls, 0);
});

test('a transient snapshot failure is retried instead of ending the run', async () => {
  const { run, backend } = setup({ screens: { home: { normal: [CASE_HOME_LOGIN] } } });
  const snapshot = backend.snapshot.bind(backend);
  let failures = 2;
  backend.snapshot = async () => {
    if (failures > 0) { failures -= 1; throw new Error('Android snapshot helper returned insufficient foreground app content []'); }
    return snapshot();
  };
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);
  assert.equal(result.status, 'pass');
});

test('a retry rule reruns the case once the wait is over, then gives up as blocked', async () => {
  const BACKEND_ERROR = { id: 'check_user_error', when: { allText: ['Exception: errorCode'] }, do: { retry: { wait: 1, max: 2 } } };
  // The first press shows a backend error on the same screen; the second one goes through.
  let presses = 0;
  const screens = { home: { normal: [CASE_HOME_LOGIN], exceptions: [BACKEND_ERROR] } };
  const { run, backend } = setup({ screens });
  backend.press = async (node) => {
    backend.log.push({ kind: 'press', label: node.text });
    presses += 1;
    backend.screen = presses === 1 ? 'home_error' : 'login_phone';
    return { ok: true };
  };
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);
  assert.equal(result.status, 'pass');
  assert.equal(presses, 2, 'the case ran again after the retry');

  const stuck = setup({ screens });
  stuck.backend.press = async () => { stuck.backend.screen = 'home_error'; return { ok: true }; };
  const failed = await stuck.run([{ at: 'core/home', to: 'core/login_phone' }]);
  assert.equal(failed.status, 'blocked');
  assert.equal(failed.reason, 'retry limit');
});

test('(4) a rule whose action changed nothing is recorded as failed, skipped, and never retried', async () => {
  const { run, backend, learner } = setup({ start: 'stuck' });
  const result = await run([{ at: 'core/home', to: 'core/signed_in' }]);

  assert.equal(result.status, 'needs_agent');
  assert.equal(result.reason, 'no_jev');
  assert.equal(result.stoppedAt, 0);
  assert.deepEqual(LEVELS(result), [
    [0, 'L1', 'stuck_retry', true],
    [0, 'L1', 'stuck_retry', false],
    [0, 'L3', 'jev', false],
  ]);
  assert.equal(backend.log.filter((item) => item.kind === 'press' && item.label === 'Thử lại').length, 1, 'the no-op tap must run once');
  assert.deepEqual(learner.calls, [['ruleOutcome', 'stuck_retry', false], ['legEnd', 'needs_agent']]);
});

test('(5) with no case, one confident Jev press moves the leg and passes it', async () => {
  const seen = [];
  const jev = createMockJev((state, questions) => {
    seen.push(state);
    return chooseByDescription('Tap "Đăng nhập"')(state, questions);
  });
  const budget = { jevCalls: 0, maxJevCalls: 30 };
  const { run, backend } = setup({ jev, budget, inputs: ['phone'] });
  const result = await run([{ at: 'core/home', to: 'core/login_phone', intent: 'Open login' }]);

  assert.equal(result.status, 'pass');
  assert.equal(backend.screen, 'login_phone');
  assert.equal(jev.stats().calls, 1);
  assert.deepEqual([budget.jevCalls, budget.maxJevCalls], [1, 30]);
  const l2 = result.entries.find((item) => item.level === 'L2');
  assert.deepEqual([l2.leg, l2.screen, l2.what, l2.ok, l2.confidence], [0, 'core/home', 'press "Đăng nhập"', true, 0.9]);
  assert.ok(l2.duration_ms >= 0);
  // What Jev was told: the leg, where it is going, and the current screen's notes.
  assert.deepEqual(seen[0].leg, { from: 'core/home', to: 'core/login_phone', intent: 'Open login' });
  assert.match(seen[0].destination, /Example app notes/);
  assert.match(seen[0].currentScreen, /Home of the example app/);
  assert.equal(seen[0].currentScreen.includes(PHONE), false);
  assert.deepEqual(seen[0].recentActions, []);
});

test('(6) a Jev answer below the threshold stops as needs_agent and changes nothing', async () => {
  const jev = createMockJev(() => ({ nextAction: { choice: 'back', confidence: 0.5 } }));
  const { run, backend, ctx } = setup({ jev, threshold: 0.75 });
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);

  assert.equal(result.status, 'needs_agent');
  assert.equal(result.reason, 'low_confidence');
  assert.equal(backend.screen, 'home');
  assert.deepEqual(ctx.budget, { jevCalls: 1, maxJevCalls: 30 });
  const last = result.entries.at(-1);
  assert.deepEqual([last.level, last.confidence, last.ok], ['L3', 0.5, false]);
});

test('(7) a blocked exception rule ends the leg as blocked, without Jev', async () => {
  const { run } = setup({ start: 'maintenance' });
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'UAT is under maintenance');
  assert.equal(result.stoppedAt, 0);
  assert.deepEqual(LEVELS(result), [[0, 'L1', 'service_maintenance', false]]);
});

test('(8) the shared eKYC policy wins over the current screen own rule', async () => {
  const start = 'ekyc';
  const { run, backend, learner } = setup({
    start,
    screens: { login_phone: { exceptions: [{ id: 'start_ekyc', when: { allText: ['Xác thực khuôn mặt'] }, do: { tap: 'Bắt đầu' } }] } },
  });
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);

  assert.equal(result.status, 'fail');
  assert.match(result.reason, /never automated \(policy\)/);
  assert.equal(backend.screen, 'ekyc', 'the screen rule must not have run');
  assert.deepEqual(LEVELS(result), [[0, 'L1', 'ekyc_face_verification', false]]);
  assert.deepEqual(learner.calls, [['legEnd', 'fail']], 'the policy rule is never learned from');
});

test('(9) checks are assertions: a pass arrives, a failure is a FAIL with no Jev call', async () => {
  const jev = createMockJev(() => { throw new Error('Jev must not be called'); });
  const passing = setup({ start: 'signed_in', jev });
  const arrived = await passing.run([{ at: 'core/home', to: 'core/signed_in', checks: [{ tool: 'assert_text', args: { text: 'authState: LOGGED', exact: true, timeout: 5 } }] }]);
  assert.equal(arrived.status, 'pass');
  assert.deepEqual(LEVELS(arrived), [[0, 'L0', 'checks', true]]);

  const failing = setup({ start: 'signed_in', jev });
  const failed = await failing.run([{ at: 'core/home', to: 'core/signed_in', checks: [{ tool: 'assert_text', args: { text: 'Wí Acme', exact: true, timeout: 5 } }] }]);
  assert.equal(failed.status, 'fail');
  assert.equal(failed.stoppedAt, 0);
  assert.match(failed.reason, /assert_text did not find a matching component/);
  assert.deepEqual(LEVELS(failed), [[0, 'L0', 'checks', false]]);
  assert.equal(jev.stats().calls, 0);
});

test('(10) no input value ever reaches the result, and a Jev fill carries the name only', async () => {
  const states = [];
  const answers = ['Type the input "phone" into text field #1', 'Tap "Tiếp tục"'];
  const jev = createMockJev((state, questions, call) => {
    states.push(JSON.stringify(state));
    return chooseByDescription(answers[call])(state, questions);
  });
  const { run, backend } = setup({ start: 'login_phone', jev, inputs: ['phone'], data: { phone: PHONE } });
  const result = await run([{ at: 'core/login_phone', to: 'core/login_method' }]);

  assert.equal(result.status, 'pass');
  assert.equal(backend.screen, 'login_method');
  assert.deepEqual(backend.fills, [PHONE]);
  assert.equal(jev.stats().calls, 2);
  assert.deepEqual(LEVELS(result), [
    [0, 'L2', 'fill "phone" into text field #1', true],
    [0, 'L2', 'press "Tiếp tục"', true],
    [0, 'L0', 'arrived', true],
  ]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(PHONE), false, 'a typed value leaked into the leg result');
  for (const state of states) assert.equal(state.includes(PHONE), false, 'a typed value leaked into the Jev state');
});

test('(11) a leg with its own steps runs them instead of its cases', async () => {
  const { run, backend, learner } = setup({
    screens: { home: { normal: [CASE_HOME_LOGIN] } },
  });
  const result = await run([{ at: 'core/home', to: 'core/login_phone', steps: [tap('Đăng nhập')] }]);

  assert.equal(result.status, 'pass');
  assert.equal(backend.screen, 'login_phone');
  assert.equal(backend.log.some((item) => item.kind === 'press' && item.label === 'Đăng nhập'), true);
  assert.deepEqual(LEVELS(result), [[0, 'L0', 'arrived', true]]);
  assert.equal(learner.calls[0][0], 'legOwnSteps');
  assert.equal(learner.calls.some((call) => call[0] === 'caseOutcome'), false, 'a leg with its own steps never reports a case');
});

test('(11b) failing own steps are not fatal: the known case still reaches the destination', async () => {
  const { run, backend, learner } = setup({
    screens: { home: { normal: [CASE_HOME_LOGIN] } },
  });
  const result = await run([{ at: 'core/home', to: 'core/login_phone', steps: [tap('Không có nút này', { timeout: 5 })] }]);

  assert.equal(result.status, 'pass');
  assert.equal(backend.screen, 'login_phone');
  assert.deepEqual(LEVELS(result), [
    [0, 'L0', 'leg steps', false],
    [0, 'L0', 'core/login_phone', true],
    [0, 'L0', 'arrived', true],
  ]);
  assert.deepEqual(learner.calls[0], ['legOwnSteps']);
});

test('(12) an ambiguous identification is a warning, not a guess', async () => {
  const { run } = setup({
    // A second screen that matches this snapshot just as specifically as `core/home` does.
    screens: { home_v2: { identify: { allText: ['Acme Example', 'Đăng nhập'] }, body: 'A second home that looks identical.' } },
  });
  const result = await run([{ at: 'core/home', to: 'core/home_v2' }]);

  assert.equal(result.status, 'needs_agent');
  assert.equal(result.reason, 'no_jev');
  assert.deepEqual(result.warnings, ['identify ambiguous: core/home, core/home_v2']);
  const warning = result.entries.find((item) => item.warning);
  assert.deepEqual([warning.leg, warning.what, warning.ok], [0, 'identify ambiguous: core/home, core/home_v2', true]);
  assert.deepEqual(LEVELS(result), [
    [0, 'L0', 'identify ambiguous: core/home, core/home_v2', true],
    [0, 'L3', 'jev', false],
  ]);
});

test('the run stops at the first leg that does not pass and reports where', async () => {
  const { run, backend } = setup({
    start: 'maintenance',
    screens: { home: { normal: [CASE_HOME_LOGIN] } },
  });
  const result = await run([
    { at: 'core/home', to: 'core/login_phone' },
    { at: 'core/login_phone', to: 'core/login_method' },
  ]);

  assert.equal(result.status, 'blocked');
  assert.equal(result.stoppedAt, 0, 'stoppedAt is the leg index, so resume knows where to restart');
  assert.equal(backend.screen, 'maintenance', 'the second leg must not have run');
});

test('a leg deadline stops the leg as needs_agent', async () => {
  const { run } = setup({ options: { legTimeoutMs: 0 } });
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);

  assert.equal(result.status, 'needs_agent');
  assert.equal(result.reason, 'leg_timeout');
  assert.deepEqual(LEVELS(result), [[0, 'L3', 'leg deadline', false]]);
});

test('the per-leg Jev budget stops the leg as needs_agent', async () => {
  const jev = createMockJev(() => ({ nextAction: { choice: 'scroll_down', confidence: 0.99 } }));
  const { run } = setup({ jev, options: { maxJevCallsPerLeg: 1 } });
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);

  assert.equal(result.status, 'needs_agent');
  assert.equal(result.reason, 'jev_budget');
  assert.equal(jev.stats().calls, 1);
});

test('a Jev action that changes nothing twice stops as no_progress', async () => {
  const jev = createMockJev(() => ({ nextAction: { choice: 'scroll_down', confidence: 0.99 } }));
  const { run } = setup({ jev });
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);

  assert.equal(result.status, 'needs_agent');
  assert.equal(result.reason, 'no_progress');
  assert.equal(jev.stats().calls, 2);
  assert.equal(result.entries.filter((item) => item.level === 'L2').length, 1);
});

test('a Jev verdict ends the leg with that status', async () => {
  const failing = createMockJev(() => ({ nextAction: { choice: 'fail', confidence: 0.9 } }));
  const failed = await setup({ jev: failing }).run([{ at: 'core/home', to: 'core/login_phone' }]);
  assert.equal(failed.status, 'fail');
  assert.equal(failed.reason, 'Jev: fail');

  const blocked = createMockJev(() => ({ nextAction: { choice: 'blocked', confidence: 0.9 } }));
  const stopped = await setup({ jev: blocked }).run([{ at: 'core/home', to: 'core/login_phone' }]);
  assert.equal(stopped.status, 'blocked');
  assert.equal(stopped.reason, 'Jev: blocked');
});

test('"arrived" from Jev is only a claim: the next identify decides, and it never ends the leg', async () => {
  const jev = createMockJev(() => ({ nextAction: { choice: 'arrived', confidence: 0.9 } }));
  const { run, backend } = setup({ jev });
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);

  // Home is still Home, so the claim is not believed: the leg does not pass, and asking the
  // same question twice on the same screen stops the run instead of spinning.
  assert.equal(backend.screen, 'home');
  assert.equal(result.status, 'needs_agent');
  assert.equal(result.reason, 'no_progress');
  assert.equal(jev.stats().calls, 2);
  assert.deepEqual(LEVELS(result), [
    [0, 'L2', 'verdict arrived', true],
    [0, 'L3', 'verdict arrived', false],
  ]);
});

const LEARNED_POPUP = { title: 'Ứng dụng có bản mới', button: 'Bỏ qua' };
const CARD_MOVES = { card: { Viettel: 'card', 'Tiếp tục': 'confirm' } };

test('(learning) the loop tells the learner which screen it is on and what a case ran', async () => {
  const { run, learner } = setup({
    start: 'card',
    moves: { card: { Viettel: 'card' } },
    screens: {
      card: { identify: { allText: ['Mua mã thẻ'] }, normal: [{ to: 'core/confirm', intent: 'Pick the carrier', steps: [tap('Viettel')] }] },
    },
  });
  const result = await run([{ at: 'core/card', to: 'core/confirm' }]);

  assert.equal(result.status, 'needs_agent');
  assert.deepEqual(learner.legStarts, [['core/card', 'core/confirm', 0]]);
  assert.deepEqual(learner.visits, ['core/card']);
  // The tap ran (the chip is on the screen) but nothing moved: those steps are what a case
  // learned from this visit has to replay first.
  assert.deepEqual(learner.caseRuns, [['core/confirm', [tap('Viettel')]]]);
  assert.deepEqual(learner.calls.filter((call) => call[0] === 'caseOutcome'), [['caseOutcome', 'core/confirm', false]]);
});

test('(learning) a popup Jev dismisses becomes a rule of the screen it was dismissed on', async () => {
  const jev = jevQueue([`Tap "${LEARNED_POPUP.button}"`, 'Tap "Đăng nhập"']);
  const { run, learner, root, backend } = setup({
    start: 'home_popup',
    jev,
    learn: true,
    moves: { ...MOVES, home_popup: { [LEARNED_POPUP.button]: 'home', 'Đăng nhập': 'login_phone' } },
  });
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);

  assert.equal(result.status, 'pass');
  assert.equal(backend.screen, 'login_phone');
  const rules = learner.ops().filter((op) => op.kind === 'addRule');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].file, yamlAt(root, 'core', 'home', 'exceptions.yml'));

  const { applied, skipped } = await flush(learner.ops());
  assert.deepEqual(skipped, []);
  assert.deepEqual(applied.map((event) => event.action), ['added', 'added']);
  // The popup rule matches the popup, not the screen's own button, and the case that got through
  // holds the ONE step Jev needed for the rest of the visit.
  assert.match(read(rules[0].file), /id: learned_ung_dung_co_ban_moi/);
  assert.match(read(rules[0].file), /tap: Bỏ qua/);
  const cases = read(yamlAt(root, 'core', 'home', 'normal.yml'));
  assert.match(cases, /to: core\/login_phone/);
  assert.match(cases, /status: learned/);
  assert.match(cases, /text: Đăng nhập/);
  assert.equal(cases.includes(LEARNED_POPUP.button), false, 'a dismissed popup is not a step of the case');
});

test('(learning) a chip that stays on screen is part of the case, never a rule', async () => {
  const jev = jevQueue(['Tap "Viettel"', 'Tap "Tiếp tục"']);
  const { run, learner, root, backend } = setup({
    start: 'card',
    jev,
    learn: true,
    moves: CARD_MOVES,
    screens: {
      card: { identify: { allText: ['Mua mã thẻ'] }, body: 'Choose a carrier and a denomination.' },
      confirm: { identify: { allText: ['Xác nhận thanh toán'] }, body: 'Payment confirmation.' },
    },
  });
  const result = await run([{ at: 'core/card', to: 'core/confirm' }]);

  assert.equal(result.status, 'pass');
  assert.equal(backend.screen, 'confirm');
  assert.deepEqual(learner.ops().map((op) => op.kind), ['addCase']);
  await flush(learner.ops());
  assert.equal(exists(yamlAt(root, 'core', 'card', 'exceptions.yml')), false, 'a chip is not an exception');
  const cases = read(yamlAt(root, 'core', 'card', 'normal.yml'));
  assert.match(cases, /text: Viettel/);
  assert.match(cases, /text: Tiếp tục/);
  assert.match(cases, /intent: Go to core\/confirm/);
});

test('(learning) a leg that stopped for the agent writes no case', async () => {
  const jev = jevQueue(['Tap "Viettel"']);
  const { run, learner, root, backend } = setup({
    start: 'card',
    jev,
    learn: true,
    threshold: 0.95, // Jev answered 0.9, so the leg stops before its decision is executed
    moves: CARD_MOVES,
    screens: {
      card: { identify: { allText: ['Mua mã thẻ'] }, normal: [{ to: 'core/confirm', intent: 'Pick the carrier', steps: [tap('Viettel')] }] },
    },
  });
  const file = yamlAt(root, 'core', 'card', 'normal.yml');
  const before = read(file);
  const result = await run([{ at: 'core/card', to: 'core/confirm' }]);

  assert.equal(result.status, 'needs_agent');
  assert.equal(result.reason, 'low_confidence');
  assert.equal(backend.screen, 'card', 'the action below the threshold never ran');
  // The stats of the case that ran are a fact about the run; the case Jev did not finish is not.
  assert.deepEqual(learner.ops().map((op) => [op.kind, op.ok]), [['outcome', false]]);
  assert.deepEqual((await flush(learner.ops())).applied, []);
  assert.equal(read(file), before, 'a draft that failed is nobody\'s fault, so nothing changed');
});


// ── a stuck leg takes ONE raw look: a node the default tree collapses can hold the cause ──

const COVERED = {
  screens: { ...SCREENS, home_covered: ['Acme Example', 'Đăng nhập'] },
  moves: { ...MOVES, home_covered: { 'Đăng nhập': 'home_covered', Minimize: 'home' } },
  // Only the raw tree lists the Minimize button of the panel that covers the page.
  hidden: { home_covered: ['Minimize'] },
};
const MINIMIZE_RULE = { id: 'panel_minimize', when: { allText: ['Minimize'] }, do: { tap: 'Minimize' } };

function coveredSetup(extra = {}) {
  const base = setup({
    start: 'home_covered',
    screens: { home: { normal: [CASE_HOME_LOGIN], ...(extra.rule ? { exceptions: [extra.rule] } : {}) } },
    deviceScreens: COVERED.screens,
    moves: COVERED.moves,
    hidden: COVERED.hidden,
    jev: extra.jev || null,
  });
  return base;
}

test('(raw look) an exception rule that matches only the raw tree fires, then the case gets another go', async () => {
  const { run, backend } = coveredSetup({ rule: MINIMIZE_RULE });
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);

  assert.equal(result.status, 'pass');
  assert.equal(backend.screen, 'login_phone');
  assert.ok(backend.log.some((item) => item.kind === 'press' && item.label === 'Minimize'), 'the raw-only button was pressed');
});

test('(raw look) with no rule for it, the decider is handed the raw tree and can pick the hidden button', async () => {
  const jev = jevQueue(['Tap "Minimize"', 'Tap "Đăng nhập"']);
  const { run, backend } = coveredSetup({ jev });
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);

  assert.equal(result.status, 'pass');
  assert.equal(backend.screen, 'login_phone');
  assert.equal(jev.stats().calls, 2);
});

test('(raw look) a screen whose raw tree lists nothing new keeps the normal path', async () => {
  const { run } = setup({ screens: { home: { normal: [] } }, jev: null });
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);

  assert.equal(result.status, 'needs_agent');
  assert.equal(result.reason, 'no_jev');
});

test('(raw look) a case that failed behind a covering panel is not blamed once the raw exception explains it', async () => {
  const { run, learner } = coveredSetup({ rule: MINIMIZE_RULE });
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);

  assert.equal(result.status, 'pass');
  const outcomes = learner.calls.filter((call) => call[0] === 'caseOutcome');
  // Only the success is counted; the first, panel-covered attempt left no failure behind.
  assert.deepEqual(outcomes, [['caseOutcome', 'core/login_phone', true]]);
});

test('(raw look) a case that fails with nothing to explain it is still blamed', async () => {
  const { run, learner } = setup({ screens: { home: { normal: [CASE_HOME_LOGIN] } }, moves: { ...MOVES, home: {} }, jev: null });
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);

  assert.equal(result.status, 'needs_agent');
  assert.deepEqual(learner.calls.filter((call) => call[0] === 'caseOutcome'), [['caseOutcome', 'core/login_phone', false]]);
});

test('(3c) a second popup of the same kind right after the first is handled again, not taken for a no-op', async () => {
  const { run, backend } = setup({
    deviceScreens: { ...SCREENS, popup2: ['Cập nhật phiên bản', 'Bản 2.0 của mini app khác', 'Để sau'] },
    moves: { ...MOVES, home: { 'Đăng nhập': 'popup' }, popup: { 'Để sau': 'popup2' }, popup2: { 'Để sau': 'login_phone' } },
    screens: { home: { normal: [CASE_HOME_LOGIN] } },
  });
  const result = await run([{ at: 'core/home', to: 'core/login_phone' }]);

  assert.equal(result.status, 'pass');
  assert.equal(backend.screen, 'login_phone');
  assert.equal(backend.log.filter((item) => item.kind === 'press' && item.label === 'Để sau').length, 2);
});
