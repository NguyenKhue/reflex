/**
 * envAccounts.test.js — the account provider is the only place a phone / password / PIN is looked up, and it
 * must answer in a fixed order: REFLEX_TEST_* env first, then the workspace manifest value.
 * Every case injects `env`, so no test can read or print a real secret, and no value is ever asserted in an
 * error message.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createEnvAccountProvider } = require('../../src/core/accounts/env');
const { createDefaultRegistry } = require('../../src/core/builtins');
const { assertContract } = require('../../src/core/contracts');
const { resolveRowData } = require('../../src/plan/data');

/** Stands in for util/workspace.js: it records the platform it was asked for, then answers from the manifest. */
function fakeWorkspace(values = {}) {
  const seen = [];
  return {
    seen,
    defaults(platform) {
      seen.push(platform);
      return { account: { phone: 'ws-phone', password: 'ws-pass', ...values } };
    },
  };
}

test('1. the provider satisfies the account contract', () => {
  const provider = createEnvAccountProvider({ workspace: fakeWorkspace(), env: {} });
  assert.equal(assertContract('account', provider), provider);
  assert.equal(typeof provider.get, 'function');
});

test('2. REFLEX_TEST_<NAME>_<PLATFORM> beats REFLEX_TEST_<NAME> beats the workspace value', () => {
  const env = { REFLEX_TEST_PHONE_ANDROID: 'env-android', REFLEX_TEST_PHONE: 'env-shared' };
  const provider = createEnvAccountProvider({ workspace: fakeWorkspace(), env });
  assert.equal(provider.get('phone', { platform: 'android' }), 'env-android');
  // ios has no suffix of its own: the android value must not leak into it.
  assert.equal(provider.get('phone', { platform: 'ios' }), 'env-shared');
  // no platform at all: only the un-suffixed name is looked at.
  assert.equal(provider.get('phone'), 'env-shared');
});

test('3. with no REFLEX_TEST_* set the workspace value is used, asked for the given platform', () => {
  const workspace = fakeWorkspace();
  const provider = createEnvAccountProvider({ workspace, env: {} });
  assert.equal(provider.get('phone', { platform: 'ios' }), 'ws-phone');
  assert.equal(provider.get('password', { platform: 'ios' }), 'ws-pass');
  assert.deepEqual(workspace.seen, ['ios', 'ios']);
});

test('4. without a platform the un-suffixed name is used and the platform suffix is ignored', () => {
  const env = { REFLEX_TEST_PHONE_ANDROID: 'env-android' };
  const provider = createEnvAccountProvider({ workspace: fakeWorkspace(), env });
  assert.equal(provider.get('phone'), 'ws-phone');
  assert.equal(provider.get('phone', { platform: 'android' }), 'env-android');
});

test('5. a workspace without a root answers "no account" instead of throwing', () => {
  const broken = {
    defaults() {
      throw new Error('no workspace root');
    },
  };
  assert.equal(createEnvAccountProvider({ workspace: broken, env: {} }).get('phone', { platform: 'android' }), undefined);
  // A missing workspace object is the same situation: nothing to fall back to.
  assert.equal(createEnvAccountProvider({ env: {} }).get('phone', { platform: 'android' }), undefined);
});

test('6. empty strings count as absent, so the next source wins', () => {
  const withEmptyEnv = createEnvAccountProvider({ workspace: fakeWorkspace(), env: { REFLEX_TEST_PHONE: '' } });
  assert.equal(withEmptyEnv.get('phone', { platform: 'android' }), 'ws-phone');
  const withEmptyWorkspace = createEnvAccountProvider({ workspace: fakeWorkspace({ phone: '' }), env: {} });
  assert.equal(withEmptyWorkspace.get('phone', { platform: 'android' }), undefined);
});

test('7. custom prefixes are checked in order, and an unknown name is simply absent', () => {
  const env = { A_PHONE: 'from-a', B_PHONE: 'from-b' };
  const provider = createEnvAccountProvider({ workspace: fakeWorkspace(), env, prefixes: ['A_', 'B_'] });
  assert.equal(provider.get('phone', { platform: 'android' }), 'from-a');
  // A name nobody declares anywhere is absent, not a guess.
  assert.equal(provider.get('otp'), undefined);
});

test('8. resolveRowData asks the provider only for inputs the row left empty', () => {
  const accounts = { get: (name) => ({ phone: 'p1', password: 'pw' })[name] };
  const options = { workspace: fakeWorkspace(), platform: 'android', accounts };
  const inputs = [
    { name: 'phone', secret: true, required: true },
    { name: 'password', secret: true, required: true },
    { name: 'pin', secret: true, required: false },
  ];
  const plan = { name: 'login', inputs };

  const fromProvider = resolveRowData(plan, {}, options);
  assert.equal(fromProvider.phone, 'p1');
  assert.equal(fromProvider.password, 'pw');
  // 'pw' is not a 6-digit PIN, so the pin input stays empty rather than inventing one.
  assert.equal(fromProvider.pin, undefined);

  const own = resolveRowData(plan, { phone: 'row-phone' }, options);
  assert.equal(own.phone, 'row-phone');

  const pinPlan = { name: 'login', inputs: [{ name: 'password', secret: true, required: true }, { name: 'pin', secret: true }] };
  const sixDigits = { get: (name) => ({ phone: 'p1', password: '123456' })[name] };
  assert.equal(resolveRowData(pinPlan, {}, { ...options, accounts: sixDigits }).pin, '123456');
});

test('9. a missing required input names the input, never the secrets the provider holds', () => {
  const accounts = { get: (name) => (name === 'password' ? 'secret-password-value' : undefined) };
  const plan = {
    name: 'x',
    inputs: [
      { name: 'phone', required: true },
      { name: 'password', secret: true, required: true },
    ],
  };
  assert.throws(() => resolveRowData(plan, {}, { workspace: fakeWorkspace(), platform: 'android', accounts }), (err) => {
    assert.equal(err.message, 'plan "x" requires input "phone"');
    assert.equal(err.message.includes('secret-password-value'), false);
    assert.equal(err.message.includes('ws-pass'), false);
    return true;
  });
});

test('10. the default registry ships the env account provider', () => {
  const registry = createDefaultRegistry();
  assert.deepEqual(registry.list('account'), ['env']);
  const provider = registry.create('account', 'env', { workspace: fakeWorkspace(), env: {} });
  assert.equal(assertContract('account', provider), provider);
  assert.equal(provider.get('phone', { platform: 'android' }), 'ws-phone');
});
