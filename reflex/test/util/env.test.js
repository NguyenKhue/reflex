/**
 * env.test.js — `.env` loading (shell wins) and the Jev threshold resolution order.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { loadWorkspaceEnv, jevThreshold, DEFAULT_THRESHOLD } = require('../../src/util/env');

// Every key a test may touch, so a leaked value can never steer another test.
const ENV_KEYS = ['A_MT_TEST', 'B_MT_TEST', 'JEV_CONFIDENCE_THRESHOLD'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function tempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acme-env-')));
}

test('a missing .env is not an error', () => {
  const dir = tempDir();
  assert.deepEqual(loadWorkspaceEnv(dir), { file: null, loaded: false });
  assert.equal(process.env.A_MT_TEST, undefined);
});

test('.env is loaded without overriding variables the shell already set', () => {
  const dir = tempDir();
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'A_MT_TEST=file\nB_MT_TEST=file\n');
  process.env.A_MT_TEST = 'shell';
  delete process.env.B_MT_TEST;

  assert.deepEqual(loadWorkspaceEnv(dir), { file, loaded: true });
  assert.equal(process.env.A_MT_TEST, 'shell'); // shell wins: one-off overrides stay usable
  assert.equal(process.env.B_MT_TEST, 'file');
});

test('the Jev threshold defaults to 0.75', () => {
  delete process.env.JEV_CONFIDENCE_THRESHOLD;
  assert.equal(DEFAULT_THRESHOLD, 0.75);
  assert.equal(jevThreshold(), 0.75);
  assert.equal(jevThreshold(undefined), 0.75);
  assert.equal(jevThreshold(''), 0.75); // an empty flag is "not given", not "0"
});

test('flag beats env, env beats the default', () => {
  delete process.env.JEV_CONFIDENCE_THRESHOLD;
  assert.equal(jevThreshold('0.9'), 0.9);
  process.env.JEV_CONFIDENCE_THRESHOLD = '0.6';
  assert.equal(jevThreshold(), 0.6);
  assert.equal(jevThreshold('0.9'), 0.9);
  assert.equal(jevThreshold(1), 1); // 1 is inclusive: only jokey/sillier values are rejected
});

test('a threshold outside (0, 1] is rejected', () => {
  for (const bad of ['0', '1.5', 'abc']) {
    assert.throws(() => jevThreshold(bad), /in \(0, 1\]/, `"${bad}" should throw`);
  }
  process.env.JEV_CONFIDENCE_THRESHOLD = '0';
  assert.throws(() => jevThreshold(), /in \(0, 1\]/);
});
