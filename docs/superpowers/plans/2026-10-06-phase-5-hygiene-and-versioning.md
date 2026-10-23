# reflex Phase 5 — hygiene, versioning and the TypeScript decision — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (this session implements) or hand a task to opencode via
> `docs/reflex/DELEGATION.md`. Steps use checkbox (`- [ ]`) syntax. Tick them as you go and update `docs/reflex/STATUS.md`.

**Goal:** Make the project safe to keep or share without leaking internal hosts, accounts or real-looking data, give it a version and a changelog, and settle the TypeScript question
without a risky migration.

**Architecture:** (1) a generic **hygiene scanner** (`reflex hygiene scan`) with shipped generic rules and per-project rule files, so "is this repo clean?" is a command, not a belief; (2) the findings it reports
are fixed (hard-coded internal defaults become configuration, the shared UAT account leaves the manifest, real-looking numbers in tests become obvious fakes, Acme branding becomes configuration);
(3) `reflex version`, a contract version checked when a plugin declares one, `CHANGELOG.md`; (4) hand-written type declarations for the plugin contracts plus an optional `typecheck` script, instead of rewriting 9,000 lines;
(5) the remaining `old-tool` strings and the `doctor` warnings are cleaned up; (6) a "before you share" document.

**Tech Stack:** Node >= 22.12, CommonJS, `node:test`; `typescript` only as an optional dev dependency for `typecheck`.

**Spec:** `docs/reflex/DESIGN.md` ("Hygiene before sharing", D1, D2, D5, D7), `docs/reflex/ROADMAP.md` (Phase 5).

## Decisions made for this phase (defaults from earlier user decisions; change them in DESIGN.md if you disagree)
- **D8 — personal project stays personal until the user says otherwise** (D2). Phase 5 makes it *shareable*, it does not share anything.
- **D9 — no git** (D5, "bỏ git đi"). The scanner makes a later `git init` safe: run it first. Nothing in this phase initialises a repository.
- **D10 — TypeScript: stay JavaScript.** 9,000+ lines work and are tested (463 tests). Plugin authors get `types/plugins.d.ts` and `npm run typecheck`; revisit a migration only if contract churn or a second author makes it pay off.
- **D11 — versioning:** semver, `0.x` until the contracts are frozen; `package.json` 0.1.0 → 0.5.0 (five phases done); `CONTRACT_VERSION` starts at `0.1.0`; a plugin may declare `contractVersion` and a different MAJOR is refused.

## Global Constraints
- Package folder `reflex/`; tests `reflex/test/`. Test command (main session only): `npm test --prefix reflex`. Baseline before this phase: 463 tests, 462 pass, 1 skipped.
- CommonJS, 2-space indent, single quotes, semicolons, English comments that explain why. Every file ends with a newline.
- The scanner NEVER prints, returns or logs the text it matched: a finding is `{ rule, description, file, line, column, length }`. Reports about secrets must not become the next leak.
- Findings are fixed by removing the data or moving it to configuration (`.env`, the manifest, a rules file), never by weakening a rule; an `allow` entry needs a `reason`.
- The agent never reads `.env` or prints account values. The shared UAT account is REMOVED from the manifest, not moved by the agent anywhere; the original is still in `the original repository`.
- No new runtime dependency. `typescript` is optional and dev-only.

## Review Focus
- A finding must never contain the matched text, in the object, the marker line, stderr or an error message.
- `allow` must work by exact file or directory prefix only (no accidental wildcard such as `reflex/test` allowing `reflex/testing-secrets/`).
- The scanner must not flag its own rule files (they contain the very patterns), and must skip binary and huge files without crashing.
- Making the OTP URL and the upload endpoint configuration-only must fail with an actionable message when unset, not with a `TypeError`.
- After T2 the scanner on this repo must report zero findings except documented `allow` entries; that is the acceptance test of the phase.

## File structure
```
reflex/src/hygiene/scan.js                T1  hygieneScan, scanTree, loadRulesFile, DEFAULT_RULES
reflex/src/cli/index.js                   T1  `hygiene scan`; T3 `version`/`--version`
reflex/test/hygiene/scan.test.js          T1
reflex/hygiene.rules.json                 T2  generic project rules (allow tests: fake values on purpose)
workspace/hygiene.rules.json       T2  app-specific names (internal hosts/CDN) + allow entries
reflex/src/util/otpApi/otp.js             T2  no default internal URL
reflex/src/report/report.js               T2  no default upload endpoint, configurable brand (no remote logo)
workspace/reflex.workspace.json    T2  shared account + internal URLs removed
reflex/test/**                            T2  real-looking phone numbers -> obvious fakes
reflex/src/core/contracts.js, reflex/package.json, CHANGELOG.md, docs/reflex/VERSIONING.md   T3
reflex/types/plugins.d.ts, reflex/types/check.ts, reflex/types/tsconfig.json                  T4
reflex/src/** (strings), reflex/src/cli/doctor.js                                             T5
docs/reflex/SHARING.md, docs/reflex/CONTRACTS.md                                              T6
```

---

### Task 1: The hygiene scanner

**Files:**
- Create: `reflex/src/hygiene/scan.js`, `reflex/test/hygiene/scan.test.js`
- Modify: `reflex/src/cli/index.js` (usage + `case 'hygiene'`)

