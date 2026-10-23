# reflex Phase 2 — measure and protect learning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (this session implements) or hand a task to opencode via
> `docs/reflex/DELEGATION.md`. Steps use checkbox (`- [ ]`) syntax. Tick them as you go and update `docs/reflex/STATUS.md`.

**Goal:** Know whether reflex actually improves (a per-run ledger and `reflex stats`), let a human review what was learned, and prove with a
fixture corpus that the runner never "heals" a real error by dismissing it.

**Architecture:** A new `src/metrics/ledger.js` (pure record builder + append/read/summarise over `<workspace>/.agentic/runs.jsonl`, next to the
existing per-machine `stats.json`), written once at the end of `execute()` in `runner/run.js` and read by a new `stats` CLI command. Review and
corpus tasks reuse the existing store, learner and leg loop; no change to the learning lifecycle (`PROMOTE_STREAK = 3`, `REMOVE_STREAK = 2` in
`screens/learn.js` already gate `learned → verified`).

**Tech Stack:** Node >= 22.12, CommonJS, `node:test`. No new dependencies.

**Spec:** `docs/reflex/ROADMAP.md` (Phase 2) and `docs/reflex/DESIGN.md`.

## Global Constraints
- CommonJS, 2-space indent, single quotes, semicolons, English comments that explain why. Every file ends with a newline.
- Package folder is `reflex/` (renamed in Phase 1 T6). Test command (main session only): `npm test --prefix reflex`. Baseline before this phase: 349 tests, 348 pass, 1 skipped.
- The ledger and every report/summary line NEVER contain input values, passwords, PINs, OTPs, tokens, captures or screen text: `recordOf` picks a fixed list of fields.
- A ledger failure must never change a run's verdict or exit code (warning only), like the report and knowledge writes in `run.js`.
- `.agentic/` is gitignored per machine (see `src/screens/stats.js`); the ledger is per machine too.
- CLI contract: exactly one `REFLEX_JSON` line on stdout, human text on stderr, exit 0 for a successful read.

## Review Focus
- A run that writes no rows (invalid plan, `error`) must not crash the ledger: `recordOf` accepts a summary with missing fields.
- A truncated or corrupted ledger line must be skipped, not abort `reflex stats`.
- A resume (`resumedFrom`) must not be counted as a second run in the rates, but its Jev calls and cost are real and stay in the sums.
- `straight` (passed without any Jev action) must be false when the status is not `pass`, even if `levels.L2 === 0`.
- No secret can reach the ledger: a summary that carries `data`, `captures` or screen text must produce a record without them.

## File structure
```
reflex/src/metrics/ledger.js          T1  LEDGER_FILE, recordOf, appendRun, readRuns, summarize
reflex/test/metrics/ledger.test.js    T1
reflex/src/cli/statsCommands.js       T2  statsCommand, formatStats
reflex/src/runner/run.js              T2  one try/catch after `summary.duration_ms`
reflex/src/cli/index.js               T2  `stats` command + usage line
reflex/test/metrics/stats.test.js     T2
```
T3 and T4 are spec-level; write their detailed steps when they start (they depend on reading `screens/learn.js` and the flow test helpers).

---

### Task 1: Run ledger module

**Files:**
- Create: `reflex/src/metrics/ledger.js`
- Create: `reflex/test/metrics/ledger.test.js`

**Interfaces:**
- Produces: `LEDGER_FILE` (`path.join('.agentic', 'runs.jsonl')`), `ledgerFileOf(workspaceRoot)`, `recordOf(summary, now = Date.now())` → flat record,
  `appendRun(workspaceRoot, summary, { now } = {})` → the record that was written, `readRuns(workspaceRoot)` → array of records (missing file → `[]`;
  blank and malformed lines skipped), `summarize(records, { plan, platform, since } = {})`.
- `summary` is the object `execute()` builds in `runner/run.js`: `{ runId, plan, app, platform, status, total, passed, failed, blocked, duration_ms,
  rows: [{ id, status, error, levels: { L0, L1, L2, L3 } }], jev: null | { calls, cost_usd, … }, knowledge: [{ action, key, … }], resumedFrom? }`.
