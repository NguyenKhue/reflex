/**
 * fillVerify.test.js — `fill` reads the field back and retypes slowly when the app scrambled a
 * fast input (seen live on Acme's phone field: keystrokes reordered while it reformats).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSnapshot } = require('../../src/device/deviceBackend');
const { createDeviceSession } = require('../../src/device/deviceTools');
const fixtures = require('../fixtures/device');

const VALUE = '0900000002';

/** One phone field; `onFill(text, opts, count)` decides what the field shows after each fill. */
function fieldDevice(onFill, { password = false } = {}) {
  let shown = '';
  const calls = [];
  const backend = {
    calls,
    async snapshot() {
      return normalizeSnapshot(fixtures.snapshot([
        fixtures.node('f1', shown || 'Nhập SĐT', 200, { type: 'android.widget.EditText', editable: true, hintShowing: !shown, password, identifier: 'input_phone_number' }),
      ], 7, { appBundleId: fixtures.APP }), fixtures.APP);
    },
    async fill(node, text, opts = {}) {
      calls.push({ charDelayMs: opts.charDelayMs });
      shown = onFill(text, opts, calls.length);
      return { ok: true };
    },
  };
  return { backend, session: createDeviceSession({ backend, pollMs: 1, reportDir: '/tmp' }) };
}

test('a value that lands intact is accepted without a retype', async () => {
  const { backend, session } = fieldDevice((text) => text);
  const result = await session.fill({ index: 0, text: VALUE });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(backend.calls, [{ charDelayMs: 0 }]);
});

test('a scrambled value is retyped, and the result never carries the value', async () => {
  const scrambled = '0900000001';
  const { backend, session } = fieldDevice((text, opts, count) => (count > 1 ? text : scrambled));
  const result = await session.fill({ index: 0, text: VALUE });
  assert.equal(result.ok, true);
  assert.equal(result.retyped, 1);
  assert.equal(backend.calls.length, 2);
  assert.ok(!JSON.stringify(result).includes(VALUE));
});

test('a formatted value (spaces) counts as the typed one', async () => {
  const { session } = fieldDevice(() => '090 000 0002');
  assert.deepEqual(await session.fill({ index: 0, text: VALUE }), { ok: true });
});

test('a field that never holds the value fails after the retries, without echoing it', async () => {
  const { backend, session } = fieldDevice(() => '0900000004');
  const result = await session.fill({ index: 0, text: VALUE });
  assert.equal(result.ok, false);
  assert.match(result.error, /does not hold the typed value/);
  assert.ok(!JSON.stringify(result).includes(VALUE));
  assert.equal(backend.calls.length, 3); // first fill + 2 retypes
});

test('a password field is checked by its masked length', async () => {
  const ok = fieldDevice((text) => '•'.repeat(text.length), { password: true });
  assert.deepEqual(await ok.session.fill({ index: 0, text: '000000' }), { ok: true });
  assert.equal(ok.backend.calls.length, 1);

  // Seen live on the example app: keys doubled, 9 dots for a 6-digit password.
  const doubled = fieldDevice((text, opts, count) => '•'.repeat(count === 1 ? 9 : text.length), { password: true });
  const result = await doubled.session.fill({ index: 0, text: '000000' });
  assert.equal(result.ok, true);
  assert.equal(result.retyped, 1);

  const never = fieldDevice(() => '•••••••••', { password: true });
  const failed = await never.session.fill({ index: 0, text: '000000' });
  assert.equal(failed.ok, false, 'a wrong-length password must not be submitted');
});

test('a password field that does not render dots cannot be checked and is accepted', async () => {
  const { session } = fieldDevice(() => '', { password: true });
  assert.deepEqual(await session.fill({ index: 0, text: '000000' }), { ok: true });
});

test('a fill the backend could not perform is a failure, not retyped', async () => {
  const { backend, session } = fieldDevice(() => '');
  backend.fill = async () => { backend.calls.push({}); return { ok: false, error: 'the field could not be emptied before typing' }; };
  assert.deepEqual(await session.fill({ index: 0, text: VALUE }), { ok: false, error: 'the field could not be emptied before typing' });
  assert.equal(backend.calls.length, 1);
});

test('verify: false skips the read-back', async () => {
  const { backend, session } = fieldDevice(() => 'garbage');
  assert.deepEqual(await session.fill({ index: 0, text: VALUE, verify: false }), { ok: true });
  assert.equal(backend.calls.length, 1);
});

