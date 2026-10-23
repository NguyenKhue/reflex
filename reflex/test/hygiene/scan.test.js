/**
 * scan.test.js — `reflex hygiene scan`: the built-in rules, project rule files, `allow` entries, the
 * limits of the scanner (binary, huge, per-file cap) and the CLI contract.
 *
 * The promise under test is that a report about secrets carries positions only. So this file also
 * carries no real-looking value: every fake is assembled from obviously fake parts, which is why the
 * scanner run on this repository must not flag its own tests.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { hygieneScan, scanTree, loadRulesFile } = require('../../src/hygiene/scan');

const BIN = path.join(__dirname, '..', '..', 'bin', 'reflex.js');

/** Assembled values: no run of digits, no host, no key that a rule could match in this file. */
const ip = (...octets) => octets.join('.');
const join = (...parts) => parts.join('');

const PRIVATE_IP = ip('10', '1', '2', '3');
const CLASS_B_IP = ip('172', '16', '0', '1');
const LAN_IP = ip('192', '168', '1', '1');
const OUTSIDE_CLASS_B = ip('172', '32', '0', '1');
const PUBLIC_DNS = ip('8', '8', '8', '8');
const JWT = join('eyJ', 'a'.repeat(12), '.', 'b'.repeat(8), '.', 'c'.repeat(8));
const HALF_JWT = join('eyJ', 'hbGciOiJIUzI1NiJ9', '.x');
const AWS_KEY = join('AKIA', 'A'.repeat(16));
const PRIVATE_KEY_HEADER = join('-----BEGIN ', 'RSA ', 'PRIVATE KEY', '-----');
const VN_PHONE = join('03481', '23456');
const VN_PHONE_OTHER_PREFIX = join('09881', '23456');
const PLACEHOLDER_PHONE = join('0900000', '123');
const REPEATED_PHONE = join('0911', '11111111');
const SHORT_NUMBER = join('034812', '345');
const LONGER_DIGIT_RUN = join('1', '03481', '23456');

let root;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-hygiene-')));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function put(base, relative, contents) {
  const file = path.join(base, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

/** A rule file the scanner loads but never reads as content. */
function putRules(relative, parsed) {
  return put(root, relative, `${JSON.stringify(parsed, null, 2)}\n`);
}

function cli(args, cwd) {
  const result = spawnSync(process.execPath, [BIN, 'hygiene', 'scan', ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, REFLEX_PROJECT_DIR: root },
  });
  const markers = result.stdout.split('\n').filter((line) => line.startsWith('REFLEX_JSON '));
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    markers,
    marker: markers.length ? JSON.parse(markers[markers.length - 1].slice('REFLEX_JSON '.length)) : null,
  };
}

test('1. a clean tree: ok, nothing found, every text file counted, the six built-in rules loaded', () => {
  put(root, 'a.txt', 'nothing to see here\njust words\n');
  put(root, 'notes.md', '# title\n\nsome prose.\n');
  put(root, path.join('sub', 'b.txt'), 'a file in a sub directory\n');

  const result = hygieneScan({ root });

  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.byRule, {});
  assert.equal(result.scanned, 3);
  assert.deepEqual(result.rules, ['private-ip', 'jwt', 'private-key', 'aws-key', 'secret-literal', 'vn-phone']);
  // No rule file in a throwaway tree, so nothing to list.
  assert.deepEqual(result.rulesFiles, []);
});

test('2. private-ip: one finding with file, line, column and length — and only inside the private ranges', () => {
  const line = `url = http://${PRIVATE_IP}:80/x`;
  put(root, 'a.txt', `endpoint config\nhost list:\n${line}\n`);

  const result = hygieneScan({ root });

  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0], {
    rule: 'private-ip',
    description: 'a private IPv4 address',
    file: 'a.txt',
    line: 3,
    column: line.indexOf(PRIVATE_IP) + 1,
    length: 8,
  });
  assert.deepEqual(result.byRule, { 'private-ip': 1 });

  put(root, 'ranges.txt', `${CLASS_B_IP}\n${LAN_IP}\n${OUTSIDE_CLASS_B}\n${PUBLIC_DNS}\n`);
  const ranges = hygieneScan({ root }).findings.filter((finding) => finding.file === 'ranges.txt');
  assert.deepEqual(ranges.map((finding) => finding.line), [1, 2]);
  assert.ok(ranges.every((finding) => finding.rule === 'private-ip'));
});

