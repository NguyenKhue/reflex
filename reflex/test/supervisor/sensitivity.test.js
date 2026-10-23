/**
 * sensitivity.test.js — which legs of a plan the agent is not allowed to run, and the two edits that make
 * the tool able to say so (the loader's `sensitive` key, `plan validate` reporting it).
 *
 * Plans and stores are hand-made here: the analysis only needs `plan.flow`, `plan.inputs` and the
 * screens/routes graph, so a test states its graph instead of loading a knowledge base.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const workspace = require('../../src/util/workspace');
const { loadPlan } = require('../../src/plan/loader');
const { legSensitivity, planSensitivity, sensitiveLegsFrom } = require('../../src/supervisor/sensitivity');
const { planValidate } = require('../../src/cli/planCommands');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'workspace');

/** A store shaped like the one `loadStore` builds: a screens Map plus the observed multi-hop routes. */
function storeOf({ screens = {}, routes = [] } = {}) {
  const map = new Map();
  for (const [id, screen] of Object.entries(screens)) map.set(id, { id, inputs: [], normal: [], ...screen });
  return { screens: map, routes };
}

/** A minimal plan: only `flow` and `inputs` matter here. */
function planOf({ flow = [], inputs = [] } = {}) {
  return { name: 'p', app: 'app1', inputs, flow };
}

/** Write a plan to a temp file and load it (for the loader's `sensitive` key). */
function tempPlan(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-sens-'));
  const file = path.join(dir, 'x.plan.md');
  fs.writeFileSync(file, body);
  return () => loadPlan(file, { root: FIXTURE });
}

const LOGIN = storeOf({
  screens: {
    'core/login_phone': { normal: [{ to: 'core/login_password' }] },
    'core/login_password': { inputs: ['password'], normal: [{ to: 'core/home' }] },
    'core/home': {},
    'core/settings': { normal: [{ to: 'core/home' }] },
  },
});

// ── the known path ───────────────────────────────────────────────────────────────────

test('a leg whose known path crosses a screen with a secret input is sensitive', () => {
  const plan = planOf({ inputs: [{ name: 'phone' }], flow: [{ at: 'core/login_phone', to: 'core/home' }] });
  assert.deepEqual(legSensitivity(plan, LOGIN, 0), {
    index: 0, at: 'core/login_phone', to: 'core/home', sensitive: true, reasons: ['screen-input:core/login_password'],
  });
  const other = planOf({ inputs: [{ name: 'phone' }], flow: [{ at: 'core/home', to: 'core/settings' }] });
  const result = legSensitivity(other, LOGIN, 0);
  assert.equal(result.sensitive, false);
  assert.deepEqual(result.reasons, []);
});

test('the screen a leg ARRIVES at does not make the leg sensitive, only the next one', () => {
  const plan = planOf({ inputs: [{ name: 'phone' }], flow: [{ at: 'core/login_phone', to: 'core/login_password' }] });
  assert.deepEqual(legSensitivity(plan, LOGIN, 0).reasons, []);
  const onwards = planOf({ inputs: [{ name: 'phone' }], flow: [{ at: 'core/login_password', to: 'core/home' }] });
  assert.deepEqual(legSensitivity(onwards, LOGIN, 0).reasons, ['screen-name', 'screen-input:core/login_password']);
});

test('own-steps: a leg typing a secret placeholder is sensitive, a plain placeholder is not', () => {
  const fill = (text) => [{ tool: 'fill', args: { index: 0, text } }];
  const plan = (steps, checks, inputs = [{ name: 'phone' }]) => planOf({ inputs, flow: [{ at: 'core/home', to: 'core/settings', steps, checks }] });
  // `pin` is secret whatever the plan declares.
  assert.deepEqual(legSensitivity(plan(fill('{pin}')), LOGIN, 0).reasons, ['own-steps']);
  assert.equal(legSensitivity(plan(fill('{phone}')), LOGIN, 0).sensitive, false);
  // An input declared secret counts under its own name, not just the three well-known ones.
  const token = [{ name: 'token', secret: true }];
  // (no store: an unknown route would otherwise add `unknown-route` for a plan that declares a secret input)
  assert.deepEqual(legSensitivity(plan(fill('{token}'), null, token), null, 0).reasons, ['own-steps']);
  // A check may type it too.
  assert.deepEqual(legSensitivity(plan(null, [{ tool: 'fill', args: { text: '{password}' } }]), LOGIN, 0).reasons, ['own-steps']);
});

test('case-step: a case on the path that types a secret makes the leg sensitive even without inputs', () => {
  const store = storeOf({
    screens: {
      'core/a': { normal: [{ to: 'core/b', steps: [{ tool: 'fill', args: { index: 0, text: '{password}' } }] }] },
      'core/b': { normal: [{ to: 'core/c' }] },
      'core/c': {},
    },
  });
  const plan = planOf({ flow: [{ at: 'core/a', to: 'core/c' }] });
  assert.deepEqual(legSensitivity(plan, store, 0).reasons, ['case-step:core/a']);
});

test('unknown-route: an unknown path counts only when the plan declares a secret input', () => {
  const store = storeOf({ screens: { 'core/home': {} } });
  const leg = { at: 'core/home', to: 'core/ghost' };
  const withSecret = planOf({ inputs: [{ name: 'password', secret: true }], flow: [leg] });
  assert.deepEqual(legSensitivity(withSecret, store, 0).reasons, ['unknown-route']);
  const withoutSecret = planOf({ inputs: [{ name: 'phone' }, { name: 'telco' }], flow: [leg] });
  assert.equal(legSensitivity(withoutSecret, store, 0).sensitive, false);
});