**Interfaces:**
- Produces: `DEFAULT_RULES` (plain objects), `loadRulesFile(file)` → `{ rules, allow, ignoreDirs }` (rules compiled), `scanTree({ root, rules, allow, ignoreDirs, skipFiles })` → `{ findings, scanned }`,
  `hygieneScan({ root, rulesFiles, useDefaults })` → `{ ok, root, scanned, rulesFiles, rules, findings, byRule }`.
- Rule file format (JSON): `{ "rules": [{ "id", "description", "regex", "flags"?, "ignore"?: [regex strings] }], "allow": [{ "rule": "<id>"|"*", "file": "<exact path or directory prefix, forward slashes>", "reason": "…" }], "ignoreDirs": ["name", …] }`.
  Built-in rules: `private-ip`, `jwt`, `private-key`, `aws-key`, `secret-literal` (a quoted non-placeholder value after `password|passwd|pin|token|api_key|secret` and `:` or `=`), `vn-phone` (a plausible Vietnamese mobile number, with `ignore` for obvious fakes `0900000xxx` and repeated digits).
  Always ignored directories: `node_modules`, `reports`, `.agentic`, `.git`. Rule files are discovered at `<root>/hygiene.rules.json`, `<root>/reflex/hygiene.rules.json`, `<root>/workspace/hygiene.rules.json` and are NOT scanned themselves.
- Error messages (exact): `<file>: not valid JSON: <parser message>`; `<file>: expected an object with rules / allow / ignoreDirs`; `<where>: every rule needs an id`; `<where>: rule "<id>" needs a regex`; `<where>: rule "<id>" has an invalid regex: <message>`; `<file>: every allow entry needs a file`.
- CLI: `reflex hygiene scan [--root dir] [--rules a.json,b.json] [--no-defaults] [--json]`; stderr lines `<file>:<line>:<column>  <rule> — <description>` and a final `hygiene: N finding(s) in M file(s)`; one `REFLEX_JSON` line; exit 0 when clean, 1 otherwise.

- [x] **Step 1: Create `src/hygiene/scan.js`**

```js
/**
 * scan.js — `reflex hygiene scan`: find what must not leave this machine before the project is shared.
 *
 * Generic rules ship with the tool (private IPs, tokens, keys, secret-looking literals, plausible phone numbers); a project adds its own in
 * `hygiene.rules.json` files (internal host names, brand strings) and lists accepted findings under `allow`, each with a reason.
 * A finding NEVER carries the text it matched: a report about secrets must not become the next leak.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_IGNORE_DIRS = ['node_modules', 'reports', '.agentic', '.git'];
const RULES_FILES = ['hygiene.rules.json', path.join('reflex', 'hygiene.rules.json'), path.join('workspace', 'hygiene.rules.json')];
const MAX_BYTES = 1000000;
const MAX_PER_FILE = 50;

const DEFAULT_RULES = [
  {
    id: 'private-ip',
    description: 'a private IPv4 address',
    regex: '\\b(?:10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|192\\.168\\.\\d{1,3}\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3})\\b',
  },
  {
    id: 'jwt',
    description: 'a JSON web token',
    regex: 'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}',
  },
  {
    id: 'private-key',
    description: 'a private key block',
    regex: '-----BEGIN [A-Z ]*PRIVATE KEY-----',
  },
  {
    id: 'aws-key',
    description: 'an AWS access key id',
    regex: '\\bAKIA[0-9A-Z]{16}\\b',
  },
  {
    id: 'secret-literal',
    description: 'a quoted literal after password / pin / token / api key / secret',
    regex: '["\']?(?:password|passwd|pin|token|api[_-]?key|secret)["\']?\\s*[:=]\\s*["\'][^"\'\\s{<$][^"\']{3,}["\']',
    flags: 'i',
  },
  {
    id: 'vn-phone',
    description: 'a plausible Vietnamese mobile number',
    regex: '\\b0(?:3[2-9]|5[25689]|7[06-9]|8[1-9]|9\\d)\\d{7}\\b',
    ignore: ['^0900000\\d{3}$', '^09(\\d)\\1{8}$'],
  },
];

function compile(rule, where) {
  if (!rule || typeof rule.id !== 'string' || !rule.id) throw new Error(`${where}: every rule needs an id`);
  if (typeof rule.regex !== 'string' || !rule.regex) throw new Error(`${where}: rule "${rule.id}" needs a regex`);
  try {
    const flags = [...new Set(`${rule.flags || ''}g`.split(''))].join('');
    return {
      id: rule.id,
      description: rule.description || rule.id,
      matcher: new RegExp(rule.regex, flags),
      ignore: (rule.ignore || []).map((source) => new RegExp(source)),
    };
  } catch (error) {
    throw new Error(`${where}: rule "${rule.id}" has an invalid regex: ${error.message}`);
  }
}

function loadRulesFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file}: expected an object with rules / allow / ignoreDirs`);
  }
  const rules = (parsed.rules || []).map((rule) => compile(rule, file));
  const allow = (parsed.allow || []).map((entry) => {
    if (!entry || typeof entry.file !== 'string' || !entry.file) throw new Error(`${file}: every allow entry needs a file`);
    return { rule: entry.rule || '*', file: entry.file.replace(/\\/g, '/'), reason: entry.reason || '' };
  });
  return { rules, allow, ignoreDirs: Array.isArray(parsed.ignoreDirs) ? parsed.ignoreDirs.map(String) : [] };
}

