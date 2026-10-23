/**
 * plan.test.js — loading, validating and resolving data of `*.plan.md` against the fixture
 * workspace. A plan is a chain of screen legs, so the loader/validator only deal with `flow`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadPlan, DEFAULT_OPTIONS } = require('../../src/plan/loader');
const { validatePlan } = require('../../src/plan/validate');
const { loadStore } = require('../../src/screens/store');
const { resolveRowData, secretKeys } = require('../../src/plan/data');

const ROOT = path.join(__dirname, '..', 'fixtures', 'workspace');
const plan = (name) => loadPlan(path.join(ROOT, 'plans', 'example', name), { root: ROOT });
const store = loadStore(ROOT, 'example');

function fakeWorkspace({ account = {} } = {}) {
  return { manifest: () => ({}), defaults: () => ({ account }) };
}

/** A minimal, valid plan object — tests override exactly the field they are about. */
function synthetic(over = {}) {
  return {
    name: 'p', app: 'example', platforms: ['android'], goal: 'g', inputs: [],
    options: { ...DEFAULT_OPTIONS }, start: { launch: 'relaunch' },
    flow: [{ at: 'core/home', to: 'core/login' }], verify: [], rows: [{ id: 'default' }], rowsFromTable: false,
    ...over,
  };
}

/** Write a plan next to the fixture workspace and load it (for loader rejections). */
function tempPlan(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-plan-'));
  const file = path.join(dir, 'x.plan.md');
  fs.writeFileSync(file, body);
  return () => loadPlan(file, { root: ROOT });
}

// ── loader ───────────────────────────────────────────────────────────────────────────

test('a flow plan loads front-matter, legs and rows', () => {
  const p = plan('login.plan.md');
  assert.equal(p.name, 'example_login_basic');
  assert.equal(p.app, 'example');
  assert.equal(p.status, 'draft');
  assert.deepEqual(p.platforms, ['android']);
  assert.deepEqual(p.inputs.map((input) => [input.name, input.required, input.secret]), [['phone', true, false], ['password', true, true]]);
  assert.deepEqual(p.options, DEFAULT_OPTIONS);
  assert.deepEqual(p.start, { launch: 'relaunch' });
  assert.equal(p.flow.length, 1);
  assert.deepEqual(p.flow[0], { at: 'core/home', to: 'core/password', intent: 'Sign in with phone, OTP and password' });
  assert.deepEqual(p.rows.map((row) => row.id), ['r1', 'r2']);
  assert.equal(p.verify.length, 1);
  assert.equal(p.file, path.join(ROOT, 'plans', 'example', 'login.plan.md'));
});

test('a leg keeps only the keys it declares', () => {
  assert.deepEqual(plan('csv.plan.md').flow, [{ at: 'core/home', to: 'core/login' }]);
  assert.deepEqual(plan('nodata.plan.md').flow, [{ at: 'core/home', to: 'core/login', intent: 'Open the login screen' }]);
});

test('rows come from @data CSV, or a single default row', () => {
  assert.deepEqual(plan('csv.plan.md').rows, [{ id: 'c1', phone: '0900000005' }, { id: 'c2', phone: '0900000006' }]);
  const p = plan('nodata.plan.md');
  assert.deepEqual(p.rows, [{ id: 'default' }]);
  assert.deepEqual(p.start, { launch: 'attach' });
  assert.equal(p.options.legTimeoutMs, 30000);
  assert.equal(p.options.maxJevCallsPerLeg, DEFAULT_OPTIONS.maxJevCallsPerLeg);
});

test('"steps" plans and "use:" blocks are rejected with a rewrite hint', () => {
  assert.throws(plan.bind(null, 'legacy.plan.md'), /"steps" plans are no longer supported — rewrite as "flow" legs/);
  assert.throws(plan.bind(null, 'use.plan.md'), /"use:" blocks are no longer supported/);
});

test('a leg only takes at/to/intent/steps/checks/data, and start/status are enums', () => {
  assert.throws(tempPlan('---\nname: x\nflow:\n  - { at: core/home, to: core/login, colour: red }\n---\n'), /flow leg 1: unknown key\(s\) colour/);
  assert.throws(tempPlan('---\nname: x\nstart: { launch: skip }\nflow:\n  - { at: core/home, to: core/login }\n---\n'), /"start\.launch" must be one of fresh \/ relaunch \/ attach/);
  assert.throws(tempPlan('---\nname: x\nstart: { relaunch: true }\nflow:\n  - { at: core/home, to: core/login }\n---\n'), /"start" only takes "launch"/);
  assert.throws(tempPlan('---\nname: x\nstatus: promoted\nflow:\n  - { at: core/home, to: core/login }\n---\n'), /"status" must be one of draft \/ passed/);
  assert.throws(tempPlan('---\nname: x\nflow:\n  - { at: core/home }\n---\n'), /flow leg 1: "to" must be a screen id/);
  assert.throws(tempPlan('no front matter'), /missing YAML front-matter/);
});

// ── validate ─────────────────────────────────────────────────────────────────────────

test('a well-formed plan validates cleanly', () => {
  assert.deepEqual(validatePlan(plan('login.plan.md'), { store }), { ok: true, errors: [], warnings: [] });
});

