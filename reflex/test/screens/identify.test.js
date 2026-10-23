/**
 * identify.test.js — picking the ONE screen a snapshot shows, and refusing to guess.
 * No device: snapshots come from the inline fixtures, knowledge from a tree in a temp dir.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSnapshot } = require('../../src/device/deviceBackend');
const { loadStore } = require('../../src/screens/store');
const { identifyScreen } = require('../../src/screens/identify');
const { writeStore } = require('../fixtures/screenStore');
const fixtures = require('../fixtures/device');

const APP = fixtures.APP;

const TREE = {
  apps: {
    example: {
      groups: {
        core: {
          screens: {
            home: { identify: { allText: ['Acme Example'] } },
            login_phone: { identify: { allText: ['Đăng nhập Acme'] } },
            login_method: { identify: { allText: ['Đăng nhập Acme'], anyText: ['Nhận OTP từ tổng đài Acme'] } },
          },
        },
        mobile_topup: {
          screens: {
            main: { identify: { allText: ['Nạp tiền điện thoại'] } },
          },
        },
      },
    },
  },
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-identify-'));
  writeStore(root, TREE);
  return loadStore(root, 'example');
}

const snap = (...nodes) => normalizeSnapshot(fixtures.snapshot(nodes), APP);

test('one match wins; no match is null, never a guess', () => {
  const store = setup();
  const ids = ['core/home', 'core/login_phone'];
  const home = snap(fixtures.node('a1', 'Acme Example', 100));
  assert.deepEqual(identifyScreen(home, store, ids), { id: 'core/home', ambiguous: [] });
  const stranger = snap(fixtures.node('a1', 'Màn hình lạ', 100));
  assert.deepEqual(identifyScreen(stranger, store, ids), { id: null, ambiguous: [] });
});

test('only the candidate ids are considered', () => {
  const store = setup();
  const home = snap(fixtures.node('a1', 'Acme Example', 100));
  assert.equal(identifyScreen(home, store, ['core/login_phone']).id, null);
  assert.equal(identifyScreen(home, store, ['core/login_phone', 'core/home']).id, 'core/home');
});

test('several matches: the most specific identify wins', () => {
  const store = setup();
  // Both `login_phone` (1 condition) and `login_method` (2 conditions) match this screen.
  const login = snap(fixtures.node('a1', 'Đăng nhập Acme', 100), fixtures.node('a2', 'Nhận OTP từ tổng đài Acme', 200));
  assert.deepEqual(identifyScreen(login, store, ['core/login_method', 'core/login_phone']), { id: 'core/login_method', ambiguous: [] });
  // On the screen without the second text only the plain match is left.
  const plain = snap(fixtures.node('a1', 'Đăng nhập Acme', 100));
  assert.deepEqual(identifyScreen(plain, store, ['core/login_method', 'core/login_phone']), { id: 'core/login_phone', ambiguous: [] });
});

test('a true tie is reported as ambiguous instead of picking either screen', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-identify-'));
  writeStore(root, {
    apps: {
      example: {
        groups: {
          core: {
            screens: {
              home: { identify: { allText: ['Acme Example'] } },
              home_v2: { identify: { anyText: ['Acme Example'] } },
            },
          },
        },
      },
    },
  });
  const store = loadStore(root, 'example');
  const ambiguous = identifyScreen(snap(fixtures.node('a1', 'Acme Example', 100)), store, ['core/home', 'core/home_v2']);
  assert.equal(ambiguous.id, null);
  assert.deepEqual(ambiguous.ambiguous, ['core/home', 'core/home_v2']);
});
