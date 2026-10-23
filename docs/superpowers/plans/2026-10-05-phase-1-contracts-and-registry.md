# reflex Phase 1 — contracts and registry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (this session implements) or hand a task
> to opencode via `docs/reflex/DELEGATION.md`. Steps use checkbox (`- [ ]`) syntax. Tick them as you go and update
> `docs/reflex/STATUS.md`.

**Goal:** Make the plugin seams of `old-tool` explicit (contracts + registry) and de-Acme the naming, with **no
behaviour change**: the 299 baseline tests still pass.

**Architecture:** A small `src/core/` layer: `contracts.js` (required methods per plugin kind + `assertContract`),
`registry.js` (register/create/list with validation), `builtins.js` (today's implementations registered under
names). `run.js` and `deviceTools.js` obtain their collaborators through the registry but default to exactly what
they use today. Config may select plugins by name; absent config means today's defaults.

**Tech Stack:** Node >= 22.12, CommonJS, `node:test`, `node:assert/strict`. No new dependencies.

**Spec:** `docs/reflex/DESIGN.md` (sections "Contracts", "Registry", "Decisions").

## Global Constraints
- CommonJS, 2-space indent, single quotes, semicolons, English comments that explain why.
- No new npm dependencies. Do not edit `package-lock.json` except in T6 (package rename).
- No behaviour change: existing tests must pass unmodified (T6 may update strings they assert, see T6).
- Never read, print or write secret values (`.env`, accounts in `legacy.workspace.json`).
- Code lives under `old-tool/` until T6 renames it; tests under `reflex/test/`.
- Test command (main session only): `npm test --prefix reflex`. Baseline 2026-10-05: tests 299, pass 298, skipped 1.

## Review Focus
- A plugin that is missing one method must fail at `create` with a message naming the method, not later mid-run.
- `register` of a duplicate `kind:name` must fail loudly (silent override would hide a misconfigured workspace).
- `create` must not swallow a factory exception; it must surface the original error.
- An unknown kind and an unknown name must produce different, specific messages that list what is available.
- The default registry must work when the optional deps (`agent-device`, `@typesafe-ai/sdk`) are not installed:
  registration must be lazy (no `require` of them at registration time).

## File structure
```
reflex/src/core/contracts.js        T1  CONTRACTS, KINDS, assertContract, describeContract
reflex/src/core/registry.js         T2  createRegistry
reflex/src/core/builtins.js         T2  createDefaultRegistry (device:agent-device, device:mock)
reflex/test/core/contracts.test.js  T1
reflex/test/core/registry.test.js   T2
reflex/src/runner/run.js            T2  defaultDeps.createBackend goes through the registry (small edit)
```

---

### Task 1: Plugin contracts

**Files:**
- Create: `reflex/src/core/contracts.js`
- Create: `reflex/test/core/contracts.test.js`

**Interfaces:**
- Produces: `CONTRACTS` (object: kind → `{ required: string[], optional: string[] }`), `KINDS` (frozen array of the keys),
  `assertContract(kind, instance)` → returns `instance` or throws `Error`, `describeContract(kind)` → fresh copy of that
  kind's `{ required, optional }`.
- Consumes: nothing (tests use `createMockBackend` from `src/device/deviceBackend.js` and `createMockJev` from
  `src/jev/jevClient.js`).

Kinds and required methods (copy exactly):

| kind | required | optional |
|---|---|---|
| `device` | `open`, `resetApp`, `snapshot`, `press`, `fill`, `scroll`, `back`, `screenshot`, `close`, `meta` | `swipe`, `clearLogcat`, `readLogcat` |
| `decider` | `decide` | — |
| `account` | `get` | — |
| `otp` | `getOtp` | — |
| `reporter` | `report` | — |
| `extractor` | `extract` | — |

Error messages (exact text, tests assert them):
- unknown kind: `unknown plugin kind "<kind>" (known: device, decider, account, otp, reporter, extractor)`
- not an object: `<kind> plugin must be an object, got <null|typeof>`
- missing methods: `<kind> plugin is missing: <a>, <b>` (names in the order of `required`)

- [x] **Step 1: Write `contracts.js`**

```js
/**
 * contracts.js — the plugin contracts of reflex (v0).
 *
 * A contract is only the set of methods the core calls. It is checked when a plugin is created (registry) so a
 * half-written plugin fails with a clear message at startup instead of halfway through a device run.
 * v0 on purpose: freeze these only after a second real app has used them (docs/reflex/DESIGN.md, D7).
 */
const CONTRACTS = {
  device: {
    required: ['open', 'resetApp', 'snapshot', 'press', 'fill', 'scroll', 'back', 'screenshot', 'close', 'meta'],
    optional: ['swipe', 'clearLogcat', 'readLogcat'],
  },
  decider: { required: ['decide'], optional: [] },
  account: { required: ['get'], optional: [] },
  otp: { required: ['getOtp'], optional: [] },
  reporter: { required: ['report'], optional: [] },
  extractor: { required: ['extract'], optional: [] },
};

const KINDS = Object.freeze(Object.keys(CONTRACTS));

function assertContract(kind, instance) {
  const contract = CONTRACTS[kind];
  if (!contract) throw new Error(`unknown plugin kind "${kind}" (known: ${KINDS.join(', ')})`);
  if (instance === null || typeof instance !== 'object') {
    throw new Error(`${kind} plugin must be an object, got ${instance === null ? 'null' : typeof instance}`);
  }
  const missing = contract.required.filter((name) => typeof instance[name] !== 'function');
  if (missing.length) throw new Error(`${kind} plugin is missing: ${missing.join(', ')}`);
  return instance;
}

/** A copy, so a caller cannot change the contract by mutating what it got back. */
function describeContract(kind) {
  const contract = CONTRACTS[kind];
  if (!contract) throw new Error(`unknown plugin kind "${kind}" (known: ${KINDS.join(', ')})`);
  return { required: contract.required.slice(), optional: contract.optional.slice() };
}

module.exports = { CONTRACTS, KINDS, assertContract, describeContract };
```