/** Exact file, or a directory prefix: `reflex/test/` allows everything under it, never a sibling that merely starts the same. */
function isAllowed(allow, ruleId, relative) {
  return allow.some((entry) => {
    if (entry.rule !== '*' && entry.rule !== ruleId) return false;
    const prefix = entry.file.endsWith('/') ? entry.file : `${entry.file}/`;
    return relative === entry.file || relative.startsWith(prefix);
  });
}

function filesOf(root, ignoreDirs) {
  const ignored = new Set(ignoreDirs);
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) walk(path.join(dir, entry.name), relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  };
  walk(root, '');
  return files.sort();
}

function scanTree({ root, rules, allow = [], ignoreDirs = DEFAULT_IGNORE_DIRS, skipFiles = [] }) {
  const skipped = new Set(skipFiles);
  const findings = [];
  let scanned = 0;
  for (const relative of filesOf(root, ignoreDirs)) {
    if (skipped.has(relative)) continue;
    const full = path.join(root, relative);
    let buffer;
    try {
      if (fs.statSync(full).size > MAX_BYTES) continue;
      buffer = fs.readFileSync(full);
    } catch (_) {
      continue;
    }
    if (buffer.subarray(0, 4096).includes(0)) continue;
    scanned += 1;
    let count = 0;
    const lines = buffer.toString('utf8').split('\n');
    for (let index = 0; index < lines.length && count < MAX_PER_FILE; index += 1) {
      for (const rule of rules) {
        for (const match of lines[index].matchAll(rule.matcher)) {
          if (rule.ignore.some((pattern) => pattern.test(match[0]))) continue;
          if (isAllowed(allow, rule.id, relative)) continue;
          findings.push({ rule: rule.id, description: rule.description, file: relative, line: index + 1, column: match.index + 1, length: match[0].length });
          count += 1;
          if (count >= MAX_PER_FILE) break;
        }
        if (count >= MAX_PER_FILE) break;
      }
    }
  }
  return { findings, scanned };
}

function hygieneScan({ root, rulesFiles = [], useDefaults = true } = {}) {
  const base = path.resolve(root || process.cwd());
  const discovered = RULES_FILES.map((name) => path.join(base, name)).filter((file) => fs.existsSync(file));
  const files = [...new Set([...discovered, ...rulesFiles.map((file) => path.resolve(file))])];
  const byId = new Map();
  const allow = [];
  const ignoreDirs = new Set(DEFAULT_IGNORE_DIRS);
  if (useDefaults) {
    for (const rule of DEFAULT_RULES) byId.set(rule.id, compile(rule, 'built-in rules'));
  }
  for (const file of files) {
    const loaded = loadRulesFile(file);
    for (const rule of loaded.rules) byId.set(rule.id, rule);
    allow.push(...loaded.allow);
    for (const dir of loaded.ignoreDirs) ignoreDirs.add(dir);
  }
  const relativeFiles = files.map((file) => path.relative(base, file).split(path.sep).join('/'));
  const { findings, scanned } = scanTree({ root: base, rules: [...byId.values()], allow, ignoreDirs: [...ignoreDirs], skipFiles: relativeFiles });
  const byRule = {};
  for (const finding of findings) byRule[finding.rule] = (byRule[finding.rule] || 0) + 1;
  return { ok: findings.length === 0, root: base, scanned, rulesFiles: relativeFiles, rules: [...byId.keys()], findings, byRule };
}

module.exports = { hygieneScan, scanTree, loadRulesFile, DEFAULT_RULES, DEFAULT_IGNORE_DIRS };
```

- [x] **Step 2: Edit `src/cli/index.js`** — (a) in `USAGE`, after the `supervise approve|reject|status` line, add
  `  hygiene scan [--root dir] [--rules a.json,b.json] [--no-defaults]   find internal hosts, tokens, keys, secret literals and real-looking phone numbers before sharing`;
  (b) in the `switch (command)`, before `case 'mcp':`, add:

```js
      case 'hygiene': {
        if (sub === 'scan') {
          const result = require('../hygiene/scan').hygieneScan({
            root: str(flags, 'root') || process.cwd(),
            rulesFiles: (str(flags, 'rules') || '').split(',').map((name) => name.trim()).filter(Boolean),
            useDefaults: flags.defaults !== false,
          });
          if (!json) {
            for (const finding of result.findings) note(`${finding.file}:${finding.line}:${finding.column}  ${finding.rule} — ${finding.description}`);
            note(`hygiene: ${result.findings.length} finding(s) in ${result.scanned} file(s)`);
          }
          emit(json ? result : { ok: result.ok, root: result.root, scanned: result.scanned, count: result.findings.length, byRule: result.byRule, rulesFiles: result.rulesFiles }, { json });
          return result.ok ? 0 : 1;
        }
        break;
      }
