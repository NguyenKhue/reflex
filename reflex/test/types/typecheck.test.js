/**
 * typecheck.test.js — the plugin contracts are checked twice: by `tsc` against `types/plugins.d.ts`, and by this file
 * against `src/core/contracts.js`, so the types cannot drift away from what the core enforces at run time.
 *
 * `typescript` is an optional dev dependency. Without it the two compiler cases are skipped; the drift case still runs,
 * because it only reads text.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CONTRACTS } = require('../../src/core/contracts');

const TYPES_DIR = path.join(__dirname, '..', '..', 'types');
const DECLARATIONS = path.join(TYPES_DIR, 'plugins.d.ts');
const TSCONFIG = path.join(TYPES_DIR, 'tsconfig.json');
// `require.resolve('typescript/bin/tsc')` does not work: the package does not export that file.
const TSC = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsc');

function typecheck(configFile) {
  return spawnSync(TSC, ['-p', configFile], { encoding: 'utf8' });
}

test('1. `tsc -p types/tsconfig.json`: the declarations accept correct plugins and the check file compiles', (t) => {
  if (!fs.existsSync(TSC)) {
    t.skip('typescript is not installed');
    return;
  }

  const result = typecheck(TSCONFIG);

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stdout.trim(), '');
  assert.equal(result.stderr.trim(), '');
});

test('2. the same check bites: a wrong plugin without an expect-error fails the build', (t) => {
  if (!fs.existsSync(TSC)) {
    t.skip('typescript is not installed');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-typecheck-'));

  try {
    // The same declarations and the same configuration, only the check file is a wrong one on purpose.
    fs.copyFileSync(DECLARATIONS, path.join(dir, 'plugins.d.ts'));
    fs.copyFileSync(TSCONFIG, path.join(dir, 'tsconfig.json'));
    fs.writeFileSync(path.join(dir, 'check.ts'), "const bad: import('./plugins').OtpProvider = {};\n\nexport { bad };\n");

    const result = typecheck(path.join(dir, 'tsconfig.json'));
    const output = `${result.stdout}${result.stderr}`;

    assert.notEqual(result.status, 0, output);
    assert.ok(output.includes('OtpProvider'), output);
    assert.ok(output.includes('getOtp'), output);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('3. plugins.d.ts names every kind and every method of CONTRACTS, so the types cannot drift', () => {
  const declarations = fs.readFileSync(DECLARATIONS, 'utf8');
  const union = declarations.match(/export type PluginKind = ([^;]+);/);

  assert.ok(union, 'plugins.d.ts has no PluginKind union');
  for (const kind of Object.keys(CONTRACTS)) {
    assert.ok(union[1].includes(`'${kind}'`), `the PluginKind union does not name ${kind}`);
  }
  for (const [kind, contract] of Object.entries(CONTRACTS)) {
    for (const method of [...contract.required, ...contract.optional]) {
      const declared = declarations.includes(`${method}(`) || declarations.includes(`${method}?(`);
      assert.ok(declared, `${kind}.${method} is not declared in plugins.d.ts`);
    }
  }
});