// ── the leg itself ───────────────────────────────────────────────────────────────────

test('explicit: `sensitive: true` wins whatever the knowledge says, and a null store still answers', () => {
  const clean = planOf({ inputs: [{ name: 'phone' }], flow: [{ at: 'core/home', to: 'core/settings', sensitive: true }] });
  assert.deepEqual(legSensitivity(clean, LOGIN, 0).reasons, ['explicit']);
  assert.deepEqual(legSensitivity(clean, null, 0).reasons, ['explicit']);
  const typed = planOf({ flow: [{ at: 'core/home', to: 'core/settings', steps: [{ tool: 'fill', args: { text: '{otp}' } }] }] });
  assert.deepEqual(legSensitivity(typed, null, 0).reasons, ['own-steps']);
  // Nothing to walk without a store, so the plan-level reasons are the whole answer.
  assert.deepEqual(planSensitivity(typed, null), {
    sensitive: true,
    legs: [{ index: 0, at: 'core/home', to: 'core/settings', sensitive: true, reasons: ['own-steps'] }],
  });
});

test('screen-name: only a whole word like pin/password/otp/passcode counts', () => {
  const named = (at) => planOf({ inputs: [{ name: 'phone' }], flow: [{ at, to: 'core/settings' }] });
  assert.deepEqual(legSensitivity(named('core/payment_pin'), LOGIN, 0).reasons, ['screen-name']);
  assert.deepEqual(legSensitivity(named('x/login_otp'), LOGIN, 0).reasons, ['screen-name']);
  // `pinned_items`, `shipping_address` and plain names contain those letters without being one.
  for (const at of ['core/pinned_items', 'core/shipping_address', 'core/home']) {
    assert.equal(legSensitivity(named(at), LOGIN, 0).reasons.includes('screen-name'), false, at);
  }
});

test('an observed route is a known edge even without a case for it', () => {
  const store = storeOf({
    screens: { 'core/a': {}, 'core/b': { inputs: ['password'] }, 'core/c': {} },
    routes: [['core/a', 'core/b', 'core/c']],
  });
  const plan = planOf({ inputs: [{ name: 'phone' }], flow: [{ at: 'core/a', to: 'core/c' }] });
  assert.deepEqual(legSensitivity(plan, store, 0).reasons, ['screen-input:core/b']);
});

// ── whole plans ──────────────────────────────────────────────────────────────────────

test('planSensitivity lists only the sensitive legs; sensitiveLegsFrom keeps their indexes', () => {
  const plan = planOf({
    inputs: [{ name: 'phone' }],
    flow: [
      { at: 'core/home', to: 'core/settings', sensitive: true },
      { at: 'core/settings', to: 'core/home' },
      { at: 'core/login_phone', to: 'core/home' },
      { at: 'core/login_password', to: 'core/home' },
    ],
  });
  const whole = planSensitivity(plan, LOGIN);
  assert.equal(whole.sensitive, true);
  assert.deepEqual(whole.legs.map((leg) => leg.index), [0, 2, 3]);
  assert.deepEqual(sensitiveLegsFrom(plan, LOGIN, 2).map((leg) => leg.index), [2, 3]);
  const quiet = planOf({ inputs: [{ name: 'phone' }], flow: [{ at: 'core/home', to: 'core/settings' }] });
  assert.deepEqual(planSensitivity(quiet, LOGIN), { sensitive: false, legs: [] });
});

// ── the two edits ────────────────────────────────────────────────────────────────────

test('the loader takes `sensitive` as a boolean and keeps it off a leg that omits it', () => {
  const yes = tempPlan('---\nname: x\nflow:\n  - { at: core/home, to: core/cart, sensitive: true }\n---\n');
  assert.equal(yes().flow[0].sensitive, true);
  const no = tempPlan('---\nname: x\nflow:\n  - { at: core/home, to: core/cart, sensitive: false }\n---\n');
  assert.equal(no().flow[0].sensitive, false);
  const absent = tempPlan('---\nname: x\nflow:\n  - { at: core/home, to: core/cart }\n---\n');
  assert.equal('sensitive' in absent().flow[0], false);
  const bad = tempPlan('---\nname: x\nflow:\n  - at: core/home\n    to: core/cart\n    sensitive: "yes"\n---\n');
  assert.throws(bad, /flow leg 1: "sensitive" must be true or false/);
});

test('plan validate reports the sensitive legs of a real plan file', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-sens-')));
  fs.cpSync(FIXTURE, root, { recursive: true });
  try {
    workspace.setOverride(root);
    // The fixture leg only ARRIVES at the password screen (nothing is typed there yet), so it is not sensitive.
    const plain = planValidate({ plan: 'plans/example/login.plan.md' });
    assert.equal(plain.plan, 'example_login_basic');
    assert.deepEqual(plain.sensitive, { sensitive: false, legs: [] });

    // The same plan with the leg marked `sensitive: true` is reported, with the reason.
    const source = fs.readFileSync(path.join(root, 'plans', 'example', 'login.plan.md'), 'utf8');
    const marked = source
      .replace('name: example_login_basic', 'name: example_login_marked')
      .replace('flow:\n  - { at: core/home,', 'flow:\n  - { sensitive: true, at: core/home,');
    assert.notEqual(marked, source);
    fs.writeFileSync(path.join(root, 'plans', 'example', 'marked.plan.md'), marked);
    const result = planValidate({ plan: 'plans/example/marked.plan.md' });
    assert.equal(result.sensitive.sensitive, true);
    assert.deepEqual(result.sensitive.legs.map((leg) => [leg.index, leg.reasons]), [[0, ['explicit']]]);
  } finally {
    workspace.reset();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
