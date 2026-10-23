/**
 * expect.test.js — the deterministic `expect` checks: validation, the polling check through a
 * device session, and the phrasing handed to Jev. Nothing walks steps any more, so this is
 * only the DSL's post-condition validator now.
 */
const os = require('os');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateExpect, checkExpect, describeExpect } = require('../../src/runner/expect');
const { createMockBackend } = require('../../src/device/deviceBackend');
const { createDeviceSession } = require('../../src/device/deviceTools');
const fixtures = require('../fixtures/device');

test('validateExpect accepts the four shapes and rejects the rest', () => {
  for (const good of [{ text: 'a' }, { anyText: ['a', 'b'], timeout: 10 }, { absent: 'a', exact: true }, { logcat: 'SUMMARY pass=\\d+' }, { text: 'a', timeout: '{t}' }]) {
    assert.doesNotThrow(() => validateExpect(good), JSON.stringify(good));
  }
  assert.throws(() => validateExpect({ text: 'a', absent: 'b' }), /exactly one/);
  assert.throws(() => validateExpect({ anyText: [] }), /non-empty list/);
  assert.throws(() => validateExpect({ logcat: '(' }), /not a valid regexp/);
  assert.throws(() => validateExpect({ text: 'a', colour: 1 }), /unknown key/);
  assert.throws(() => validateExpect({ text: 'a', timeout: 'soon' }), /number of ms/);
});

test('checkExpect polls the screen through the device session', async () => {
  const backend = createMockBackend({ snapshots: [fixtures.snapshot([fixtures.node('a1', 'Đăng nhập Acme', 100)])], appId: fixtures.APP });
  const session = createDeviceSession({ backend, reportDir: os.tmpdir(), pollMs: 1 });
  assert.equal((await checkExpect(session, { text: 'Đăng nhập Acme' })).ok, true);
  assert.equal((await checkExpect(session, { anyText: ['Nope', 'Đăng nhập Acme'] })).detail, 'saw "Đăng nhập Acme"');
  assert.equal((await checkExpect(session, { absent: 'Popup' }, { defaultTimeout: 0 })).ok, true);
  const missing = await checkExpect(session, { text: 'Trang chủ', timeout: 0 });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /expect not met after 0ms: the screen shows "Trang chủ"/);
  assert.equal((await checkExpect({ wait_text: async () => { throw new Error('boom'); } }, { text: 'x' })).ok, false);
});

test('describeExpect phrases the condition for Jev', () => {
  assert.equal(describeExpect({ anyText: ['A', 'B'] }), 'the screen shows one of "A", "B"');
  assert.equal(describeExpect({ absent: 'X' }), '"X" is no longer shown');
  assert.equal(describeExpect({ logcat: 'done' }), 'the app logs /done/');
});