```

- [x] **Step 3: Create `test/hygiene/scan.test.js`** (`node:test` + `node:assert/strict`; each test builds a temp tree with `fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-hygiene-'))`; a helper `put(root, relative, text)`; the fake secrets in the tests are made of obviously fake parts such as `10.1.2.3`, `AKIA` + sixteen `A`) — cases it MUST contain:
  1. a clean tree: `hygieneScan({ root })` → `ok: true`, `findings: []`, `scanned` equal to the number of text files, `rules` lists the six built-in ids.
  2. one file with a private IP (`http://10.1.2.3:80/x`) on line 3 → exactly one finding `{ rule: 'private-ip', file: 'a.txt', line: 3, column: <position of "10.">, length: 8 }`; `172.16.0.1` and `192.168.1.1` are flagged, `172.32.0.1` and `8.8.8.8` are not.
  3. `jwt` (three dot-separated parts), `private-key` (`-----BEGIN RSA PRIVATE KEY-----`), `aws-key` (`AKIA` + 16 chars) are each flagged once; a two-part `eyJhbGciOiJIUzI1NiJ9.x` is not.
  4. `secret-literal`: `"password": "hunter22"`, `pin: '1234'`, `token = "abcd"` and `API_KEY: "xyzxyz"` (case-insensitive) are flagged; `password: '{password}'`, `pin: "<hidden>"`, `token: "${TOKEN}"`, `LEGACY_TEST_PASSWORD=` (no quotes) and `password: ''` are not.
  5. `vn-phone`: `0348123456` and `0988123456` are flagged; `0900000123`, `0911111111`, a 9-digit number and `10348123456` (longer run) are not.
  6. NO finding ever contains the matched text: `JSON.stringify(result)` of a tree holding an IP, a token and a phone has none of those strings; the CLI stderr and marker line (case 12) also do not.
  7. `allow` by exact file and by directory prefix: `{ rule: 'vn-phone', file: 'tests/' }` silences `tests/a.txt` and `tests/sub/b.txt` but NOT `tests-extra/c.txt` or a file `tests.txt`; an allow with rule `'*'` silences every rule for that file; a different rule id does not.
  8. rule files: `loadRulesFile` compiles rules and allow entries; the exact messages for invalid JSON, a non-object, a rule with no id, no regex, an invalid regex (`'('`), an allow entry with no file; `flags: 'i'` makes a rule case-insensitive; a rule's `ignore` regex skips a match.
  9. discovery: `<root>/reflex/hygiene.rules.json` and `<root>/workspace/hygiene.rules.json` are loaded automatically and listed in `rulesFiles`; a rule defined there with the id of a built-in replaces it; `rulesFiles: [path]` adds an explicit file; the rule files are NOT scanned themselves (a rules file containing the string it searches for produces no finding).
  10. `ignoreDirs` from a rules file plus the always-ignored `node_modules`, `reports`, `.agentic`, `.git`: files inside them are not scanned and not counted.
  11. binary (a NUL byte in the first 4096 bytes) and huge (> 1,000,000 bytes) files are skipped without a throw; a file with 60 matches yields 50 findings (the per-file cap); `useDefaults: false` with no rule files scans with no rules (`rules: []`, `ok: true`).
  12. CLI: spawn `process.execPath [reflex/bin/reflex.js, 'hygiene', 'scan', '--root', <tmp>, '--json']` on a tree with one finding → exit 1, marker `ok: false`, `findings.length === 1`; on a clean tree exit 0 and `ok: true`; without `--json` the marker has `count` and no `findings`, stderr has the `file:line:col  rule — description` line and `hygiene: 1 finding(s) in N file(s)`.
- [x] **Step 4: Run (main session)** `npm test --prefix reflex` → 463 + new tests, 0 failures. Then `node reflex/bin/reflex.js hygiene scan --root .` on this repo and record the number of findings by rule in STATUS (the baseline T2 must bring to zero).
- [x] **Step 5: Update `STATUS.md`** (tick T1).

---

### Task 2: Fix what the scanner finds (spec-level — write exact edits after the T1 baseline scan)

Known before scanning (2026-10-06): (a) `reflex/src/util/otpApi/otp.js` `DEFAULT_BASE_URL` is an internal OTP host → remove the default, `otpConfig`/`otpApiBaseUrl` must throw
`authOtpApi base URL is not configured: set BYPASS_LOGIN_OTP_BASE_URL or authOtpApi.url in the workspace manifest` when nothing is set; (b) `reflex/src/report/report.js` `DEFAULT_UPLOAD_ENDPOINT` is an internal IP → `uploadEndpoint()` returns `null`
when unset and `uploadReport` throws `uploadReport: no endpoint configured (set REPORT_UPLOAD_URL or report.uploadUrl in the workspace manifest)`; (c) the report header loads a remote Acme logo and says "ACME APP DEVELOPMENT AUTOMATION TESTING REPORT" / "Acme App Testing"
→ brand from the manifest `report.brand { logoUrl, eyebrow, footer }`, neutral defaults (`AUTOMATION TEST REPORT`, `reflex`, no `<img>` when no logoUrl); (d) `workspace/reflex.workspace.json` holds a shared UAT account (phone/password/PIN), an internal OTP URL and an internal upload URL
→ remove them from the manifest (main session, values never printed; the original stays in the untouched `the original repository`); (e) real-looking phone numbers in `reflex/test/**` → obvious fakes (`090000xxxx`), keeping every formatted variant consistent (`034 876 8190` → `090 000 0001`);
(f) `reflex/hygiene.rules.json` (allow `reflex/test/` for `secret-literal`, `jwt`, `vn-phone` with the reason "fixtures use fake values on purpose") and `workspace/hygiene.rules.json` (a rule `acme-internal-host` listing the internal host and CDN names (the list lives only in that file), allow entries with reasons for public package names in `workspace/screens/acme/` and `workspace/AGENTS.md`).
**Acceptance:** `reflex hygiene scan --root .` reports 0 findings; every changed behaviour has a test; the suite is green.

