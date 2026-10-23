/**
 * resolver.test.js — `askOnce`, the single Jev decision the leg loop asks for.
 *
 * The action set is closed and screen-derived, `exclude` decides what is not even offered, and
 * the record that comes back is what a report or a learned case would keep: a label or a test id
 * for a press, and NEVER a field's label — on Android the label of an EditText is its value.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSnapshot } = require('../../src/device/deviceBackend');
const { createMockJev } = require('../../src/jev/jevClient');
const { askOnce, LEG_VERDICTS, LEG_INSTRUCTION } = require('../../src/jev/resolver');
const { publicText } = require('../../src/device/screenState');
const { chooseByDescription } = require('../fixtures/screens');
const fixtures = require('../fixtures/device');

const APP = fixtures.APP;
const PHONE = '0900000002';

/** A login screen whose editable field is pre-filled, so its label IS the phone number. */
const login = () => normalizeSnapshot(fixtures.snapshot([
  fixtures.node('e1', 'Đăng nhập Acme', 100),
  fixtures.node('e2', PHONE, 200, { type: 'android.widget.EditText', editable: true, value: PHONE }),
  fixtures.node('e3', 'Tiếp tục', 300, { type: 'android.widget.Button' }),
], 7), APP);

const captureJev = (responder) => {
  const seen = [];
  const jev = createMockJev((state, questions, index) => {
    seen.push({ state, questions });
    return responder(state, questions, index);
  });
  return { jev, seen };
};

test('the leg verdicts are a closed set and are offered next to the screen actions', async () => {
  assert.deepEqual(LEG_VERDICTS.map((item) => [item.id, item.verdict]),
    [['arrived', 'arrived'], ['fail', 'fail'], ['blocked', 'blocked']]);

  const { jev, seen } = captureJev(() => ({ nextAction: { choice: 'arrived', confidence: 0.8 } }));
  const answer = await askOnce({ jev, snapshot: login(), state: { goal: 'Sign in' } });
  assert.equal(answer.record.kind, 'verdict');
  assert.equal(answer.record.verdict, 'arrived');
  assert.equal(answer.record.description, 'verdict arrived');
  assert.equal(answer.confidence, 0.8);
  assert.equal(seen[0].questions.nextAction.instructions, LEG_INSTRUCTION);
  const criteria = seen[0].questions.nextAction.criteria;
  for (const verdict of LEG_VERDICTS) assert.equal(criteria[verdict.id], verdict.description);
  assert.ok(criteria.wait && criteria.back && criteria.scroll_down && criteria.scroll_up);
  assert.equal(criteria.fail, LEG_VERDICTS[1].description);
});

test('a press is recorded by its public label and test id, never by a field value', async () => {
  const { jev } = captureJev(chooseByDescription('Tap "Tiếp tục"'));
  const answer = await askOnce({ jev, snapshot: login(), state: { goal: 'g' } });
  assert.equal(answer.record.kind, 'press');
  assert.equal(answer.record.label, 'Tiếp tục');
  assert.equal(answer.record.fieldIndex, undefined);
  assert.equal(answer.record.input, undefined);
  assert.equal(answer.action.node.text, 'Tiếp tục');
  assert.ok(JSON.stringify(answer.record).includes('Tiếp tục'));
});

test('a fill is recorded by input NAME and field position only', async () => {
  const { jev, seen } = captureJev(chooseByDescription('Type the input "phone" into text field #1'));
  const answer = await askOnce({ jev, snapshot: login(), state: { goal: 'g' }, inputs: ['phone'] });
  assert.equal(answer.record.kind, 'fill');
  assert.equal(answer.record.input, 'phone');
  assert.equal(answer.record.fieldIndex, 0);
  assert.equal(answer.record.label, undefined);
  assert.equal(answer.action.node.editable, true);
  assert.ok(!JSON.stringify(answer.record).includes(PHONE), 'the typed value reached the record');
  assert.ok(!JSON.stringify(seen[0].state).includes(PHONE), 'the typed value reached the Jev state');
  // The offered fill action names the input and the position, never the value.
  const fillDescription = Object.values(seen[0].questions.nextAction.criteria).find((text) => text.startsWith('Type the input'));
  assert.equal(fillDescription, 'Type the input "phone" into text field #1');
});