test('3. jwt, private-key and aws-key are flagged once each; a token without its signature is not a token', () => {
  const tokenLine = `session = ${JWT}`;
  const keyLine = `key = ${PRIVATE_KEY_HEADER}`;
  const awsLine = `access = ${AWS_KEY}`;
  put(root, 'tokens.txt', `${tokenLine}\n${keyLine}\n${awsLine}\npartial = ${HALF_JWT}\n`);

  const result = hygieneScan({ root });

  assert.deepEqual(result.byRule, { jwt: 1, 'private-key': 1, 'aws-key': 1 });
  assert.deepEqual(result.findings.map((finding) => `${finding.rule}@${finding.line}`), ['jwt@1', 'private-key@2', 'aws-key@3']);
  assert.deepEqual(result.findings.map((finding) => finding.column), [
    tokenLine.indexOf(JWT) + 1,
    keyLine.indexOf(PRIVATE_KEY_HEADER) + 1,
    awsLine.indexOf(AWS_KEY) + 1,
  ]);
  assert.deepEqual(result.findings.map((finding) => finding.length), [JWT.length, PRIVATE_KEY_HEADER.length, AWS_KEY.length]);
});

test('4. secret-literal: a real-looking value is flagged, a placeholder, a hidden field or an empty value is not', () => {
  const positives = [
    '"password": "hunter22"',
    "pin: '1234'",
    'token = "abcd"',
    'API_KEY: "xyzxyz"',
  ];
  put(root, 'config.txt', `${positives.join('\n')}\n`);

  const result = hygieneScan({ root });

  assert.deepEqual(result.byRule, { 'secret-literal': 4 });
  // Each line starts with the keyword and ends with the value, so the match spans the whole line.
  assert.deepEqual(
    result.findings.map((finding) => [finding.rule, finding.file, finding.line, finding.column, finding.length]),
    positives.map((line, index) => ['secret-literal', 'config.txt', index + 1, 1, line.length]),
  );

  put(root, 'placeholders.txt', [
    "password: '{password}'",
    'pin: "<hidden>"',
    'token: "${TOKEN}"',
    'REFLEX_TEST_PASSWORD=',
    "password: ''",
    '',
  ].join('\n'));

  const withPlaceholders = hygieneScan({ root });
  assert.deepEqual(withPlaceholders.findings.filter((finding) => finding.file === 'placeholders.txt'), []);
});

test('5. vn-phone: plausible numbers are flagged, obvious fakes and longer digit runs are not', () => {
  const lines = [
    `phone = ${VN_PHONE}`,
    `phone = ${VN_PHONE_OTHER_PREFIX}`,
    `phone = ${PLACEHOLDER_PHONE}`,
    `phone = ${REPEATED_PHONE}`,
    `phone = ${SHORT_NUMBER}`,
    `phone = ${LONGER_DIGIT_RUN}`,
  ];
  put(root, 'phones.txt', `${lines.join('\n')}\n`);

  const result = hygieneScan({ root });

  assert.deepEqual(result.byRule, { 'vn-phone': 2 });
  assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.file, finding.line, finding.column, finding.length]), [
    ['vn-phone', 'phones.txt', 1, 9, 10],
    ['vn-phone', 'phones.txt', 2, 9, 10],
  ]);
});

test('6. a finding carries a position, never the text it matched', () => {
  put(root, 'a.txt', `host = ${PRIVATE_IP}\n`);
  put(root, 'b.txt', `session = ${JWT}\n`);
  put(root, 'c.txt', `phone = ${VN_PHONE}\n`);

  const result = hygieneScan({ root });
  const json = JSON.stringify(result);

  assert.deepEqual(result.byRule, { 'private-ip': 1, jwt: 1, 'vn-phone': 1 });
  for (const forbidden of [PRIVATE_IP, JWT, VN_PHONE]) {
    assert.ok(!json.includes(forbidden), `the JSON carries ${forbidden}`);
  }
  // The shape is fixed, so there is nowhere in a finding for the text to hide.
  for (const finding of result.findings) {
    assert.deepEqual(Object.keys(finding).sort(), ['column', 'description', 'file', 'length', 'line', 'rule']);
  }
});

