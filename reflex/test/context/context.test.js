/**
 * context.test.js — the Kotlin/Compose extractor and the source-hint build it feeds
 * (`screens/<app>/_app/source/`), on trimmed copies of the example app's real login sources.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractKotlin, literalText } = require('../../src/context/extractKotlin');
const { buildContext, MANUAL_START, MANUAL_END } = require('../../src/context/build');

const SRC = path.join(__dirname, '..', 'fixtures', 'kotlin');

test('the extractor finds the login texts, including enum labels and template prefixes', () => {
  const result = extractKotlin({ src: SRC });
  const all = new Set([...result.screens.flatMap((screen) => screen.texts), ...result.shared]);
  for (const text of ['Đăng nhập', 'Đăng nhập Acme', 'Tiếp tục', 'Xác nhận', 'Đăng nhập thành công', 'Nhập mật khẩu', 'Nhập mã xác thực', 'Chưa nhận được mã?']) {
    assert.ok(all.has(text), `missing "${text}"`);
  }
  const phone = result.screens.find((screen) => /Popup$/.test(screen.id) && screen.texts.includes('Đăng nhập Acme'));
  assert.ok(phone, 'a *Popup screen shows "Đăng nhập Acme"');
  assert.ok(result.enums.some((item) => item.enum === 'LoginAction' && item.entry === 'CHECK_PHONE' && item.label === 'Tiếp tục'));
  for (const text of all) {
    assert.ok(!/[$%\n]/.test(text) && text.length <= 60, `noise kept: ${JSON.stringify(text)}`);
  }
  assert.ok(!result.screens.some((screen) => /(Theme|Components)$/.test(screen.id)));
});

test('state-driven navigation becomes screen transitions', () => {
  const result = extractKotlin({ src: SRC });
  const section = result.screens.find((screen) => screen.id === 'SessionSection');
  assert.ok(section.actions.some((action) => action.label === 'Đăng nhập' && action.to === 'PhonePopup'));
});

test('literalText keeps UI copy and drops noise', () => {
  assert.equal(literalText('Chưa nhận được mã? ${LoginAction.RESEND_OTP.label}'), 'Chưa nhận được mã?');
  assert.equal(literalText('Bước ${step}'), null);
  assert.equal(literalText('%d items'), null);
  assert.equal(literalText('auth_state'), null);
  assert.equal(literalText('▶ Run all'), '▶ Run all');
  assert.equal(literalText('x'), null);
});

test('build writes the hints into the app tier and keeps the manual block across rebuilds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-ctx-'));
  const first = buildContext({ app: 'example', src: SRC, root, now: () => new Date('2026-09-24T00:00:00Z') });
  const md = path.join(first.outDir, 'source-hints.md');
  assert.equal(first.outDir, path.join(root, 'screens', 'example', '_app', 'source'));
  assert.ok(fs.existsSync(path.join(first.outDir, 'glossary.json')));
  assert.match(fs.readFileSync(md, 'utf8'), /## Screens \(\d+\)/);
  const manual = '\n## Source notes\n- The OTP comes from the UAT API, never invented.\n';
  const edited = fs.readFileSync(md, 'utf8').replace(/<!-- manual:start -->[\s\S]*<!-- manual:end -->/, `${MANUAL_START}${manual}${MANUAL_END}`);
  fs.writeFileSync(md, edited);
  buildContext({ app: 'example', src: SRC, root });
  assert.ok(fs.readFileSync(md, 'utf8').includes(`${MANUAL_START}${manual}${MANUAL_END}`));
  assert.deepEqual(fs.readdirSync(first.outDir).sort(), ['glossary.json', 'source-hints.md']);
  assert.throws(() => buildContext({ app: 'Bad App', src: SRC, root }), /invalid app key/);
  assert.throws(() => buildContext({ app: 'x', src: path.join(root, 'none'), root }), /is not a directory/);
});
