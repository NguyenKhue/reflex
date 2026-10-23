'use strict';

/**
 * contracts.test.js — the plugin contract is the only thing the core knows about a plugin.
 *
 * These tests pin the contract of today's implementations (the mock device backend, the mock Jev) so a change to
 * either one cannot silently break plugin loading.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { KINDS, assertContract, describeContract } = require('../../src/core/contracts');
const { createMockBackend } = require('../../src/device/deviceBackend');
const { createMockJev } = require('../../src/jev/jevClient');

const KNOWN_KINDS = ['device', 'decider', 'account', 'otp', 'reporter', 'extractor'];

/** A device plugin with exactly the required methods, built from the contract so the test cannot drift. */
function deviceWithRequiredOnly() {
  const plugin = {};
  for (const name of describeContract('device').required) plugin[name] = () => {};
  return plugin;
}

test('the mock device backend satisfies the device contract and is returned unchanged', () => {
  const backend = createMockBackend();
  assert.equal(assertContract('device', backend), backend);
});

test('the mock Jev does not satisfy the decider contract (T3 adapts it)', () => {
  const jev = createMockJev(() => ({}));
  assert.throws(() => assertContract('decider', jev), { message: 'decider plugin is missing: decide' });
});

test('an unknown kind is rejected and KINDS is the frozen list of known kinds', () => {
  assert.throws(() => assertContract('sensor', {}), {
    message: 'unknown plugin kind "sensor" (known: device, decider, account, otp, reporter, extractor)',
  });
  assert.deepEqual(KINDS, KNOWN_KINDS);
  assert.ok(Object.isFrozen(KINDS));
});

test('a plugin that is not an object is rejected with its type', () => {
  assert.throws(() => assertContract('device', null), { message: 'device plugin must be an object, got null' });
  assert.throws(() => assertContract('device', 'backend'), { message: 'device plugin must be an object, got string' });
  assert.throws(() => assertContract('device', () => {}), { message: 'device plugin must be an object, got function' });
});

test('a device plugin with only open reports every other required name, in contract order', () => {
  assert.throws(() => assertContract('device', { open() {} }), {
    message: 'device plugin is missing: resetApp, snapshot, press, fill, scroll, back, screenshot, close, meta',
  });
});

test('optional device methods are not required', () => {
  const plugin = deviceWithRequiredOnly();
  assert.equal(assertContract('device', plugin), plugin);
});

test('describeContract returns a copy that cannot be mutated into the contract', () => {
  const first = describeContract('device');
  first.required.push('teleport');
  assert.deepEqual(describeContract('device').required, first.required.slice(0, -1));
  assert.equal(describeContract('device').required.length, 10);
});

test('each single-method kind passes with an object that has exactly its one required method', () => {
  const oneMethod = {
    decider: 'decide',
    account: 'get',
    otp: 'getOtp',
    reporter: 'report',
    extractor: 'extract',
  };
  for (const kind of ['decider', 'account', 'otp', 'reporter', 'extractor']) {
    const plugin = { [oneMethod[kind]]() {} };
    assert.deepEqual(Object.keys(plugin), [describeContract(kind).required[0]]);
    assert.equal(assertContract(kind, plugin), plugin);
  }
});