- [x] **Step 2: Write `test/core/contracts.test.js`** — cases the file MUST contain (use `node:test` + `node:assert/strict`):
  1. `createMockBackend()` satisfies `assertContract('device', …)` and the same object is returned.
  2. `createMockJev(() => ({}))` does NOT satisfy `decider` (it has `ask`, not `decide`): throws `decider plugin is missing: decide`
     (documents that T3 adapts Jev).
  3. unknown kind throws the exact unknown-kind message; `KINDS` equals `['device','decider','account','otp','reporter','extractor']`
     and is frozen (`Object.isFrozen`).
  4. `null`, a string and a function each throw `<kind> plugin must be an object, got …` (`null`, `string`, `function`).
  5. an object with only `open` for `device` throws a message listing the other nine required names in order.
  6. optional methods are not required: a device object with only the ten required methods passes.
  7. `describeContract('device')` returns a copy: pushing to its `required` does not change a second call's result.
  8. each of `decider`, `account`, `otp`, `reporter`, `extractor` passes with an object that has exactly its one required method.
- [x] **Step 3: Run (main session)** `npm test --prefix reflex` → baseline 299 + new tests, 0 failures.
- [x] **Step 4: Update `docs/reflex/STATUS.md`** (tick T1).

---

### Task 2: Registry, built-ins, wiring

**Files:**
- Create: `reflex/src/core/registry.js`, `reflex/src/core/builtins.js`
- Create: `reflex/test/core/registry.test.js`
- Modify: `reflex/src/runner/run.js` (function `defaultDeps`, the `createBackend` line only)

**Interfaces:**
- Consumes: `KINDS`, `assertContract` from `./contracts`.
- Produces: `createRegistry()` → `{ register(kind, name, factory), has(kind, name), create(kind, name, options), list(kind) }`;
  `createDefaultRegistry()` → a registry with `device:agent-device` and `device:mock` registered (lazy requires).

Behaviour (messages are asserted by tests):
- `register`: unknown kind → same unknown-kind message as contracts; empty/non-string name → `plugin name must be a non-empty string`;
  non-function factory → `factory for <kind>:<name> must be a function`; duplicate → `<kind>:<name> is already registered`.
- `has(kind, name)` → boolean (false for unknown kind, no throw).
- `list(kind)` → sorted array of names (empty array when none; unknown kind throws the unknown-kind message).
- `create(kind, name, options)`: unknown kind → unknown-kind message; unknown name →
  `no <kind> plugin named "<name>" (available: <comma list or none>)`; calls `factory(options)`; a factory exception
  propagates unchanged; the result is validated with `assertContract(kind, result)` and returned.

- [x] **Step 1: Write `registry.js`**

```js
/**
 * registry.js — create plugins by kind and name, and validate them against their contract.
 *
 * Factories are synchronous and receive the options object unchanged. Nothing here knows about a device,
 * a model or an app: built-ins are registered by builtins.js, user plugins by whoever builds the registry.
 */
const { KINDS, assertContract } = require('./contracts');

function checkKind(kind) {
  if (!KINDS.includes(kind)) throw new Error(`unknown plugin kind "${kind}" (known: ${KINDS.join(', ')})`);
}

function createRegistry() {
  const factories = new Map(); // kind -> Map(name -> factory)
  for (const kind of KINDS) factories.set(kind, new Map());

  return {
    register(kind, name, factory) {
      checkKind(kind);
      if (typeof name !== 'string' || !name) throw new Error('plugin name must be a non-empty string');
      if (typeof factory !== 'function') throw new Error(`factory for ${kind}:${name} must be a function`);
      const byName = factories.get(kind);
      if (byName.has(name)) throw new Error(`${kind}:${name} is already registered`);
      byName.set(name, factory);
    },

    has(kind, name) {
      return KINDS.includes(kind) && factories.get(kind).has(name);
    },

    list(kind) {
      checkKind(kind);
      return [...factories.get(kind).keys()].sort();
    },

    create(kind, name, options) {
      checkKind(kind);
      const byName = factories.get(kind);
      const factory = byName.get(name);
      if (!factory) {
        const available = [...byName.keys()].sort().join(', ') || 'none';
        throw new Error(`no ${kind} plugin named "${name}" (available: ${available})`);
      }
      return assertContract(kind, factory(options));
    },
  };
}

module.exports = { createRegistry };
```

- [x] **Step 2: Write `builtins.js`**

```js
/**
 * builtins.js — today's implementations, registered under stable names. Requires are lazy: the optional
 * dependencies (agent-device, @typesafe-ai/sdk) may not be installed, and a registry must still build.
 */
const { createRegistry } = require('./registry');

function createDefaultRegistry() {
  const registry = createRegistry();
  registry.register('device', 'agent-device', (options) => require('../device/deviceBackend').createDeviceBackend(options));
  registry.register('device', 'mock', (options) => require('../device/deviceBackend').createMockBackend(options));
  return registry;
}

module.exports = { createDefaultRegistry };
```

