/**
 * recipe.test.js — the deterministic step executor (recovery hook, assertion set,
 * per-step helpers) and app resolution. No device, no network, no Jev client.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateChecklistRecipe, executeChecklistRecipe, runToolStep, applySaveAs, validateToolStep } = require('../../src/runner/recipe');
const { DEVICE_TOOL_SPECS, DEVICE_ASSERTIONS } = require('../../src/device/deviceTools');
const { resolveApp, appKey } = require('../../src/runner/app');

const RECIPE = [{ tool: 'launch_app', args: { relaunch: true } }];

/** A session whose named tools are the given async functions. */
function sessionOf(tools) {
  const calls = [];
  const session = {};
  for (const [name, fn] of Object.entries(tools)) {
    session[name] = async (args) => {
      calls.push({ name, args });
      return fn(args, calls.filter((call) => call.name === name).length);
    };
  }
  session.calls = calls;
  return session;
}

test('a step that fails then succeeds is recorded as recovered', async () => {
  const session = sessionOf({
    tap_text: (_args, attempt) => {
      if (attempt === 1) throw new Error('no element with text "Đăng nhập"');
      return { ok: true, found: true };
    },
  });
  const recoveries = [];
  const execution = await executeChecklistRecipe(session, [{ tool: 'tap_text', args: { text: 'Đăng nhập' } }], {}, {
    toolSpecs: DEVICE_TOOL_SPECS,
    onStepError: async (ctx) => {
      recoveries.push(ctx);
      return true;
    },
  });

  assert.equal(execution.ok, true);
  assert.equal(execution.steps.length, 1);
  assert.equal(execution.steps[0].ok, true);
  assert.equal(execution.steps[0].recovered, true);
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].tool, 'tap_text');
  assert.equal(recoveries[0].index, 0);
  assert.match(recoveries[0].error.message, /no element/);
});

test('a step that stays broken keeps both errors', async () => {
  const session = sessionOf({
    wait_text: (_args, attempt) => {
      if (attempt === 1) throw new Error('first failure');
      throw new Error('still missing');
    },
  });
  const execution = await executeChecklistRecipe(session, [{ tool: 'wait_text', args: { text: 'Home' } }], {}, {
    toolSpecs: DEVICE_TOOL_SPECS,
    onStepError: async () => true,
  });

  assert.equal(execution.ok, false);
  assert.equal(execution.steps[0].ok, false);
  assert.equal(execution.steps[0].error, 'first failure; after recovery: still missing');
  assert.equal(session.calls.length, 2);
});

test('a recovery policy that declines leaves the original failure', async () => {
  const session = sessionOf({ tap_text: () => ({ ok: false, error: 'tap missed' }) });
  const execution = await executeChecklistRecipe(session, [{ tool: 'tap_text', args: { text: 'X' } }], {}, {
    toolSpecs: DEVICE_TOOL_SPECS,
    onStepError: async () => false,
  });

  assert.equal(execution.ok, false);
  assert.equal(execution.steps[0].error, 'tap_text reported failure: tap missed');
  assert.equal(execution.steps[0].recovered, undefined);
  assert.equal(session.calls.length, 1);
});

test('without a recovery policy the executor behaves exactly as before', async () => {
  const session = sessionOf({ tap_text: () => ({ ok: false, error: 'tap missed' }) });
  const execution = await executeChecklistRecipe(session, [
    { tool: 'tap_text', args: { text: 'X' } },
    { tool: 'wait_text', args: { text: 'Home' } },
  ], {}, { toolSpecs: DEVICE_TOOL_SPECS });

  assert.equal(execution.ok, false);
  assert.equal(execution.steps.length, 1);
  assert.equal(execution.failed_step.index, 0);
  assert.equal(session.calls.length, 1);
});