- Record fields (exactly these, `v: 1`): `at` (ISO), `runId`, `plan`, `app`, `platform`, `status`, `rows`, `passed`, `failed`, `blocked`, `duration_ms`,
  `levels` (sum over rows), `jevCalls`, `jevCostUsd`, `straight`, `resumed`, `learned` (counts for `added`, `replaced`, `removed`, `promoted`, `demoted`, `route`).
  Level meaning (from `flow.js`): L0 loop/case/arrived, L1 exception rule, L2 a decider action, L3 escalation (`needs_agent`, decider error).
- `summarize` returns `{ runs, resumes, passRate, straightRate, needsAgentRate, jevCalls, jevCostUsd, avgDurationMs, byStatus, byPlan }` where `runs` counts non-resumed
  records, `resumes` the resumed ones, rates are `count / runs` rounded to 3 decimals (`null` when `runs === 0`), `jevCalls`/`jevCostUsd` sum ALL filtered records
  (`jevCostUsd` rounded to 6 decimals), `avgDurationMs` is the rounded mean of non-resumed `duration_ms` (`null` when none), `byStatus` counts non-resumed
  records per status, `byPlan` maps plan name → `{ runs, passed, straight }` over non-resumed records. Filters: `plan` and `platform` are equality, `since` is
  an ISO date or timestamp compared to `at` as a string (`at >= since`).

- [x] **Step 1: Create `src/metrics/ledger.js`**