- [x] **Step 3: Wire `run.js`** — in `defaultDeps`, replace only the `createBackend` default with
  `((opts) => require('../core/builtins').createDefaultRegistry().create('device', 'agent-device', opts))`. Nothing else in
  `run.js` changes.
- [x] **Step 4: Write `test/core/registry.test.js`** — cases the file MUST contain:
  1. register + create returns the validated instance and passes `options` through (factory records the argument).
  2. duplicate `register` throws `device:x is already registered`.
  3. unknown kind in `register`, `list` and `create` throws the unknown-kind message; `has` returns `false` instead.
  4. unknown name throws `no device plugin named "ghost" (available: a, b)` with sorted names, and `(available: none)` when empty.
  5. a factory returning an object missing `snapshot` makes `create` throw `device plugin is missing: snapshot`.
  6. a factory that throws `new Error('boom')` propagates `boom` unchanged.
  7. bad name (`''`, `5`) and non-function factory throw their messages.
  8. `list` is sorted.
  9. `createDefaultRegistry()` lists `['agent-device', 'mock']` for `device`, builds without `agent-device` installed
     (do not call the `agent-device` factory), and `create('device', 'mock', {})` satisfies the device contract.
- [x] **Step 5: Run (main session)** `npm test --prefix reflex` → baseline + T1 + T2 tests, 0 failures.
- [x] **Step 6: Update `STATUS.md`** (tick T2).

---

### Task 3: Decider contract + Jev adapter

**Files:**
- Create: `reflex/src/core/deciders/jev.js`
- Modify: `reflex/src/jev/resolver.js` (function `askOnce`, its `require` of `choice`)
- Modify: `reflex/src/core/builtins.js` (register `decider:jev`)
- Create: `reflex/test/core/jevDecider.test.js`

**Interfaces:**
- Consumes: `choice` from `src/jev/jevClient.js`; `assertContract` (T1); `createDefaultRegistry` (T2).
- Produces: `createJevDecider(jev)` → `{ decide({ state, instruction, options }) }` returning
  `{ choice, confidence, usage, latency_ms, model }` (`confidence` is passed through raw; it may be undefined/null);
  `askOnce({ jev, decider, … })` — a `decider` wins over `jev`; `jev` alone is wrapped with `createJevDecider`; neither → `{ error: 'jev_unavailable' }`.
  Everything else about `askOnce` (offered actions, `exclude`, `redact`, record shape, `jev_error:`/`jev_invalid_choice` messages, `confidence` null/undefined → 1) is unchanged.
  `flow.js`, `agentLoop.js`, `deviceTools.js` are NOT touched (they keep passing `jev`).

- [x] **Step 1: Create `src/core/deciders/jev.js`**

```js
/**
 * jev.js — adapt a Jev client (ask(state, questions)) to the decider contract (decide({ state, instruction, options })).
 *
 * The core asks one closed-set question: pick one id from `options` ({ id: description }). Jev answers that as a `choice`
 * question; any other model plugs in by implementing `decide` directly. Confidence is passed through untouched: deciding
 * what an absent confidence means is the caller's policy (resolver.js treats it as 1).
 */
const { choice } = require('../../jev/jevClient');

function createJevDecider(jev) {
  if (!jev || typeof jev.ask !== 'function') {
    throw new Error('createJevDecider needs a Jev client with ask(state, questions)');
  }
  return {
    async decide({ state, instruction, options }) {
      const response = await jev.ask(state, { nextAction: choice(instruction, options) });
      const answer = (response && response.answers && response.answers.nextAction) || {};
      return {
        choice: answer.choice,
        confidence: answer.confidence,
        usage: response && response.usage,
        latency_ms: response && response.latency_ms,
        model: response && response.model,
      };
    },
  };
}

module.exports = { createJevDecider };
```

- [x] **Step 2: Edit `askOnce` in `src/jev/resolver.js`** — three changes only:
  1. Replace the line `const { choice } = require('./jevClient');` with `const { createJevDecider } = require('../core/deciders/jev');`.
  2. Change the signature and the first line of the body to:
     `async function askOnce({ jev, decider = null, snapshot, state, inputs = [], exclude = () => false, redact = null }) {`
     `  const brain = decider || (jev ? createJevDecider(jev) : null);`
     `  if (!brain) return { error: 'jev_unavailable' };`
     (this replaces `if (!jev) return { error: 'jev_unavailable' };`).
  3. Replace the `try { const response = await jev.ask(...); answer = (response && response.answers && response.answers.nextAction) || {}; } catch …` block with:
     `try {`
     `  answer = (await brain.decide({ state: { ...state, screen: redactState(toJevState(snapshot), redact) }, instruction: LEG_INSTRUCTION, options: criteria })) || {};`
     `} catch (error) {`
     `  return { error: `jev_error: ${error.message || error}` };`
     `}`
  Update the doc comment above `askOnce` to say it takes a `decider` or a `jev` client. Nothing else in the file changes.

- [x] **Step 3: Edit `src/core/builtins.js`** — add inside `createDefaultRegistry`, before `return registry;`:

```js
  registry.register('decider', 'jev', (options = {}) => {
    const jev = options.jev || require('../jev/jevClient').createJevClient(options.client);
    return require('./deciders/jev').createJevDecider(jev);
  });
```