test('the assertion set is the caller\'s, not a global', async () => {
  const recipe = [{ tool: 'wait_text', args: { text: 'Home' } }];
  const failing = sessionOf({ wait_text: () => ({ ok: true, found: false }) });
  const withDeviceAssertions = await executeChecklistRecipe(failing, recipe, {}, {
    toolSpecs: DEVICE_TOOL_SPECS,
    assertions: DEVICE_ASSERTIONS,
  });
  assert.equal(withDeviceAssertions.ok, false);
  assert.match(withDeviceAssertions.steps[0].error, /did not find a matching component/);

  const passing = sessionOf({ wait_text: () => ({ ok: true, found: false }) });
  const withNoAssertions = await executeChecklistRecipe(passing, recipe, {}, {
    toolSpecs: DEVICE_TOOL_SPECS,
    assertions: new Set(),
  });
  assert.equal(withNoAssertions.ok, true);
});

test('resolveApp reads the plan mapping and lets the CLI override it', () => {
  const flow = { name: 'example_bootstrap', app: { android: { package: 'com.acme.example', activity: 'com.acme.example.MainActivity' } } };

  assert.deepEqual(resolveApp(flow, {}, 'android'), {
    package: 'com.acme.example',
    activity: 'com.acme.example.MainActivity',
    bundleId: null,
  });
  // A platform without its own entry falls back to the mapping itself.
  assert.deepEqual(resolveApp({ name: 'f', app: { package: 'com.acme.only' } }, {}, 'android').package, 'com.acme.only');
  // --app / --activity win over the flow.
  assert.deepEqual(resolveApp(flow, { app: 'com.acme.cli', activity: 'com.acme.cli.Main' }, 'android'), {
    package: 'com.acme.cli',
    activity: 'com.acme.cli.Main',
    bundleId: null,
  });
});

test('resolveApp maps an iOS bundle id to the session app id', () => {
  const flow = { name: 'example_ios', app: { ios: { bundleId: 'com.acme.app' } } };

  assert.deepEqual(resolveApp(flow, {}, 'ios'), {
    package: 'com.acme.app',
    activity: null,
    bundleId: 'com.acme.app',
  });
  assert.deepEqual(resolveApp({ name: 'f', app: { ios: {} } }, { app: 'com.example.cli' }, 'ios'), {
    package: 'com.example.cli',
    activity: null,
    bundleId: 'com.example.cli',
  });
});

test('resolveApp fails loudly when nothing resolves an app', () => {
  assert.throws(() => resolveApp({ name: 'no_app' }, {}, 'android'), /no Android package/);
  assert.throws(() => resolveApp({ name: 'no_app' }, {}, 'ios'), /no iOS bundle id/);
  assert.throws(() => resolveApp({ name: 'no_app', app: {} }, { app: true }, 'android'), /no Android package/);
});

test('the device vocabulary is the default and shape rules still apply', () => {
  assert.doesNotThrow(() => validateChecklistRecipe(RECIPE));
  assert.throws(() => validateChecklistRecipe([{ tool: 'launch_app', args: [1] }]), /"args" must be a mapping/);
  assert.throws(() => validateToolStep({ tool: 'nope' }, 2), /checklist step 3: unsupported tool "nope"/);
});

test('runToolStep reports a throwing tool as a failure instead of throwing', async () => {
  const session = { tap_text: async () => { throw new Error('device gone'); } };
  const outcome = await runToolStep(session, { tool: 'tap_text' }, { text: 'x' });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error.message, /device gone/);
});

test('runToolStep fails an assertion whose found flag is false', async () => {
  const session = { wait_text: async () => ({ ok: true, found: false }) };
  const outcome = await runToolStep(session, { tool: 'wait_text' }, { text: 'x' }, { assertionSet: DEVICE_ASSERTIONS });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error.message, /did not find/);
});

test('applySaveAs stores the tool value and rejects a bad name', () => {
  const data = {};
  applySaveAs({ saveAs: 'totals' }, { ok: true, value: '3 pass' }, data);
  applySaveAs({ saveAs: 'raw' }, { ok: true }, data);
  applySaveAs({}, { value: 'ignored' }, data);
  assert.deepEqual(data, { totals: '3 pass', raw: { ok: true } });
  assert.throws(() => applySaveAs({ saveAs: '1bad' }, {}, data), /invalid saveAs "1bad"/);
});

test('appKey is the app key, or the plan name for an inline mapping', () => {
  assert.equal(appKey({ name: 'p', app: 'example' }), 'example');
  assert.equal(appKey({ name: 'p', app: { android: { package: 'x' } } }), 'p');
});