test('7. allow: by exact file, by directory prefix, by rule id or by every rule — never by accident', () => {
  put(root, path.join('tests', 'a.txt'), `phone = ${VN_PHONE}\n`);
  put(root, path.join('tests', 'sub', 'b.txt'), `phone = ${VN_PHONE}\n`);
  put(root, path.join('tests-extra', 'c.txt'), `phone = ${VN_PHONE}\n`);
  put(root, 'tests.txt', `phone = ${VN_PHONE}\nhost = ${PRIVATE_IP}\n`);

  const found = (allow) => hygieneScan({ root, rulesFiles: [putRules('hygiene.rules.json', { allow })] })
    .findings.map((finding) => `${finding.file}:${finding.rule}`).sort();
  const reason = 'fixtures use fake values on purpose';

  assert.deepEqual(found([]), [
    'tests-extra/c.txt:vn-phone',
    'tests.txt:private-ip',
    'tests.txt:vn-phone',
    'tests/a.txt:vn-phone',
    'tests/sub/b.txt:vn-phone',
  ]);
  // A directory prefix covers everything under it: a sibling that merely starts the same is still scanned.
  assert.deepEqual(found([{ rule: 'vn-phone', file: 'tests/', reason }]), [
    'tests-extra/c.txt:vn-phone',
    'tests.txt:private-ip',
    'tests.txt:vn-phone',
  ]);
  // An exact file needs no trailing slash, and it silences only its own rule.
  assert.deepEqual(found([{ rule: 'vn-phone', file: 'tests.txt', reason }]), [
    'tests-extra/c.txt:vn-phone',
    'tests.txt:private-ip',
    'tests/a.txt:vn-phone',
    'tests/sub/b.txt:vn-phone',
  ]);
  // '*' silences every rule of that file.
  assert.deepEqual(found([{ rule: '*', file: 'tests.txt', reason }]), [
    'tests-extra/c.txt:vn-phone',
    'tests/a.txt:vn-phone',
    'tests/sub/b.txt:vn-phone',
  ]);
  // Another rule id does not silence this one.
  assert.deepEqual(found([{ rule: 'jwt', file: 'tests-extra/', reason }])[0], 'tests-extra/c.txt:vn-phone');
});