test('a field that disappears after typing (a PIN that submits itself) is not retyped', async () => {
  let gone = false;
  const { backend, session } = fieldDevice(() => { gone = true; return '000000'; });
  const snapshot = backend.snapshot;
  backend.snapshot = async () => (gone ? normalizeSnapshot(fixtures.snapshot([fixtures.node('h1', 'Trang chủ', 100)], 7, { appBundleId: fixtures.APP }), fixtures.APP) : snapshot());
  assert.deepEqual(await session.fill({ index: 0, text: '000000' }), { ok: true });
  assert.equal(backend.calls.length, 1);
});

test('charDelayMs paces the first fill and every retype', async () => {
  const seen = [];
  const { backend, session } = fieldDevice((text, opts, count) => {
    seen.push(opts.charDelayMs);
    return count === 1 ? '00900000002' : text;
  });
  const result = await session.fill({ index: 0, text: VALUE, charDelayMs: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.retyped, 1);
  assert.deepEqual(seen, [5, 5]);
});

test('iOS Compose field: no text field in the tree, so fill focuses the placeholder and types', async () => {
  const calls = [];
  const backend = {
    async snapshot() {
      return normalizeSnapshot(fixtures.snapshot([
        fixtures.node('p1', 'Tìm tên, số điện thoại, số tài khoản', 80, { type: 'StaticText' }),
      ], 7, { appBundleId: fixtures.APP }), fixtures.APP);
    },
    async fill() { calls.push('fill'); return { ok: true }; },
    async press(node) { calls.push(`press:${node.text}`); return { ok: true }; },
    async typeText(text, opts) { calls.push(`type:${opts.charDelayMs}`); return { ok: true }; },
  };
  const session = createDeviceSession({ backend, pollMs: 1, reportDir: '/tmp' });
  const result = await session.fill({ label: 'Tìm tên, số điện thoại', text: VALUE, charDelayMs: 400, timeout: 10 });
  assert.deepEqual(result, { ok: true, focused: true });
  assert.deepEqual(calls, ['press:Tìm tên, số điện thoại, số tài khoản', 'type:400']);
  assert.ok(!JSON.stringify(result).includes(VALUE));
});

test('a rotating placeholder is found by any of its phrases', async () => {
  const calls = [];
  const backend = {
    async snapshot() {
      return normalizeSnapshot(fixtures.snapshot([
        fixtures.node('p1', 'Dán mã QR', 80, { type: 'StaticText' }),
      ], 7, { appBundleId: fixtures.APP }), fixtures.APP);
    },
    async fill() { calls.push('fill'); return { ok: true }; },
    async press(node) { calls.push(`press:${node.text}`); return { ok: true }; },
    async typeText() { calls.push('type'); return { ok: true }; },
  };
  const session = createDeviceSession({ backend, pollMs: 1, reportDir: '/tmp' });
  const result = await session.fill({ label: ['Tìm tên, số điện thoại, số tài khoản', 'Dán mã QR'], text: VALUE, timeout: 10 });
  assert.deepEqual(result, { ok: true, focused: true });
  assert.deepEqual(calls, ['press:Dán mã QR', 'type']);

  const missing = await session.fill({ label: ['Nhập số tiền', 'Số tiền'], text: VALUE, timeout: 10 });
  assert.deepEqual(missing, { ok: false, error: 'no editable field labelled "Nhập số tiền" | "Số tiền"' });
});

test('a tap target left of the screen is swiped into view along its row, then pressed', async () => {
  let x = -66;
  const actions = [];
  const backend = {
    async snapshot() {
      return normalizeSnapshot({ nodes: [
        { index: 0, type: 'Application', label: 'Acme UAT', rect: { x: 0, y: 0, width: 402, height: 874 }, ref: 'e1' },
        { index: 1, type: 'StaticText', label: 'Mã thẻ', rect: { x, y: 126, width: 50, height: 24 }, ref: 'e2' },
      ] }, fixtures.APP);
    },
    async press(node) {
      actions.push(`press@${node.rect.x}`);
      if (node.rect.x < 0) throw new Error('Ref @e2 is off-screen and not safe to press');
      return { ok: true };
    },
    async swipe(from, to) { actions.push(`swipe ${from.x}->${to.x} y${from.y}`); x = 60; return { ok: true }; },
  };
  const session = createDeviceSession({ backend, pollMs: 1, reportDir: '/tmp' });
  assert.deepEqual(await session.tap_text({ text: 'Mã thẻ', exact: true, timeout: 10 }), { ok: true, found: true, label: 'Mã thẻ' });
  assert.deepEqual(actions, ['press@-66', 'swipe 101->342 y138', 'press@60']);
});