test('every rule of a broken plan is reported', () => {
  const { ok, errors, warnings } = validatePlan(plan('bad.plan.md'), { store });
  assert.equal(ok, false);
  const text = errors.join('\n');
  assert.match(text, /flow leg 1 \(core\/home → core\/ghost\): screen "core\/ghost" does not exist in screens\/example\//);
  assert.match(text, /flow leg 2 \(core\/login → core\/password\): "at" must be the previous leg's "to" \("core\/ghost"\)/);
  assert.match(text, /flow leg 3 \(core\/password → core\/home\): data key "nope" is not a declared input/);
  assert.match(text, /flow leg 3 \(core\/password → core\/home\) step 1 \(jev_recover\): jev_recover is not a tool/);
  assert.match(text, /step 2: unsupported tool "nope"/);
  assert.match(text, /step 3: a flow step needs a "tool"/);
  assert.match(text, /step 4 \(tap_text\): "expect" needs exactly one of/);
  assert.match(text, /verify 1: a flow step needs a "tool"/);
  assert.match(text, /data column "email" is not a declared input/);
  assert.match(text, /duplicate data row id "a"/);
  assert.match(warnings.join('\n'), /step 4 \(tap_text\): unknown key "colour"/);
  assert.match(warnings.join('\n'), /unknown field "\{ghost\}"/);
  assert.match(warnings.join('\n'), /"start\.launch: fresh" on iOS works on a simulator only/);
  assert.match(warnings.join('\n'), /"expect" is not evaluated — use an assertion tool/);
});

test('each leg must name screens of the workspace', () => {
  const missing = synthetic({ flow: [{ at: 'core/home', to: 'core/ghost' }] });
  assert.match(validatePlan(missing, { store }).errors.join('\n'), /screen "core\/ghost" does not exist in screens\/example\//);
  // Without a store the ids are only checked for shape, never for existence.
  assert.equal(validatePlan(missing).ok, true);
  assert.match(validatePlan(synthetic({ flow: [{ at: 'home', to: 'core/login' }] }), { store }).errors.join('\n'), /"at" must be a screen id/);
});

test('the legs have to form an unbroken chain', () => {
  const broken = synthetic({ flow: [{ at: 'core/home', to: 'core/login' }, { at: 'core/home', to: 'core/password' }] });
  assert.match(validatePlan(broken, { store }).errors.join('\n'), /flow leg 2 .*"at" must be the previous leg's "to" \("core\/login"\)/);
  const chained = synthetic({ flow: [{ at: 'core/home', to: 'core/login' }, { at: 'core/login', to: 'core/password' }] });
  assert.deepEqual(validatePlan(chained, { store }), { ok: true, errors: [], warnings: [] });
});

test('a saveAs capture is known to the legs and the verify that follow it', () => {
  const p = synthetic({
    flow: [
      { at: 'core/home', to: 'core/login', checks: [{ tool: 'snapshot_text', saveAs: 'captured' }] },
      { at: 'core/login', to: 'core/password', steps: [{ tool: 'wait_text', args: { text: '{captured}' } }] },
    ],
    verify: [{ tool: 'assert_value', args: { value: '{captured}', match: 'x' } }],
  });
  assert.equal(validatePlan(p, { store }).ok, true);
  const early = synthetic({ flow: [{ at: 'core/home', to: 'core/login', steps: [{ tool: 'wait_text', args: { text: '{captured}' } }] }] });
  assert.match(validatePlan(early, { store }).warnings.join('\n'), /flow leg 1 .*step 1 \(wait_text\): unknown field "\{captured\}"/);
});

test('the data table and each leg data override must only use declared inputs', () => {
  const p = synthetic({ flow: [{ at: 'core/home', to: 'core/login', data: { phone: '0900000000' } }] });
  assert.match(validatePlan(p, { store }).errors.join('\n'), /data key "phone" is not a declared input/);
  const declared = synthetic({ inputs: [{ name: 'phone', required: false, secret: false }], flow: [{ at: 'core/home', to: 'core/login', data: { phone: '0900000000' } }] });
  const verdict = validatePlan(declared, { store });
  assert.equal(verdict.ok, true);
  assert.doesNotMatch(verdict.warnings.join('\n'), /"data"/);
});

// ── data ─────────────────────────────────────────────────────────────────────────────

test('row data resolves {env:} from the environment and never leaks values', () => {
  const p = plan('login.plan.md');
  const saved = process.env.FIXTURE_PASSWORD;
  try {
    process.env.FIXTURE_PASSWORD = 's3cret-env';
    const fromEnv = resolveRowData(p, p.rows[1], { workspace: fakeWorkspace() });
    assert.equal(fromEnv.password, 's3cret-env');
    assert.equal(fromEnv.id, undefined);
    delete process.env.FIXTURE_PASSWORD;
    // The dropped reflex.workspace.local.json overlay is not a source any more: env only.
    assert.throws(
      () => resolveRowData(p, p.rows[1], { workspace: fakeWorkspace() }),
      (error) => /input "password" needs env FIXTURE_PASSWORD/.test(error.message) && !/s3cret/.test(error.message)
    );
  } finally {
    if (saved === undefined) delete process.env.FIXTURE_PASSWORD;
    else process.env.FIXTURE_PASSWORD = saved;
  }
});

test('missing account inputs fall back to the workspace account; pin follows a 6-digit password', () => {
  const p = plan('nodata.plan.md');
  const data = resolveRowData({ ...p, inputs: [...p.inputs, { name: 'password', required: false, secret: true }] }, p.rows[0], {
    workspace: fakeWorkspace({ account: { phone: '0900000000', password: '123456' } }),
  });
  assert.equal(data.phone, '0900000000');
  assert.equal(data.pin, '123456');
  assert.equal(data.mode, 'fast');
  assert.throws(() => resolveRowData(p, p.rows[0], { workspace: fakeWorkspace() }), /plan "no_data" requires input "phone"/);
});

test('secretKeys covers declared secrets and the always-secret names', () => {
  const keys = secretKeys(plan('login.plan.md'));
  for (const name of ['password', 'pin', 'otp']) assert.ok(keys.has(name));
  assert.ok(!keys.has('phone'));
});