```js
/**
 * ledger.js — the per-machine run ledger: one JSON line per finished run in <workspace>/.agentic/runs.jsonl.
 *
 * It answers "is reflex getting better?": how many runs passed, how many passed WITHOUT asking the decider
 * (`straight`), how often an agent had to step in, what the decider cost. Like stats.js it lives under the gitignored
 * `.agentic/`, so two people never conflict on it. A record is built from a fixed list of summary fields, so no input
 * value, capture or screen text can ever reach it.
 */
const fs = require('fs');
const path = require('path');

const LEDGER_FILE = path.join('.agentic', 'runs.jsonl');
const ACTIONS = ['added', 'replaced', 'removed', 'promoted', 'demoted', 'route'];
const LEVELS = ['L0', 'L1', 'L2', 'L3'];

function ledgerFileOf(workspaceRoot) {
  return path.join(workspaceRoot, LEDGER_FILE);
}

function levelsOf(rows) {
  const levels = Object.fromEntries(LEVELS.map((level) => [level, 0]));
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const level of LEVELS) levels[level] += Number(row && row.levels && row.levels[level]) || 0;
  }
  return levels;
}

function learnedOf(knowledge) {
  const counts = Object.fromEntries(ACTIONS.map((action) => [action, 0]));
  for (const event of Array.isArray(knowledge) ? knowledge : []) {
    if (event && counts[event.action] !== undefined) counts[event.action] += 1;
  }
  return counts;
}

/** The flat record of one finished run. Pure, so it is tested without a workspace; tolerant of a summary with missing fields. */
function recordOf(summary, now = Date.now()) {
  const source = summary || {};
  const levels = levelsOf(source.rows);
  const jev = source.jev || null;
  const status = source.status || 'error';
  return {
    v: 1,
    at: new Date(now).toISOString(),
    runId: source.runId || null,
    plan: source.plan || null,
    app: source.app || null,
    platform: source.platform || null,
    status,
    rows: Number(source.total) || 0,
    passed: Number(source.passed) || 0,
    failed: Number(source.failed) || 0,
    blocked: Number(source.blocked) || 0,
    duration_ms: Number(source.duration_ms) || 0,
    levels,
    jevCalls: jev ? Number(jev.calls) || 0 : 0,
    jevCostUsd: jev ? Number(jev.cost_usd) || 0 : 0,
    // Passed without a single decider action: the number that should grow as the knowledge base learns.
    straight: status === 'pass' && levels.L2 === 0,
    resumed: Boolean(source.resumedFrom),
    learned: learnedOf(source.knowledge),
  };
}

function appendRun(workspaceRoot, summary, { now = Date.now() } = {}) {
  const record = recordOf(summary, now);
  const file = ledgerFileOf(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  return record;
}

/** A missing file is an empty ledger; a damaged line is skipped, never fatal: the ledger is a convenience, not a contract. */
function readRuns(workspaceRoot) {
  let text;
  try {
    text = fs.readFileSync(ledgerFileOf(workspaceRoot), 'utf8');
  } catch (_) {
    return [];
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) records.push(parsed);
    } catch (_) {
      // a truncated line (a run killed mid-write) must not hide every other run
    }
  }
  return records;
}

function summarize(records, { plan = null, platform = null, since = null } = {}) {
  const filtered = (Array.isArray(records) ? records : []).filter((record) => (
    (!plan || record.plan === plan)
    && (!platform || record.platform === platform)
    && (!since || String(record.at || '') >= String(since))
  ));
  const counted = filtered.filter((record) => !record.resumed);
  const runs = counted.length;
  const rate = (count) => (runs ? Math.round((count / runs) * 1000) / 1000 : null);

  const byStatus = {};
  const byPlan = {};
  for (const record of counted) {
    byStatus[record.status] = (byStatus[record.status] || 0) + 1;
    const name = record.plan || '(unknown)';
    const entry = byPlan[name] || (byPlan[name] = { runs: 0, passed: 0, straight: 0 });
    entry.runs += 1;
    if (record.status === 'pass') entry.passed += 1;
    if (record.straight) entry.straight += 1;
  }

  const totalDuration = counted.reduce((sum, record) => sum + (Number(record.duration_ms) || 0), 0);
  const cost = filtered.reduce((sum, record) => sum + (Number(record.jevCostUsd) || 0), 0);
  return {
    runs,
    resumes: filtered.length - runs,
    passRate: rate(counted.filter((record) => record.status === 'pass').length),
    straightRate: rate(counted.filter((record) => record.straight).length),
    needsAgentRate: rate(counted.filter((record) => record.status === 'needs_agent').length),
    jevCalls: filtered.reduce((sum, record) => sum + (Number(record.jevCalls) || 0), 0),
    jevCostUsd: Math.round(cost * 1e6) / 1e6,
    avgDurationMs: runs ? Math.round(totalDuration / runs) : null,
    byStatus,
    byPlan,
  };
}

module.exports = { LEDGER_FILE, ledgerFileOf, recordOf, appendRun, readRuns, summarize };
```

