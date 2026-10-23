/**
 * registry.test.js — the registry must fail loudly and early: a bad kind, name or plugin has to be a clear
 * error at create time, not a strange device run twenty minutes later. Every message is asserted verbatim so a
 * wording change is a deliberate decision.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createRegistry } = require('../../src/core/registry');
const { createDefaultRegistry } = require('../../src/core/builtins');
const { assertContract } = require('../../src/core/contracts');

const UNKNOWN_KIND = 'unknown plugin kind "nope" (known: device, decider, account, otp, reporter, extractor)';

/** A device with every required method; cases delete one to check that the contract is really enforced. */
function fullDevice() {
  const device = {};
  for (const name of ['open', 'resetApp', 'snapshot', 'press', 'fill', 'scroll', 'back', 'screenshot', 'close', 'meta']) {
    device[name] = () => undefined;
  }
  return device;
}

test('1. register + create returns the validated instance and passes options through', () => {
  const registry = createRegistry();
  const device = fullDevice();
  const seen = [];
  registry.register('device', 'x', (options) => {
    seen.push(options);
    return device;
  });
  const options = { deviceId: 'emulator-5554' };
  const created = registry.create('device', 'x', options);
  assert.equal(created, device);
  assert.deepEqual(seen, [options]);
});

test('2. a duplicate register fails instead of silently overriding', () => {
  const registry = createRegistry();
  registry.register('device', 'x', () => fullDevice());
  assert.throws(() => registry.register('device', 'x', () => fullDevice()), {
    message: 'device:x is already registered',
  });
});

test('3. an unknown kind throws in register, list and create; has just answers false', () => {
  const registry = createRegistry();
  assert.throws(() => registry.register('nope', 'x', () => ({})), { message: UNKNOWN_KIND });
  assert.throws(() => registry.list('nope'), { message: UNKNOWN_KIND });
  assert.throws(() => registry.create('nope', 'x', {}), { message: UNKNOWN_KIND });
  assert.equal(registry.has('nope', 'x'), false);
});

test('4. an unknown name lists what is available, sorted, or none', () => {
  const registry = createRegistry();
  registry.register('device', 'b', () => fullDevice());
  registry.register('device', 'a', () => fullDevice());
  assert.throws(() => registry.create('device', 'ghost', {}), {
    message: 'no device plugin named "ghost" (available: a, b)',
  });
  assert.throws(() => createRegistry().create('device', 'ghost', {}), {
    message: 'no device plugin named "ghost" (available: none)',
  });
});

test('5. a factory result missing a required method is rejected at create', () => {
  const registry = createRegistry();
  const broken = fullDevice();
  delete broken.snapshot;
  registry.register('device', 'broken', () => broken);
  assert.throws(() => registry.create('device', 'broken', {}), {
    message: 'device plugin is missing: snapshot',
  });
});

test('6. a factory exception propagates unchanged', () => {
  const registry = createRegistry();
  const boom = new Error('boom');
  registry.register('device', 'boom', () => {
    throw boom;
  });
  assert.throws(() => registry.create('device', 'boom', {}), { message: 'boom' });
  assert.throws(() => registry.create('device', 'boom', {}), (err) => err === boom);
});

test('7. a bad name or a non-function factory is rejected at register', () => {
  const registry = createRegistry();
  assert.throws(() => registry.register('device', '', () => ({})), {
    message: 'plugin name must be a non-empty string',
  });
  assert.throws(() => registry.register('device', 5, () => ({})), {
    message: 'plugin name must be a non-empty string',
  });
  assert.throws(() => registry.register('device', 'x', 'not a function'), {
    message: 'factory for device:x must be a function',
  });
});

test('8. list is sorted, and empty for a kind with nothing registered', () => {
  const registry = createRegistry();
  for (const name of ['c', 'a', 'b']) registry.register('device', name, () => fullDevice());
  assert.deepEqual(registry.list('device'), ['a', 'b', 'c']);
  assert.deepEqual(createRegistry().list('device'), []);
});

test('9. the default registry lists both devices, needs no agent-device, and builds the mock', () => {
  // agent-device is an optional dependency. Drop it from the module cache and prove that building the registry
  // does not bring it back, so a checkout without it still works. Never call the agent-device factory here.
  let agentDevice = null;
  try {
    agentDevice = require.resolve('agent-device');
  } catch {
    agentDevice = null; // not installed in this checkout, which is exactly the case that must survive
  }
  if (agentDevice) delete require.cache[agentDevice];

  const registry = createDefaultRegistry();
  assert.deepEqual(registry.list('device'), ['agent-device', 'mock']);
  if (agentDevice) assert.equal(require.cache[agentDevice], undefined);

  const mock = registry.create('device', 'mock', {});
  assert.equal(assertContract('device', mock), mock);
  assert.equal(typeof mock.snapshot, 'function');
});