- [x] **Step 4: Create `test/core/jevDecider.test.js`** (`node:test` + `node:assert/strict`) — cases it MUST contain:
  1. `createJevDecider(createMockJev(...))` satisfies `assertContract('decider', …)`; `createJevDecider(null)` and `createJevDecider({})` throw
     `createJevDecider needs a Jev client with ask(state, questions)`.
  2. `decide` passes `state` to the Jev client unchanged and builds `{ nextAction: { type: 'choice', instructions: <instruction>, criteria: <options> } }`
     (capture with the mock's responder arguments).
  3. `decide` returns `{ choice, confidence, usage, latency_ms, model }` from the mock response (mock answers `{ nextAction: { choice: 'back', confidence: 0.7 } }`;
     assert `choice`, `confidence`, and that `model === 'mock'`).
  4. a response without `nextAction` (`{}`) gives `choice === undefined` and does not throw.
  5. an exception thrown by the Jev client propagates from `decide`.
  6. `askOnce` with a fake `decider` (records its argument, returns `{ choice: 'back', confidence: 0.9 }`): result `record.kind === 'back'`,
     `confidence === 0.9`; the decider received `instruction === LEG_INSTRUCTION` and `options` containing the keys `arrived`, `fail`, `blocked`, `back`, `wait`;
     use a snapshot built like `test/jev/resolver.test.js` (`normalizeSnapshot(fixtures.snapshot([...]), fixtures.APP)`).
  7. `decider` wins over `jev`: pass a `jev` that throws if called and a working `decider`; no throw.
  8. `askOnce({ snapshot, state })` with neither → `{ error: 'jev_unavailable' }`; a decider that throws `new Error('boom')` → `{ error: 'jev_error: boom' }`;
     a decider returning `{ choice: 'nope', confidence: 1 }` → `{ error: 'jev_invalid_choice' }`; a decider returning `{ choice: 'back' }` (no confidence) → `confidence === 1`.
  9. `createDefaultRegistry().list('decider')` equals `['jev']`, and `create('decider', 'jev', { jev: createMockJev(() => ({})) })` satisfies the contract and returns an object with `decide`.
- [x] **Step 5: Run (main session)** `npm test --prefix reflex` → 316 + new tests, 0 failures; every existing test in `test/jev/`, `test/runner/`, `test/device/` unchanged and passing.
- [x] **Step 6: Update `STATUS.md`** (tick T3).

---

### Task 4: AccountProvider

**Files:**
- Create: `reflex/src/core/accounts/env.js`
- Modify: `reflex/src/plan/data.js` (function `resolveRowData`: the account block and its `require`)
- Modify: `reflex/src/core/builtins.js` (register `account:env`)
- Create: `reflex/test/core/envAccounts.test.js`

**Interfaces:**
- Consumes: `workspace.defaults(platform)` (today's chain: `LEGACY_TEST_<NAME>_<PLATFORM>` → `LEGACY_TEST_<NAME>` → manifest `defaults.account`; unchanged, still in `src/util/workspace.js`).
- Produces: `createEnvAccountProvider({ workspace, env = process.env, prefixes = ['REFLEX_TEST_'] })` → `{ get(name, { platform }) }` returning a non-empty string or `undefined`.
  Order: for each prefix (in order) `<PREFIX><NAME>_<PLATFORM>` then `<PREFIX><NAME>` (name and platform upper-cased; no platform → no suffix);
  then `workspace.defaults(platform).account[name]` (so existing `LEGACY_TEST_*` and the manifest keep working, D4). Empty strings count as absent.
  A throwing `workspace.defaults` (no workspace root) is swallowed and treated as "no account" (exactly as `resolveRowData` does today).
  `resolveRowData(plan, row, { workspace, platform, accounts = null })`: `accounts` defaults to `createEnvAccountProvider({ workspace })`; the
  loop over `ACCOUNT_INPUTS` (phone, password, pin) asks `accounts.get(name, { platform })` for inputs the plan declares and the row left empty.
  Everything else (row columns, `{env:VAR}`, the 6-digit password → pin rule, input `default`, `required` errors, `secretKeys`) is unchanged.

- [x] **Step 1: Create `src/core/accounts/env.js`**

```js
/**
 * env.js — the default account provider: where a test account's phone / password / PIN come from.
 *
 * REFLEX_TEST_* wins (D4); anything else falls through to the workspace chain that existed before
 * (LEGACY_TEST_* env, then the manifest's defaults.account), so existing workspaces and .env files keep working.
 * A value is never put in an error message: they are phones, passwords and PINs.
 */
function envKey(prefix, name, platform) {
  const base = `${prefix}${String(name).toUpperCase()}`;
  return platform ? `${base}_${String(platform).toUpperCase()}` : base;
}

function present(value) {
  return value !== undefined && value !== null && value !== '' ? String(value) : undefined;
}

function createEnvAccountProvider({ workspace, env = process.env, prefixes = ['REFLEX_TEST_'] } = {}) {
  return {
    get(name, { platform } = {}) {
      for (const prefix of prefixes) {
        const specific = platform ? present(env[envKey(prefix, name, platform)]) : undefined;
        if (specific !== undefined) return specific;
        const shared = present(env[envKey(prefix, name)]);
        if (shared !== undefined) return shared;
      }
      let account = {};
      try {
        account = (workspace && workspace.defaults(platform).account) || {};
      } catch (_) {
        account = {}; // no workspace root: the plan's own data has to carry the value
      }
      return present(account[name]);
    },
  };
}

module.exports = { createEnvAccountProvider };
```

- [x] **Step 2: Edit `src/plan/data.js`** — (a) add `const { createEnvAccountProvider } = require('../core/accounts/env');` next to the existing `require`;
  (b) change the signature to `function resolveRowData(plan, row, { workspace, platform, accounts = null }) {`;
  (c) replace the block that declares `let account = {}` through the `for (const name of ACCOUNT_INPUTS) { … }` loop with:

```js
  const provider = accounts || createEnvAccountProvider({ workspace });
  for (const name of ACCOUNT_INPUTS) {
    if (!inputNames.has(name) || !isEmpty(data[name])) continue;
    const value = provider.get(name, { platform });
    if (!isEmpty(value)) data[name] = String(value);
  }
```
  Keep the line `const inputNames = new Set(...)` that precedes it, and keep the 6-digit-pin rule, the input-default loop and `return data;` exactly as they are. Update the header comment's fallback chain to mention REFLEX_TEST_* first.

- [x] **Step 3: Edit `src/core/builtins.js`** — add before `return registry;`:

```js
  registry.register('account', 'env', (options = {}) => require('./accounts/env').createEnvAccountProvider(options));
```

- [x] **Step 4: Create `test/core/envAccounts.test.js`** (`node:test` + `node:assert/strict`) — cases it MUST contain (use an injected `env` object, never `process.env`; fake workspace = `{ defaults: (platform) => { seen.push(platform); return { account: { phone: 'ws-phone', password: 'ws-pass' } }; } }`):
  1. `createEnvAccountProvider({ workspace })` satisfies `assertContract('account', …)`.
  2. precedence: `REFLEX_TEST_PHONE_ANDROID` beats `REFLEX_TEST_PHONE` beats the workspace value, for platform `android`; with platform `ios` the android value is ignored.
  3. no REFLEX env → the workspace value, and `workspace.defaults` was called with the platform that was passed.
  4. no platform → the un-suffixed name only (`REFLEX_TEST_PHONE_ANDROID` set but `get('phone')` ignores it).
  5. a throwing `workspace.defaults` → `get` returns `undefined`, no throw; also `workspace` omitted → `undefined`.
  6. empty-string env and empty-string workspace values count as absent (next source wins / `undefined`).
  7. a custom `prefixes: ['A_', 'B_']` checks `A_PHONE` before `B_PHONE`; unknown names (`'otp'`) return `undefined`.
  8. `resolveRowData` with `accounts: { get: (name) => ({ phone: 'p1', password: 'pw' })[name] }`: a row without phone gets `p1`; a row that carries its own phone keeps it; the missing `pin` input stays absent when `password` is not 6 digits; with `password: '123456'` and a declared `pin` input, pin becomes `'123456'` (existing rule).
  9. a missing required input throws exactly `plan "x" requires input "phone"` even when the provider holds other secrets — the message contains none of their values.
  10. `createDefaultRegistry().list('account')` equals `['env']` and `create('account', 'env', { workspace })` satisfies the contract.
- [x] **Step 5: Run (main session)** `npm test --prefix reflex` → 325 + new tests, 0 failures; `test/plan/plan.test.js` and `test/util/*` unchanged and passing.
- [x] **Step 6: Update `STATUS.md`** (tick T4).

---

### Task 5: OtpProvider and Reporters

**Files:**
- Create: `reflex/src/core/otp/uatApi.js`
- Create: `reflex/src/core/reporters/upload.js`
- Create: `reflex/src/core/reporters/googleChat.js`
- Modify: `reflex/src/device/deviceTools.js` (only the `fetchOtp` line near line 76)
- Modify: `reflex/src/core/builtins.js` (register `otp:uat-api`, `reporter:upload`, `reporter:google-chat`)
- Create: `reflex/test/core/otpAndReporters.test.js`

**Context found while reading (2026-10-05):** `uploadReport(reportDir, endpoint, options)` and `notifyGoogleChat(text, webhook)` /
`shouldNotifyGoogleChat()` in `src/report/report.js` have NO callers in `src/` and NO tests; `report.js` is not changed in this task.
`deviceTools.createDeviceSession({ otpProvider })` accepts a FUNCTION `(phone) => Promise<string>` today; existing tests pass a function.
`src/util/otpApi/otp.js` exports `getOtp(phoneNumber, options)`. `report.js` still has a hard-coded internal upload IP
(`DEFAULT_UPLOAD_ENDPOINT`): that is a hygiene item for Phase 5, do not touch it here.

**Interfaces:**
- Produces: `createUatApiOtpProvider({ getOtp = null })` → `{ getOtp(phone) }` (`getOtp` defaults to a lazy call of `src/util/otpApi` `otp.getOtp`);
  `createUploadReporter({ upload = null, endpoint = null, options = {} })` → `{ name: 'upload', report(summary, { reportDir }) }`;
  `createGoogleChatReporter({ notify = null, shouldNotify = null, webhook = null, format = defaultText })` → `{ name: 'google-chat', report(summary) }`.
  `createDeviceSession({ otpProvider })` accepts a function (as today) OR an object with `getOtp`; when absent it uses the registry's `otp:uat-api`.

- [x] **Step 1: Create `src/core/otp/uatApi.js`**

```js
/**
 * uatApi.js — the OTP provider backed by the Acme UAT OTP API (src/util/otpApi).
 *
 * The HTTP client is required lazily: a run that never reaches an OTP screen must not load network code.
 * `getOtp` can be injected so tests and other apps can supply their own source.
 */
function createUatApiOtpProvider({ getOtp = null } = {}) {
  const fetchOtp = getOtp || ((phone) => require('../../util/otpApi').otp.getOtp(phone));
  return {
    async getOtp(phone) {
      return fetchOtp(phone);
    },
  };
}

module.exports = { createUatApiOtpProvider };
```

- [x] **Step 2: Create `src/core/reporters/upload.js`**

```js
/**
 * upload.js — the reporter that uploads a finished report directory to an HTTP endpoint (report.js uploadReport).
 *
 * report.js is large, so it is required only when a report is actually sent. `upload` can be injected for tests.
 */
function createUploadReporter({ upload = null, endpoint = null, options = {} } = {}) {
  const send = upload || ((reportDir, target, opts) => require('../../report/report').uploadReport(reportDir, target, opts));
  return {
    name: 'upload',
    async report(summary, { reportDir } = {}) {
      if (!reportDir) throw new Error('upload reporter needs a reportDir');
      return send(reportDir, endpoint || undefined, options);
    },
  };
}

module.exports = { createUploadReporter };
```

- [x] **Step 3: Create `src/core/reporters/googleChat.js`**

```js
/**
 * googleChat.js — the reporter that posts a one-line run summary to a Google Chat webhook (report.js notifyGoogleChat).
 *
 * It does nothing unless delivery is switched on (NOTIFY_CHAT env or the workspace's report.notifyChat), exactly like
 * report.js decides today. `notify`, `shouldNotify` and `format` can be injected for tests and other chat formats.
 */
function defaultText(summary) {
  const name = (summary && (summary.plan || summary.name)) || 'run';
  const status = (summary && summary.status) || 'unknown';
  return `*${name}* — ${status}`;
}

function createGoogleChatReporter({ notify = null, shouldNotify = null, webhook = null, format = defaultText } = {}) {
  const post = notify || ((text, hook) => require('../../report/report').notifyGoogleChat(text, hook));
  const enabled = shouldNotify || (() => require('../../report/report').shouldNotifyGoogleChat());
  return {
    name: 'google-chat',
    async report(summary) {
      if (!enabled()) return { skipped: true };
      return post(format(summary), webhook || undefined);
    },
  };
}

module.exports = { createGoogleChatReporter, defaultText };
```

- [x] **Step 4: Edit `src/device/deviceTools.js`** — replace ONLY the line
  `const fetchOtp = otpProvider || ((phone) => require('../util/otpApi').otp.getOtp(phone));` with:

```js
  let defaultOtp = null;
  const fetchOtp = typeof otpProvider === 'function'
    ? otpProvider
    : otpProvider
      ? (phone) => otpProvider.getOtp(phone)
      : (phone) => {
        defaultOtp = defaultOtp || require('../core/builtins').createDefaultRegistry().create('otp', 'uat-api', {});
        return defaultOtp.getOtp(phone);
      };
```
  Keep the comment above it. Change nothing else in the file.

- [x] **Step 5: Edit `src/core/builtins.js`** — add before `return registry;`:

```js
  registry.register('otp', 'uat-api', (options = {}) => require('./otp/uatApi').createUatApiOtpProvider(options));
  registry.register('reporter', 'upload', (options = {}) => require('./reporters/upload').createUploadReporter(options));
  registry.register('reporter', 'google-chat', (options = {}) => require('./reporters/googleChat').createGoogleChatReporter(options));
```

- [x] **Step 6: Create `test/core/otpAndReporters.test.js`** (`node:test` + `node:assert/strict`; never call the network, never spawn curl) — cases it MUST contain:
  1. `createUatApiOtpProvider({ getOtp })` satisfies `assertContract('otp', …)`; `getOtp('0900')` calls the injected function with `'0900'` and returns its value; a rejection propagates with its message.
  2. `createUploadReporter({ upload })`: `report({ status: 'pass' }, { reportDir: '/r' })` calls `upload('/r', undefined, {})` and returns its result; with `endpoint: 'http://x'` and `options: { singleFile: true }` it passes both; without `reportDir` it throws `upload reporter needs a reportDir`; the object satisfies `assertContract('reporter', …)`.
  3. `createGoogleChatReporter`: `shouldNotify: () => false` → result `{ skipped: true }` and `notify` never called; `shouldNotify: () => true` → `notify` called once with `('*p* — pass', undefined)` for summary `{ plan: 'p', status: 'pass' }`; with `webhook: 'http://hook'` it is passed as the second argument; a custom `format` is used; it satisfies the `reporter` contract.
  4. `defaultText({})` → `*run* — unknown`; `defaultText({ name: 'n', status: 'fail' })` → `*n* — fail`; `defaultText(null)` → `*run* — unknown`.
  5. `createDeviceSession` with `otpProvider` as an object `{ getOtp }`: build a session the same way `test/device/deviceTools.test.js` does for `fill_otp_from_api` (copy its `sessionFor`/OTP fixtures) and prove the object provider's `getOtp` is called with the phone and the OTP is typed. (If copying the fixtures is impractical, instead assert only that `createDeviceSession({ backend: createMockBackend(), otpProvider: { getOtp() {} } })` does not throw.)
  6. `createDefaultRegistry()` lists `otp` → `['uat-api']` and `reporter` → `['google-chat', 'upload']`; `create('otp', 'uat-api', { getOtp: async () => '1234' })` and both reporters satisfy their contracts.
- [x] **Step 7: Run (main session)** `npm test --prefix reflex` → 335 + new tests, 0 failures; `test/device/deviceTools.test.js` unchanged and passing.
- [x] **Step 8: Update `STATUS.md`** (tick T5) and add the hard-coded upload IP to the hygiene list in `DESIGN.md`.

---

### Task 6: Rename to reflex (split T6a code · T6b folder/package · T6c docs)

Inventory (2026-10-05): `old-tool` appears in 16 src / 6 test / 2 bin files; `the old marker name` in 3 src, 3 test files; `legacy.workspace.json`
in 5 src files; env names `LEGACY_PROJECT_DIR`, `LEGACY_JS_REPO`, `LEGACY_HOME`; state dir `legacy-state`; pointer file `~/.legacy/app-testing/js_repo.txt`.
Account env names (`LEGACY_TEST_PHONE/PASSWORD/PIN`) were handled in T4 (`REFLEX_TEST_*` first). Principle: every old name keeps working
as a FALLBACK; only what the tool prints changes (`REFLEX_JSON`). Cosmetic strings (help text, doctor, mcp descriptions, plan/validate
messages that mention `legacy.workspace.json`) are left for T6c / later.

#### T6a — code (delegated)

**Files:**
- Modify: `old-tool/src/util/markers.js`, `old-tool/src/runner/run.js`, `old-tool/src/cli/index.js`, `old-tool/src/util/workspace.js`
- Create: `old-tool/test/core/rename.test.js`
- Main session (mechanical, not delegated): in `test/runner/run.test.js`, `test/cli/cli.test.js`, `test/cli/screenCommands.test.js` replace the
  marker string `the old marker name` by `REFLEX_JSON`; in `test/util/workspace.test.js` add `'REFLEX_PROJECT_DIR'` and `'REFLEX_HOME'` to `ENV_KEYS` and change the two
  regexes `does not contain legacy.workspace.json` to `does not contain reflex.workspace.json \\(or legacy.workspace.json\\)`.

- [x] **Step 1: Replace `src/util/markers.js`** entirely with:

```js
/**
 * markers.js — the single machine-readable stdout marker: `REFLEX_JSON <one-line json>`.
 *
 * `the old marker name` is the pre-rename name. It is no longer printed, but parseMarker still reads it so old logs and
 * consumers keep working.
 */
const MARKER = 'REFLEX_JSON';
const LEGACY_MARKER = 'the old marker name';

function parseMarker(line) {
  const text = String(line || '');
  for (const name of [MARKER, LEGACY_MARKER]) {
    if (!text.startsWith(`${name} `)) continue;
    try {
      return JSON.parse(text.slice(name.length + 1));
    } catch (_) {
      return null;
    }
  }
  return null;
}

module.exports = { MARKER, LEGACY_MARKER, parseMarker };
```

- [x] **Step 2: Edit `src/runner/run.js`** — `const { ACME_TEST } = require('../util/markers');` → `const { MARKER } = require('../util/markers');`;
  in `printMarker` use `${MARKER}` instead of `${ACME_TEST}`; in the header comment replace `the old marker name` by `REFLEX_JSON`. Nothing else.
- [x] **Step 3: Edit `src/cli/index.js`** — the same three changes (require, the `process.stdout.write` line, the header comment).
- [x] **Step 4: Edit `src/util/workspace.js`** (exact edits; keep everything not listed):
  1. Replace `const MANIFEST_NAME = 'legacy.workspace.json';` with:
     `// reflex.workspace.json is canonical; legacy.workspace.json is read as a fallback so existing workspaces keep working.`
     `const MANIFEST_NAMES = ['reflex.workspace.json', 'legacy.workspace.json'];`
     `const MANIFEST_LABEL = 'reflex.workspace.json (or legacy.workspace.json)';`
  2. Replace `function isWorkspace(dir) {…}` with:
```js
function manifestPath(dir) {
  if (!dir) return null;
  for (const name of MANIFEST_NAMES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function isWorkspace(dir) {
  return manifestPath(dir) !== null;
}

/** REFLEX_<name> wins over the pre-rename ACME_<name>. */
function envOf(name) {
  return process.env[`REFLEX_${name}`] || process.env[`ACME_${name}`] || '';
}
```
  3. In `expandHome` and `pointerFile` replace `process.env.LEGACY_HOME || os.homedir()` by `envOf('HOME') || os.homedir()`; replace the body of `pointerFile` with:
```js
function pointerFile() {
  const home = envOf('HOME') || os.homedir();
  for (const folder of ['.reflex', '.acme']) {
    const file = path.join(home, folder, 'app-testing', 'js_repo.txt');
    if (!fs.existsSync(file)) continue;
    const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((item) => item.trim()).find(Boolean);
    if (!line) continue;
    const dir = path.resolve(expandHome(line));
    if (isWorkspace(dir)) return dir;
  }
  return null;
}
```
  4. In `tryRoot`: replace the `const envName = …` line with
     `const envName = ['REFLEX_PROJECT_DIR', 'LEGACY_PROJECT_DIR', 'LEGACY_JS_REPO'].find((name) => (process.env[name] || '').trim()) || null;`
     and every `${MANIFEST_NAME}` in the three error messages (`--workspace … does not contain`, `${envName}=… does not contain`) by `${MANIFEST_LABEL}`;
     in `root()` the final message becomes `…set REFLEX_PROJECT_DIR, or cd into a directory containing reflex.workspace.json.`
  5. In `manifest()` read `manifestPath(dir)` instead of `path.join(dir, MANIFEST_NAME)`.
  6. Replace `function stateDir() {…}` with:
```js
function stateDir() {
  const legacy = path.join(root(), 'legacy-state');
  return fs.existsSync(legacy) ? legacy : path.join(root(), '.reflex');
}
```
  7. In `module.exports` replace `MANIFEST_NAME,` by `MANIFEST_NAME: MANIFEST_NAMES[0],`. Update the header comment (resolution order mentions `REFLEX_PROJECT_DIR`, `~/.reflex/app-testing/js_repo.txt`, the manifest names).
- [x] **Step 5: Create `test/core/rename.test.js`** (`node:test` + `node:assert/strict`; use temp dirs from `fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-rename-'))`; save and restore `process.env` keys `REFLEX_PROJECT_DIR`, `LEGACY_PROJECT_DIR`, `LEGACY_JS_REPO`, `REFLEX_HOME`, `LEGACY_HOME` and call `workspace.reset()` in a `beforeEach`/`afterEach`-style helper) — cases it MUST contain:
  1. `MARKER === 'REFLEX_JSON'`, `LEGACY_MARKER === 'the old marker name'`; `parseMarker('REFLEX_JSON {"a":1}')` → `{ a: 1 }`; `parseMarker('the old marker name {"a":2}')` → `{ a: 2 }`.
  2. `parseMarker` returns `null` for `''`, `null`, `'hello'`, `'REFLEX_JSON {broken'`, and for a prefix without the space (`'REFLEX_JSON{"a":1}'`).
  3. a directory with only `reflex.workspace.json` is a workspace (`REFLEX_PROJECT_DIR=<dir>` → `workspace.root()` equals it); the same with only `legacy.workspace.json`.
  4. when both manifests exist, `workspace.manifest()` returns the `reflex.workspace.json` content (write `{ "name": "new" }` vs `{ "name": "old" }`).
  5. env precedence: with `REFLEX_PROJECT_DIR=A`, `LEGACY_PROJECT_DIR=B`, `LEGACY_JS_REPO=C` (three workspaces) root is A; without the first, B; without the second, C.
  6. a non-workspace `REFLEX_PROJECT_DIR` throws a message that contains `REFLEX_PROJECT_DIR=` and `reflex.workspace.json (or legacy.workspace.json)`.
  7. pointer file: with `REFLEX_HOME=<tmp>` and `<tmp>/.reflex/app-testing/js_repo.txt` naming a workspace, no env project dir, and cwd that is not inside a workspace (use `process.chdir` to another temp dir and restore) → root is that workspace; a pointer at `<tmp>/.acme/app-testing/js_repo.txt` works when `.reflex` has none.
  8. `workspace.stateDir()` ends with `.reflex` normally and with `legacy-state` when that folder already exists in the workspace root.
- [x] **Step 6: Main session** apply the four mechanical test edits above, then `node --check` every touched file, then `npm test --prefix old-tool` → 341 + new tests, 0 failures.
- [x] **Step 7: Update `STATUS.md`** (T6a done).

#### T6b — folder, package, bin (main session, no delegation)

- [x] `mv old-tool reflex` (with `node_modules`); in `reflex/package.json` set `"name": "reflex-test"`, `"description"` (generic), `"bin": { "reflex": "bin/reflex.js", "old-tool": "bin/reflex.js" }`; `mv bin/old-tool.js bin/reflex.js`; keep a one-line `bin/old-tool.js` that does `require('./reflex');`.
- [x] `npm install --package-lock-only --prefix reflex` (name change only); `npm test --prefix reflex` green with the same count.
- [x] Update every path/command in `AGENTS.md`, `README.md`, `docs/reflex/*`, `docs/superpowers/plans/2026-10-05-*.md`: `old-tool/` → `reflex/`, `npm test --prefix old-tool` → `npm test --prefix reflex`, `node ../old-tool/bin/old-tool.js` → `node ../reflex/bin/reflex.js`, `the old marker name` → `REFLEX_JSON`.
- [x] Rename `workspace/legacy.workspace.json` → `workspace/reflex.workspace.json` (the code reads both).

#### T6c — docs and cosmetics (main session)

- [x] `reflex/README.md`, `docs/reflex/DESIGN.md` D3/D4 status "done", `STATUS.md` (Phase 1 done, next = Phase 2 plan), ROADMAP table.
- [x] Optional later: reword help/doctor/mcp/plan-validate strings that still say `legacy.workspace.json` / `old-tool`.

**Acceptance for T6 overall:** `npm test --prefix reflex` green (341 + new), `reflex` and `old-tool` bins both start (`node reflex/bin/reflex.js doctor --platform android` runs without crashing on a missing device), the CLI prints `REFLEX_JSON`, old workspaces/env/pointer files still resolve.

---

## Self-review (2026-10-05)
- Spec coverage: contracts (T1), registry + config selection hook (T2; selecting by manifest is wired in T3–T5 where a second
  implementation exists), decider/account/otp/reporter (T3–T5), naming (T6). Extractor contract exists (T1) but no built-in yet.
- T3–T6 are intentionally spec-level: their exact code depends on T1/T2 landing and on re-reading `resolver.js`,
  `plan/data.js`, `report.js`. Write their detailed steps at the start of each task (writing-plans skill).
- Type consistency: kinds and method names above are the single source; `DESIGN.md` table must match `contracts.js`.