- [x] **Step 2: Create `test/metrics/ledger.test.js`** (`node:test` + `node:assert/strict`; temp dirs from `fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-ledger-'))`; fixed `now = Date.parse('2026-10-05T10:00:00Z')`) — cases it MUST contain:
  1. `recordOf` on a typical summary (`runId 'r1'`, `plan 'p'`, `app 'pkg'`, `platform 'android'`, `status 'pass'`, `total 2`, `passed 2`, `failed 0`, `blocked 0`, `duration_ms 5000`,
     two rows with `levels` `{L0:3,L1:1,L2:0,L3:0}` and `{L0:2,L1:0,L2:0,L3:0}`, `jev: { calls: 0, cost_usd: 0 }`, `knowledge: [{ action: 'added' }, { action: 'promoted' }, { action: 'skipped' }]`)
     deep-equals the exact record (levels `{L0:5,L1:1,L2:0,L3:0}`, `straight: true`, `resumed: false`, `learned` with `added: 1`, `promoted: 1`, others 0, `at: '2026-10-05T10:00:00.000Z'`, `v: 1`).
  2. `straight` is false when `levels.L2 > 0`, false when `status` is not `pass` even with `L2 === 0`, and true for a pass with `L1 > 0` but `L2 === 0`.
  3. `recordOf({})` and `recordOf(null)` do not throw and give `status: 'error'`, zeros, `plan: null`, `straight: false`.
  4. `recordOf` with `resumedFrom: { legIndex: 1 }` has `resumed: true`.
  5. no secret can reach the record: a summary with `rows: [{ id: 'a', error: 'boom', captures: { secret: 'TOPSECRET' }, levels: {} }]`, `data: { password: 'TOPSECRET' }` and `knowledge: [{ action: 'added', key: 'x', text: 'TOPSECRET' }]` serialises (`JSON.stringify(record)`) without `TOPSECRET`.
  6. `appendRun` creates `<root>/.agentic/runs.jsonl`; two calls give two lines; the return value deep-equals `JSON.parse` of the last line.
  7. `readRuns` on a missing file → `[]`; with a blank line, a truncated line (`{"v":1,`) and a JSON array line between two valid records → exactly the two valid records.
  8. `summarize([])` → `runs: 0`, `passRate: null`, `straightRate: null`, `needsAgentRate: null`, `avgDurationMs: null`, `jevCalls: 0`, `byStatus: {}`, `byPlan: {}`.
  9. rates: four non-resumed records — pass straight, pass straight, pass with `levels.L2 = 2` (so `straight: false`), `needs_agent` — give `passRate 0.75`, `straightRate 0.5`, `needsAgentRate 0.25`, correct `byStatus`, and `byPlan` counts.
  10. a resumed record is not counted in `runs`/rates but counts in `resumes`, and its `jevCalls`/`jevCostUsd` are included in the sums.
  11. filters: `plan`, `platform` and `since` (`'2026-10-06'` excludes a record at `2026-10-05T…Z`) each narrow the result.
  12. `jevCostUsd` sums with rounding to 6 decimals (`0.1 + 0.2` → `0.3`), `avgDurationMs` rounds the mean.
- [x] **Step 3: Run (main session)** `npm test --prefix reflex` → 349 + new tests, 0 failures.
- [x] **Step 4: Update `STATUS.md`** (tick T1).

---

### Task 2: Wire the ledger into runs and add `reflex stats`

**Files:**
- Create: `reflex/src/cli/statsCommands.js`, `reflex/test/metrics/stats.test.js`
- Modify: `reflex/src/runner/run.js` (inside `execute`, right after `summary.duration_ms = Date.now() - startedAt;`)
- Modify: `reflex/src/cli/index.js` (usage line + one `case 'stats'`)

**Interfaces:**
- Consumes: `readRuns`, `summarize`, `appendRun` from `src/metrics/ledger.js`; `workspace.root()`.
- Produces: `statsCommand({ plan, platform, since, root })` → `{ ok: true, ...summarize(...) }`; `formatStats(result)` → array of text lines;
  CLI `reflex stats [--plan name] [--platform p] [--since date] [--json]` printing the lines on stderr and one `REFLEX_JSON` line, exit 0.

- [x] **Step 1: Create `src/cli/statsCommands.js`**

```js
/**
 * statsCommands.js — `reflex stats`: read the run ledger and say how the knowledge base is doing.
 */
const workspace = require('../util/workspace');
const { readRuns, summarize } = require('../metrics/ledger');

function statsCommand({ plan = null, platform = null, since = null, root = null } = {}) {
  const records = readRuns(root || workspace.root());
  return { ok: true, ...summarize(records, { plan, platform, since }) };
}

const percent = (value) => (value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`);

/** Human lines for stderr; the machine answer is the marker line. */
function formatStats(result) {
  const lines = [];
  lines.push(`runs: ${result.runs}${result.resumes ? ` (+${result.resumes} resumed)` : ''}`);
  lines.push(`pass rate: ${percent(result.passRate)}   straight-through (no decider action): ${percent(result.straightRate)}   needed an agent: ${percent(result.needsAgentRate)}`);
  const seconds = result.avgDurationMs === null || result.avgDurationMs === undefined ? 'n/a' : `${(result.avgDurationMs / 1000).toFixed(1)}s`;
  lines.push(`decider calls: ${result.jevCalls}   est. cost: $${Number(result.jevCostUsd || 0).toFixed(4)}   avg duration: ${seconds}`);
  for (const [name, entry] of Object.entries(result.byPlan || {})) {
    lines.push(`  ${name}: ${entry.runs} run(s), ${entry.passed} pass, ${entry.straight} straight`);
  }
  return lines;
}

