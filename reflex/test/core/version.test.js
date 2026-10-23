/**
 * version.test.js — the version reflex reports must be real, and the numbers that must agree must agree.
 *
 * A version that drifts (package.json 0.6.0, changelog 0.5.0, contract 0.1.0 vs what plugins declare) is worse than no version at all, so the
 * cross-file numbers are asserted here rather than trusted. `contractVersion` is checked before the methods: a plugin built for another
 * major contract must say so instead of failing on a missing method that the new contract renamed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { CONTRACT_VERSION, assertContract } = require('../../src/core/contracts');
const { createRegistry } = require('../../src/core/registry');
const { versionInfo, versionLine } = require('../../src/util/version');
const { MARKER, parseMarker } = require('../../src/util/markers');

const PKG = require('../../package.json');
const BIN = path.join(__dirname, '..', '..', 'bin', 'reflex.js');
const CHANGELOG = path.join(__dirname, '..', '..', '..', 'CHANGELOG.md');

function markerLines(stdout) {
  return String(stdout || '').split('\n').filter((line) => line.startsWith(`${MARKER} `));
}

test('1. versionInfo reports the package version, the contract version and the running Node', () => {
  const info = versionInfo();
  assert.equal(info.version, PKG.version);
  assert.equal(info.contracts, CONTRACT_VERSION);
  assert.equal(info.node, process.version);
  assert.deepEqual(Object.keys(info), ['version', 'contracts', 'node']);
  assert.equal(versionLine(), `reflex ${PKG.version} (contracts 0.1.0, node ${process.version})`);
  assert.equal(versionLine({ version: '9.9.9', contracts: '8.0.0', node: 'v0.0.0' }), 'reflex 9.9.9 (contracts 8.0.0, node v0.0.0)');
});

test('2. CONTRACT_VERSION is 0.1.0 and the package version and the changelog top entry agree', () => {
  assert.equal(CONTRACT_VERSION, '0.1.0');
  assert.match(PKG.version, /^\d+\.\d+\.\d+$/);
  assert.equal(PKG.version, '0.5.0');
  const heading = fs.readFileSync(CHANGELOG, 'utf8').match(/^## .*$/m);
  assert.ok(heading, 'CHANGELOG.md has no "## " entry');
  assert.ok(heading[0].startsWith(`## ${PKG.version}`), `changelog top entry "${heading[0]}" does not start with "## ${PKG.version}"`);
});

test('3. assertContract accepts the same major contractVersion and refuses another major, before the methods', () => {
  const good = { contractVersion: '0.9.1', decide() {} };
  assert.equal(assertContract('decider', good), good);
  const undeclared = { decide() {} };
  assert.equal(assertContract('decider', undeclared), undeclared);
  assert.equal(assertContract('decider', { contractVersion: CONTRACT_VERSION, decide() {} }).contractVersion, '0.1.0');

  assert.throws(() => assertContract('decider', { contractVersion: '1.0.0', decide() {} }), {
    message: 'decider plugin targets contract 1.0.0 but this reflex provides 0.1.0',
  });
  assert.throws(() => assertContract('decider', { contractVersion: 2, decide() {} }), {
    message: 'decider plugin targets contract 2 but this reflex provides 0.1.0',
  });
  // The version wins over "device plugin is missing: …": the plugin author needs to know the contract moved.
  assert.throws(() => assertContract('device', { contractVersion: '3.0.0' }), {
    message: 'device plugin targets contract 3.0.0 but this reflex provides 0.1.0',
  });
});

test('4. the registry refuses a factory whose instance targets another contract major', () => {
  const registry = createRegistry();
  registry.register('decider', 'x', () => ({ contractVersion: '1.2.3', decide() {} }));
  assert.throws(() => registry.create('decider', 'x'), {
    message: 'decider plugin targets contract 1.2.3 but this reflex provides 0.1.0',
  });

  const compatible = createRegistry();
  compatible.register('decider', 'ok', () => ({ contractVersion: '0.4.0', decide() {} }));
  const created = compatible.create('decider', 'ok');
  assert.equal(created.contractVersion, '0.4.0');
  assert.equal(typeof created.decide, 'function');
});

test('5. `reflex version` and `--version` print one marker line and the version line on stderr', () => {
  // A temp cwd so no workspace (and no .env) is discovered: this test must not depend on the machine it runs on.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-version-'));
  const expected = { ok: true, version: PKG.version, contracts: '0.1.0', node: process.version };
  const line = versionLine();

  const byCommand = spawnSync(process.execPath, [BIN, 'version', '--json'], { cwd, encoding: 'utf8' });
  assert.equal(byCommand.status, 0, byCommand.stderr);
  assert.equal(markerLines(byCommand.stdout).length, 1, `expected one marker line: ${byCommand.stdout}`);
  assert.deepEqual(parseMarker(markerLines(byCommand.stdout)[0]), expected);
  assert.ok(byCommand.stderr.includes(line), `stderr has no version line: ${byCommand.stderr}`);

  const byFlag = spawnSync(process.execPath, [BIN, '--version', '--json'], { cwd, encoding: 'utf8' });
  assert.equal(byFlag.status, 0, byFlag.stderr);
  assert.equal(markerLines(byFlag.stdout).length, 1, `expected one marker line: ${byFlag.stdout}`);
  assert.deepEqual(parseMarker(markerLines(byFlag.stdout)[0]), expected);
  assert.ok(byFlag.stderr.includes(line), `stderr has no version line: ${byFlag.stderr}`);

  fs.rmSync(cwd, { recursive: true, force: true });
});
