/**
 * otpAndReporters.test.js — the OTP provider and the two reporters behind their contracts.
 *
 * Nothing here reaches the network: every HTTP side of the plugins is injected. The device case uses the mock
 * backend, exactly like test/device/deviceTools.test.js, so the OTP is only ever typed into a fake device.
 */
const os = require('os');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createMockBackend } = require('../../src/device/deviceBackend');
const { createDeviceSession } = require('../../src/device/deviceTools');
const { assertContract } = require('../../src/core/contracts');
const { createDefaultRegistry } = require('../../src/core/builtins');
const { createUploadReporter } = require('../../src/core/reporters/upload');
const { createGoogleChatReporter, defaultText } = require('../../src/core/reporters/googleChat');
const fixtures = require('../fixtures/device');

const OTP_CODE = '2468';

function statusBar() {
  return fixtures.node('e99', '9:41', 12, { bundleId: fixtures.SYSTEMUI, hittable: false });
}

/** OTP screen: a title plus the OTP box (no text, value or label in the tree). */
function otpRaw() {
  return fixtures.snapshot([
    statusBar(),
    fixtures.node('e90', 'Nhập mã xác thực', 100),
    fixtures.node('e91', '', 200, { type: 'android.widget.EditText', editable: true }),
    fixtures.node('e92', 'Xác nhận', 300, { type: 'android.widget.Button' })
  ]);
}

function sessionFor(raw, extra = {}) {
  const backend = createMockBackend({ snapshots: [raw], appId: fixtures.APP });
  return { backend, session: createDeviceSession({ backend, pollMs: 1, reportDir: os.tmpdir(), ...extra }) };
}

test('1. an otp provider object satisfies the otp contract and the registry holds only the generic http one', async () => {
  const provider = { getOtp: async (phone) => `${OTP_CODE}:${phone}` };
  assert.equal(assertContract('otp', provider), provider);
  assert.equal(await provider.getOtp('0900'), `${OTP_CODE}:0900`);
  assert.deepEqual(createDefaultRegistry().list('otp'), ['http']);
});

test('2. the upload reporter sends the report directory and needs one', async () => {
  const seen = [];
  const reporter = createUploadReporter({
    upload: async (reportDir, endpoint, options) => {
      seen.push({ reportDir, endpoint, options });
      return { uploaded: true };
    },
  });
  assert.equal(assertContract('reporter', reporter), reporter);
  assert.equal(reporter.name, 'upload');

  assert.deepEqual(await reporter.report({ status: 'pass' }, { reportDir: '/r' }), { uploaded: true });
  assert.deepEqual(seen, [{ reportDir: '/r', endpoint: undefined, options: {} }]);

  const targeted = createUploadReporter({
    upload: async (reportDir, endpoint, options) => {
      seen.push({ reportDir, endpoint, options });
      return { uploaded: true };
    },
    endpoint: 'http://x',
    options: { singleFile: true },
  });
  await targeted.report({ status: 'pass' }, { reportDir: '/r' });
  assert.deepEqual(seen[1], { reportDir: '/r', endpoint: 'http://x', options: { singleFile: true } });

  await assert.rejects(() => reporter.report({ status: 'pass' }), { message: 'upload reporter needs a reportDir' });
});

test('3. the Google Chat reporter only posts when delivery is switched on', async () => {
  const posted = [];
  const notify = async (text, hook) => {
    posted.push({ text, hook });
    return { sent: true };
  };

  const off = createGoogleChatReporter({ notify, shouldNotify: () => false });
  assert.equal(assertContract('reporter', off), off);
  assert.equal(off.name, 'google-chat');
  assert.deepEqual(await off.report({ plan: 'p', status: 'pass' }), { skipped: true });
  assert.deepEqual(posted, []);

  const on = createGoogleChatReporter({ notify, shouldNotify: () => true });
  await on.report({ plan: 'p', status: 'pass' });
  assert.deepEqual(posted, [{ text: '*p* — pass', hook: undefined }]);

  const hooked = createGoogleChatReporter({
    notify,
    shouldNotify: () => true,
    webhook: 'http://hook',
  });
  await hooked.report({ plan: 'p', status: 'pass' });
  assert.deepEqual(posted[1], { text: '*p* — pass', hook: 'http://hook' });

  const formatted = createGoogleChatReporter({
    notify,
    shouldNotify: () => true,
    format: (summary) => `${summary.status}/${summary.plan}`,
  });
  await formatted.report({ plan: 'p', status: 'pass' });
  assert.deepEqual(posted[2], { text: 'pass/p', hook: undefined });
});