module.exports = { statsCommand, formatStats };
```

- [x] **Step 2: Edit `src/runner/run.js`** — immediately after the line `summary.duration_ms = Date.now() - startedAt;` (inside `execute`, before the `try { const { writeReport }` block) add:

```js
  // The ledger is a convenience: a failure to write it must never change the verdict (same rule as the report and knowledge writes).
  try {
    require('../metrics/ledger').appendRun(workspace.root(), summary);
  } catch (error) {
    log(`warning: run ledger not written: ${error.message || error}`);
  }
```
  Nothing else in `run.js` changes.

- [x] **Step 3: Edit `src/cli/index.js`** — (a) in `USAGE`, after the `screen identify` line, add
  `  stats [--plan name] [--platform p] [--since date]    pass / straight-through / decider-call rates from the run ledger`;
  (b) in the `switch (command)`, before `case 'mcp':`, add:

```js
      case 'stats': {
        const commands = require('./statsCommands');
        const result = commands.statsCommand({ plan: str(flags, 'plan'), platform, since: str(flags, 'since') });
        if (!json) for (const line of commands.formatStats(result)) note(line);
        emit(result, { json });
        return 0;
      }
```

- [x] **Step 4: Create `test/metrics/stats.test.js`** — cases it MUST contain:
  1. `statsCommand({ root })` on a temp dir whose `.agentic/runs.jsonl` holds two hand-written records returns `ok: true`, `runs: 2` and the same rates `summarize` gives; on an empty temp dir returns `runs: 0`.
  2. `statsCommand` passes `plan`, `platform` and `since` through (one record excluded by each).
  3. `formatStats` of an empty result (`runs: 0`, null rates) prints `n/a` for the rates and `$0.0000`; of a populated result prints `75.0%` for `passRate: 0.75`, the `(+1 resumed)` suffix, and one line per plan.
  4. CLI: build a temp workspace (a `reflex.workspace.json` with `{}` and `.agentic/runs.jsonl` with two records), spawn `process.execPath [reflex/bin/reflex.js, 'stats', '--json', '--workspace', <tmp>]` (use `path.join(__dirname, '..', '..', 'bin', 'reflex.js')`), parse the stdout line starting with `REFLEX_JSON ` and assert `runs === 2`, exit status 0, and that stderr does not contain `error`.
  5. CLI without `--json` still prints exactly one `REFLEX_JSON` line on stdout and the `runs:` line on stderr.
- [x] **Step 5: Add ONE test to `test/runner/run.test.js`** (read its helpers around the first full passing run test and reuse them): a finished run appends exactly one line to `<workspace>/.agentic/runs.jsonl` whose `status` equals the run's summary status and whose `runId` matches. If the helpers make this impractical, skip this step and say so in the report; the caller verifies manually.
- [x] **Step 6: Run (main session)** `npm test --prefix reflex` → 349 + T1 + T2 tests, 0 failures; existing tests unchanged and passing. Manually run `node reflex/bin/reflex.js stats --workspace workspace` (prints `runs: 0`, no crash).
- [x] **Step 7: Update `STATUS.md`** (tick T2).

---

### Task 3: Learning review

**Files:**
- Create: `reflex/src/cli/knowledgeCommands.js`
- Create: `reflex/test/cli/knowledgeReview.test.js`
- Modify: `reflex/src/cli/index.js` (usage line + `case 'knowledge'`)

**Context (read 2026-10-05):** `loadStore(root, app)` (`src/screens/store.js`) returns `screens` (each with `normal` cases `{ to, intent, steps, status, stats?, pinned?, file, key }` and
`exceptions` rules `{ id, when, do, status?, stats?, pinned?, file, key }`), `groups` (mini-app exceptions), `appTier.exceptions`, `shared` (policy rules, not reviewed). It already overlays the
per-machine counters of `.agentic/stats.json` onto every item (`overlayStats`). Case statuses are `draft | learned | verified`; the loader defaults a missing `status` to `draft`. Promotion
(`learned → verified` after `PROMOTE_STREAK = 3` ok runs) and removal (`REMOVE_STREAK = 2` fails) live in `screens/learn.js` `applyOutcome` and are NOT changed here.

**Interfaces:**
- Produces: `knowledgeReview({ app, status = 'review', root = null })` → `{ ok: true, app, status, total, shown, items }` where each item is
  `{ kind: 'case' | 'exception', screen, name, status, pinned, ok, fail, streak, lastOk, lastFail }` (+ `does` for exceptions: the single key of `do`, e.g. `tap`);
  `formatReview(result)` → array of text lines. `status` filter: `review` (default = `learned` + `draft`), `all`, `learned`, `draft`, `verified`. (Corrected after T3: the loader gives hand-written rules without a status the status `draft`, so there is no `authored` filter.)
- Privacy: step arguments, `when` conditions and tap texts are NEVER put in the result (they may hold placeholders for secrets); only ids, targets, status and counters.
- CLI: `reflex knowledge review --app <key> [--status …] [--json]`; lines on stderr, one `REFLEX_JSON` line on stdout, exit 0.

- [x] **Step 1: Create `src/cli/knowledgeCommands.js`**

```js
/**
 * knowledgeCommands.js — `reflex knowledge review`: what the runner learned, so a human can look at it before trusting it.
 *
 * Read-only. It never prints step arguments, rule conditions or tap texts (they may carry placeholders for secrets): only
 * ids, targets, statuses and the counters. The counters already include this machine's `.agentic/stats.json` (the store overlays them).
 */
const workspace = require('../util/workspace');
const { loadStore } = require('../screens/store');

const REVIEW_STATUSES = ['learned', 'draft'];
const STATUS_FILTERS = ['review', 'all', 'learned', 'draft', 'verified'];

/** The store gives every item a status (a hand-written rule without one is a `draft`: a guess nobody has proven yet). */
function statusOf(item) {
  return item.status || 'draft';
}

function rowOf(kind, screen, item) {
  const stats = item.stats || {};
  const row = {
    kind,
    screen,
    name: kind === 'case' ? `to ${item.to}` : item.id,
    status: statusOf(item),
    pinned: Boolean(item.pinned),
    ok: Number(stats.ok) || 0,
    fail: Number(stats.fail) || 0,
    streak: Number(stats.streak) || 0,
    lastOk: stats.lastOk || null,
    lastFail: stats.lastFail || null,
  };
  if (kind === 'exception') row.does = Object.keys(item.do || {})[0] || null;
  return row;
}

function collect(store) {
  const rows = [];
  for (const screen of store.screens.values()) {
    for (const item of screen.normal) rows.push(rowOf('case', screen.id, item));
    for (const item of screen.exceptions) rows.push(rowOf('exception', screen.id, item));
  }
  for (const [group, entry] of store.groups) {
    for (const item of entry.exceptions) rows.push(rowOf('exception', `${group}/_miniapp`, item));
  }
  for (const item of store.appTier.exceptions) rows.push(rowOf('exception', '_app', item));
  return rows;
}

function knowledgeReview({ app, status = 'review', root = null } = {}) {
  if (!app) throw new Error('knowledge review requires --app <key>');
  if (!STATUS_FILTERS.includes(status)) {
    throw new Error(`--status must be one of ${STATUS_FILTERS.join(', ')} (got "${status}")`);
  }
  const store = loadStore(root || workspace.root(), String(app));
  const all = collect(store);
  const wanted = all.filter((row) => (status === 'all' ? true : status === 'review' ? REVIEW_STATUSES.includes(row.status) : row.status === status));
  // Most recently proven first: the freshest learning is what a reviewer should look at; never-proven items come last.
  const items = wanted.sort((a, b) => (
    String(b.lastOk || '').localeCompare(String(a.lastOk || ''))
    || a.screen.localeCompare(b.screen)
    || a.name.localeCompare(b.name)
  ));
  return { ok: true, app: String(app), status, total: all.length, shown: items.length, items };
}

function formatReview(result) {
  const lines = [`${result.shown} of ${result.total} item(s) for app "${result.app}" (status: ${result.status})`];
  for (const item of result.items) {
    const detail = item.kind === 'exception' && item.does ? ` -> ${item.does}` : '';
    const flags = `${item.status}${item.pinned ? ', pinned' : ''}`;
    lines.push(`  ${item.screen}  ${item.kind} ${item.name}${detail}  [${flags}]  ok ${item.ok} / fail ${item.fail}, streak ${item.streak}, last ok ${item.lastOk || 'never'}`);
  }
  return lines;
}

module.exports = { knowledgeReview, formatReview, STATUS_FILTERS };
```

- [x] **Step 2: Edit `src/cli/index.js`** — (a) in `USAGE`, after the `stats` line, add
  `  knowledge review --app <key> [--status review|all|learned|draft|verified]   cases and rules the runner learned, with their counters`;
  (b) in the `switch (command)`, before `case 'mcp':`, add:

```js
      case 'knowledge': {
        if (sub === 'review') {
          const commands = require('./knowledgeCommands');
          const result = commands.knowledgeReview({ app: str(flags, 'app'), status: str(flags, 'status') || 'review' });
          if (!json) for (const line of commands.formatReview(result)) note(line);
          emit(result, { json });
          return 0;
        }
        break;
      }
```

- [x] **Step 3: Create `test/cli/knowledgeReview.test.js`** (`node:test` + `node:assert/strict`). Build a temp workspace with `fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-review-'))`:
  `reflex.workspace.json` = `{ "name": "t", "apps": { "app1": { "android": { "package": "p.app1" } } } }`;
  `screens/app1/core/home/screen.md` and `screens/app1/core/login/screen.md` (front matter `id`, `identify: { allText: ["Home"] }` / `["Login"]`, `inputs: []`, then a one-line body);
  `screens/app1/core/home/normal.yml` with three cases to `core/login`... NOTE: a screen's cases may share a `to`, so use distinct `intent`s and distinct step texts:
  a `learned` case (`status: learned`, `stats: { ok: 2, fail: 0, streak: 2, lastOk: '2026-10-04' }`, step `{ tool: tap_text, args: { text: "SECRET_BUTTON", exact: true } }`),
  a `draft` case (no stats), a `verified` case (`stats: { ok: 5, fail: 0, streak: 5, lastOk: '2026-10-01' }`);
  `screens/app1/core/home/exceptions.yml` with a learned rule (`id: dismiss_promo`, `when: { allText: ["Promo"] }`, `do: { tap: "SECRET_BUTTON" }`, `status: learned`, `stats: { ok: 1, fail: 0, streak: 1, lastOk: '2026-10-05' }`) and a hand-written rule (`id: maintenance`, `when: { allText: ["Maintenance"] }`, `do: { blocked: "UAT is down" }`);
  `screens/app1/_app/exceptions.yml` with a learned rule `id: rate_us` (`do: { back: true }`, `status: learned`).
  Cases it MUST contain:
  1. default `status: 'review'` returns exactly the learned and draft items (the learned case, the draft case, `dismiss_promo`, `rate_us`, and `maintenance` which is a draft), `total` counts all six, `shown` is 5 (the plan first said 4: the loader defaults a missing status to `draft`).
  2. `all` returns six items; `verified` only the verified case; `draft` the draft case and `maintenance` (a rule without a status is a draft); `learned` the three learned ones.
  3. sorting: `dismiss_promo` (lastOk 2026-10-05) before the learned case (2026-10-04); the draft case (never proven) is last among the `review` items.
  4. counters come from the file (`ok: 2`, `streak: 2`, `lastOk: '2026-10-04'` for the learned case; `lastOk: null` and zeros for the draft).
  5. `does` is `tap` for `dismiss_promo`, `back` for `rate_us`, `blocked` for `maintenance`; `screen` is `core/home` for the first two and `_app` for `rate_us`.
  6. privacy: `JSON.stringify(result)` and `formatReview(result).join('\n')` contain neither `SECRET_BUTTON` nor `UAT is down` nor `Promo`.
  7. an unknown `status` throws `--status must be one of review, all, learned, draft, verified (got "nope")`; a missing `app` throws `knowledge review requires --app <key>`.
  8. `formatReview` prints `last ok never` for the draft case and `[learned]` / `[draft]` markers.
  9. CLI: spawn `process.execPath [reflex/bin/reflex.js, 'knowledge', 'review', '--app', 'app1', '--json', '--workspace', <tmp>]` (`path.join(__dirname, '..', '..', 'bin', 'reflex.js')`), parse the `REFLEX_JSON ` stdout line, assert `shown === 5`, exit status 0; the same without `--json` prints exactly one marker line and the header line on stderr.
- [x] **Step 4: Run (main session)** `npm test --prefix reflex` → 367 + new tests, 0 failures. If a fixture file fails schema validation, fix the FIXTURE (not the loader) and note it.
- [x] **Step 5: Update `STATUS.md`** (tick T3).

---

### Task 4: Popup-vs-error corpus (done in the main session, 2026-10-05)

**Why not delegated:** the expected behaviour had to be discovered by running scenarios, and it touched 3 files.

**Delivered:** `reflex/test/fixtures/flowHarness.js` (a small harness mirroring `setup()` in `flow.test.js`; tech debt: share one harness when that file is next refactored)
and `reflex/test/runner/popupCorpus.test.js`. Screens: `home_promo` (harmless) and `home_alert` (a "Lỗi hệ thống" dialog), both over Home with a "Đóng" button.
Scenarios (all pass): (1) control: a promo dismissed by the decider is learned as a dismiss rule; (2) an authored promo rule does not fire on the error dialog;
(3) an authored `fail` rule ends the leg as fail with 0 decider calls and nothing learned; (4) below-threshold confidence on the error → `needs_agent`, nothing pressed/learned;
(5) a decider `fail` verdict ends the leg and never presses the button; (6) the real gap, first as a `todo` that proved the gap and then, after T5, a normal test:
an error dialog dismissed by the decider is NOT learned as a rule (a `skipped` event with the reason); (7) unit test of `looksLikeError`.

### Task 5: Error-text guard in the learner (done in the main session, 2026-10-05)

**Finding:** `screens/learn.js` `jevAction` classified any popup the decider closed (and after which the leg continued) as a dismiss rule via `toException`; nothing
checked whether the dialog was an ERROR. One lucky "Đóng" on a real error therefore became a permanent auto-dismiss rule.

**Change (only `screens/learn.js`):** `ERROR_HINTS` + exported `looksLikeError(texts)` (accent-aware, matched on NFC text, NOT on folded text: folded "lỗi" equals "lợi"/"lời");
in `jevAction`, when the texts that disappeared look like an error, push a `skipped` event (`'looks like an error: not learned as a dismissal'`) and return before `toException`.
The leg's own status is unchanged (the app may legitimately continue); only the knowledge write is refused. Verdict-based rules (`fail`/`blocked`) are untouched.
**Known limits:** the list is small and Vietnamese/English only; a dialog whose error wording is not in it is still learnable (extend `ERROR_HINTS` as new wording is met);
the decision to let a leg PASS after dismissing an error is a separate question (the ledger's `straight` and a future "warnings" counter are the place to watch it).


---

## Self-review (2026-10-05)
- Roadmap coverage: run ledger + `stats` (T1, T2), learning protection (T3 review + T4 corpus; the "trusted only after N clean runs" gate already exists as `PROMOTE_STREAK`).
- T3/T4 are spec-level on purpose: their code depends on reading `learn.js`/flow test helpers first. Write their detailed steps at the start of each.
- Types: record field names in T1 are the single source for `statsCommands.js` and its tests (`jevCalls`, `jevCostUsd`, `straight`, `resumed`, `levels`, `learned`).
