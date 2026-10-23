/**
 * store.test.js — loading `screens/<app>/` and the two lookups a leg needs.
 *
 * The tree is built inline (test/fixtures/screenStore.writeStore) rather than kept as a static
 * directory: a case can then say exactly which tier, status and streak it is testing.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadStore, exceptionTiers, candidateScreens, casesFor } = require('../../src/screens/store');
const { writeStore } = require('../fixtures/screenStore');

const tap = (text, extra = {}) => ({ tool: 'tap_text', args: { text, exact: true, ...extra } });
const fill = (text) => ({ tool: 'fill', args: { index: 0, text } });

const TREE = {
  shared: {
    exceptions: [
      { id: 'ekyc_face_verification', when: { anyText: ['Xác thực khuôn mặt', 'Quét CCCD'] }, do: { fail: 'identity/face/eKYC verification shown — never automated (policy)' }, pinned: true },
    ],
  },
  apps: {
    example: {
      app: {
        context: 'Example app: package com.acme.example.',
        exceptions: [{ id: 'app_error', when: { allText: ['Bạn ơi, Acme gặp chút lỗi'] }, do: { tap: 'Đã hiểu' } }],
        routes: [['core/home', 'core/login_phone', 'core/signed_in']],
      },
      groups: {
        core: {
          miniapp: { exceptions: [{ id: 'core_hint', when: { anyText: ['Gợi ý'] }, do: { back: true } }] },
          screens: {
            home: {
              identify: { allText: ['Acme Example'] },
              body: 'Home of the example app.',
              normal: [
                { to: 'mobile_topup/main', intent: 'Open the topup mini app', steps: [tap('Nạp tiền')], status: 'draft' },
                { to: 'mobile_topup/card_code', intent: 'Open the card-code screen', steps: [tap('Mua mã thẻ')], status: 'draft' },
                { to: 'core/login_phone', intent: 'Open login', steps: [tap('Đăng nhập')], status: 'verified', stats: { streak: 2, ok: 2 } },
                { to: 'core/login_phone', intent: 'Open login through the other tab', steps: [tap('Đăng nhập', { index: 1 })], status: 'verified', stats: { streak: 9, ok: 9 } },
                { to: 'core/login_phone', intent: 'Open login (learned)', steps: [tap('Đăng nhập ngay')], status: 'learned' },
                { to: 'core/login_phone', intent: 'Open login (draft guess)', steps: [tap('Đăng nhập (mới)')] },
              ],
              exceptions: [{ id: 'home_popup', when: { allText: ['Xác thực khuôn mặt'] }, do: { tap: 'Ở lại' } }],
            },
            login_phone: {
              identify: { allText: ['Đăng nhập Acme'] },
              inputs: ['phone'],
              normal: [{ to: 'core/signed_in', intent: 'Submit the phone number', steps: [fill('{phone}')] }],
            },
            signed_in: { identify: { allText: ['authState: LOGGED'] } },
            no_files: { identify: { anyId: ['no_files'] } },
          },
        },
        mobile_topup: {
          miniapp: { context: 'Mini app: buy topup and card codes.', exceptions: [{ id: 'miniapp_oos', when: { anyText: ['Tạm hết'] }, do: { blocked: 'out of stock' } }] },
          screens: {
            main: { identify: { allText: ['Nạp tiền điện thoại'] } },
            card_code: { identify: { allText: ['Mua mã thẻ'] } },
          },
        },
      },
    },
  },
};

function setup(tree = TREE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-store-'));
  writeStore(root, tree);
  return { root, store: loadStore(root, 'example') };
}

test('the tree loads screens, groups, the app tier, the shared tier and routes', () => {
  const { root, store } = setup();
  assert.equal(store.app, 'example');
  assert.deepEqual([...store.screens.keys()], ['core/home', 'core/login_phone', 'core/no_files', 'core/signed_in', 'mobile_topup/card_code', 'mobile_topup/main']);
  assert.equal(store.screens.get('core/home').group, 'core');
  assert.equal(store.screens.get('core/home').body, 'Home of the example app.');
  assert.deepEqual(store.screens.get('core/login_phone').inputs, ['phone']);
  assert.equal(store.appTier.context.trim(), 'Example app: package com.acme.example.');
  assert.equal(store.groups.get('mobile_topup').context.trim(), 'Mini app: buy topup and card codes.');
  assert.equal(store.groups.get('core').context, null, 'a group without _miniapp has no context');
  assert.deepEqual(store.routes, [['core/home', 'core/login_phone', 'core/signed_in']]);
  assert.deepEqual(store.shared.map((rule) => rule.id), ['ekyc_face_verification']);
  assert.ok(store.screens.get('core/home').normal.every((item) => path.isAbsolute(item.file)));
  assert.ok(store.screens.get('core/home').normal[0].file.endsWith(path.join('core', 'home', 'normal.yml')));
  assert.equal(store.screens.get('core/home').normal[0].key, `mobile_topup/main|${JSON.stringify([tap('Nạp tiền')])}`);
  assert.equal(store.appTier.exceptions[0].key, 'app_error');
  assert.equal(root, path.dirname(store.root));
});

test('a missing optional file is empty, not an error', () => {
  const { store } = setup();
  const bare = store.screens.get('core/no_files');
  assert.deepEqual(bare.normal, []);
  assert.deepEqual(bare.exceptions, []);
  assert.equal(bare.body, '');
  assert.deepEqual(store.groups.get('core').exceptions.map((rule) => rule.id), ['core_hint']);
});

test('exception tiers stop in the documented order, the shared policy always first', () => {
  const { store } = setup();
  assert.deepEqual(exceptionTiers(store, 'core/home', 'core').map((rule) => rule.id),
    ['ekyc_face_verification', 'home_popup', 'core_hint', 'app_error']);
  // A screen rule that looks for the same eKYC text still loses: the shared rule is earlier.
  const home = store.screens.get('core/home').exceptions[0];
  assert.deepEqual(home.when.allText, ['Xác thực khuôn mặt']);
  // Nothing identified: the leg's own group provides the mini-app tier.
  assert.deepEqual(exceptionTiers(store, null, 'mobile_topup').map((rule) => rule.id),
    ['ekyc_face_verification', 'miniapp_oos', 'app_error']);
  // Identified in another group: the SCREEN's group wins over the leg's group.
  assert.deepEqual(exceptionTiers(store, 'mobile_topup/card_code', 'core').map((rule) => rule.id),
    ['ekyc_face_verification', 'miniapp_oos', 'app_error']);
  // An unknown screen id is treated as "not identified".
  assert.deepEqual(exceptionTiers(store, 'core/ghost', 'core').map((rule) => rule.id),
    ['ekyc_face_verification', 'core_hint', 'app_error']);
});

test('candidateScreens: both ends, their groups, and every core screen', () => {
  const { store } = setup();
  assert.deepEqual(candidateScreens(store, { at: 'core/home', to: 'mobile_topup/main' }),
    ['core/home', 'mobile_topup/main', 'core/login_phone', 'core/no_files', 'core/signed_in', 'mobile_topup/card_code']);
  assert.deepEqual(candidateScreens(store, { at: 'mobile_topup/main', to: 'mobile_topup/card_code' }),
    ['mobile_topup/main', 'mobile_topup/card_code', 'core/home', 'core/login_phone', 'core/no_files', 'core/signed_in']);
});

test('casesFor (a): the direct hop first, verified before learned before draft, then streak', () => {
  const { store } = setup();
  const cases = casesFor(store, 'core/home', 'core/login_phone');
  assert.deepEqual(cases.map((item) => item.intent), [
    'Open login through the other tab', // verified, streak 9
    'Open login',                       // verified, streak 2
    'Open login (learned)',             // learned
    'Open login (draft guess)',         // draft
  ]);
});

test('the machine-local ledger overrides a streak still written in the file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-store-'));
  writeStore(root, TREE);
  const key = `core/login_phone|${JSON.stringify([tap('Đăng nhập')])}`;
  fs.mkdirSync(path.join(root, '.agentic'));
  fs.writeFileSync(path.join(root, '.agentic', 'stats.json'), JSON.stringify({
    [`screens/example/core/home/normal.yml#${key}`]: { ok: 20, streak: 20 },
  }));
  const store = loadStore(root, 'example');
  const cases = casesFor(store, 'core/home', 'core/login_phone');
  assert.deepEqual(cases.slice(0, 2).map((item) => [item.intent, item.stats.streak]), [
    ['Open login', 20],
    ['Open login through the other tab', 9],
  ]);
});

test('casesFor (b): the next screen on a recorded route that ends at the leg destination', () => {
  const { store } = setup();
  const candidates = new Set(candidateScreens(store, { at: 'core/home', to: 'core/signed_in' }));
  const cases = casesFor(store, 'core/home', 'core/signed_in', { candidates });
  // No direct case to `core/signed_in` exists, so the route's next screen (login_phone) comes
  // first. `mobile_topup/*` is NOT a candidate here: both ends of the leg are in `core`.
  assert.deepEqual(cases.map((item) => item.intent), [
    'Open login through the other tab',
    'Open login',
    'Open login (learned)',
    'Open login (draft guess)',
  ]);
});

test('casesFor (c): only hops that can still reach the destination are explored, never a visited screen', () => {
  const { store } = setup();
  const candidates = new Set(candidateScreens(store, { at: 'core/home', to: 'mobile_topup/main' }));
  // In this knowledge nothing but the direct case leads to the destination: no wandering to the login screens.
  const all = casesFor(store, 'core/home', 'mobile_topup/main', { candidates });
  assert.deepEqual(all.map((item) => item.to), ['mobile_topup/main']);
  assert.deepEqual(casesFor(store, 'core/ghost', 'core/home'), []);

  // A hop through an intermediate screen that does lead on is explored, unless it was already visited.
  const hop = (to) => ({ key: `k-${to}`, to, steps: [], status: 'verified', streak: 0 });
  const fake = {
    routes: [],
    screens: new Map([
      ['a/start', { normal: [hop('a/mid'), hop('a/dead')] }],
      ['a/mid', { normal: [hop('a/end')] }],
      ['a/dead', { normal: [] }],
      ['a/end', { normal: [] }],
    ]),
  };
  const cands = new Set(['a/mid', 'a/dead', 'a/end']);
  assert.deepEqual(casesFor(fake, 'a/start', 'a/end', { candidates: cands }).map((item) => item.to), ['a/mid']);
  assert.deepEqual(casesFor(fake, 'a/start', 'a/end', { candidates: cands, visited: new Set(['a/mid']) }), []);
});

test('broken files throw with their path', () => {
  const badId = JSON.parse(JSON.stringify(TREE));
  badId.apps.example.groups.core.screens.home.id = 'core/home_screen';
  assert.throws(() => setup(badId), /core[/\\]home[/\\]screen\.md: "id" must be "core\/home"/);

  const noIdentify = JSON.parse(JSON.stringify(TREE));
  delete noIdentify.apps.example.groups.core.screens.home.identify;
  assert.throws(() => setup(noIdentify), /screen\.md: identify/);

  const duplicateRule = JSON.parse(JSON.stringify(TREE));
  duplicateRule.apps.example.groups.core.screens.home.exceptions.push({ id: 'home_popup', when: { anyText: ['X'] }, do: { back: true } });
  assert.throws(() => setup(duplicateRule), /exceptions\.yml: rule "home_popup": duplicate id/);

  const duplicateCase = JSON.parse(JSON.stringify(TREE));
  duplicateCase.apps.example.groups.core.screens.home.normal.push({ to: 'core/login_phone', intent: 'same steps as the first', steps: [tap('Đăng nhập')], status: 'verified' });
  assert.throws(() => setup(duplicateCase), /normal\.yml: case 7: duplicate case/);

  const { root } = setup();
  assert.throws(() => loadStore(root, 'ghost'), /no screens directory for app "ghost"/);
  fs.writeFileSync(path.join(root, 'screens', 'example', 'core', 'home', 'normal.yml'), 'key: [unclosed\n');
  assert.throws(() => loadStore(root, 'example'), /normal\.yml: invalid YAML/);
});