test('4. the default chat line falls back to run and unknown', () => {
  assert.equal(defaultText({}), '*run* — unknown');
  assert.equal(defaultText({ name: 'n', status: 'fail' }), '*n* — fail');
  assert.equal(defaultText(null), '*run* — unknown');
});

test('5. an object OTP provider (getOtp) works as well as the old function form', async () => {
  const phones = [];
  const { backend, session } = sessionFor(otpRaw(), {
    otpProvider: {
      getOtp: async (phone) => {
        phones.push(phone);
        return OTP_CODE;
      },
    },
  });

  const result = await session.fill_otp_from_api({ phone: ' 0900000002 ', waitText: 'Nhap ma xac thuc', timeout: 200 });

  assert.deepEqual(result, { ok: true, found: true, attempts: 1 });
  assert.deepEqual(phones, ['0900000002']);
  assert.equal(backend.actions[0].kind, 'fill');
  assert.equal(backend.actions[0].target.ref, 'e91');
  assert.equal(backend.actions[0].text, OTP_CODE);
});

test('6. the default registry exposes both reporters and the generic http otp provider', () => {
  const registry = createDefaultRegistry();
  assert.deepEqual(registry.list('otp'), ['http']);
  assert.deepEqual(registry.list('reporter'), ['google-chat', 'upload']);
  assertContract('reporter', registry.create('reporter', 'upload', {}));
  assertContract('reporter', registry.create('reporter', 'google-chat', {}));
});

test('the http otp provider fills {phone}, sends the bearer token and reads otp from data', async () => {
  const { createHttpOtpProvider } = require('../../src/core/otp/http');
  const seen = [];
  const provider = createHttpOtpProvider({
    env: { REFLEX_OTP_URL: 'http://otp.invalid/otp/{phone}', REFLEX_OTP_TOKEN: 'Bearer tok' },
    fetchImpl: async (url, init) => {
      seen.push({ url, auth: init.headers.Authorization });
      return { ok: true, status: 200, json: async () => ({ data: { otp: OTP_CODE } }) };
    },
  });
  assert.equal(assertContract('otp', provider), provider);
  assert.equal(await provider.getOtp(' 0900 '), OTP_CODE);
  assert.deepEqual(seen, [{ url: 'http://otp.invalid/otp/0900', auth: 'Bearer tok' }]);
});

test('the http otp provider appends the phone without {phone} and never echoes the token or the body', async () => {
  const { createHttpOtpProvider, urlFor } = require('../../src/core/otp/http');
  assert.equal(urlFor('http://otp.invalid/otp/', '0900'), 'http://otp.invalid/otp/0900');
  const failing = createHttpOtpProvider({
    env: { REFLEX_OTP_URL: 'http://otp.invalid/otp', REFLEX_OTP_TOKEN: 'secret-token' },
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  await assert.rejects(failing.getOtp('0900'), (error) => /HTTP 401/.test(error.message) && !/secret-token/.test(error.message));
  const shapeless = createHttpOtpProvider({
    env: { REFLEX_OTP_URL: 'http://otp.invalid/otp' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ otp: 'abc' }) }),
  });
  await assert.rejects(shapeless.getOtp('0900'), /no 4-8 digit/);
  await assert.rejects(createHttpOtpProvider({ env: {} }).getOtp('0900'), /REFLEX_OTP_URL/);
});
