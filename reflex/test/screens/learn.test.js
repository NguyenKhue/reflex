/**
 * learn.test.js — what a run may turn into knowledge, and what it must refuse to.
 *
 * The privacy rules are the important half: a value a run typed is never written into a
 * committed file, so every test that exercises a label also asks what the file would have said.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  secretsOf, placeholderize, safeTexts, toCaseSteps, isPopupDismiss, toException, applyOutcome, createLearner,
} = require('../../src/screens/learn');
const { loadStore } = require('../../src/screens/store');
const { screenIndex } = require('../../src/screens/match');
const { writeStore } = require('../fixtures/screenStore');

const PHONE = '0900000002';
const RUN = 'example_run_20260924_120000';
const DAY = '2026-09-24';
const SEEN_AT = Date.parse(`${DAY}T10:00:00Z`);

/** A snapshot in the shape `screenIndex`/`visibleTexts` read. */
const snap = (texts) => ({
  nodes: texts.map((item, index) => (typeof item === 'string'
    ? { ref: `n${index}`, text: item }
    : { ref: `n${index}`, ...item })),
});

const TREE = {
  apps: {
    example: {
      app: { exceptions: [] },
      groups: {
        core: {
          screens: {
            home: {
              identify: { allText: ['Acme Example'] },
              normal: [{ to: 'core/login', intent: 'Open the login screen', steps: [{ tool: 'tap_text', args: { text: 'Biến mất', exact: true } }] }],
            },
            login: { identify: { allText: ['Đăng nhập Acme'] }, inputs: ['phone'] },
            signed_in: { identify: { allText: ['authState: LOGGED'] } },
          },
        },
        mobile_topup: {
          miniapp: { exceptions: [] },
          screens: { main: { identify: { allText: ['Nạp tiền'] } } },
        },
      },
    },
  },
};