### Task 3: Versioning

**Files:** Create `reflex/src/util/version.js`, `reflex/test/core/version.test.js`. Modify `reflex/src/core/contracts.js`, `reflex/src/cli/index.js`.
**Done by the main session before delegating (do not touch):** `reflex/package.json` and `package-lock.json` version `0.5.0` (+ `types`, scripts `typecheck`/`hygiene`, devDependency `typescript`), root `CHANGELOG.md` (top entry `## 0.5.0 — 2026-10-06`).

**Interfaces:**
- `CONTRACT_VERSION = '0.1.0'` exported from `src/core/contracts.js`. `assertContract(kind, instance)`: after the "must be an object" check and BEFORE the missing-methods check, when `instance.contractVersion !== undefined` and its MAJOR (`String(version).split('.')[0]`) differs from the major of `CONTRACT_VERSION`, throw
  `<kind> plugin targets contract <declared> but this reflex provides <CONTRACT_VERSION>`. A plugin that declares nothing, or the same major, is accepted.
- `src/util/version.js`: `versionInfo()` → `{ version, contracts, node }` (`version` from `package.json`, `contracts` = `CONTRACT_VERSION`, `node` = `process.version`); `versionLine(info)` → `reflex <version> (contracts <contracts>, node <node>)`.
- CLI: `reflex version` and `reflex --version` print `versionLine` on stderr and one marker line `{ ok: true, version, contracts, node }`, exit 0.

- [x] **Step 1: Create `src/util/version.js`**

```js
/**
 * version.js — what `reflex version` reports: the package version, the plugin contract version and the Node it runs on.
 */
const { CONTRACT_VERSION } = require('../core/contracts');
const pkg = require('../../package.json');

function versionInfo() {
  return { version: pkg.version, contracts: CONTRACT_VERSION, node: process.version };
}

function versionLine(info = versionInfo()) {
  return `reflex ${info.version} (contracts ${info.contracts}, node ${info.node})`;
}

module.exports = { versionInfo, versionLine };
```

- [x] **Step 2: Edit `src/core/contracts.js`** — (a) add `const CONTRACT_VERSION = '0.1.0';` and `const majorOf = (version) => String(version).split('.')[0];` above `CONTRACTS`, with a one-line comment (the version of the plugin contracts, independent of the package version; bump the MAJOR when a contract breaks);
  (b) in `assertContract`, right after the `must be an object` check, add:

```js
  if (instance.contractVersion !== undefined && majorOf(instance.contractVersion) !== majorOf(CONTRACT_VERSION)) {
    throw new Error(`${kind} plugin targets contract ${instance.contractVersion} but this reflex provides ${CONTRACT_VERSION}`);
  }
```
  (c) export `CONTRACT_VERSION` (add it to `module.exports`). Update the header comment's first paragraph with one sentence about `contractVersion`. Nothing else changes.
- [x] **Step 3: Edit `src/cli/index.js`** — in `USAGE` add after the `hygiene scan` line `  version                                             print the reflex version, the plugin contract version and the Node version (also: --version)`;
  in `main`, right after the `if (flags.help || command === 'help') { … }` block and BEFORE the `if (!command)` block, add:

```js
  if (flags.version === true || command === 'version') {
    const { versionInfo, versionLine } = require('../util/version');
    const info = versionInfo();
    note(versionLine(info));
    emit({ ok: true, ...info }, { json });
    return 0;
  }
```
- [x] **Step 4: Create `test/core/version.test.js`** (`node:test` + `node:assert/strict`) — cases it MUST contain:
  1. `versionInfo()` returns `version` equal to `require('../../package.json').version`, `contracts` equal to `CONTRACT_VERSION`, `node` equal to `process.version`; `versionLine()` equals `reflex <version> (contracts 0.1.0, node <node>)`.
  2. `CONTRACT_VERSION === '0.1.0'`; `package.json` version matches `/^\d+\.\d+\.\d+$/` and equals `0.5.0`; the first `## ` heading of the root `CHANGELOG.md` (`path.join(__dirname, '..', '..', '..', 'CHANGELOG.md')`) starts with `## ` + the package version (so they cannot drift).
  3. `assertContract`: a decider with `contractVersion: '0.9.1'` passes (same major 0); `'1.0.0'` throws exactly `decider plugin targets contract 1.0.0 but this reflex provides 0.1.0`; a plugin with no `contractVersion` passes; a number `2` throws `… targets contract 2 but …`; the version check comes BEFORE the missing-methods check (an object `{ contractVersion: '3.0.0' }` for kind `device` throws the version message, not `device plugin is missing`).
  4. the registry refuses a factory whose instance targets another major: `createRegistry()` + `register('decider', 'x', () => ({ contractVersion: '1.2.3', decide() {} }))` → `create('decider', 'x')` throws the version message.
  5. CLI: spawn `process.execPath [reflex/bin/reflex.js, 'version', '--json']` → exit 0, marker `{ ok: true, version, contracts: '0.1.0', node }`; `--version` gives the same marker; stderr contains the `versionLine`; exactly one marker line on stdout. Use `path.join(__dirname, '..', '..', 'bin', 'reflex.js')` and a `cwd` of a temp dir so no workspace is discovered.
