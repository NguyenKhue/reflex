/**
 * match.test.js — the one matcher behind `identify` and every exception `when`.
 *
 * Fold + contains is what makes the knowledge base survive a label that is re-worded, and
 * `noneText` is what separates two screens that share their main text. The privacy rule shows
 * up here too: an editable node's label IS its value on Android, so it never satisfies a
 * `when` — otherwise a screen could be identified by a phone number.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSnapshot } = require('../../src/device/deviceBackend');
const { screenIndex, matchWhen, specificity, KEYS } = require('../../src/screens/match');
const fixtures = require('../fixtures/device');

const APP = fixtures.APP;

function indexOf(nodes) {
  return screenIndex(normalizeSnapshot(fixtures.snapshot(nodes), APP));
}

const cardCode = () => indexOf([
  fixtures.node('c1', 'Mua mã thẻ', 100),
  fixtures.node('c2', 'Viettel', 200, { type: 'android.widget.Button' }),
  fixtures.node('c3', 'Mobifone', 260, { type: 'android.widget.Button' }),
  fixtures.node('c4', 'card_code_tab', 320, { identifier: 'card_code_tab' }),
]);

test('allText needs every text, anyText needs one, noneText vetoes', () => {
  const index = cardCode();
  assert.equal(matchWhen(index, { allText: ['Mua mã thẻ', 'Viettel'] }), true);
  assert.equal(matchWhen(index, { allText: ['Mua mã thẻ', 'Vinaphone'] }), false);
  assert.equal(matchWhen(index, { anyText: ['Vinaphone', 'Mobifone'] }), true);
  assert.equal(matchWhen(index, { anyText: ['Vinaphone'] }), false);
  assert.equal(matchWhen(index, { allText: ['Mua mã thẻ'], noneText: ['Xác nhận thanh toán'] }), true);
  assert.equal(matchWhen(index, { allText: ['Mua mã thẻ'], noneText: ['Viettel'] }), false);
});

test('anyId matches an identifier and a test ID that only shows up as text', () => {
  const index = cardCode();
  assert.equal(matchWhen(index, { anyId: ['card_code_tab'] }), true);
  assert.equal(matchWhen(index, { anyId: ['card_code_tab', 'other_tab'] }), true);
  assert.equal(matchWhen(index, { anyId: ['missing_tab'] }), false);
  // React Native test IDs often surface as a plain text node.
  assert.equal(matchWhen(index, { anyId: ['Mua mã thẻ'] }), false, 'a text with a space is not a test id');
  const rn = indexOf([fixtures.node('r1', 'btn_continue', 100)]);
  assert.equal(matchWhen(rn, { anyId: ['btn_continue'] }), true);
});

test('matching folds diacritics in both directions', () => {
  const index = indexOf([fixtures.node('v1', 'Đăng nhập', 100, { type: 'android.widget.Button' })]);
  assert.equal(matchWhen(index, { allText: ['dang nhap'] }), true);
  const folded = indexOf([fixtures.node('v2', 'dang nhap', 100)]);
  assert.equal(matchWhen(folded, { allText: ['Đăng nhập'] }), true);
});

test('an editable field never identifies a screen: its label is its value', () => {
  const index = indexOf([
    fixtures.node('f1', '0900000002', 100, { type: 'android.widget.EditText', editable: true, value: '0900000002' }),
    fixtures.node('f2', 'Mật khẩu của bạn', 200),
  ]);
  assert.equal(matchWhen(index, { anyText: ['0900000002'] }), false);
  assert.equal(matchWhen(index, { allText: ['0900000002'] }), false);
  assert.equal(matchWhen(index, { noneText: ['0900000002'] }), true, 'a value must not veto either');
  assert.equal(matchWhen(index, { allText: ['Mật khẩu của bạn'] }), true);
});

test('an empty or unknown-only `when` never matches', () => {
  const index = cardCode();
  assert.equal(matchWhen(index, {}), false);
  assert.equal(matchWhen(index, { allText: [] }), false);
  assert.equal(matchWhen(index, undefined), false);
  assert.equal(matchWhen(index, { anyId: ['nope'], allText: [] }), false);
});

test('specificity counts the conditions, which is how a tie is broken', () => {
  assert.equal(specificity({ anyId: ['a'] }), 1);
  assert.equal(specificity({ anyId: ['a'], allText: ['x', 'y'], noneText: ['z'] }), 4);
  assert.equal(specificity({}), 0);
  assert.equal(specificity(undefined), 0);
  assert.deepEqual(KEYS, ['anyId', 'allText', 'anyText', 'noneText']);
});