test('`exclude` removes an option from what Jev may choose, and choosing it is invalid', async () => {
  // Learn the id the press on "Tiếp tục" gets, then have Jev insist on exactly that option.
  const { jev: openJev } = captureJev(chooseByDescription('Tap "Tiếp tục"'));
  const excludedId = (await askOnce({ jev: openJev, snapshot: login(), state: {} })).record.id;

  const { jev, seen } = captureJev(() => ({ nextAction: { choice: excludedId, confidence: 0.95 } }));
  const answer = await askOnce({
    jev,
    snapshot: login(),
    state: { goal: 'g' },
    exclude: (action) => action.kind === 'press' && publicText(action.node) === 'Tiếp tục',
  });
  assert.deepEqual(answer, { error: 'jev_invalid_choice' });
  assert.ok(!Object.values(seen[0].questions.nextAction.criteria).includes('Tap "Tiếp tục"'));
  // The other options are still offered, so the exclusion is surgical.
  assert.ok(Object.values(seen[0].questions.nextAction.criteria).includes('Tap "Đăng nhập Acme"'));
});

test('an unknown id and a throwing Jev both come back as an error, never as an action', async () => {
  const weird = createMockJev(() => ({ nextAction: { choice: 'nope', confidence: 1 } }));
  assert.deepEqual(await askOnce({ jev: weird, snapshot: login(), state: {} }), { error: 'jev_invalid_choice' });
  const empty = createMockJev(() => ({}));
  assert.deepEqual(await askOnce({ jev: empty, snapshot: login(), state: {} }), { error: 'jev_invalid_choice' });
  const broken = createMockJev(() => { throw new Error('Jev is down'); });
  assert.deepEqual(await askOnce({ jev: broken, snapshot: login(), state: {} }), { error: 'jev_error: Jev is down' });
  assert.deepEqual(await askOnce({ jev: null, snapshot: login(), state: {} }), { error: 'jev_unavailable' });
});

test('a missing confidence is treated as sure, and the screen state still says it is untrusted', async () => {
  const { jev, seen } = captureJev(() => ({ nextAction: { choice: 'scroll_down' } }));
  const answer = await askOnce({ jev, snapshot: login(), state: { goal: 'g' } });
  assert.equal(answer.confidence, 1);
  assert.equal(answer.record.direction, 'down');
  assert.equal(seen[0].state.goal, 'g');
  assert.match(seen[0].state.screen.note, /untrusted/);
  assert.ok(seen[0].state.screen.visibleText.includes('Đăng nhập Acme'));
});

test('askOnce redacts input values the app printed on screen before Jev sees them', async () => {
  const { askOnce } = require('../../src/jev/resolver');
  const { normalizeSnapshot } = require('../../src/device/deviceBackend');
  const fixtures = require('../fixtures/device');
  const snapshot = normalizeSnapshot(fixtures.snapshot([
    fixtures.node('a1', 'Số ví: 0900000002 - Đặng Văn A', 100),
    fixtures.node('a2', '0900000002', 200),
  ], 7, { appBundleId: fixtures.APP }), fixtures.APP);
  let sent;
  const jev = { ask: async (state, questions) => { sent = { state, questions }; return { answers: { nextAction: { choice: 'arrived', confidence: 0.9 } } }; } };
  const redact = (text) => String(text).split('0900000002').join('{phone}');
  const answer = await askOnce({ jev, snapshot, state: { goal: 'g' }, redact });
  assert.equal(answer.record.verdict, 'arrived');
  assert.ok(!JSON.stringify(sent).includes('0900000002'), 'the phone reached Jev');
  assert.ok(JSON.stringify(sent).includes('{phone}'));
});