- [x] **Step 5: Run (main session)** `npm test --prefix reflex`; then update `STATUS.md` (tick T3).

### Task 4: Types instead of a rewrite

**Files:** Create `reflex/types/plugins.d.ts`, `reflex/types/check.ts`, `reflex/types/tsconfig.json`, `reflex/test/types/typecheck.test.js`.
**Done by the main session before delegating:** `typescript` 7.0.2 installed as an exact devDependency; `package.json` has `"types": "types/plugins.d.ts"` and the script `"typecheck": "tsc -p types/tsconfig.json"`; the compiler binary is `reflex/node_modules/.bin/tsc` (`require.resolve('typescript/bin/tsc')` does NOT work: the package does not export it).

- [x] **Step 1: Create `types/plugins.d.ts`**

```ts
/**
 * plugins.d.ts — the plugin contracts of reflex (contract version 0.1.0) as TypeScript types.
 *
 * reflex itself stays JavaScript (docs/reflex/DESIGN.md D10): these declarations are for people who write a plugin, so their editor and
 * `tsc` can check it against the same contract `src/core/contracts.js` enforces at run time. Keep the two in step.
 */
export declare const CONTRACT_VERSION: string;

export type PluginKind = 'device' | 'decider' | 'account' | 'otp' | 'reporter' | 'extractor';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapshotNode {
  ref: string | null;
  pinned: string | null;
  type: string;
  role: string;
  label: string;
  value: string;
  text: string;
  identifier: string | null;
  rect: Rect | null;
  enabled: boolean;
  hittable: boolean;
  editable: boolean;
  focused: boolean;
  password: boolean;
  hintShowing: boolean;
}

export interface Snapshot {
  generation?: number;
  truncated: boolean;
  sparse: boolean;
  appBundleId: string | null;
  takenAt: number;
  /** 'uiautomator' when the screen was read through adb because agent-device could not see it (system windows). */
  source?: 'uiautomator';
  nodes: SnapshotNode[];
}

export type ActionTarget = SnapshotNode | string | { selector: string } | { x: number; y: number };

export interface Plugin {
  /** The contract version this plugin was written for; a different MAJOR than reflex's is refused when the plugin is created. */
  contractVersion?: string;
}

export interface DeviceBackend extends Plugin {
  open(options?: { app?: string; activity?: string; relaunch?: boolean; extras?: Record<string, unknown> }): Promise<unknown>;
  resetApp(options?: { app?: string; grants?: string[] }): Promise<unknown>;
  snapshot(): Promise<Snapshot>;
  press(target: ActionTarget, options?: { settle?: boolean }): Promise<unknown>;
  fill(target: ActionTarget, text: string, options?: { charDelayMs?: number }): Promise<unknown>;
  scroll(direction?: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<unknown>;
  back(): Promise<unknown>;
  screenshot(filePath: string): Promise<unknown>;
  close(): Promise<unknown>;
  meta(): Record<string, unknown>;
  swipe?(from: unknown, to: unknown): Promise<unknown>;
  clearLogcat?(): Promise<unknown>;
  readLogcat?(): Promise<string>;
}

export interface DecisionRequest {
  state: Record<string, unknown>;
  instruction: string;
  /** `{ <actionId>: <description> }`: the closed set the decider must choose from. */
  options: Record<string, string>;
}

export interface Decision {
  choice?: string;
  confidence?: number | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  latency_ms?: number;
  model?: string;
}

export interface Decider extends Plugin {
  decide(request: DecisionRequest): Promise<Decision>;
}

export interface AccountProvider extends Plugin {
  get(name: string, context?: { platform?: string; plan?: unknown; row?: unknown }): string | undefined | null;
}

export interface OtpProvider extends Plugin {
  getOtp(phone: string): Promise<string>;
}

export interface Reporter extends Plugin {
  report(summary: unknown, context?: { reportDir?: string }): Promise<unknown>;
}

export interface ContextExtractor extends Plugin {
  extract(request: { rootDir: string }): Promise<Record<string, unknown>>;
}

export interface PluginMap {
  device: DeviceBackend;
  decider: Decider;
  account: AccountProvider;
  otp: OtpProvider;
  reporter: Reporter;
  extractor: ContextExtractor;
}

export interface Registry {
  register<K extends PluginKind>(kind: K, name: string, factory: (options?: any) => PluginMap[K]): void;
  has(kind: PluginKind, name: string): boolean;
  list(kind: PluginKind): string[];
  create<K extends PluginKind>(kind: K, name: string, options?: unknown): PluginMap[K];
}
```

