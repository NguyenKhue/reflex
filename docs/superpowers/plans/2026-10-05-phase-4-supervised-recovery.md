# reflex Phase 4 — supervised recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (this session implements) or hand a task to opencode via
> `docs/reflex/DELEGATION.md`. Steps use checkbox (`- [ ]`) syntax. Tick them as you go and update `docs/reflex/STATUS.md`.

**Goal:** When a run stops with `needs_agent`, an agent can look at it, fix the knowledge and let the run continue — WITHOUT the agent ever entering credentials, and
with every knowledge change kept provisional until a human approves it.

**Architecture:** (1) a static **sensitivity** analysis says which legs of a plan enter credentials (`src/supervisor/sensitivity.js`); (2) the tool itself enforces
the agent boundary: runs and resumes started as an agent (`--agent`, always for MCP) are refused when they would run a sensitive leg, and `resume.json` records which remaining legs are sensitive;
(3) a **handoff** document is written for the agent (`handoff.json` / `handoff.md`); (4) the agent's knowledge edits are **snapshotted and diffed** (`screens/<app>/` + `_shared`) so a human can
approve or reject them; (5) `reflex supervise` runs the loop for a human or CI: run → on exit 3 → handoff → configured agent command → diff → resume, bounded by a round limit.

**Tech Stack:** Node >= 22.12, CommonJS, `node:test`, `diff` (BSD/GNU, `-u --label`, verified on macOS). No new npm dependencies.

**Spec:** `docs/reflex/ROADMAP.md` (Phase 4), `AGENTS.md` ("Safety boundaries for the agent"), `docs/reflex/DESIGN.md` D6.

## Global Constraints
- Package folder `reflex/`; tests `reflex/test/`. Test command (main session only): `npm test --prefix reflex`. Baseline before this phase: 403 tests, 402 pass, 1 skipped.
- CommonJS, 2-space indent, single quotes, semicolons, English comments that explain why. Every file ends with a newline.
- The agent never enters credentials and never starts a run/resume that does. This phase turns that rule into tool behaviour; it does not weaken it. The human/CI-started `reflex supervise` may resume sensitive legs
  (secrets come from the environment of the human/CI process), the agent process may not.
- Nothing written for the agent (`handoff.*`, diffs, `supervisor.json`) contains input values, passwords, PINs, OTPs, tokens, captures or screen text beyond what `resume.json` already holds (`visibleText` excludes editable fields).
- No git in this repo: snapshots/diffs are file-based (see AGENTS.md "Version control").
- Exit codes keep their meaning: 0 pass, 1 fail/blocked/error/invalid/refused, 3 needs_agent.

## Review Focus
- A leg whose route to `to` is unknown to the knowledge base must count as sensitive when the plan declares any secret input (the decider could walk into a credential screen).
- A refused run/resume must leave no side effect: no `reports/<runId>/` directory, no device session, no knowledge write.
- An agent edit to `screens/_shared/` (policy) must never survive: it is detected and the whole round is rejected and restored.
- `reject` must restore the app's screens byte-for-byte from the snapshot, including deleting files the agent added.
- A supervisor loop must terminate: `maxRounds`, a non-zero agent exit code, a timeout, and "agent changed nothing" all stop it.
- No secret can reach `handoff.*`: a `resume.json` carrying `captures`/`data` fields must not leak them into the handoff.

## File structure
```
reflex/src/supervisor/sensitivity.js          T1  legSensitivity, planSensitivity, sensitiveLegsFrom
reflex/src/plan/loader.js                     T1  leg key `sensitive` (explicit marker)
reflex/src/cli/planCommands.js                T1  `plan validate` reports `sensitive`
reflex/test/supervisor/sensitivity.test.js    T1
reflex/src/runner/run.js                      T2  `actor` guard + `sensitive` in resume.json
reflex/src/cli/index.js                       T2  `--agent` flag for run/resume
reflex/src/mcp/handlers.js                    T2  pre-check + `--agent` for run_start / resume_start
reflex/test/supervisor/guards.test.js         T2
reflex/src/supervisor/handoff.js              T3  buildHandoff, writeHandoff
reflex/test/supervisor/handoff.test.js        T3
reflex/src/supervisor/knowledgeSnapshot.js    T4  snapshotKnowledge, diffKnowledge, restoreKnowledge
reflex/test/supervisor/knowledgeSnapshot.test.js  T4
reflex/src/supervisor/supervise.js            T5  superviseRun, approveRun, rejectRun   (+ cli wiring)
docs/reflex/SUPERVISION.md                    T6
```

---

### Task 1: Sensitivity analysis

**Files:**
- Create: `reflex/src/supervisor/sensitivity.js`, `reflex/test/supervisor/sensitivity.test.js`
- Modify: `reflex/src/plan/loader.js` (accept the leg key `sensitive`), `reflex/src/cli/planCommands.js` (`planValidate` result)

**Context (read 2026-10-05):** a plan is `{ name, inputs: [{ name, secret? }], flow: [{ at, to, intent?, steps?, checks?, data? }] }` (`plan/loader.js`, legs normalised by `normalizeLeg`, allowed keys in `LEG_KEYS`).
`plan/data.js` exports `secretKeys(plan)` = inputs marked `secret: true` plus `password`, `pin`, `otp`. A store (`loadStore`) has `screens: Map(id -> { id, inputs: string[], normal: [{ to, steps }] })` and `routes: string[][]`
(observed multi-hop paths). A multi-hop leg (`login_phone → home`) has no direct case: the route runs through screens that take the password, so the analysis walks the graph of known hops.

**Interfaces:**
- Produces: `legSensitivity(plan, store, index)` → `{ index, at, to, sensitive, reasons }`; `planSensitivity(plan, store)` → `{ sensitive, legs }` (only sensitive legs, each as above);
  `sensitiveLegsFrom(plan, store, fromIndex)` → the sensitive legs with `index >= fromIndex`. `store` may be `null` (then only `explicit` and `own-steps` can apply).
