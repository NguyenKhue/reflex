/**
 * popupCorpus.test.js — popup versus real error, driven through the real leg loop.
 *
 * The question this file answers: can reflex "heal" a real failure by dismissing it, and can it learn to do that
 * forever? A harmless promotion and a "Lỗi hệ thống" dialog both have a "Đóng" button, so the loop and the learner
 * must treat them differently. Each case asserts the status, how often the decider was asked and what the learner
 * would write.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockJev } = require('../../src/jev/jevClient');
const { chooseByDescription } = require('../fixtures/screens');
const { setup } = require('../fixtures/flowHarness');
const { looksLikeError } = require('../../src/screens/learn');

const LEG = [{ at: 'core/home', to: 'core/login_phone' }];

/** A decider that answers with the given option descriptions, one per call. */
function jevQueue(descriptions) {
  return createMockJev((state, questions, call) => chooseByDescription(descriptions[call])(state, questions));
}

function neverAsked() {
  return createMockJev(() => { throw new Error('the decider must not be called'); });
}

const rulesOf = (learner) => learner.ops().filter((op) => op.kind === 'addRule');

test('control: a harmless promo dismissed by the decider is learned as a dismiss rule of Home', async () => {
  const jev = jevQueue(['Tap "Đóng"', 'Tap "Đăng nhập"']);
  const { run, learner, backend } = setup({ start: 'home_promo', jev, learn: true });
  const result = await run(LEG);

  assert.equal(result.status, 'pass');
  assert.equal(backend.screen, 'login_phone');
  assert.equal(jev.stats().calls, 2);
  const rules = rulesOf(learner);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].item.do, { tap: 'Đóng' });
});

test('an authored dismiss rule for the promo does not fire on the error dialog (no decider: the leg stops for an agent)', async () => {
  const promoRule = { id: 'dismiss_promo', when: { allText: ['Khuyến mãi mới dành cho bạn', 'Đóng'] }, do: { tap: 'Đóng' } };
  const { run, backend } = setup({ start: 'home_alert', appRules: [promoRule] });
  const result = await run(LEG);

  assert.equal(backend.screen, 'home_alert', 'the error dialog is still up: nothing dismissed it');
  assert.equal(result.status, 'needs_agent');
  assert.equal(result.reason, 'no_jev');
});

test('an authored fail rule for the error text ends the leg as fail without asking the decider', async () => {
  const errorRule = { id: 'system_error', when: { anyText: ['Lỗi hệ thống'] }, do: { fail: 'the app showed a system error' } };
  const jev = neverAsked();
  const { run, learner, backend } = setup({ start: 'home_alert', jev, appRules: [errorRule], learn: true });
  const result = await run(LEG);

  assert.equal(result.status, 'fail');
  assert.equal(result.reason, 'the app showed a system error');
  assert.equal(backend.screen, 'home_alert');
  assert.equal(jev.stats().calls, 0);
  assert.deepEqual(learner.ops(), [], 'a failed leg teaches nothing');
});

test('a decider below the confidence threshold on the error dialog stops for an agent and presses nothing', async () => {
  const jev = jevQueue(['Tap "Đóng"']);
  const { run, learner, backend } = setup({ start: 'home_alert', jev, learn: true, threshold: 0.95 });
  const result = await run(LEG);

  assert.equal(result.status, 'needs_agent');
  assert.equal(result.reason, 'low_confidence');
  assert.equal(backend.screen, 'home_alert');
  assert.deepEqual(learner.ops(), []);
});

test('a decider that calls the error dialog a failure ends the leg as fail and never presses its button', async () => {
  const jev = createMockJev(() => ({ nextAction: { choice: 'fail', confidence: 0.9 } }));
  const { run, backend } = setup({ start: 'home_alert', jev, learn: true });
  const result = await run(LEG);

  assert.equal(result.status, 'fail');
  assert.equal(result.reason, 'Jev: fail');
  assert.equal(backend.screen, 'home_alert');
});

test('a real error dialog dismissed by the decider is never learned as a permanent dismiss rule', async () => {
  const jev = jevQueue(['Tap "Đóng"', 'Tap "Đăng nhập"']);
  const { run, learner } = setup({ start: 'home_alert', jev, learn: true });
  const result = await run(LEG);

  // The leg itself carries on (the app moved on after the press), but the dismissal of an ERROR must not become knowledge.
  assert.equal(result.status, 'pass');
  assert.deepEqual(rulesOf(learner), [], 'a dismiss rule was learned from an error dialog');
  const refused = learner.events().filter((event) => event.action === 'skipped');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].reason, 'looks like an error: not learned as a dismissal');
});

test('looksLikeError flags error wording and leaves ordinary Vietnamese copy alone', () => {
  for (const texts of [['Lỗi hệ thống'], ['Giao dịch thất bại'], ['Exception: errorCode 40000'], ['Không thành công'], ['Sự cố kết nối'], ['Payment failed']]) {
    assert.equal(looksLikeError(texts), true, JSON.stringify(texts));
  }
  // "lợi" (benefit) and "lời" (words) fold to the same letters as "lỗi" (error): the check must not be fooled by that.
  for (const texts of [['Ưu đãi lợi ích cho bạn'], ['Lời chào buổi sáng'], ['Khuyến mãi mới dành cho bạn'], [], null]) {
    assert.equal(looksLikeError(texts), false, JSON.stringify(texts));
  }
  // NFD (decomposed) text is normalised before matching.
  assert.equal(looksLikeError(['Lỗi hệ thống'.normalize('NFD')]), true);
});