- [x] **Step 2: Create `types/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["plugins.d.ts", "check.ts"]
}
```

- [x] **Step 3: Create `types/check.ts`** — it compiles only if the declarations accept correct plugins and REJECT wrong ones (each `@ts-expect-error` line fails the build if the error it expects disappears):

```ts
import type { AccountProvider, ContextExtractor, Decider, DeviceBackend, OtpProvider, Registry, Reporter, Snapshot } from './plugins';

const snapshot: Snapshot = { truncated: false, sparse: false, appBundleId: null, takenAt: 0, nodes: [] };

const device: DeviceBackend = {
  contractVersion: '0.1.0',
  async open() { return { ok: true }; },
  async resetApp() { return { ok: true }; },
  async snapshot() { return snapshot; },
  async press() { return { ok: true }; },
  async fill() { return { ok: true }; },
  async scroll() { return { ok: true }; },
  async back() { return { ok: true }; },
  async screenshot() { return { ok: true }; },
  async close() { return undefined; },
  meta() { return { platform: 'android' }; },
};

const decider: Decider = {
  async decide({ options }) {
    return { choice: Object.keys(options)[0], confidence: 0.9 };
  },
};

const account: AccountProvider = { get: (name) => (name === 'phone' ? '0900000001' : undefined) };
const otp: OtpProvider = { getOtp: async () => '123456' };
const reporter: Reporter = { report: async () => undefined };
const extractor: ContextExtractor = { extract: async () => ({}) };

declare const registry: Registry;
registry.register('device', 'mine', () => device);
registry.register('decider', 'mine', () => decider);
registry.register('account', 'mine', () => account);
registry.register('otp', 'mine', () => otp);
registry.register('reporter', 'mine', () => reporter);
registry.register('extractor', 'mine', () => extractor);

const made = registry.create('device', 'mine');
made.snapshot().then((shot: Snapshot) => shot.nodes.length);

// @ts-expect-error a decider must have `decide`
const noDecide: Decider = {};
// @ts-expect-error a device factory must not return a decider
registry.register('device', 'wrong', () => decider);
// @ts-expect-error unknown plugin kind
registry.list('sensor');
// @ts-expect-error a snapshot needs its nodes
const noNodes: Snapshot = { truncated: false, sparse: false, appBundleId: null, takenAt: 0 };

export { noDecide, noNodes };
```

- [x] **Step 4: Create `test/types/typecheck.test.js`** (`node:test` + `node:assert/strict`) — cases: (1) when `reflex/node_modules/.bin/tsc` exists (`path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsc')`), `spawnSync(tsc, ['-p', path.join(__dirname, '..', '..', 'types', 'tsconfig.json')], { encoding: 'utf8' })` exits 0 with empty output; otherwise `t.skip('typescript is not installed')`; (2) a throw-away copy proves the check bites: copy `types/plugins.d.ts` and `types/tsconfig.json` into a temp dir, write a `check.ts` there that assigns `const bad: import('./plugins').OtpProvider = {};` WITHOUT an expect-error, run `tsc -p` on it and assert a non-zero exit status and `OtpProvider` in the output (skip when tsc is missing); (3) `types/plugins.d.ts` names every kind in `CONTRACTS` from `src/core/contracts.js` (read the file as text and assert that each of `Object.keys(CONTRACTS)` appears in the `PluginKind` union) and every required method of every contract appears in the d.ts text, so the types cannot silently drift from `contracts.js`.
- [x] **Step 5: Run (main session)** `npm test --prefix reflex` and `npm run typecheck --prefix reflex`; update `STATUS.md` (tick T4).

### Task 5: Leftover strings and `doctor`

**Inventory (2026-10-06, `grep -rn "old-tool" reflex/src`):** `context/build.js` (2), `util/env.js` (1 comment), `util/otpApi/index.js` (1 comment), `util/workspace.js` (comment line 2; line 160 is the LEGACY `legacy-state` state folder: KEEP),
`runner/run.js` (log prefix `[old-tool]` line 41, report title suffix line 486), `runner/recipe.js` (comment), `mcp/handlers.js` (comment), `mcp/server.js` (3: comment, server name, ready message), `cli/index.js` (comment, USAGE banner and usage line, `note(` prefixes on lines ~67, ~90, ~284),
`cli/snapshot.js` and `cli/explore.js` and `cli/screenCommands.js` (agent-device SESSION NAMES `old-tool-*`, plus a `[old-tool] explore` prefix), `jev/jevClient.js` and `device/deviceBackend.js` (install hints `npm install --prefix old-tool`), `cli/doctor.js` (3).
Tests that assert an old string: `test/device/deviceBackend.test.js:183` (the install hint). Tests that must KEEP `old-tool`: `test/core/rename.test.js` (legacy names on purpose), `test/util/workspace.test.js:88` (a temp path), `test/cli/cli.test.js:17` and `test/cli/screenCommands.test.js:22` (they run the legacy `bin/old-tool.js` shim: that is its test), fixtures `test/fixtures/workspace/**`.

