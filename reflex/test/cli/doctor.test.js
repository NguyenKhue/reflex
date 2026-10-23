/**
 * doctor.test.js — `reflex doctor`: the account and OTP checks are informational and accept both
 * the REFLEX_TEST_* account names and the two OTP names.
 *
 * A machine that never logs in is fine, so a missing account must not fail the command.
 * No device and no network: every case asks for `platform: 'ios'`, which skips the adb checks.
 *
 * Only an obviously fake placeholder value is used here; no real-looking phone, host or password
 * appears in this file.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { doctor } = require('../../src/cli/doctor');

const FAKE_VALUE = 'S3CR3T-xyz';

/** The account family doctor reads, so no case can inherit a real value. */
const ENV_KEYS = [
  'TYPESAFE_API_KEY',
];

const PREFIXES = ['REFLEX_TEST_'];

function relevantKeys() {
  const keys = new Set(ENV_KEYS);
  for (const key of Object.keys(process.env)) {
    if (PREFIXES.some((prefix) => key.startsWith(prefix))) keys.add(key);
  }
  return [...keys];
}

/**
 * Run `body` with `values` exported and every other account/OTP name removed, then put the
 * caller's environment back exactly as it was — including variables that only existed under a
 * prefix, so a later test file in the same process sees them again.
 */
async function withEnv(values, body) {
  const keys = relevantKeys();
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    return await body();
  } finally {
    for (const key of keys) {
      if (saved.get(key) === undefined) delete process.env[key];
      else process.env[key] = saved.get(key);
    }
  }
}

const byName = (result, fragment) => result.checks.filter((check) => check.name.includes(fragment));

test('1. with nothing set the account checks warn and do not fail the command', async () => {
  const result = await withEnv({}, () => doctor({ platform: 'ios' }));
  for (const fragment of ['REFLEX_TEST_PHONE', 'REFLEX_TEST_PASSWORD']) {
    const checks = byName(result, fragment);
    assert.equal(checks.length, 1, `expected exactly one ${fragment} check`);
    const [check] = checks;
    assert.equal(check.ok, false, `${fragment} is not set`);
    assert.equal(check.level, 'warn', `${fragment} is informational`);
    assert.ok(check.detail.includes('only needed by plans that log in'), `${fragment} detail explains why: ${check.detail}`);
  }
  // The verdict must ignore warn-level checks: an otherwise fine machine stays ok.
  const failing = result.checks.filter((check) => !check.ok && check.level !== 'warn');
  assert.equal(result.ok, failing.length === 0, 'warn checks never make ok false');
  assert.ok(result.checks.some((check) => check.name === 'node' && check.ok), 'the node check passes here');
});

test('2. REFLEX_TEST_PHONE makes the phone check ok', async () => {
  const result = await withEnv({ REFLEX_TEST_PHONE: FAKE_VALUE }, () => doctor({ platform: 'ios' }));
  const [phone] = byName(result, 'REFLEX_TEST_PHONE');
  assert.equal(phone.ok, true);
  assert.equal(phone.detail, 'set');
  assert.equal(phone.hint, undefined, 'a passing check carries no hint');
});

test('3. REFLEX_TEST_PASSWORD makes the password check ok', async () => {
  const result = await withEnv({ REFLEX_TEST_PASSWORD: FAKE_VALUE }, () => doctor({ platform: 'ios' }));
  const password = result.checks.find((check) => check.name === 'REFLEX_TEST_PASSWORD');
  assert.ok(password, 'the check names REFLEX_TEST_PASSWORD');
  assert.equal(password.ok, true);
  assert.equal(password.detail, 'set');
});

test('4. doctor no longer asks for an OTP token', async () => {
  const result = await withEnv({}, () => doctor({ platform: 'ios' }));
  assert.equal(byName(result, 'OTP').length, 0);
});

test('5. a per-platform name adds its own entry', async () => {
  const result = await withEnv(
    { REFLEX_TEST_PHONE_ANDROID: FAKE_VALUE, REFLEX_TEST_PHONE_IOS: FAKE_VALUE },
    () => doctor({ platform: 'ios' }),
  );
  const android = result.checks.find((check) => check.name === 'REFLEX_TEST_PHONE_ANDROID');
  const ios = result.checks.find((check) => check.name === 'REFLEX_TEST_PHONE_IOS');
  assert.ok(android, 'REFLEX_TEST_PHONE_ANDROID is listed');
  assert.ok(ios, 'REFLEX_TEST_PHONE_IOS is listed');
  for (const check of [android, ios]) {
    assert.equal(check.ok, true);
    assert.equal(check.detail, 'set');
    assert.equal(check.level, 'warn');
  }
  // A platform entry is additive: the shared names stay unset and stay reported as such.
  const phone = result.checks.find((check) => check.name === 'REFLEX_TEST_PHONE');
  assert.equal(phone.ok, false);
});

test('6. no check ever carries a value that was set', async () => {
  const values = {
    REFLEX_TEST_PHONE: FAKE_VALUE,
    REFLEX_TEST_PASSWORD: FAKE_VALUE,
    REFLEX_TEST_PIN_ANDROID: FAKE_VALUE,
    REFLEX_TEST_PHONE_IOS: FAKE_VALUE,
    TYPESAFE_API_KEY: FAKE_VALUE,
  };
  const result = await withEnv(values, () => doctor({ platform: 'ios' }));
  const printed = JSON.stringify(result);
  assert.ok(!printed.includes(FAKE_VALUE), 'no set value appears anywhere in the result');
  for (const check of result.checks) {
    assert.ok(!String(check.detail || '').includes(FAKE_VALUE), `detail of ${check.name}`);
    assert.ok(!String(check.hint || '').includes(FAKE_VALUE), `hint of ${check.name}`);
  }
});

test('7. the environment is left exactly as it was found', async () => {
  const before = relevantKeys().map((key) => `${key}=${process.env[key] === undefined ? '' : process.env[key]}`).sort();
  await withEnv({ REFLEX_TEST_PHONE: FAKE_VALUE }, () => doctor({ platform: 'ios' }));
  const after = relevantKeys().map((key) => `${key}=${process.env[key] === undefined ? '' : process.env[key]}`).sort();
  assert.deepEqual(after, before);
});