test('8. rule files: what compiles, the exact message when they do not, and flags / ignore', () => {
  const file = putRules('hygiene.rules.json', {
    rules: [{ id: 'brand', description: 'an internal brand', regex: 'acme' }],
    allow: [{ file: 'a.txt' }],
    ignoreDirs: ['cache'],
  });

  const loaded = loadRulesFile(file);

  assert.equal(loaded.rules.length, 1);
  assert.equal(loaded.rules[0].id, 'brand');
  assert.equal(loaded.rules[0].description, 'an internal brand');
  assert.ok(loaded.rules[0].matcher instanceof RegExp);
  assert.deepEqual(loaded.rules[0].ignore, []);
  assert.deepEqual(loaded.allow, [{ rule: '*', file: 'a.txt', reason: '' }]);
  assert.deepEqual(loaded.ignoreDirs, ['cache']);

  const broken = (parsed) => putRules('broken.rules.json', parsed);
  const startsWith = (prefix) => (error) => {
    assert.ok(error.message.startsWith(prefix), `expected "${prefix}", got "${error.message}"`);
    return true;
  };
  const notJson = put(root, 'broken.rules.json', '{ not json');
  assert.throws(() => loadRulesFile(notJson), startsWith(`${notJson}: not valid JSON: `));

  const notAnObject = broken([]);
  assert.throws(() => loadRulesFile(notAnObject), { message: `${notAnObject}: expected an object with rules / allow / ignoreDirs` });

  const noId = broken({ rules: [{ regex: 'acme' }] });
  assert.throws(() => loadRulesFile(noId), { message: `${noId}: every rule needs an id` });

  const noRegex = broken({ rules: [{ id: 'brand' }] });
  assert.throws(() => loadRulesFile(noRegex), { message: `${noRegex}: rule "brand" needs a regex` });

  const badRegex = broken({ rules: [{ id: 'brand', regex: '(' }] });
  assert.throws(() => loadRulesFile(badRegex), startsWith(`${badRegex}: rule "brand" has an invalid regex: `));

  const noFile = broken({ allow: [{ rule: 'vn-phone', reason: 'a reason is not enough' }] });
  assert.throws(() => loadRulesFile(noFile), { message: `${noFile}: every allow entry needs a file` });

  // flags: 'i' makes a rule case-insensitive; without it only the exact case matches.
  // The rule file itself holds the word it searches for, so it lives outside the tree being scanned.
  const brandTree = path.join(root, 'brand');
  put(brandTree, 'a.txt', 'Acme first line\nacme second line\n');
  const insensitive = putRules('brand.rules.json', { rules: [{ id: 'brand', description: 'a brand', regex: 'acme', flags: 'i' }] });
  const withFlag = scanTree({ root: brandTree, rules: loadRulesFile(insensitive).rules });
  assert.deepEqual(withFlag.findings.map((finding) => finding.line), [1, 2]);

  const sensitive = putRules('brand.rules.json', { rules: [{ id: 'brand', description: 'a brand', regex: 'acme' }] });
  const withoutFlag = scanTree({ root: brandTree, rules: loadRulesFile(sensitive).rules });
  assert.deepEqual(withoutFlag.findings.map((finding) => finding.line), [2]);

  // A rule's own ignore list drops the matches it recognises as placeholders.
  const ignoring = putRules('brand.rules.json', { rules: [{ id: 'brand', description: 'a brand', regex: 'acme', flags: 'i', ignore: ['^acme$'] }] });
  put(brandTree, 'a.txt', 'acme\nAcme\n');
  const withIgnore = scanTree({ root: brandTree, rules: loadRulesFile(ignoring).rules });
  assert.deepEqual(withIgnore.findings.map((finding) => [finding.rule, finding.line]), [['brand', 2]]);
});

test('9. discovery: the three rule files are found, a project rule replaces a built-in, and a rule file is never scanned', () => {
  putRules('hygiene.rules.json', { rules: [{ id: 'project-tag', description: 'a tag of our own', regex: 'zzz-project-tag' }] });
  putRules(path.join('reflex', 'hygiene.rules.json'), { rules: [{ id: 'private-ip', description: 'an internal host', regex: 'zzz-replaced-rule' }] });
  putRules(path.join('workspace', 'hygiene.rules.json'), { rules: [{ id: 'acme-internal-host', description: 'an internal host name', regex: 'internal-host' }] });
  put(root, 'a.txt', `host = ${PRIVATE_IP}\nsession = ${JWT}\nname = internal-host-uat\n`);

  const result = hygieneScan({ root });

  assert.deepEqual(result.rulesFiles, ['hygiene.rules.json', 'reflex/hygiene.rules.json', 'workspace/hygiene.rules.json']);
  assert.ok(result.rules.includes('project-tag'));
  assert.ok(result.rules.includes('acme-internal-host'));
  // The replacement keeps the id it replaces, so the address is no longer a finding.
  assert.ok(result.rules.includes('private-ip'));
  assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.file, finding.line]), [
    ['jwt', 'a.txt', 2],
    ['acme-internal-host', 'a.txt', 3],
  ]);
  // A rule file holds the very pattern it searches for, and is never read as content.
  assert.equal(result.scanned, 1);

  const extra = putRules(path.join('extra', 'more.rules.json'), { rules: [{ id: 'extra-rule', description: 'an extra project rule', regex: 'extra-marker' }] });
  put(root, 'b.txt', 'value = extra-marker\n');

  const withExtra = hygieneScan({ root, rulesFiles: [extra] });

  assert.ok(withExtra.rules.includes('extra-rule'));
  assert.deepEqual(withExtra.findings.map((finding) => finding.rule).sort(), ['acme-internal-host', 'extra-rule', 'jwt']);
  assert.equal(withExtra.scanned, 2, 'the explicitly named rule file is skipped like a discovered one');
});