**Rules:** every user-visible `old-tool` becomes `reflex`: the banner (`reflex — run agent-authored app flow plans on agent-device (decider fallback)`), `Usage: reflex <command> …`, log and error prefixes (`[reflex]`, `reflex:`), the report title suffix `(reflex)`, the MCP server `name` and ready message, hints `npm install --prefix reflex`, agent-device session names (`reflex-snapshot`, `reflex-explore`, `reflex-screen-capture`, `reflex-screen-identify`),
and comments that describe the current tool. KEEP: `legacy-state` (legacy state folder, with its explaining comment), the file `bin/old-tool.js` and any text that explains the legacy alias, and the `ACME_*` legacy names.
Run A (strings): all files above EXCEPT `cli/doctor.js`; update `test/device/deviceBackend.test.js:183` to `--prefix reflex`. Run B (doctor): `cli/doctor.js` + new `test/cli/doctor.test.js`.

**Doctor changes (Run B):** (1) the account and OTP checks are informational: level `warn`, a missing value says `not set — only needed by plans that log in`; (2) each check accepts either name: `REFLEX_TEST_PHONE` or `LEGACY_TEST_PHONE`, `REFLEX_TEST_PASSWORD` or `LEGACY_TEST_PASSWORD`, OTP token from `BYPASS_LOGIN_OTP_TOKEN` or `UAT_OTP_TOKEN` (values are never printed: only `set` / `not set`); the per-platform names (`…_ANDROID` / `…_IOS`) are listed when set under either prefix;
(3) the workspace hint says `REFLEX_PROJECT_DIR`; the daemon note says `reflex starts it`; the `npm install --prefix old-tool` hints say `reflex`. The `ok` verdict does not change for a missing account.
`test/cli/doctor.test.js` cases: with `platform: 'ios'` (no adb needed) and a scrubbed environment (save/restore every `REFLEX_TEST_*`, `LEGACY_TEST_*`, `BYPASS_LOGIN_OTP_TOKEN`, `UAT_OTP_TOKEN`, `TYPESAFE_API_KEY`): (a) nothing set → the phone/password/OTP checks exist, are `ok: false`, `level: 'warn'`, their `detail` contains `only needed by plans that log in`, and `result.ok` is not made false by them; (b) `REFLEX_TEST_PHONE` set → its check is `ok: true`, detail `set`; (c) only `LEGACY_TEST_PASSWORD` set → the password check is ok; (d) the OTP token check is ok with `UAT_OTP_TOKEN`; (e) `REFLEX_TEST_PHONE_ANDROID` set adds a `…_ANDROID` entry with `ok: true`; (f) no check `detail` or `hint` ever contains a set value (set the variables to `S3CR3T-xyz` and assert `JSON.stringify(result)` lacks it).

### Task 6: Documents (spec-level)

`docs/reflex/SHARING.md` (the checklist: run `reflex hygiene scan`, what to remove or generalise, `docs/upstream/` and `screens/acme/` are internal knowledge, licence not chosen, `git init` only after a clean scan) and `docs/reflex/CONTRACTS.md`
(per contract: which implementations exist, which were exercised by a real second app, and the verdict "v0, stays" or "v1 candidate"). Update `STATUS.md`, `ROADMAP.md`, `DESIGN.md` (D8–D11).

---

## Self-review (2026-10-06)
- Roadmap coverage: hygiene (T1, T2, T6), TypeScript decision (D10, T4), versioning (T3), plus the two backlog items that block a clean share (T5).
- T2–T6 are spec-level: their exact edits depend on the T1 baseline scan and on reading `doctor.js`/`report.js` regions first.
- Names: `hygieneScan`, `scanTree`, `loadRulesFile`, `DEFAULT_RULES`, `CONTRACT_VERSION`, `contractVersion` are used consistently.

## Result (2026-10-06)
- T1 `reflex hygiene scan` — delegated to opencode, code identical to the plan; one test bug (a rule without the `i` flag asserted case-insensitive matching). Baseline scan: 125 findings.
- T2 — code part delegated (no internal defaults in `otp.js`/`report.js`, configurable report brand, 9 tests); by hand: the shared test account, the internal OTP and upload URLs left the manifest; 7 real-looking phone numbers (21 files) became obvious fakes in every format variant; two rule files with narrow, reasoned `allow` entries.
  Scan: 125 → 0 findings. The first allow list used `*` for the whole test tree and was narrowed to specific rules so a real number cannot hide there again.
- T3 `reflex version`, `CONTRACT_VERSION`, `contractVersion` check, `package.json` 0.5.0, `CHANGELOG.md` (a test ties the changelog's top heading to `package.json`) — delegated, identical to the plan.
- T4 `types/plugins.d.ts` + `check.ts` + `npm run typecheck` (TypeScript 7.0.2; it dropped `moduleResolution: node`, found when the plan's tsconfig was compiled BEFORE delegating) — delegated, identical to the plan.
- T5 leftover `old-tool` strings in 14 files (only text changed; the legacy `legacy-state` folder code is kept on purpose) and `doctor` (account/OTP checks informational, both name prefixes, values never printed; 7 tests) — two parallel runs.
- T6 `VERSIONING.md`, `CONTRACTS.md`, `SHARING.md`, D8–D11 in `DESIGN.md`.
Suite 499/498 pass/1 skipped; `npm run typecheck` and `npm run hygiene` clean.