/** A learner over a real store tree, so `file` is exactly what the writer would be handed. */
function learnerFor({ data = { phone: PHONE }, plan = null, inputNames = ['phone'], captureNames = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-learn-'));
  writeStore(root, TREE);
  const store = loadStore(root, 'example');
  const learner = createLearner({
    store,
    runId: RUN,
    data,
    plan,
    inputNames,
    captureNames,
    now: () => SEEN_AT,
  });
  return { root, store, learner, file: (id, name) => path.join(store.screens.get(id).dir, name) };
}

const ACTION = (extra) => ({
  id: 'p1', kind: 'press', description: 'Tap "Đăng nhập"', confidence: 0.9, label: 'Đăng nhập', ...extra,
});

const before = snap(['Acme Example', 'Đăng nhập']);
const after = snap(['Đăng nhập Acme']);

test('secretsOf keeps resolved inputs and captures of three characters or more', () => {
  const secrets = secretsOf({ phone: PHONE, pin: '12', token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6' }, ['phone', 'pin'], ['token']);
  assert.deepEqual(secrets, [
    { name: 'token', value: 'eyJhbGciOiJIUzI1NiIsInR5cCI6' },
    { name: 'phone', value: PHONE },
  ]);
  assert.deepEqual(secretsOf({}, [], []), []);
});

test('placeholderize hides a value wherever it appears and refuses what is left', () => {
  const secrets = secretsOf({ phone: PHONE, amount_label: '10.000đ' }, ['phone', 'amount_label']);
  assert.equal(placeholderize(PHONE, secrets), '{phone}');
  assert.equal(placeholderize('Số ví: 0900000002 - A', secrets), 'Số ví: {phone} - A');
  // The amount IS the plan's own data, so it becomes a name — but a value that only LOOKS like
  // data (a price on the screen, a timestamp) has no name to hide behind and is refused.
  assert.equal(placeholderize('10.000đ', secrets), '{amount_label}');
  assert.equal(placeholderize('15.000đ', secrets), null);
  assert.equal(placeholderize('10:30', secrets), null);
  assert.equal(placeholderize('Mã OTP 1234', secrets), null);
  assert.equal(placeholderize('eyJhbGciOiJIUzI1NiIsInR5cCI6', secrets), null);
  assert.equal(placeholderize('Đăng nhập', secrets), 'Đăng nhập');
  assert.equal(placeholderize('', secrets), null);
});

test('safeTexts drops sensitive and placeholder texts, keeps order, caps at max', () => {
  const secrets = secretsOf({ phone: PHONE }, ['phone']);
  assert.deepEqual(safeTexts(['Cập nhật phiên bản', 'Để sau'], secrets), ['Cập nhật phiên bản', 'Để sau']);
  assert.deepEqual(safeTexts(['Số ví: 0900000002', '15.000đ', 'Bảo trì'], secrets), ['Bảo trì']);
  assert.deepEqual(safeTexts(['a', 'b', 'c', 'd'], secrets, 2), ['a', 'b']);
  assert.deepEqual(safeTexts(['a', 'a'], secrets), ['a']);
});

test('toCaseSteps writes a press by test id, a fill by input NAME, and never a label', () => {
  const secrets = secretsOf({ phone: PHONE, amount_label: '10.000đ' }, ['phone', 'amount_label']);
  const steps = toCaseSteps([
    { kind: 'step', step: { tool: 'back', args: {} } },
    { kind: 'press', label: 'Mua mã thẻ', identifier: 'card_code_tab' },
    { kind: 'press', label: '10.000đ', identifier: null },
    { kind: 'fill', input: 'phone', fieldIndex: 1 },
    { kind: 'scroll', direction: 'down' },
    { kind: 'wait' },
  ], secrets);
  assert.deepEqual(steps, [
    { tool: 'back', args: {} },
    { tool: 'tap_text', args: { text: 'card_code_tab', exact: true } },
    { tool: 'tap_text', args: { text: '{amount_label}', exact: true } },
    { tool: 'fill', args: { index: 1, text: '{phone}' } },
    { tool: 'scroll', args: { direction: 'down' } },
  ]);
  assert.equal(steps.some((step) => 'label' in (step.args || {})), false, 'a field label is a typed value on Android');
  // A phone number Jev happened to press may not be pinned into a step: the whole case is refused.
  assert.equal(toCaseSteps([{ kind: 'press', label: PHONE.slice(0, -1) + '1', identifier: null }], secrets), null);
  assert.equal(toCaseSteps([{ kind: 'fill', input: null, fieldIndex: 0 }], secrets), null);
});

test('isPopupDismiss: the screen has to stay the same AND the pressed node has to be gone', () => {
  const pressed = { label: 'Để sau', identifier: null };
  // The index is the one `screenIndex` builds: folded texts and identifiers.
  const gone = screenIndex(snap(['Acme Example']));
  const stillThere = screenIndex(snap(['Acme Example', 'Để sau']));
  assert.equal(isPopupDismiss({ beforeId: 'core/home', afterId: 'core/home', pressed, afterIndex: gone }), true);
  // The chip is still on screen: that was an action on the screen, not a popup.
  assert.equal(isPopupDismiss({ beforeId: 'core/home', afterId: 'core/home', pressed, afterIndex: stillThere }), false);
  assert.equal(isPopupDismiss({ beforeId: 'core/home', afterId: 'core/login', pressed, afterIndex: screenIndex(snap([])) }), false);
  // Both sides unidentified: the screen we were looking at never appeared, so only the node matters.
  const noId = screenIndex(snap([]));
  assert.equal(isPopupDismiss({ beforeId: null, afterId: null, pressed: { label: null, identifier: 'close_btn' }, afterIndex: noId }), true);
  assert.equal(isPopupDismiss({ beforeId: null, afterId: null, pressed: { label: null, identifier: null }, afterIndex: noId }), false);
});

test('toException: a titled popup becomes a rule, a lone button is refused', () => {
  const secrets = secretsOf({ phone: PHONE }, ['phone']);
  const rule = toException({
    disappeared: ['Cập nhật phiên bản', 'Để sau'],
    pressedLabel: 'Để sau',
    secrets,
    runId: RUN,
    confidence: 0.88,
    today: DAY,
  });
  assert.deepEqual(rule, {
    id: 'learned_cap_nhat_phien_ban',
    when: { allText: ['Để sau', 'Cập nhật phiên bản'] },
    do: { tap: 'Để sau' },
    status: 'learned',
    confidence: 0.88,
    learnedFrom: RUN,
    stats: { ok: 1, fail: 0, streak: 1, lastOk: DAY },
  });
  // "Xác nhận" alone would match half the app.
  assert.equal(toException({ disappeared: ['Xác nhận'], pressedLabel: 'Xác nhận', secrets, today: DAY }), null);
  // A rule may not carry a number the app printed, and a phone is not a title.
  assert.equal(toException({ disappeared: [PHONE, 'OK'], pressedLabel: 'OK', secrets, today: DAY }), null);

  const verdict = toException({ disappeared: ['Bảo trì hệ thống', 'Thử lại sau'], verdict: 'blocked', secrets, runId: RUN, confidence: null, today: DAY });
  assert.deepEqual(verdict, {
    id: 'learned_bao_tri_he_thong',
    when: { allText: ['Bảo trì hệ thống', 'Thử lại sau'] },
    do: { blocked: 'Jev: Bảo trì hệ thống' },
    status: 'learned',
    confidence: null,
    learnedFrom: RUN,
    stats: { ok: 1, fail: 0, streak: 1, lastOk: DAY },
  });
  assert.equal(toException({ disappeared: ['15.000đ'], verdict: 'fail', secrets, today: DAY }), null);
});

test('applyOutcome follows the status table, and never touches a pinned or shared item', () => {
  const item = (extra) => ({ to: 'core/login', intent: 'x', steps: [], file: '/w/screens/example/core/home/normal.yml', key: 'core/login|[]', ...extra });

  const draft = applyOutcome(item({ status: 'draft', stats: { ok: 2, streak: 2 } }), true, { today: DAY });
  assert.deepEqual([draft.item.status, draft.event], ['verified', 'promoted']);
  assert.deepEqual(draft.item.stats, { ok: 3, streak: 3, failStreak: 0, lastOk: DAY });

  // A draft is a guess: a failed run counts against nobody.
  const guessed = applyOutcome(item({ status: 'draft', stats: { ok: 0, streak: 0 } }), false, { today: DAY });
  assert.deepEqual([guessed.event, guessed.item.stats], [null, { ok: 0, streak: 0 }]);

  const learned = applyOutcome(item({ status: 'learned', stats: { ok: 1, streak: 1 } }), true, { today: DAY });
  assert.deepEqual([learned.item.status, learned.event], ['learned', null]);

  // One failure of a learned case is common (a popup, a slow backend); the second removes it.
  const once = applyOutcome(item({ status: 'learned', stats: { ok: 4, fail: 0, streak: 3, failStreak: 0 } }), false, { today: DAY });
  assert.deepEqual([once.event, once.item.stats], [null, { ok: 4, fail: 1, streak: 0, failStreak: 1, lastFail: DAY }]);
  const twice = applyOutcome(item({ status: 'learned', stats: { ok: 4, fail: 1, streak: 0, failStreak: 1 } }), false, { today: DAY });
  assert.equal(twice.event, 'removed');

  const stable = applyOutcome(item({ status: 'verified', stats: { ok: 9, fail: 0, streak: 9 } }), true, { today: DAY });
  assert.deepEqual([stable.item.status, stable.event, stable.item.stats.streak], ['verified', null, 10]);

  const demoted = applyOutcome(item({ status: 'verified', stats: { ok: 9, fail: 0, streak: 9 } }), false, { today: DAY });
  assert.deepEqual([demoted.item.status, demoted.event], ['learned', 'demoted']);

  assert.deepEqual(applyOutcome(item({ status: 'verified', pinned: true }), false, { today: DAY }).event, null);
  assert.equal(applyOutcome({ ...item({ status: 'learned' }), file: '/w/screens/_shared/exceptions.yml', id: 'policy' }, false, { today: DAY }).event, null);
});

test('a visit with Jev actions becomes a one-hop case for the screen it started on', () => {
  const { learner, file } = learnerFor({ plan: { flow: [{ at: 'core/home', to: 'core/login', intent: 'Open the login screen' }] } });
  learner.legStart({ at: 'core/home', to: 'core/login', intent: 'Open the login screen' }, 0);
  learner.visitStart('core/home', before);
  learner.jevAction(ACTION(), before, after, 'core/home', 'core/login', 0.9);
  learner.visitStart('core/login', after);
  learner.legEnd('pass');

  const cases = learner.ops().filter((op) => op.kind === 'addCase');
  assert.equal(cases.length, 1);
  assert.deepEqual(cases[0].item, {
    to: 'core/login',
    intent: 'Open the login screen',
    steps: [{ tool: 'tap_text', args: { text: 'Đăng nhập', exact: true } }],
    status: 'learned',
    confidence: 0.9,
    learnedFrom: RUN,
    stats: { ok: 1, fail: 0, streak: 1, lastOk: DAY },
  });
  assert.equal(cases[0].file, file('core/home', 'normal.yml'));
  // No route: two screens are one hop, which the case itself already describes.
  assert.deepEqual(learner.ops().filter((op) => op.kind === 'addRoute'), []);
});

test('the leg intent is used only when the visit ends at that leg destination', () => {
  const { learner } = learnerFor({ plan: { flow: [{ at: 'core/home', to: 'core/signed_in', intent: 'Sign in' }] } });
  learner.legStart({ at: 'core/home', to: 'core/signed_in', intent: 'Sign in' }, 0);
  learner.visitStart('core/home', before);
  learner.jevAction(ACTION(), before, after, 'core/home', 'core/login', 0.9);
  learner.visitStart('core/login', after);
  learner.legEnd('pass');
  assert.equal(learner.ops()[0].item.intent, 'Go to core/login');
});

test('only a passing leg commits cases and routes; the stats of what ran are always kept', () => {
  const stopped = learnerFor();
  const case_ = stopped.store.screens.get('core/home').normal[0];
  stopped.learner.legStart({ at: 'core/home', to: 'core/login' }, 0);
  stopped.learner.visitStart('core/home', before);
  stopped.learner.jevAction(ACTION(), before, after, 'core/home', 'core/login', 0.9);
  stopped.learner.caseOutcome(case_, false);
  stopped.learner.legPassed(['core/home', 'core/login', 'core/signed_in']);
  stopped.learner.legEnd('needs_agent');

  assert.deepEqual(stopped.learner.ops(), [{
    file: case_.file,
    kind: 'outcome',
    key: case_.key,
    ok: false,
    runId: RUN,
    historyFile: path.join(path.dirname(case_.file), 'history.yml'),
  }]);

  const passed = learnerFor();
  passed.learner.legStart({ at: 'core/home', to: 'core/login' }, 0);
  passed.learner.visitStart('core/home', before);
  passed.learner.jevAction(ACTION(), before, after, 'core/home', 'core/login', 0.9);
  passed.learner.visitStart('core/login', after);
  passed.learner.caseOutcome(case_, true);
  passed.learner.legPassed(['core/home', 'core/login', 'core/signed_in']);
  passed.learner.legEnd('pass');
  assert.deepEqual(passed.learner.ops().map((op) => op.kind), ['addCase', 'outcome', 'addRoute']);
  assert.deepEqual(passed.learner.ops().find((op) => op.kind === 'addRoute').path, ['core/home', 'core/login', 'core/signed_in']);
});

test('a case that ran here heads the learned case, and the case it replaces goes to history', () => {
  const { store, learner } = learnerFor();
  const case_ = store.screens.get('core/home').normal[0];
  learner.legStart({ at: 'core/home', to: 'core/signed_in' }, 0);
  learner.visitStart('core/home', before);
  learner.caseRan(case_, case_.steps);
  learner.caseOutcome(case_, false);
  // The case is run again after a popup took the screen over: its steps must not be stored twice.
  learner.caseRan(case_, case_.steps);
  // A chip that is still on screen after the press was an action ON the screen, so it is a step.
  const chip = snap(['Mua mã thẻ', 'Viettel', 'Mobifone']);
  learner.jevAction({ ...ACTION(), label: 'Viettel', identifier: null }, chip, chip, 'core/home', 'core/home', 0.9);
  learner.jevAction({ ...ACTION(), label: 'Vào', identifier: null }, chip, after, 'core/home', 'core/signed_in', 0.9);
  learner.visitStart('core/signed_in', after);
  learner.legEnd('pass');

  const replace = learner.ops().find((op) => op.kind === 'replaceCase');
  assert.equal(replace.key, case_.key);
  assert.equal(replace.historyFile, path.join(path.dirname(case_.file), 'history.yml'));
  assert.deepEqual(replace.item.steps, [
    ...case_.steps,
    { tool: 'tap_text', args: { text: 'Viettel', exact: true } },
    { tool: 'tap_text', args: { text: 'Vào', exact: true } },
  ]);
  assert.deepEqual(learner.ops().filter((op) => op.kind === 'addCase'), []);
});

test('a visit that only saw popups dismissed has no case to learn', () => {
  const { learner } = learnerFor();
  const popup = snap(['Acme Example', 'Cập nhật phiên bản', 'Để sau']);
  learner.legStart({ at: 'core/home', to: 'core/login' }, 0);
  learner.visitStart('core/home', popup);
  learner.jevAction({ ...ACTION(), label: 'Để sau', identifier: null }, popup, before, 'core/home', 'core/home', 0.9);
  learner.visitStart('core/login', before);
  learner.legEnd('pass');
  assert.deepEqual(learner.ops().map((op) => op.kind), ['addRule']);
});

test('a popup Jev dismissed becomes a rule of the screen it was dismissed on', () => {
  const { learner, file } = learnerFor();
  const popup = snap(['Acme Example', 'Cập nhật phiên bản', 'Để sau']);
  learner.legStart({ at: 'core/home', to: 'core/login' }, 0);
  learner.visitStart('core/home', popup);
  learner.jevAction({ ...ACTION(), label: 'Để sau', identifier: null }, popup, before, 'core/home', 'core/home', 0.9);
  learner.jevAction({ ...ACTION(), label: 'Tiếp tục', identifier: null }, before, after, 'core/home', 'core/login', 0.9);
  learner.visitStart('core/login', after);
  learner.legEnd('pass');

  const rules = learner.ops().filter((op) => op.kind === 'addRule');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].file, file('core/home', 'exceptions.yml'));
  assert.equal(rules[0].item.id, 'learned_cap_nhat_phien_ban');
  // The dismissal itself is not a step of the case that got through.
  assert.deepEqual(learner.ops().find((op) => op.kind === 'addCase').item.steps, [{ tool: 'tap_text', args: { text: 'Tiếp tục', exact: true } }]);
});

test('a popup on an unidentified screen goes to the leg mini app, or to _app for core', () => {
  const popup = snap(['Cập nhật phiên bản', 'Để sau']);
  const clear = snap(['Nạp tiền', 'Chọn mệnh giá']);
  const mini = learnerFor();
  mini.learner.legStart({ at: 'mobile_topup/main', to: 'mobile_topup/card_code' }, 0);
  mini.learner.jevAction({ ...ACTION(), label: 'Để sau', identifier: null }, popup, clear, null, null, 0.9);
  mini.learner.legEnd('pass');
  assert.equal(mini.learner.ops()[0].file, path.join(mini.root, 'screens', 'example', 'mobile_topup', '_miniapp', 'exceptions.yml'));

  const core = learnerFor();
  core.learner.legStart({ at: 'core/home', to: 'core/login' }, 0);
  core.learner.jevAction({ ...ACTION(), label: 'Để sau', identifier: null }, popup, clear, null, null, 0.9);
  core.learner.legEnd('pass');
  assert.equal(core.learner.ops()[0].file, path.join(core.root, 'screens', 'example', '_app', 'exceptions.yml'));
});

test('a rule whose action changed nothing is counted, and _shared is never the runner business', () => {
  const stopped = learnerFor();
  stopped.learner.legStart({ at: 'core/home', to: 'core/login' }, 0);
  stopped.learner.ruleOutcome({ id: 'version_popup', key: 'version_popup', file: path.join(stopped.store.appTier.dir, 'exceptions.yml') }, false);
  stopped.learner.legEnd('fail');
  assert.deepEqual(stopped.learner.ops().map((op) => op.kind), ['outcome']);

  const shared = learnerFor();
  shared.learner.legStart({ at: 'core/home', to: 'core/login' }, 0);
  shared.learner.ruleOutcome({ id: 'ekyc', key: 'ekyc', file: path.join(shared.root, 'screens', '_shared', 'exceptions.yml') }, false);
  shared.learner.legEnd('pass');
  assert.deepEqual(shared.learner.ops(), []);

  // A dismissed popup on a leg that then failed taught us nothing about reaching `to`.
  const dismissed = learnerFor();
  const popup = snap(['Acme Example', 'Cập nhật phiên bản', 'Để sau']);
  dismissed.learner.legStart({ at: 'core/home', to: 'core/login' }, 0);
  dismissed.learner.jevAction({ ...ACTION(), label: 'Để sau', identifier: null }, popup, before, 'core/home', 'core/home', 0.9);
  dismissed.learner.legEnd('fail');
  assert.deepEqual(dismissed.learner.ops(), []);
});

test('a Jev verdict on a leg that failed is the leg outcome, so its rule is kept', () => {
  const { learner } = learnerFor();
  learner.legStart({ at: 'core/home', to: 'core/login' }, 0);
  learner.verdict('blocked', snap(['Bảo trì hệ thống', 'Thử lại sau']), 'core/home', 'core');
  learner.legEnd('blocked');
  const ops = learner.ops();
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, 'addRule');
  assert.deepEqual(ops[0].item.do, { blocked: 'Jev: Bảo trì hệ thống' });
});