test('10. always-ignored directories and the ones a project adds: never scanned, never counted', () => {
  put(root, 'a.txt', 'clean\n');
  put(root, 'keep.txt', 'clean\n');
  put(root, path.join('cache', 'w.txt'), `host = ${PRIVATE_IP}\n`);
  for (const ignored of ['node_modules', 'reports', '.agentic', '.git']) {
    put(root, path.join(ignored, 'inside.txt'), `host = ${PRIVATE_IP}\n`);
  }

  // Without the project rule, the extra directory is ordinary content.
  const before = hygieneScan({ root });

  assert.equal(before.scanned, 3);
  assert.deepEqual(before.findings.map((finding) => finding.file), ['cache/w.txt']);

  putRules('hygiene.rules.json', { ignoreDirs: ['cache'] });
  const after = hygieneScan({ root });

  assert.equal(after.scanned, 2);
  assert.deepEqual(after.findings, []);
  assert.equal(after.ok, true);
});

test('11. binary and huge files are skipped, a file stops at 50 findings, and no defaults means no rules', () => {
  put(root, 'binary.bin', Buffer.concat([Buffer.from('head'), Buffer.from([0]), Buffer.from(PRIVATE_IP)]));
  put(root, 'huge.txt', `${'x'.repeat(1000001)}${PRIVATE_IP}`);
  put(root, 'many.txt', `${new Array(60).fill(PRIVATE_IP).join(' ')}\n`);
  put(root, 'small.txt', 'nothing here\n');

  const result = hygieneScan({ root });

  assert.equal(result.scanned, 2, 'the binary file and the huge one are neither scanned nor counted');
  assert.equal(result.findings.length, 50, 'the per-file cap holds');
  assert.deepEqual(result.byRule, { 'private-ip': 50 });
  assert.ok(result.findings.every((finding) => finding.file === 'many.txt'));

  const none = hygieneScan({ root, useDefaults: false });

  assert.deepEqual(none.rules, []);
  assert.deepEqual(none.findings, []);
  assert.equal(none.ok, true);
  assert.equal(none.scanned, 2);
});

test('12. CLI: `hygiene scan --json` exits 1 with the findings, 0 when clean, and neither output carries the text', () => {
  const tree = path.join(root, 'tree');
  const ipLine = `host = ${PRIVATE_IP}`;
  put(tree, 'a.txt', `first line\n${ipLine}\n`);
  put(tree, 'notes.md', '# notes\n');
  const cleanTree = path.join(root, 'clean-tree');
  put(cleanTree, 'b.txt', 'all good\n');

  const dirty = cli(['--root', tree, '--json'], tree);

  assert.equal(dirty.code, 1, dirty.stderr);
  assert.equal(dirty.markers.length, 1, dirty.markers.join('\n'));
  assert.equal(dirty.marker.ok, false);
  assert.equal(dirty.marker.findings.length, 1);
  assert.deepEqual(dirty.marker.findings[0], {
    rule: 'private-ip',
    description: 'a private IPv4 address',
    file: 'a.txt',
    line: 2,
    column: ipLine.indexOf(PRIVATE_IP) + 1,
    length: 8,
  });
  assert.deepEqual(dirty.marker.byRule, { 'private-ip': 1 });

  const clean = cli(['--root', cleanTree, '--json'], cleanTree);

  assert.equal(clean.code, 0, clean.stderr);
  assert.equal(clean.markers.length, 1, clean.markers.join('\n'));
  assert.equal(clean.marker.ok, true);
  assert.deepEqual(clean.marker.findings, []);

  const human = cli(['--root', tree], tree);

  assert.equal(human.code, 1, human.stderr);
  assert.equal(human.markers.length, 1, human.markers.join('\n'));
  assert.equal(human.marker.count, 1);
  assert.equal(human.marker.findings, undefined);
  const lines = human.stderr.split('\n');
  assert.ok(lines.includes(`a.txt:2:8  private-ip — a private IPv4 address`), human.stderr);
  assert.ok(lines.includes('hygiene: 1 finding(s) in 2 file(s)'), human.stderr);

  // Not the marker line, not the human line, not either command's stderr.
  for (const stream of [dirty.stdout, dirty.stderr, human.stdout, human.stderr]) {
    assert.ok(!stream.includes(PRIVATE_IP), `an output carries ${PRIVATE_IP}: ${stream}`);
  }
});
