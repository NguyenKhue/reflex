/** actions.test.js — the closed action set offered to Jev for one screen. */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSnapshot } = require('../../src/device/deviceBackend');
const { buildActions, describeAction } = require('../../src/jev/actions');
const fixtures = require('../fixtures/device');

const APP = fixtures.APP;
const home = () => normalizeSnapshot(fixtures.homeRaw(), APP);
const FIXED_IDS = ['qa_pass', 'qa_fail', 'need_input', 'incomplete', 'wait', 'back', 'scroll_down', 'scroll_up'];

test('the fixed verdicts lead the action list', () => {
  const actions = buildActions(home());

  assert.deepEqual(actions.slice(0, FIXED_IDS.length).map((action) => action.id), FIXED_IDS);
  assert.equal(actions[0].kind, 'verdict');
  assert.equal(actions[0].verdict, 'pass');
  assert.equal(actions[1].verdict, 'fail');
  assert.equal(actions[2].verdict, 'need_input');
  assert.equal(actions[3].verdict, 'incomplete');
  assert.equal(actions[4].kind, 'wait');
  assert.equal(actions.find((action) => action.id === 'scroll_up').direction, 'up');
});

test('back and scroll can be withheld, and every id is unique', () => {
  const actions = buildActions(home(), { allowBack: false, allowScroll: false });
  const ids = actions.map((action) => action.id);

  assert.equal(ids.includes('back'), false);
  assert.equal(ids.some((id) => id.startsWith('scroll')), false);
  assert.equal(new Set(ids).size, ids.length);
});

test('each unique text node becomes one press action, top-to-bottom', () => {
  const actions = buildActions(home());
  const presses = actions.filter((action) => action.kind === 'press');

  assert.deepEqual(presses.map((action) => action.id), ['pe10', 'pe11', 'pe12', 'pe13', 'pe14', 'pe15', 'pe16', 'pe17']);
  assert.equal(presses[0].description, 'Tap "Acme Example"');
  assert.equal(presses.find((action) => action.id === 'pe15').node.pinned, '@e15~s7');
  assert.equal(actions.some((action) => action.kind === 'fill'), false);
});

test('duplicate labels on one screen yield a single action', () => {
  const actions = buildActions(normalizeSnapshot(fixtures.orderingRaw(), APP));
  const presses = actions.filter((action) => action.kind === 'press');

  assert.deepEqual(presses.map((action) => action.description), ['Tap "max-api-v2"', 'Tap "max-api-v2 gốc"']);
});

test('a disabled node never becomes an action', () => {
  const actions = buildActions(normalizeSnapshot(fixtures.disabledRaw(), APP));

  assert.equal(actions.some((action) => action.description.includes('Bị khoá')), false);
  assert.ok(actions.some((action) => action.description === 'Tap "Bấm được"'));
});

test('fill actions carry input names, never input values', () => {
  const actions = buildActions(normalizeSnapshot(fixtures.loginRaw(), APP), { inputs: [{ name: 'phone' }] });
  const fills = actions.filter((action) => action.kind === 'fill');

  assert.equal(fills.length, 1);
  assert.equal(fills[0].id, 'fe51_phone');
  assert.equal(fills[0].input, 'phone');
  assert.equal(fills[0].description, 'Type the input "phone" into text field #1');
  // The screen's own value may be a secret; it must not appear in any description.
  assert.equal(actions.map((action) => action.description).join(' | ').includes('0900000002'), false);
  assert.equal(fills[0].node.value, '0900000002');
});

test('the variable part of the list is capped at maxActions', () => {
  const snap = home();
  const full = buildActions(snap, { inputs: [{ name: 'phone' }] });

  assert.equal(full.length, FIXED_IDS.length + 8);
  assert.equal(buildActions(snap, { maxActions: 10 }).length, 10);
  assert.equal(buildActions(snap, { maxActions: 8 }).length, 8);
  // The fixed verdicts always survive, even when the budget is smaller than the list.
  const tiny = buildActions(snap, { maxActions: 2 });
  assert.equal(tiny.length, FIXED_IDS.length);
  assert.deepEqual(tiny.map((action) => action.id), FIXED_IDS);
});

test('describeAction renders a short, secret-free label', () => {
  const snap = normalizeSnapshot(fixtures.loginRaw(), APP);
  const actions = buildActions(snap, { inputs: ['phone'] });

  assert.equal(describeAction(actions.find((action) => action.id === 'pe53')), 'press "Tiếp tục"');
  assert.equal(describeAction(actions.find((action) => action.id === 'fe51_phone')), 'fill "phone" into text field #1');
  assert.equal(describeAction(actions.find((action) => action.id === 'scroll_down')), 'scroll down');
  assert.equal(describeAction(actions.find((action) => action.id === 'qa_pass')), 'verdict pass');
  assert.equal(describeAction(undefined), 'unknown');
});