test('a leg with its own steps learns rules but no cases', () => {
  const { learner } = learnerFor();
  learner.legStart({ at: 'core/home', to: 'core/login' }, 0);
  learner.legOwnSteps();
  learner.visitStart('core/home', before);
  const popup = snap(['Acme Example', 'Cập nhật phiên bản', 'Để sau']);
  learner.jevAction({ ...ACTION(), label: 'Để sau', identifier: null }, popup, before, 'core/home', 'core/home', 0.9);
  learner.jevAction(ACTION(), before, after, 'core/home', 'core/login', 0.9);
  learner.visitStart('core/login', after);
  learner.legEnd('pass');
  assert.deepEqual(learner.ops().map((op) => op.kind), ['addRule']);
});

test('a visit Jev navigated with no label it could write is reported, not written', () => {
  const { learner } = learnerFor();
  learner.legStart({ at: 'core/home', to: 'core/login' }, 0);
  learner.visitStart('core/home', before);
  // A phone-shaped label that is NOT one of the row's values has no name to hide behind.
  learner.jevAction({ ...ACTION(), label: 'Số dư 0900000007', identifier: null }, before, after, 'core/home', 'core/login', 0.9);
  learner.visitStart('core/login', after);
  learner.legEnd('pass');
  assert.deepEqual(learner.ops(), []);
  assert.deepEqual(learner.events().map((event) => [event.action, event.reason]), [['skipped', 'sensitive label']]);
  assert.match(learner.events()[0].file, /core\/home\/normal\.yml$/);
});

