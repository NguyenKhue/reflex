/**
 * jevDecider.test.js — the decider contract, the Jev adapter, and askOnce driven by a decider.
 *
 * The adapter is the reference implementation of `decide`, and askOnce must treat a decider and a
 * raw jev client identically, so both the plugin path and the resolver path are checked here.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockJev } = require('../../src/jev/jevClient');
const { askOnce, LEG_INSTRUCTION } = require('../../src/jev/resolver');
const { createJevDecider } = require('../../src/core/deciders/jev');
const { assertContract } = require('../../src/core/contracts');
const { createDefaultRegistry } = require('../../src/core/builtins');
const { normalizeSnapshot } = require('../../src/device/deviceBackend');
const fixtures = require('../fixtures/device');

const PHONE = '0900000002';

/** A login screen whose editable field is pre-filled, so its label IS the phone number. */
const login = () => normalizeSnapshot(fixtures.snapshot([
  fixtures.node('e1', 'Đăng nhập Acme', 100),
  fixtures.node('e2', PHONE, 200, { type: 'android.widget.EditText', editable: true, value: PHONE }),
  fixtures.node('e3', 'Tiếp tục', 300, { type: 'android.widget.Button' }),
], 7), fixtures.APP);

test('createJevDecider satisfies the decider contract and refuses a client without ask', () => {
  assertContract('decider', createJevDecider(createMockJev(() => ({}))));
  const message = 'createJevDecider needs a Jev client with ask(state, questions)';
  assert.throws(() => createJevDecider(null), { message });
  assert.throws(() => createJevDecider({}), { message });
});

test('decide hands the state to the Jev client unchanged as one choice question', async () => {
  let seen = null;
  const jev = createMockJev((state, questions) => { seen = { state, questions }; return {}; });
  const decider = createJevDecider(jev);
  await decider.decide({ state: { goal: 'Sign in' }, instruction: 'Pick one', options: { back: 'Go back' } });
  assert.deepEqual(seen.state, { goal: 'Sign in' });
  assert.equal(seen.questions.nextAction.type, 'choice');
  assert.equal(seen.questions.nextAction.instructions, 'Pick one');
  assert.deepEqual(seen.questions.nextAction.criteria, { back: 'Go back' });
});

test('decide returns the answer plus the raw telemetry of the response', async () => {
  const decider = createJevDecider(createMockJev(() => ({ nextAction: { choice: 'back', confidence: 0.7 } })));
  const answer = await decider.decide({ state: {}, instruction: 'Pick one', options: { back: 'Go back' } });
  assert.equal(answer.choice, 'back');
  assert.equal(answer.confidence, 0.7);
  assert.equal(answer.model, 'mock');
});

test('a response without an answer gives choice undefined instead of throwing', async () => {
  const decider = createJevDecider(createMockJev(() => ({})));
  const answer = await decider.decide({ state: {}, instruction: 'Pick one', options: { back: 'Go back' } });
  assert.equal(answer.choice, undefined);
});

test('a Jev failure propagates out of decide so the caller can map it', async () => {
  const decider = createJevDecider(createMockJev(() => { throw new Error('Jev is down'); }));
  await assert.rejects(
    () => decider.decide({ state: {}, instruction: 'Pick one', options: { back: 'Go back' } }),
    { message: 'Jev is down' },
  );
});

test('askOnce asks the decider for one of the closed-set ids and returns its record', async () => {
  let seen = null;
  const decider = { async decide(request) { seen = request; return { choice: 'back', confidence: 0.9 }; } };
  const result = await askOnce({ decider, snapshot: login(), state: { goal: 'Sign in' } });
  assert.equal(result.record.kind, 'back');
  assert.equal(result.confidence, 0.9);
  assert.equal(seen.instruction, LEG_INSTRUCTION);
  for (const id of ['arrived', 'fail', 'blocked', 'back', 'wait']) {
    assert.notEqual(seen.options[id], undefined, `option ${id} must be offered to the decider`);
  }
});

test('a decider wins over a jev client, which is then never called', async () => {
  const decider = { async decide() { return { choice: 'back', confidence: 1 }; } };
  const jev = createMockJev(() => { throw new Error('the jev client must not be called'); });
  const result = await askOnce({ decider, jev, snapshot: login(), state: { goal: 'Sign in' } });
  assert.equal(result.record.kind, 'back');
});

test('askOnce reports the missing, failing and wrong decider answers with the same messages as before', async () => {
  const snapshot = login();
  const state = { goal: 'Sign in' };
  assert.deepEqual(await askOnce({ snapshot, state }), { error: 'jev_unavailable' });
  assert.deepEqual(
    await askOnce({ decider: { async decide() { throw new Error('boom'); } }, snapshot, state }),
    { error: 'jev_error: boom' },
  );
  assert.deepEqual(
    await askOnce({ decider: { async decide() { return { choice: 'nope', confidence: 1 }; } }, snapshot, state }),
    { error: 'jev_invalid_choice' },
  );
  const noConfidence = await askOnce({
    decider: { async decide() { return { choice: 'back' }; } }, snapshot, state,
  });
  assert.equal(noConfidence.confidence, 1);
});

test('the default registry offers the jev and opencode deciders', () => {
  const registry = createDefaultRegistry();
  assert.deepEqual(registry.list('decider'), ['jev', 'opencode']);
  const decider = registry.create('decider', 'jev', { jev: createMockJev(() => ({})) });
  assertContract('decider', decider);
  assert.equal(typeof decider.decide, 'function');
});