- Reasons (strings, tests assert them): `explicit` (leg key `sensitive: true`), `own-steps` (the leg's own `steps`/`checks` use a `{secretName}` placeholder),
  `screen-input:<id>` (a screen on a known path from `at` to `to`, `to` excluded, declares a secret input), `case-step:<id>` (a case between screens of that path uses a `{secretName}` placeholder),
  `unknown-route` (no known path from `at` to `to` AND the plan declares a secret input), `screen-name` (`at` is a screen named like `…pin`, `…password`, `…otp`, `…passcode`).
- `plan validate` result gains `sensitive: { sensitive, legs }`.

- [x] **Step 1: Create `src/supervisor/sensitivity.js`**

```js
/**
 * sensitivity.js — which legs of a plan enter credentials.
 *
 * The agent must never enter a password, PIN or OTP, so the tool has to know which legs do. A leg is sensitive when its own
 * steps use a secret placeholder, when it is marked `sensitive: true`, or when a screen on a known path from `at` to `to`
 * takes a secret input or has a case whose steps use one. When no known path exists a decider or an agent chooses the route and
 * could walk into a credential screen, so the leg counts as sensitive if the plan declares any secret input at all.
 */
const { secretKeys } = require('../plan/data');

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SCREEN_NAME = /(^|[_/])(pin|password|otp|passcode)([_/]|$)/i;

function placeholdersOf(value, found = new Set()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER)) found.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) placeholdersOf(item, found);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) placeholdersOf(item, found);
  }
  return found;
}

function usesSecret(value, secrets) {
  for (const name of placeholdersOf(value)) if (secrets.has(name)) return true;
  return false;
}

/** from -> Set(to): the hops of every known case plus the observed routes. */
function edgesOf(store) {
  const edges = new Map();
  const add = (from, to) => {
    if (!from || !to) return;
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  };
  if (store && store.screens) {
    for (const screen of store.screens.values()) for (const item of screen.normal || []) add(screen.id, item.to);
  }
  for (const route of (store && store.routes) || []) {
    for (let i = 0; i + 1 < route.length; i += 1) add(route[i], route[i + 1]);
  }
  return edges;
}

function reverseOf(edges) {
  const back = new Map();
  for (const [from, targets] of edges) {
    for (const to of targets) {
      if (!back.has(to)) back.set(to, new Set());
      back.get(to).add(from);
    }
  }
  return back;
}

function reach(start, edges) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const node = queue.shift();
    for (const next of edges.get(node) || []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

function legSensitivity(plan, store, index) {
  const leg = plan.flow[index];
  const secrets = secretKeys(plan);
  const reasons = [];
  if (leg.sensitive === true) reasons.push('explicit');
  if (usesSecret(leg.steps, secrets) || usesSecret(leg.checks, secrets)) reasons.push('own-steps');
  if (SCREEN_NAME.test(String(leg.at || ''))) reasons.push('screen-name');
  if (store && leg.at && leg.to) {
    const edges = edgesOf(store);
    const forward = reach(leg.at, edges);
    if (!forward.has(leg.to)) {
      if ((plan.inputs || []).some((input) => secrets.has(input.name))) reasons.push('unknown-route');
    } else {
      const backward = reach(leg.to, reverseOf(edges));
      const onPath = (id) => forward.has(id) && backward.has(id);
      for (const id of forward) {
        if (id === leg.to || !onPath(id)) continue;
        const screen = store.screens.get(id);
        if (!screen) continue;
        if ((screen.inputs || []).some((name) => secrets.has(name))) reasons.push(`screen-input:${id}`);
        if ((screen.normal || []).some((item) => onPath(item.to) && usesSecret(item.steps, secrets))) reasons.push(`case-step:${id}`);
      }
    }
  }
  return { index, at: leg.at || null, to: leg.to || null, sensitive: reasons.length > 0, reasons };
}

function sensitiveLegsFrom(plan, store, fromIndex = 0) {
  const legs = [];
  for (let index = Math.max(0, fromIndex); index < (plan.flow || []).length; index += 1) {
    const result = legSensitivity(plan, store, index);
    if (result.sensitive) legs.push(result);
  }
  return legs;
}

function planSensitivity(plan, store) {
  const legs = sensitiveLegsFrom(plan, store, 0);
  return { sensitive: legs.length > 0, legs };
}

module.exports = { legSensitivity, planSensitivity, sensitiveLegsFrom };
```

- [x] **Step 2: Edit `src/plan/loader.js`** — add `'sensitive'` to `LEG_KEYS` (`const LEG_KEYS = new Set(['at', 'to', 'intent', 'steps', 'checks', 'data', 'sensitive']);`), and in `normalizeLeg` accept it:
  if `leg.sensitive !== undefined && typeof leg.sensitive !== 'boolean'` throw `${where}: "sensitive" must be true or false`; include `...(leg.sensitive === undefined ? {} : { sensitive: leg.sensitive })` in the returned leg next to `steps`/`checks`.
  Read `normalizeLeg` (around lines 115-145) first and follow its existing style exactly. Nothing else in the loader changes.
- [x] **Step 3: Edit `src/cli/planCommands.js`** — in `planValidate`, `require('../supervisor/sensitivity')` and add `sensitive: planSensitivity(loaded, store || null)` to the returned object (after `rows`). No other change.
- [x] **Step 4: Create `test/supervisor/sensitivity.test.js`** (`node:test` + `node:assert/strict`; hand-made plan and store objects; a store helper `storeOf({ screens: { id: { inputs, normal } }, routes })` building `{ screens: new Map(...), routes }` with `id` set on each screen) — cases it MUST contain:
  1. a leg whose known path crosses a screen with `inputs: ['password']` is sensitive with the reason `screen-input:core/login_password` (graph: `core/login_phone → core/login_password → core/home`, leg `login_phone → home`); the same plan's leg `home → settings` is not.
  2. the destination screen's own secret input does NOT make the leg that arrives there sensitive (leg `login_phone → login_password` is not sensitive; the next leg `login_password → home` is, via `screen-input` of `login_password` or `screen-name`).
  3. `own-steps`: a leg with `steps: [{ tool: fill, args: { index: 0, text: '{pin}' } }]` is sensitive; `{phone}` (not secret) is not; an input declared `secret: true` under another name (`token`) counts; a placeholder in `checks` counts too.
  4. `case-step:<id>`: a case on a path screen whose steps use `{password}` makes the leg sensitive even when the screen declares no `inputs`.
  5. `unknown-route`: no known path and the plan declares `password` → sensitive with `['unknown-route']`; the same with a plan whose inputs are only `phone` and `telco` → not sensitive.
  6. `explicit`: a leg with `sensitive: true` is sensitive whatever the knowledge says; `store === null` still reports `explicit`/`own-steps`, never throws.
  7. `screen-name`: `at: 'core/payment_pin'` and `'x/login_otp'` are sensitive; `'core/shipping'`, `'core/pinned_items'`... must NOT match (`pinned_items` contains `pin` only inside a longer word): assert `core/home` and `core/shipping_address` are not.
  8. observed `routes` count as edges: a leg with no direct case but a route `[a, b, c]` where `b` takes a secret input is sensitive.
  9. `planSensitivity` returns only the sensitive legs and `sensitive: true/false`; `sensitiveLegsFrom(plan, store, 2)` ignores earlier sensitive legs and keeps the original `index` values.
  10. loader: a plan file whose leg has `sensitive: true` loads with `leg.sensitive === true`; `sensitive: 'yes'` throws `…flow leg 1: "sensitive" must be true or false` (write a temp plan file like `test/plan/plan.test.js` does; read its helpers first).
  11. `planValidate` on `test/fixtures/workspace` plan `plans/example/run.plan.md` (`workspace.setOverride`/`reset` in a `finally`) returns an object with `sensitive: { sensitive: <boolean>, legs: <array> }`.
- [x] **Step 5: Run (main session)** `npm test --prefix reflex` → 403 + new tests, 0 failures.
- [x] **Step 6: Update `STATUS.md`** (tick T1).

---

**T1/T3/T4 done 2026-10-05** — delegated to opencode IN PARALLEL (3 independent runs, disjoint files): all three source files identical to the plan, 4 of 26 tests had wrong expectations (test bugs, not code bugs: a long line placed outside the first 40 lines, a snapshot captured before the edit it was meant to compare, a token case that used a store with no route, and a fixture plan that is correctly NOT sensitive because its leg only arrives at the password screen). Fixed by hand; suite green.

### Task 2: Enforce the agent boundary in the tool

**Files:**
- Modify: `reflex/src/runner/run.js`, `reflex/src/cli/index.js`, `reflex/src/mcp/handlers.js`
- Create: `reflex/test/supervisor/guards.test.js`

**Interfaces:**
- Consumes: `planSensitivity`, `sensitiveLegsFrom` (T1).
- Produces:
  - `runPlan({ …, actor = 'human' })` and `resumeRun(runId, { planPath, deps, actor = 'human' })`. With `actor: 'agent'`:
    `runPlan` returns the `invalid(...)` result `{ status: 'refused', plan, planFile, error, sensitiveLegs }` (exit code 1) when `planSensitivity` finds a sensitive leg, BEFORE any directory or session is created. Error text:
    `requires_human: plan "<name>" has sensitive leg(s) <1-based indexes joined by ", "> that enter credentials; start it yourself or from CI: reflex run <plan file>`.
    `resumeRun` refuses with status `refused` when `sensitiveLegsFrom(plan, store, resume.legIndex)` is non-empty; error:
    `requires_human: resuming run "<runId>" from leg <k+1> would run sensitive leg(s) <1-based indexes>; resume it yourself: reflex resume <runId>`.
  - `resume.json` gains `sensitive: { remaining: [{ index, at, to, reasons }], blocksAgent: boolean }` (computed with `sensitiveLegsFrom(plan, store, k)` when the run stops with `needs_agent`).
  - CLI: `reflex run … --agent` and `reflex resume … --agent` pass `actor: 'agent'`. MCP `run_start` and `resume_start` always pass `--agent` to the spawned process AND pre-check synchronously:
    `runStart` loads the plan and its store and throws `new Error(<same requires_human message>)` before creating a report dir; `resumeStart` reads `resume.json` and throws the resume message when `resume.sensitive && resume.sensitive.blocksAgent`.

- [x] **Step 1: Edit `src/runner/run.js`** — (a) `const { planSensitivity, sensitiveLegsFrom } = require('../supervisor/sensitivity');` near the other requires;
  (b) add and export a small helper next to `invalid`: `function refused(summary, deps) { printMarker(summary, deps); return { summary, exitCode: 1 }; }` is NOT needed — reuse `invalid` with `status: 'refused'`;
  (c) `runPlan`: add `actor = 'human'` to the destructured options (after `deps = {}`); after the `if (errors.length) {…}` block and BEFORE `SCREENSHOT_MODES` check add
  `if (actor === 'agent') { const sensitivity = planSensitivity(plan, store || null); if (sensitivity.sensitive) return invalid({ status: 'refused', plan: plan.name, planFile: plan.file, error: <message>, sensitiveLegs: sensitivity.legs }, resolvedDeps); }`
  with the exact message above (`const numbers = sensitivity.legs.map((leg) => leg.index + 1).join(', ')`);
  (d) `resumeRun(runId, { planPath, deps = {}, actor = 'human' } = {})`: after the `if (k >= plan.flow.length)` check and before computing `rows`, if `actor === 'agent'` and `sensitiveLegsFrom(plan, store || null, k)` is non-empty return `invalid({ status: 'refused', runId, plan: plan.name, error: <message>, sensitiveLegs }, resolvedDeps)`;
  (e) in the `needs_agent` branch of `execute` where the `resume` object is built (it already has `legIndex: k`), add
  `sensitive: (() => { const remaining = sensitiveLegsFrom(plan, store || null, k); return { remaining, blocksAgent: remaining.length > 0 }; })(),` as the last property before `createdAt`.
  Nothing else in `run.js` changes. (`execute` receives `store`; it can be `null`/`undefined` only when validation failed, which cannot reach `needs_agent`.)
- [x] **Step 2: Edit `src/cli/index.js`** — in `case 'run'` add `actor: flags.agent === true ? 'agent' : 'human',` to the `runPlan({…})` argument object; in `case 'resume'` pass `{ planPath: …, actor: flags.agent === true ? 'agent' : 'human' }`;
  in `USAGE` extend the `run` and `resume` lines with `[--agent]` and add one explanatory line under them: `  --agent                                             mark the caller as an agent: refuse plans/resumes that would enter credentials (always on for the MCP server)`.
- [x] **Step 3: Edit `src/mcp/handlers.js`** — (a) `const { planSensitivity } = require('../supervisor/sensitivity');` and `const { loadStore } = require('../screens/store');` plus `const { appKey } = require('../runner/app');`;
  (b) in `runStart`, after `const loaded = loadPlan(file, { root });` and BEFORE `newRunId`/`mkdirSync`, compute the store (`let store = null; try { store = loadStore(root, appKey(loaded)); } catch (_) { store = null; }`), `const sensitivity = planSensitivity(loaded, store);` and `if (sensitivity.sensitive) throw new Error(<run message>)`;
  (c) add `'--agent'` to the args passed to `spawnDetached` in `runStart` (after `'--json'`) and in `resumeStart`;
  (d) in `resumeStart`, after the `resume.json` existence check and before `writeStatus`, read it (`JSON.parse(fs.readFileSync(…))`) and `if (resume.sensitive && resume.sensitive.blocksAgent) throw new Error(<resume message>)` (use `resume.legIndex + 1` and the remaining indexes);
  (e) in `BIN` use `reflex.js` instead of `old-tool.js` (`path.join(__dirname, '..', '..', 'bin', 'reflex.js')`).
- [x] **Step 4: Create `test/supervisor/guards.test.js`** — read `test/runner/run.test.js` helpers (`deviceDeps`, the fixture workspace) and `test/mcp/*` (how handlers are tested with `spawnFn`) first; cases:
  1. `planValidate`-style: a workspace copy of `test/fixtures/workspace` with an extra plan whose leg is `sensitive: true`: `runPlan({ planPath, actor: 'agent', deps })` returns `summary.status === 'refused'`, `exitCode === 1`, `summary.error` starting `requires_human: plan "` and naming leg `1`; no `reports/<runId>` directory exists afterwards and the injected `createBackend` was never called.
  2. the same plan with `actor` omitted (human) runs normally (the existing run fixtures).
  3. `resume.json` of a run that stopped with `needs_agent` contains `sensitive: { remaining: [...], blocksAgent }` (use an existing needs_agent scenario from `run.test.js`; assert the shape and `blocksAgent === false` for a plan without secret legs, `true` when a later leg is `sensitive: true`).
  4. `resumeRun(runId, { actor: 'agent' })` on a run whose remaining legs include a sensitive one returns `refused` with the `resuming run "<id>" from leg` message and does not change `status.json`; with `actor: 'human'` it proceeds.
  5. MCP: `runStart({ plan })` for a sensitive plan throws an error whose message starts `requires_human:` and creates no report dir; for a non-sensitive plan the spawned args (via the injected `spawnFn`) include `--agent`.
  6. MCP: `resumeStart({ runId })` with a `resume.json` that has `sensitive.blocksAgent: true` throws `requires_human:`; with `false` it spawns with `--agent`.
  7. CLI: spawn `reflex run <sensitive plan> --agent --workspace <tmp>` → exit 1 and the stdout marker has `status: 'refused'` (no device needed because the refusal comes before any session).
- [x] **Step 5: Run (main session)** `npm test --prefix reflex` → all green; existing run/mcp tests unchanged and passing.
- [x] **Step 6: Update `STATUS.md`** (tick T2).

---

**Done 2026-10-05** — delegated to opencode (4 files, one run, ~15 min). Source diffs identical to the plan's edit lists (exact `requires_human:` messages, refusal before any report dir or session, MCP always `--agent`, `BIN` now `reflex.js`);
7 tests in `test/supervisor/guards.test.js`; one wrong assertion (the spawned args hold an ABSOLUTE plan path) fixed by hand. Worker's notes worth keeping: `remaining` entries keep the full leg object; `resumeStart` now parses `resume.json` (a malformed file surfaces as a JSON error);
the CLI `--agent` refusal is tested through `runPlan` and a CLI spawn, the human CLI path is covered at `runPlan` level. Suite 436/435.

### Task 3: The handoff document

**Files:**
- Create: `reflex/src/supervisor/handoff.js`, `reflex/test/supervisor/handoff.test.js`

**Interfaces:**
- Consumes: the object written to `reports/<runId>/resume.json` (fields used: `runId`, `plan` (file), `planName`, `appKey`, `platform`, `serial`, `legIndex`, `leg: { at, to, intent }`, `screen`, `reason`, `error`, `visibleText`, `screenshot`, `sensitive`).
- Produces: `buildHandoff({ resume, now = Date.now() })` → `{ json, markdown }`; `writeHandoff(reportDir, handoff)` → `{ jsonFile, markdownFile }` (writes `handoff.json` and `handoff.md`).
  `json` fields: `v: 1`, `createdAt`, `runId`, `plan`, `planFile`, `app`, `platform`, `serial`, `leg: { index, at, to, intent }`, `screen`, `reason`, `error` (clipped), `visibleText` (first 40 lines, each clipped to 160 chars), `screenshot`,
  `resume: { command, agentMayResume, sensitiveLegs: [{ index, reasons }] }` (`agentMayResume` is `false` when `resume.sensitive.blocksAgent` is true), nothing else — no `captures`, `data`, or any other field of `resume.json`.

- [x] **Step 1: Create `src/supervisor/handoff.js`**

```js
/**
 * handoff.js — the document an agent reads when a run stops with `needs_agent`.
 *
 * It is built ONLY from fields that resume.json already holds and that are safe by construction (visible text excludes editable
 * fields, errors are redacted by the runner). Anything else in resume.json (captures, data) is deliberately not copied.
 */
const fs = require('fs');
const path = require('path');

const MAX_TEXT_LINES = 40;
const MAX_LINE = 160;

function clip(text) {
  const value = String(text);
  return value.length > MAX_LINE ? `${value.slice(0, MAX_LINE - 1)}…` : value;
}

function markdownOf(json) {
  const lines = [];
  lines.push(`# Handoff — run ${json.runId}`);
  lines.push('');
  lines.push(`The run of plan \`${json.plan}\` stopped and needs an agent. Created ${json.createdAt}.`);
  lines.push('');
  lines.push('## Where it stopped');
  lines.push(`- Leg ${json.leg.index === null ? '?' : json.leg.index + 1}: \`${json.leg.at}\` → \`${json.leg.to}\`${json.leg.intent ? ` (${json.leg.intent})` : ''}`);
  lines.push(`- Screen identified: ${json.screen ? `\`${json.screen}\`` : '(not identified)'}`);
  lines.push(`- Reason: ${json.reason || '(none)'}${json.error ? ` — ${json.error}` : ''}`);
  lines.push(`- App: ${json.app || '?'} on ${json.platform || '?'}${json.serial ? ` (${json.serial})` : ''}`);
  if (json.screenshot) lines.push(`- Screenshot: ${json.screenshot}`);
  lines.push('');
  lines.push('## What the screen shows (public text only)');
  if (json.visibleText.length) for (const text of json.visibleText) lines.push(`- ${text}`);
  else lines.push('- (nothing readable)');
  lines.push('');
  lines.push('## What you may do');
  lines.push(`- Fix the knowledge of app \`${json.app}\` under \`screens/${json.app}/\`: a missing case in \`normal.yml\`, a wrong \`identify\` in \`screen.md\`, a popup rule in \`exceptions.yml\`.`);
  lines.push('- A real error (a failure message, a rejected transaction) is a `fail` or `blocked` rule, never a dismiss rule.');
  lines.push('');
  lines.push('## What you must not do');
  lines.push('- Never type a password, PIN, OTP or any credential, and never start a run or resume that does.');
  lines.push('- Never edit `screens/_shared/` (policy), a `pinned` item, or the legs of the plan before the stopped one.');
  lines.push('- Never copy a value from the screen into a file; use placeholders such as `{phone}`.');
  lines.push('');
  lines.push('## How to continue');
  if (json.resume.agentMayResume) {
    lines.push(`- After fixing the knowledge, resume with \`${json.resume.command} --agent\` (or the \`resume_start\` MCP tool).`);
  } else {
    const legs = json.resume.sensitiveLegs.map((item) => `${item.index + 1} (${item.reasons.join(', ')})`).join('; ');
    lines.push(`- The rest of this run includes sensitive leg(s): ${legs}.`);
    lines.push(`- Do NOT resume it yourself. Fix the knowledge, then ask the human or CI to run \`${json.resume.command}\`.`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildHandoff({ resume, now = Date.now() } = {}) {
  const source = resume || {};
  const remaining = source.sensitive && Array.isArray(source.sensitive.remaining) ? source.sensitive.remaining : [];
  const blocksAgent = Boolean(source.sensitive && source.sensitive.blocksAgent) || remaining.length > 0;
  const leg = source.leg || {};
  const json = {
    v: 1,
    createdAt: new Date(now).toISOString(),
    runId: source.runId || null,
    plan: source.planName || null,
    planFile: source.plan || null,
    app: source.appKey || null,
    platform: source.platform || null,
    serial: source.serial || null,
    leg: {
      index: Number.isFinite(source.legIndex) ? source.legIndex : null,
      at: leg.at || null,
      to: leg.to || null,
      intent: leg.intent || null,
    },
    screen: source.screen || null,
    reason: source.reason || null,
    error: source.error ? clip(source.error) : null,
    visibleText: (Array.isArray(source.visibleText) ? source.visibleText : []).slice(0, MAX_TEXT_LINES).map(clip),
    screenshot: source.screenshot || null,
    resume: {
      command: `reflex resume ${source.runId}`,
      agentMayResume: !blocksAgent,
      sensitiveLegs: remaining.map((item) => ({ index: item.index, reasons: item.reasons || [] })),
    },
  };
  return { json, markdown: markdownOf(json) };
}

function writeHandoff(reportDir, handoff) {
  const jsonFile = path.join(reportDir, 'handoff.json');
  const markdownFile = path.join(reportDir, 'handoff.md');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(jsonFile, `${JSON.stringify(handoff.json, null, 2)}\n`);
  fs.writeFileSync(markdownFile, `${handoff.markdown}\n`);
  return { jsonFile, markdownFile };
}

module.exports = { buildHandoff, writeHandoff };
```

- [x] **Step 2: Create `test/supervisor/handoff.test.js`** (`node:test` + `node:assert/strict`; temp dirs for `writeHandoff`; fixed `now = Date.parse('2026-10-05T10:00:00Z')`) — cases it MUST contain:
  1. a typical resume (`runId 'r1'`, `planName 'p'`, `plan '/w/plans/p.plan.md'`, `appKey 'app1'`, `platform 'android'`, `serial 'emu'`, `legIndex 1`, `leg { at: 'a', to: 'b', intent: 'Do it' }`, `screen 'core/a'`, `reason 'no_jev'`, `error 'boom'`, `visibleText ['x','y']`, `screenshot '/r/stuck.png'`, `sensitive { remaining: [], blocksAgent: false }`)
     gives the exact `json` (deep-equal, `createdAt: '2026-10-05T10:00:00.000Z'`, `resume: { command: 'reflex resume r1', agentMayResume: true, sensitiveLegs: [] }`).
  2. `blocksAgent: true` with `remaining: [{ index: 2, reasons: ['screen-input:core/login_password'] }]` gives `agentMayResume: false`, one `sensitiveLegs` entry, and the markdown contains `Do NOT resume it yourself`, `3 (screen-input:core/login_password)` and does NOT contain `--agent`.
  3. an agent-safe handoff's markdown contains `reflex resume r1 --agent`, the leg line `Leg 2: \`a\` → \`b\` (Do it)`, `screens/app1/` and the three "must not" rules; the visible text lines appear as bullet items.
  4. clipping: 60 visible-text lines → 40 kept; a 300-char line → 160 chars ending with `…`; a 500-char `error` is clipped the same way.
  5. nothing outside the allow-list leaks: a resume with `captures: { code: 'TOPSECRET' }`, `data: { password: 'TOPSECRET' }`, `useJev`, `jevThreshold`, `cwd` serialises (`JSON.stringify(json)` and the markdown) without `TOPSECRET`, `captures`, `cwd`.
  6. `buildHandoff({})` and `buildHandoff({ resume: null })` do not throw: `leg.index` is `null`, `visibleText` `[]`, the markdown contains `(nothing readable)` and `(not identified)`.
  7. `writeHandoff(dir, handoff)` writes `handoff.json` (parses back to `handoff.json` deep-equal) and `handoff.md` (ends with a newline) into a not-yet-existing nested directory and returns both paths.
- [x] **Step 3: Run (main session)** `npm test --prefix reflex` → green.
- [x] **Step 4: Update `STATUS.md`** (tick T3).

---

### Task 4: Knowledge snapshot, diff and restore

**Files:**
- Create: `reflex/src/supervisor/knowledgeSnapshot.js`, `reflex/test/supervisor/knowledgeSnapshot.test.js`

**Interfaces:**
- Produces: `snapshotKnowledge(root, app, dest)` → `dest`: copies `<root>/screens/<app>` and `<root>/screens/_shared` (when they exist) into `<dest>/<app>` and `<dest>/_shared`, replacing any previous `dest`;
  `diffKnowledge(root, app, snapshotDir)` → `{ changed: [{ file, kind, forbidden }], forbidden, diffText }` where `file` is `screens/<name>/<relative path>` with `/` separators, `kind` is `added | modified | removed`, `forbidden` is true for anything under `_shared`,
  `forbidden` (second) is the list of forbidden entries, `diffText` is the concatenated `diff -u --label before/<file> --label after/<file>` output (an added file diffs against `/dev/null`, a removed one too); `changed` is sorted by `file`;
  `restoreKnowledge(root, app, snapshotDir)` → makes `<root>/screens/<app>` and `<root>/screens/_shared` identical to the snapshot (files added since are deleted, a missing snapshot dir means the live dir is removed).
- Never touches `.agentic/` (counters) or any other app's screens.

- [x] **Step 1: Create `src/supervisor/knowledgeSnapshot.js`**

```js
/**
 * knowledgeSnapshot.js — keep an agent's knowledge edits provisional.
 *
 * Before an agent works on a stuck run the app's screens (and the shared policy tier) are copied away; afterwards the two trees are diffed so a
 * human can read exactly what changed, approve it (drop the snapshot) or reject it (restore the snapshot byte for byte). Changes under `_shared`
 * are policy and always forbidden. There is no git in this repo, so this is file based; the `diff` binary (BSD/GNU `-u --label`) renders the text.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SHARED = '_shared';

function namesOf(app) {
  return [String(app), SHARED];
}

function filesOf(dir) {
  const files = [];
  const walk = (current, prefix) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative);
      else files.push(relative);
    }
  };
  walk(dir, '');
  return files.sort();
}

function sameContent(a, b) {
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

/** `diff -u` exits 1 when the files differ, which execFileSync reports as an error carrying the output. */
function unified(before, after, label) {
  try {
    return execFileSync('diff', ['-u', '--label', `before/${label}`, '--label', `after/${label}`, before, after], { encoding: 'utf8' });
  } catch (error) {
    if (error && error.status === 1 && typeof error.stdout === 'string') return error.stdout;
    return `(diff unavailable for ${label}: ${(error && error.message) || error})\n`;
  }
}

function snapshotKnowledge(root, app, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const name of namesOf(app)) {
    const from = path.join(root, 'screens', name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, name), { recursive: true });
  }
  return dest;
}

function diffKnowledge(root, app, snapshotDir) {
  const changed = [];
  const parts = [];
  for (const name of namesOf(app)) {
    const liveDir = path.join(root, 'screens', name);
    const thenDir = path.join(snapshotDir, name);
    const live = new Set(filesOf(liveDir));
    const then = new Set(filesOf(thenDir));
    for (const relative of [...new Set([...live, ...then])].sort()) {
      const file = `screens/${name}/${relative}`;
      const liveFile = path.join(liveDir, relative);
      const thenFile = path.join(thenDir, relative);
      let kind = null;
      if (!then.has(relative)) kind = 'added';
      else if (!live.has(relative)) kind = 'removed';
      else if (!sameContent(thenFile, liveFile)) kind = 'modified';
      if (!kind) continue;
      changed.push({ file, kind, forbidden: name === SHARED });
      parts.push(unified(kind === 'added' ? '/dev/null' : thenFile, kind === 'removed' ? '/dev/null' : liveFile, file));
    }
  }
  changed.sort((a, b) => (a.file < b.file ? -1 : 1));
  return { changed, forbidden: changed.filter((item) => item.forbidden), diffText: parts.join('') };
}

function restoreKnowledge(root, app, snapshotDir) {
  for (const name of namesOf(app)) {
    const liveDir = path.join(root, 'screens', name);
    const thenDir = path.join(snapshotDir, name);
    fs.rmSync(liveDir, { recursive: true, force: true });
    if (fs.existsSync(thenDir)) fs.cpSync(thenDir, liveDir, { recursive: true });
  }
}

module.exports = { snapshotKnowledge, diffKnowledge, restoreKnowledge };
```

- [x] **Step 2: Create `test/supervisor/knowledgeSnapshot.test.js`** (`node:test` + `node:assert/strict`; a temp `root` with `screens/app1/core/home/{screen.md,normal.yml}`, `screens/app1/_app/exceptions.yml`, `screens/_shared/exceptions.yml`, `screens/other/core/x/screen.md`; a temp `dest` outside `root`) — cases it MUST contain:
  1. `snapshotKnowledge` copies `app1` and `_shared` (not `other`) into `dest/app1` and `dest/_shared`, returns `dest`, and replaces a pre-existing dest (a stale file there disappears).
  2. nothing changed → `diffKnowledge` gives `changed: []`, `forbidden: []`, `diffText: ''`.
  3. an edited file, an added file and a removed file under `app1` → `changed` lists exactly those three with kinds `modified`, `added`, `removed`, sorted by `file`, paths like `screens/app1/core/home/normal.yml`, none forbidden;
     `diffText` contains `--- before/screens/app1/core/home/normal.yml`, `+++ after/screens/app1/core/home/normal.yml` and a `+`/`-` line for the edit, `+++ after/…` for the added file and `--- before/…` for the removed one.
  4. an edit under `_shared` → forbidden `true`, listed in the second `forbidden` array; a change under `other` or in `.agentic/stats.json` is not reported at all.
  5. `restoreKnowledge` after a mixed change (edit + add + delete + `_shared` edit) makes both trees identical to the original: compare a `{ relativePath: content }` map of `screens/app1` and `screens/_shared` before and after; the added file is gone, the deleted one is back; `screens/other` is untouched.
  6. `restoreKnowledge` when the snapshot has no `_shared` (it did not exist) removes a `_shared` the agent created; when the app dir did not exist at snapshot time the live app dir is removed.
  7. binary-safe equality: two files with identical bytes are not reported (write the same content twice via copy); a changed byte is `modified`.
  8. snapshot → approve is just deleting `dest`: after `fs.rmSync(dest)` the live tree is unchanged (documents that approval keeps the edits).
- [x] **Step 3: Run (main session)** `npm test --prefix reflex` → green.
- [x] **Step 4: Update `STATUS.md`** (tick T4).

---

### Task 5: `reflex supervise`

**Files:**
- Create: `reflex/src/supervisor/supervise.js`, `reflex/test/supervisor/supervise.test.js`
- Modify: `reflex/src/cli/index.js` (usage + `case 'supervise'`)

**Context (read 2026-10-05):** `runPlan(options)` and `resumeRun(runId, options)` (`runner/run.js`) return `{ summary, exitCode }`; `summary` has `runId`, `status`, `reportDir`, and, for `needs_agent`, `resume` (the path of
`reports/<runId>/resume.json`). `resume.json` has `appKey`, `plan`, `legIndex`, `leg`, `sensitive` (T2). `workspace.root()` and `workspace.reportsDir()` give the workspace and its reports folder.

**Interfaces:**
- Consumes: `buildHandoff`/`writeHandoff` (T3), `snapshotKnowledge`/`diffKnowledge`/`restoreKnowledge` (T4), `actor` on `runPlan`/`resumeRun` (T2).
- Produces: `superviseRun`, `approveRun`, `rejectRun`, `statusRun`, `scrubEnv`, `AGENT_ENV_ALLOW`.
  State file `reports/<runId>/supervisor.json`: `{ v: 1, runId, state, runStatus, rounds, changed: [{ file, kind, forbidden }], startedAt, approvedAt, rejectedAt }`.
  States: `finished` (the run ended without a stop and nothing is pending), `awaiting_agent` (stopped, no `agentCmd`), `awaiting_approval` (knowledge edits exist that a human has not approved; `runStatus` says how the run ended),
  `max_rounds`, `no_change` (the agent edited nothing), `rejected_forbidden` (the agent touched `_shared`: everything restored), `agent_failed`, `agent_timeout`, `error_no_resume`, then after a human step `approved` / `rejected`.
  Exit code of `superviseRun`: that of the last run/resume, except `rejected_forbidden`, `agent_failed`, `agent_timeout`, `error_no_resume` which are `1`.
- CLI: `reflex supervise <plan> [run options] [--agent-cmd "<shell command>"] [--agent-env A,B] [--max-rounds n] [--no-resume] [--agent-timeout-min n] [--agent]`; `reflex supervise approve|reject|status <runId>`.
  The command runs with env `REFLEX_HANDOFF` (path of `handoff.md`), `REFLEX_RUN_ID`, `REFLEX_REPORT_DIR`, cwd = workspace root. The wrapper is started by a human or CI, so it runs/resumes with `actor: 'human'`
  (credentials come from the human's environment); `--agent` makes it pass `actor: 'agent'` so the T2 guards apply.
- **The agent process never inherits the human's environment.** Only `AGENT_ENV_ALLOW` plus names listed in `--agent-env` plus the three `REFLEX_*` handoff variables are passed, so `LEGACY_TEST_*`, `REFLEX_TEST_*`, `TYPESAFE_API_KEY`,
  OTP tokens and so on can never reach it. (An agent CLI that needs an API key gets it only if the human names it in `--agent-env`.) The agent's stdout goes to stderr, keeping the one-marker stdout contract.

- [x] **Step 1: Create `src/supervisor/supervise.js`**

```js
/**
 * supervise.js — `reflex supervise`: run a plan, and when it stops for an agent, hand it over and keep the agent's knowledge edits provisional.
 *
 * It is meant to be started by a human or by CI: it may resume legs that enter credentials (the secrets come from THEIR environment),
 * and the agent it launches is given a scrubbed environment, so it can never read those secrets. The agent's edits to the app's knowledge are
 * snapshotted before it starts and diffed afterwards: a human approves them (`approve`) or throws them away (`reject`, a byte-for-byte restore).
 * Anything under `screens/_shared/` (policy) is forbidden: the whole change is restored on the spot.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const workspace = require('../util/workspace');
const { buildHandoff, writeHandoff } = require('./handoff');
const { snapshotKnowledge, diffKnowledge, restoreKnowledge } = require('./knowledgeSnapshot');
const { parseMarker } = require('../util/markers');

const SUPERVISOR_FILE = 'supervisor.json';
const SNAPSHOT_DIR = 'knowledge-before';
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
/** The only variables of the caller's environment an agent process inherits. */
const AGENT_ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'ANDROID_SERIAL', 'ANDROID_HOME', 'ANDROID_SDK_ROOT'];
const FAILING = new Set(['rejected_forbidden', 'agent_failed', 'agent_timeout', 'error_no_resume']);

const BIN = path.join(__dirname, '..', '..', 'bin', 'reflex.js');

/**
 * Runs and resumes happen in a CHILD process, like a human or CI would start them. In the same process a second run after a stop timed out on
 * the agent-device daemon (the client of the first run keeps its session and handles open): seen on an emulator on 2026-10-05, repeatable.
 */
function childArgs(kind, options = {}) {
  const args = kind === 'resume'
    ? ['resume', String(options.runId), ...(options.planPath ? ['--plan', String(options.planPath)] : [])]
    : ['run', String(options.planPath)];
  if (kind === 'run') {
    if (options.caseId) args.push('--case', String(options.caseId));
    if (options.platform) args.push('--platform', String(options.platform));
    if (options.serial) args.push('--serial', String(options.serial));
    if (options.udid) args.push('--udid', String(options.udid));
    if (options.app) args.push('--app', String(options.app));
    if (options.screenshots) args.push('--screenshots', String(options.screenshots));
    if (options.useJev === false) args.push('--no-jev');
    if (options.jevThreshold !== undefined && options.jevThreshold !== null) args.push('--jev-threshold', String(options.jevThreshold));
    if (options.learn === false) args.push('--no-learn');
    if (options.runId) args.push('--run-id', String(options.runId));
    if (options.maxJevCalls) args.push('--max-jev-calls', String(options.maxJevCalls));
  }
  if (options.actor === 'agent') args.push('--agent');
  args.push('--workspace', workspace.root());
  return args;
}

/** `{ summary, exitCode }` from the last REFLEX_JSON line of a child's stdout. */
function parseChildResult(stdout, status) {
  const lines = String(stdout || '').split('\n').filter(Boolean);
  let summary = null;
  for (let index = lines.length - 1; index >= 0 && !summary; index -= 1) summary = parseMarker(lines[index]);
  return {
    summary: summary || { status: 'error', error: 'the child process printed no REFLEX_JSON marker' },
    exitCode: Number.isInteger(status) ? status : 1,
  };
}

function runChild(kind, options) {
  const result = spawnSync(process.execPath, [BIN, ...childArgs(kind, options)], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 2], maxBuffer: 64 * 1024 * 1024,
  });
  return parseChildResult(result.stdout, result.status);
}

function scrubEnv(env, { keep = [], extra = {} } = {}) {
  const allowed = new Set([...AGENT_ENV_ALLOW, ...keep]);
  const out = {};
  for (const [name, value] of Object.entries(env || {})) {
    if (allowed.has(name) && value !== undefined) out[name] = value;
  }
  return { ...out, ...extra };
}

/** The agent's own output goes to stderr (fd 2): stdout stays the single REFLEX_JSON marker line. */
function runAgentDefault(command, env, { cwd, timeoutMs }) {
  const result = spawnSync('/bin/sh', ['-c', command], { cwd, env, timeout: timeoutMs, stdio: ['ignore', 2, 2] });
  return {
    code: result.status,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    error: result.error ? result.error.message : null,
  };
}

function isDaemonTimeout(outcome) {
  const summary = (outcome && outcome.summary) || {};
  return summary.status === 'error' && /Daemon request timed out/i.test(String(summary.error || ''));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeState(reportDir, state) {
  fs.writeFileSync(path.join(reportDir, SUPERVISOR_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

function diffMarkdown(runId, diff) {
  const lines = [
    `# Knowledge changes — run ${runId}`,
    '',
    'Provisional until a human approves (`reflex supervise approve <runId>`) or rejects (`reflex supervise reject <runId>`).',
    '',
  ];
  for (const item of diff.changed) lines.push(`- ${item.kind}: \`${item.file}\``);
  // Built, not written out: three backticks inside this block would end the markdown fence of the plan itself.
  const fence = '`'.repeat(3);
  lines.push('', `${fence}diff`, diff.diffText.trimEnd(), fence, '');
  return lines.join('\n');
}

async function superviseRun({
  planPath, runOptions = {}, agentCmd = null, agentEnvKeep = [], maxRounds = 2, resume = true,
  agentTimeoutMs = DEFAULT_AGENT_TIMEOUT_MS, actor = 'human', resumeRetries = 2, resumeRetryDelayMs = 15000, deps = {},
} = {}) {
  const runPlan = deps.runPlan || ((options) => runChild('run', options));
  const resumeRun = deps.resumeRun || ((runId, options) => runChild('resume', { ...options, runId }));
  const runAgent = deps.runAgent || runAgentDefault;
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  /**
   * agent-device's daemon can time out on the FIRST request of a process that starts soon after another reflex process (seen on an
   * Android 8.1 emulator on 2026-10-05: every other resume hung ~2.5 minutes, the next one worked). That is an environment hiccup, not a
   * verdict about the knowledge, so only that exact error is retried, a bounded number of times, after a pause.
   */
  const resumeWithRetry = async (runId, options) => {
    let outcome = await resumeRun(runId, options);
    for (let attempt = 0; attempt < resumeRetries && isDaemonTimeout(outcome); attempt += 1) {
      await sleep(resumeRetryDelayMs);
      outcome = await resumeRun(runId, options);
    }
    return outcome;
  };
  const root = workspace.root();

  let result = await runPlan({ ...runOptions, planPath, actor });
  let round = 0;
  let snapshotDir = null;
  let state = { v: 1, runId: null, state: 'running', runStatus: null, rounds: 0, changed: [], startedAt: new Date(now()).toISOString(), approvedAt: null, rejectedAt: null };

  const finish = (name) => {
    const summary = result.summary || {};
    state = { ...state, runId: summary.runId || state.runId, state: name, runStatus: summary.status || null, rounds: round };
    if (summary.reportDir) writeState(summary.reportDir, state);
    return { ...state, reportDir: summary.reportDir || null, exitCode: FAILING.has(name) ? 1 : result.exitCode };
  };

  for (;;) {
    const summary = result.summary || {};
    state.runId = summary.runId || state.runId;
    if (summary.status !== 'needs_agent') return finish(state.changed.length ? 'awaiting_approval' : 'finished');

    const reportDir = summary.reportDir;
    const resumeJson = readJson(summary.resume || path.join(reportDir, 'resume.json'));
    if (!resumeJson) return finish('error_no_resume');
    const app = resumeJson.appKey;
    // One snapshot per run, taken before the first agent edit: a rejection undoes every round, an approval keeps every round.
    if (!snapshotDir) snapshotDir = snapshotKnowledge(root, app, path.join(reportDir, SNAPSHOT_DIR));
    const files = writeHandoff(reportDir, buildHandoff({ resume: resumeJson, now: now() }));
    if (!agentCmd) return finish('awaiting_agent');
    if (round >= maxRounds) return finish('max_rounds');

    round += 1;
    const env = scrubEnv(process.env, {
      keep: agentEnvKeep,
      extra: { REFLEX_HANDOFF: files.markdownFile, REFLEX_RUN_ID: String(summary.runId), REFLEX_REPORT_DIR: reportDir },
    });
    const agentRun = await runAgent(agentCmd, env, { cwd: root, timeoutMs: agentTimeoutMs });
    if (agentRun.timedOut) return finish('agent_timeout');
    if (agentRun.code !== 0) return finish('agent_failed');

    const diff = diffKnowledge(root, app, snapshotDir);
    if (diff.forbidden.length) {
      restoreKnowledge(root, app, snapshotDir);
      state.changed = [];
      return finish('rejected_forbidden');
    }
    if (!diff.changed.length) return finish('no_change');
    state.changed = diff.changed;
    fs.writeFileSync(path.join(reportDir, 'knowledge-diff.md'), diffMarkdown(state.runId, diff));
    if (!resume) return finish('awaiting_approval');
    result = await resumeWithRetry(summary.runId, { actor });
  }
}

function stateOf(runId) {
  const reportDir = path.join(workspace.reportsDir(), String(runId));
  const state = readJson(path.join(reportDir, SUPERVISOR_FILE));
  if (!state) throw new Error(`no supervisor state for run "${runId}"`);
  return { reportDir, state };
}

function approveRun(runId, { now = Date.now } = {}) {
  const { reportDir, state } = stateOf(runId);
  if (state.state !== 'awaiting_approval') throw new Error(`run "${runId}" is "${state.state}", not awaiting_approval`);
  fs.rmSync(path.join(reportDir, SNAPSHOT_DIR), { recursive: true, force: true });
  const next = { ...state, state: 'approved', approvedAt: new Date(now()).toISOString() };
  writeState(reportDir, next);
  return next;
}

function rejectRun(runId, { now = Date.now } = {}) {
  const { reportDir, state } = stateOf(runId);
  const snapshotDir = path.join(reportDir, SNAPSHOT_DIR);
  if (!fs.existsSync(snapshotDir)) throw new Error(`run "${runId}" has no knowledge snapshot to restore (state: ${state.state})`);
  const resumeJson = readJson(path.join(reportDir, 'resume.json'));
  if (!resumeJson || !resumeJson.appKey) throw new Error(`run "${runId}" has no resume.json that names its app`);
  restoreKnowledge(workspace.root(), resumeJson.appKey, snapshotDir);
  fs.rmSync(snapshotDir, { recursive: true, force: true });
  const next = { ...state, state: 'rejected', changed: [], rejectedAt: new Date(now()).toISOString() };
  writeState(reportDir, next);
  return next;
}

/** The whole supervisor.json object (its `state` field is the state name). */
function statusRun(runId) {
  return stateOf(runId).state;
}

module.exports = { superviseRun, approveRun, rejectRun, statusRun, scrubEnv, AGENT_ENV_ALLOW, childArgs, parseChildResult };
```

- [x] **Step 2: Edit `src/cli/index.js`** — (a) in `USAGE`, after the `app init` line add two lines:
  `  supervise <plan> [run options] [--agent-cmd "<cmd>"] [--agent-env A,B] [--max-rounds n] [--no-resume] [--agent-timeout-min n] [--agent]`
  `             run; on needs_agent hand the run to an agent command, keep its knowledge edits provisional`
  `  supervise approve|reject|status <runId>             a human keeps (approve) or undoes (reject) what the agent changed`;
  (b) in the `switch (command)`, before `case 'mcp':`, add:

```js
      case 'supervise': {
        const supervise = require('../supervisor/supervise');
        if (sub === 'approve' || sub === 'reject' || sub === 'status') {
          const runId = positionals[2];
          if (!runId) throw new Error(`supervise ${sub} requires a runId`);
          const state = sub === 'approve' ? supervise.approveRun(runId) : sub === 'reject' ? supervise.rejectRun(runId) : supervise.statusRun(runId);
          if (!json) note(`${sub}: run ${runId} is ${state.state}`);
          emit({ ok: true, ...state }, { json });
          return 0;
        }
        const result = await supervise.superviseRun({
          planPath: sub,
          runOptions: {
            caseId: str(flags, 'case'),
            platform,
            serial,
            udid,
            app: str(flags, 'app'),
            screenshots: str(flags, 'screenshots') || 'fail',
            useJev: flags.jev !== false,
            jevThreshold: str(flags, 'jev-threshold') || undefined,
            learn: flags.learn !== false,
            runId: str(flags, 'run-id') || undefined,
            maxJevCalls: Number(str(flags, 'max-jev-calls')) || 30,
          },
          agentCmd: str(flags, 'agent-cmd'),
          agentEnvKeep: (str(flags, 'agent-env') || '').split(',').map((name) => name.trim()).filter(Boolean),
          maxRounds: Number(str(flags, 'max-rounds')) || 2,
          resume: flags.resume !== false,
          agentTimeoutMs: (Number(str(flags, 'agent-timeout-min')) || 30) * 60 * 1000,
          actor: flags.agent === true ? 'agent' : 'human',
        });
        if (!json) note(`supervise: run ${result.runId} is ${result.state} (run status: ${result.runStatus}, ${result.rounds} agent round(s), ${result.changed.length} knowledge change(s))`);
        emit({ ok: result.exitCode === 0, runId: result.runId, state: result.state, runStatus: result.runStatus, rounds: result.rounds, changed: result.changed, reportDir: result.reportDir }, { json });
        return result.exitCode;
      }
```

- [x] **Step 3: Create `test/supervisor/supervise.test.js`** (`node:test` + `node:assert/strict`). Setup per test: a temp workspace (`fs.mkdtempSync` under os.tmpdir(), `fs.realpathSync`) with `reflex.workspace.json` `{ "name": "t", "apps": { "app1": { "android": { "package": "p.app1" } } } }`, `screens/app1/core/home/screen.md` (valid front matter) and
  `normal.yml`, `screens/_shared/exceptions.yml`; `workspace.setOverride(root)` in `beforeEach` and `workspace.reset()` + removal in `afterEach`. Stub deps: `runPlan` (records its options) returns `{ exitCode, summary }` after creating `reports/<runId>/` and a `resume.json`
  (`{ runId, appKey: 'app1', plan: <file>, planName: 'p', legIndex: 1, leg: { at: 'core/home', to: 'core/x' }, screen: 'core/home', reason: 'no_jev', visibleText: ['Home'], sensitive: { remaining: [], blocksAgent: false } }`) and a summary
  `{ runId, status: 'needs_agent', reportDir, resume: <path> }` — or a `pass` summary; `resumeRun` records `(runId, options)` and returns the next scripted result; `runAgent` is a stub recording `(command, env, options)` that may edit files under `root` and returns `{ code: 0, timedOut: false }`. Cases it MUST contain:
  1. a run that passes: `state: 'finished'`, `exitCode: 0`, no `knowledge-before` dir, no `handoff.*`, `supervisor.json` says `finished`; `runPlan` received `planPath` and `actor: 'human'`.
  2. a stop with no `agentCmd`: `awaiting_agent`, exit 3, `handoff.json` and `handoff.md` exist and mention the run id, `knowledge-before/app1/core/home/screen.md` exists, the agent stub was not called.
  3. agent edits `normal.yml`, then `resumeRun` returns a pass: `state: 'awaiting_approval'`, `runStatus: 'pass'`, `exitCode: 0`, `changed` lists `screens/app1/core/home/normal.yml` as `modified`, `knowledge-diff.md` contains the `+++ after/screens/app1/core/home/normal.yml` header, `resumeRun` was called once with `(runId, { actor: 'human' })`, and the agent stub received `cwd: root`, a timeout and env with `REFLEX_HANDOFF` (an existing file), `REFLEX_RUN_ID`, `REFLEX_REPORT_DIR`.
  4. forbidden: the agent edits `screens/_shared/exceptions.yml` (and an app file): `rejected_forbidden`, exit 1, both trees restored byte-for-byte, `resumeRun` not called, `changed: []`.
  5. the agent changes nothing → `no_change`, `resumeRun` not called; the agent exits with code 2 → `agent_failed`, exit 1; the stub returns `{ timedOut: true }` → `agent_timeout`, exit 1.
  6. `maxRounds`: `runPlan` and every `resumeRun` return a stop and the agent edits a file each time; with `maxRounds: 2` the agent stub is called exactly twice and the state is `max_rounds`; with `resume: false` the first edit ends with `awaiting_approval` and `resumeRun` is never called.
  7. `approveRun` after case 3: state `approved`, `approvedAt` set, `knowledge-before` removed, the agent's edit still on disk; calling it again throws `run "<id>" is "approved", not awaiting_approval`; an unknown run id throws `no supervisor state for run "<id>"`.
  8. `rejectRun` after case 3 (agent edited one file and ADDED one): the edited file is back byte-for-byte, the added file is gone, state `rejected`, `rejectedAt` set, `knowledge-before` removed; rejecting again throws `run "<id>" has no knowledge snapshot to restore (state: rejected)`.
  9. `actor: 'agent'` is passed through to both `runPlan` and `resumeRun` stubs.
  10. `scrubEnv`: from `{ PATH, HOME, LEGACY_TEST_PASSWORD, REFLEX_TEST_PIN, TYPESAFE_API_KEY, BYPASS_LOGIN_OTP_TOKEN, ANTHROPIC_API_KEY, ANDROID_SERIAL }` it keeps only `PATH`, `HOME`, `ANDROID_SERIAL` (plus `extra`), and with `keep: ['ANTHROPIC_API_KEY']` it also keeps that one; `AGENT_ENV_ALLOW` contains none of the names matching `/PASSWORD|PIN|OTP|TOKEN|SECRET|KEY/i`.
  11. the default agent runner (real process, no `deps.runAgent`): with `process.env.LEGACY_TEST_PASSWORD = 'TOPSECRET'` set in the parent for the test (restore it afterwards), an `agentCmd` of `node -e "require('fs').writeFileSync(process.env.REFLEX_REPORT_DIR + '/env.txt', JSON.stringify({ secret: process.env.LEGACY_TEST_PASSWORD || null, handoff: !!process.env.REFLEX_HANDOFF }))"` produces an `env.txt` with `secret: null` and `handoff: true`; a command `node -e "setTimeout(()=>{}, 5000)"` with `agentTimeoutMs: 300` gives `agent_timeout`; the agent's stdout does not appear on the test process's stdout (assert only that the call returns).
  12. CLI: spawn `process.execPath [reflex/bin/reflex.js, 'supervise', 'status', <runId>, '--json', '--workspace', root]` against a prepared `supervisor.json` → marker `ok: true`, `state` equal to the file's; `supervise approve` without a run id exits 1 with the message `supervise approve requires a runId`.
- [x] **Step 4: Run (main session)** `npm test --prefix reflex` → green.
- [x] **Step 5: Update `STATUS.md`** (tick T5).

---

**Done 2026-10-05/06.** `supervise.js` delegated to opencode (3 files; source identical to the plan; 2 of 12 tests had bugs in the TEST, a misplaced parenthesis and a real-process test that accidentally injected an agent stub; one more bug was in MY plan: `statusRun` returns the whole state object, the CLI wrapped it as if it were a string).
**Found by running it live on the emulator (not by any unit test):** (1) the first resume of a `supervise` run failed with `Daemon request timed out` — first guessed to be the in-process client of the first run, so `run`/`resume` were moved to CHILD processes (`childArgs`, `parseChildResult`, `runChild`; tests `superviseChild.test.js`, 9) — that did NOT fix it; (2) the timeout is the agent-device daemon on the emulator: a reflex process that starts soon after another one fails its first request (about 2.5 minutes), the next works; aligning the package's `agent-device` pin (0.21.12 → 0.21.20, same as the global CLI) did not change it; (3) fix that works: a bounded retry of a resume that ends with exactly that error (`resumeRetries` 2, `resumeRetryDelayMs` 15000; tests `superviseRetry.test.js`, 6). Live result: stuck run → stand-in agent adds the missing case → resume (one timeout, one retry) → pass → `awaiting_approval`, exit 0; `approve` kept the edit and refused a second approval; `reject` restored the file (2 cases back to 1) and refused a second rejection.
Suite 463/462 pass/1 skipped.

### Task 6: Documentation

**Deliverable:** `docs/reflex/SUPERVISION.md` (the boundary, the sensitivity reasons, the handoff, the approval flow, how to wire an agent command such as a non-interactive Claude Code session, CI example), links from `README.md` and `AGENTS.md`,
and an update of `AGENTS.md` "Safety boundaries" stating that the tool now enforces them for `--agent`/MCP callers. **Acceptance:** every command in the doc was run (with a stub agent command for the supervise example).

**Done 2026-10-06:** `docs/reflex/SUPERVISION.md`, written from the live run (every command and output above was run; the real-agent example is marked as not verified), linked from `README.md` and `AGENTS.md` (which now says what the tool enforces and what it cannot).

---

## Self-review (2026-10-05)
- Roadmap coverage: sensitive legs/inputs (T1), the supervisor never auto-resumes them (T2 for the agent side; T5 documents that the human/CI wrapper may), handoff (T3), approval before knowledge becomes permanent (T4 + T5), wrapper on exit 3 (T5).
- T5 and T6 are spec-level on purpose: T5's code depends on the exact exports of T1–T4 and on how `runPlan`/`resumeRun` return after T2.
- Names used consistently: `planSensitivity`, `sensitiveLegsFrom`, `blocksAgent`, `actor`, `buildHandoff`, `snapshotKnowledge`, `diffKnowledge`, `restoreKnowledge`.