test('a lone popup button with nothing to match on is reported, not written', () => {
  const { learner } = learnerFor();
  const popup = snap(['Acme Example', 'Xác nhận']);
  learner.legStart({ at: 'core/home', to: 'core/login' }, 0);
  learner.visitStart('core/home', popup);
  learner.jevAction({ ...ACTION(), label: 'Xác nhận', identifier: null }, popup, before, 'core/home', 'core/home', 0.9);
  learner.legEnd('pass');
  assert.deepEqual(learner.ops(), []);
  assert.deepEqual(learner.events().map((event) => event.reason), ['generic popup']);
});

test('a value captured during the run is hidden as well: secrets are read when the text is written', () => {
  const data = { phone: PHONE };
  const live = learnerFor({ data });
  live.learner.legStart({ at: 'core/home', to: 'core/login' }, 0);
  live.learner.visitStart('core/home', before);
  // A `saveAs` capture lands in the same row data object the learner holds, after it was built.
  data.wallet = '1234567890';
  live.learner.jevAction({ ...ACTION(), label: 'Ví 1234567890', identifier: null }, before, after, 'core/home', 'core/login', 0.9);
  live.learner.visitStart('core/login', after);
  live.learner.legEnd('pass');
  assert.deepEqual(live.learner.ops().find((op) => op.kind === 'addCase').item.steps, [
    { tool: 'tap_text', args: { text: 'Ví {wallet}', exact: true } },
  ]);
});

test('redactText replaces every input value and keeps the rest of the text', () => {
  const { redactText, secretsOf } = require('../../src/screens/learn');
  const secrets = secretsOf({ phone: '0900000002', password: '000000' }, ['phone', 'password'], []);
  assert.equal(redactText('Số ví: 0900000002 - A', secrets), 'Số ví: {phone} - A');
  assert.equal(redactText('Ví Acme', secrets), 'Ví Acme');
});
