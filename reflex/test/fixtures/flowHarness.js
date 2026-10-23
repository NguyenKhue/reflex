/**
 * flowHarness.js — a small leg-loop harness for the popup-vs-error corpus.
 *
 * It mirrors `setup()` in test/runner/flow.test.js (kept there as private helpers) so the corpus can add its own
 * screens and rules without touching that file. Tech debt: when flow.test.js is next refactored, make both share one
 * harness.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runLegs } = require('../../src/runner/flow');
const { loadStore } = require('../../src/screens/store');
const { createLearner } = require('../../src/screens/learn');
const { createDeviceSession } = require('../../src/device/deviceTools');
const { createScreenDevice } = require('./screens');
const { writeStore } = require('./screenStore');

const SCREENS = {
  home: ['Acme Example', 'Đăng nhập'],
  login_phone: ['Đăng nhập Acme', { label: 'Số điện thoại', editable: true, identifier: 'phone_input' }, { label: 'Tiếp tục', identifier: 'btn_continue' }],
  // A harmless promotion drawn over Home: Home is still the identified screen while it is up.
  home_promo: ['Acme Example', 'Đăng nhập', 'Khuyến mãi mới dành cho bạn', 'Đóng'],
  // A real failure drawn over Home, with the same kind of "Đóng" button as the promo.
  home_alert: ['Acme Example', 'Đăng nhập', 'Lỗi hệ thống, vui lòng thử lại sau', 'Đóng'],
};

const MOVES = {
  home: { 'Đăng nhập': 'login_phone' },
  home_promo: { Đóng: 'home', 'Đăng nhập': 'login_phone' },
  home_alert: { Đóng: 'home', 'Đăng nhập': 'login_phone' },
};

/** The knowledge tree: Home and the login phone screen, the policy tier, and app-level rules the test chooses. */
function treeOf({ appRules = [], homeRules = [] } = {}) {
  return {
    shared: { exceptions: [] },
    apps: {
      example: {
        app: { context: 'Corpus app notes.', exceptions: appRules, routes: [] },
        groups: {
          core: {
            miniapp: { exceptions: [] },
            screens: {
              home: { identify: { allText: ['Acme Example', 'Đăng nhập'] }, body: 'Home of the example app, signed out.', normal: [], exceptions: homeRules },
              login_phone: { identify: { allText: ['Đăng nhập Acme'] }, inputs: [], body: 'Phone number entry.', normal: [], exceptions: [] },
            },
          },
        },
      },
    },
  };
}

/**
 * `setup({ start, jev, appRules, homeRules, learn, threshold })` → `{ root, backend, learner, run(legs) }`.
 * With `learn: false` the learner is a recording stub; with `learn: true` it is the real one (its `ops()` say what
 * would be written, `flush` from src/screens/writer writes it).
 */
function setup({ start = 'home', jev = null, appRules = [], homeRules = [], learn = false, threshold = 0.75, moves = MOVES } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-corpus-'));
  writeStore(root, treeOf({ appRules, homeRules }));
  const store = loadStore(root, 'example');
  const backend = createScreenDevice({ screens: SCREENS, moves, start });
  const session = createDeviceSession({ backend, jev, reportDir: root, pollMs: 1 });
  const plan = {
    name: 'corpus',
    goal: 'Reach the login phone screen from Home',
    inputs: [],
    options: { legTimeoutMs: 4000, maxJevCallsPerLeg: 6, caseWaitMs: 30, stepTimeoutMs: 2000, unknownGraceMs: 10 },
  };
  const learner = learn
    ? createLearner({ store, runId: 'corpus_run', data: {}, plan, inputNames: [], now: () => Date.parse('2026-10-05T10:00:00Z') })
    : null;
  const ctx = {
    backend,
    session,
    recipeSession: session,
    jev,
    store,
    plan,
    data: {},
    inputs: [],
    threshold,
    budget: { jevCalls: 0, maxJevCalls: 30 },
    learner,
  };
  return { root, store, backend, learner, run: (legs) => runLegs(ctx, legs) };
}

module.exports = { setup, SCREENS, MOVES };
