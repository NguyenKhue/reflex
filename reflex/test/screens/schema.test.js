/**
 * schema.test.js — one valid and one broken example per rule of the knowledge files.
 * The message matters as much as the rejection: it is what the agent reads to fix the file.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateIdentify, validateCase, validateException, validateRoutes } = require('../../src/screens/schema');

const WHERE = '/w/screens/example/core/home/normal.yml: case 1';
const TAP = { tool: 'tap_text', args: { text: 'Đăng nhập', exact: true } };

test('identify: a mapping with at least one non-empty text list', () => {
  assert.deepEqual(validateIdentify({ allText: ['Mua mã thẻ'], anyId: ['card_code_tab'] }, 'f'),
    { allText: ['Mua mã thẻ'], anyId: ['card_code_tab'] });
  assert.throws(() => validateIdentify({}, 'screen.md: identify'), /screen\.md: identify: at least one of/);
  assert.throws(() => validateIdentify({ allText: [] }, 'f'), /"allText" must be a non-empty list/);
  assert.throws(() => validateIdentify({ anyText: [1] }, 'f'), /"anyText" must be a non-empty list/);
  assert.throws(() => validateIdentify({ allText: ['x'], text: ['y'] }, 'f'), /unknown key "text"/);
  assert.throws(() => validateIdentify(['x'], 'f'), /expected a mapping/);
});

test('case: valid one is normalized, broken ones name the file and the item', () => {
  const valid = validateCase({ to: 'mobile_topup/confirm', intent: 'Pick the denomination', steps: [TAP] }, WHERE);
  assert.equal(valid.status, 'draft');
  assert.deepEqual(valid.steps, [TAP]);
  assert.equal(valid.pinned, undefined);

  const pinned = validateCase({ to: 'a/b', intent: 'i', steps: [TAP], status: 'verified', pinned: true, confidence: 0.9, learnedFrom: 'run1', stats: { streak: 3 } }, WHERE);
  assert.deepEqual([pinned.status, pinned.pinned, pinned.confidence, pinned.learnedFrom], ['verified', true, 0.9, 'run1']);

  assert.throws(() => validateCase({ to: 'home', intent: 'i', steps: [TAP] }, WHERE), /normal\.yml: case 1: "to" must be a screen id/);
  assert.throws(() => validateCase({ to: 'a/b', steps: [TAP] }, WHERE), /"intent" must be a string of 1–200/);
  assert.throws(() => validateCase({ to: 'a/b', intent: 'i', steps: [] }, WHERE), /"steps" must be a non-empty list/);
  assert.throws(() => validateCase({ to: 'a/b', intent: 'i', steps: [{ tool: 'nope' }] }, WHERE), /normal\.yml: case 1: unsupported tool "nope"/);
  assert.throws(() => validateCase({ to: 'a/b', intent: 'i', steps: [TAP], status: 'maybe' }, WHERE), /"status" must be one of draft \/ learned \/ verified/);
  assert.throws(() => validateCase({ to: 'a/b', intent: 'i', steps: [TAP], pinned: 'yes' }, WHERE), /"pinned" must be true or false/);
});

test('exception: exactly one action, and retry carries its own budget', () => {
  const tap = validateException({ id: 'fingerprint_unlock_offer', when: { allText: ['Mở khoá bằng vân tay'] }, do: { tap: 'ĐỂ SAU' } }, 'f: rule "x"');
  assert.deepEqual(tap.do, { tap: 'ĐỂ SAU' });
  assert.equal(tap.status, 'draft');

  const retry = validateException({ id: 'network_blip', when: { anyText: ['Lỗi kết nối'] }, do: { retry: { wait: 2000 } } }, 'f: rule "x"');
  assert.deepEqual(retry.do, { retry: { wait: 2000, max: 2 } });
  assert.equal(validateException({ id: 'n', when: { anyText: ['x'] }, do: { retry: { wait: 0, max: 3 } } }, 'w').do.retry.max, 3);

  assert.throws(() => validateException({ id: 'Bad-Id', when: { anyText: ['x'] }, do: { back: true } }, 'w'), /"id" must match/);
  assert.throws(() => validateException({ id: 'a', when: { anyText: ['x'] }, do: { tap: 'x', back: true } }, 'w'), /"do" needs exactly one of tap \/ back \/ retry \/ fail \/ blocked/);
  assert.throws(() => validateException({ id: 'a', when: { anyText: ['x'] }, do: { back: 'yes' } }, 'w'), /"do.back" must be true/);
  assert.throws(() => validateException({ id: 'a', when: { anyText: ['x'] }, do: { fail: '' } }, 'w'), /"do.fail" must be a reason/);
  assert.throws(() => validateException({ id: 'a', when: { anyText: ['x'] }, do: { retry: { wait: 99999 } } }, 'w'), /"do.retry.wait" must be a number of milliseconds between 0 and 10000/);
  assert.throws(() => validateException({ id: 'a', when: { anyText: ['x'] }, do: { retry: { wait: 1, max: 4 } } }, 'w'), /"do.retry.max" must be an integer between 1 and 3/);
  // The eKYC policy rule of `_shared` is pinned and never touched by the runner.
  assert.equal(validateException({ id: 'ekyc_face_verification', when: { anyText: ['Quét khuôn mặt'] }, do: { fail: 'policy' }, pinned: true }, 'w').pinned, true);
});

test('routes: a path of at least two screens', () => {
  assert.deepEqual(validateRoutes([{ path: ['core/home', 'mobile_topup/main'] }], 'routes.yml'), [{ path: ['core/home', 'mobile_topup/main'] }]);
  assert.deepEqual(validateRoutes(undefined, 'routes.yml'), []);
  assert.throws(() => validateRoutes({ path: [] }, 'routes.yml'), /routes\.yml route 1: a route must be a mapping|routes\.yml: expected a list of routes/);
  assert.throws(() => validateRoutes([{ path: ['core/home'] }], 'routes.yml'), /routes\.yml route 1: "path" must be a list of at least 2 screen ids/);
  assert.throws(() => validateRoutes([{ path: ['core/home', 'nope'] }], 'routes.yml'), /routes\.yml route 1: "path\[1\]" must be a screen id/);
});
