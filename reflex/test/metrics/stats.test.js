/**
 * stats.test.js — `reflex stats`: the ledger read, the filter pass-through, the human lines and the
 * CLI contract (exactly one REFLEX_JSON line, exit 0). No device, no run: the records are written by hand.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { readRuns, summarize } = require('../../src/metrics/ledger');
const { statsCommand, formatStats } = require('../../src/cli/statsCommands');

const BIN = path.join(__dirname, '..', '..', 'bin', 'reflex.js');

// Two hand-written records: one straight pass, one run that needed an agent after two decider actions.
const RECORDS = [
  {
    v: 1, at: '2026-10-01T10:00:00.000Z', runId: 'r1', plan: 'checkout', app: 'pkg', platform: 'android',
    status: 'pass', rows: 2, passed: 2, failed: 0, blocked: 0, duration_ms: 4000,
    levels: { L0: 8, L1: 0, L2: 0, L3: 0 }, jevCalls: 0, jevCostUsd: 0, straight: true, resumed: false,
    learned: { added: 1, replaced: 0, removed: 0, promoted: 0, demoted: 0, route: 0 },
  },
  {
    v: 1, at: '2026-10-05T10:00:00.000Z', runId: 'r2', plan: 'signup', app: 'pkg', platform: 'ios',
    status: 'needs_agent', rows: 1, passed: 0, failed: 0, blocked: 0, duration_ms: 6000,
    levels: { L0: 3, L1: 1, L2: 2, L3: 1 }, jevCalls: 2, jevCostUsd: 0.25, straight: false, resumed: false,
    learned: { added: 0, replaced: 0, removed: 0, promoted: 0, demoted: 0, route: 0 },
  },
];

let root;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-stats-')));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeLedger(target, records) {
  fs.mkdirSync(path.join(target, '.agentic'), { recursive: true });
  fs.writeFileSync(path.join(target, '.agentic', 'runs.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

/** The smallest workspace the CLI accepts: the manifest and the ledger, nothing else. */
function writeWorkspace(records) {
  fs.writeFileSync(path.join(root, 'reflex.workspace.json'), '{}\n');
  writeLedger(root, records);
}

function cli(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
  const markers = result.stdout.split('\n').filter((line) => line.startsWith('REFLEX_JSON '));
  return {
    code: result.status,
    markers,
    marker: markers.length ? JSON.parse(markers[markers.length - 1].slice('REFLEX_JSON '.length)) : null,
    stderr: result.stderr,
  };
}

test('statsCommand reads the ledger: ok, the run count, and the same rates as summarize', () => {
  // A fresh workspace has no ledger at all: that is a zero, never an error.
  const empty = statsCommand({ root });
  assert.equal(empty.ok, true);
  assert.equal(empty.runs, 0);
  assert.equal(empty.passRate, null);
  assert.deepEqual(empty, { ok: true, ...summarize([]) });

  writeLedger(root, RECORDS);
  const result = statsCommand({ root });
  assert.equal(result.ok, true);
  assert.equal(result.runs, 2);
  assert.equal(result.resumes, 0);
  assert.equal(result.passRate, 0.5);
  assert.equal(result.straightRate, 0.5);
  assert.equal(result.needsAgentRate, 0.5);
  assert.equal(result.jevCalls, 2);
  assert.equal(result.jevCostUsd, 0.25);
  // The whole answer is exactly summarize over the same records: the command adds only `ok`.
  assert.deepEqual(result, { ok: true, ...summarize(readRuns(root)) });
});

test('statsCommand passes plan, platform and since through: one record is dropped by each filter', () => {
  writeLedger(root, RECORDS);

  const byPlan = statsCommand({ root, plan: 'checkout' });
  assert.equal(byPlan.runs, 1);
  assert.deepEqual(byPlan.byPlan, { checkout: { runs: 1, passed: 1, straight: 1 } });

  const byPlatform = statsCommand({ root, platform: 'ios' });
  assert.equal(byPlatform.runs, 1);
  assert.deepEqual(byPlatform.byPlan, { signup: { runs: 1, passed: 0, straight: 0 } });

  // '2026-10-04' is after the 2026-10-01 record and before the 2026-10-05 one, so only r2 survives.
  const bySince = statsCommand({ root, since: '2026-10-04' });
  assert.equal(bySince.runs, 1);
  assert.equal(bySince.jevCalls, 2);
  assert.equal(bySince.jevCostUsd, 0.25);

  // Filters compose: nothing matches both, which is still a valid empty answer.
  const none = statsCommand({ root, plan: 'checkout', platform: 'ios' });
  assert.equal(none.runs, 0);
  assert.equal(none.passRate, null);
});

test('formatStats prints n/a for an empty ledger and the real rates for a populated one', () => {
  const empty = formatStats({ runs: 0, resumes: 0, passRate: null, straightRate: null, needsAgentRate: null, jevCalls: 0, jevCostUsd: 0, avgDurationMs: null, byStatus: {}, byPlan: {} });
  assert.equal(empty[0], 'runs: 0');
  assert.ok(empty[1].includes('pass rate: n/a'), empty[1]);
  assert.ok(empty[1].includes('straight-through (no decider action): n/a'), empty[1]);
  assert.ok(empty[1].includes('needed an agent: n/a'), empty[1]);
  assert.ok(empty[2].includes('est. cost: $0.0000'), empty[2]);
  assert.ok(empty[2].includes('avg duration: n/a'), empty[2]);
  assert.equal(empty.length, 3);

  const populated = formatStats({
    runs: 4, resumes: 1, passRate: 0.75, straightRate: 0.5, needsAgentRate: 0.25,
    jevCalls: 5, jevCostUsd: 0.1235, avgDurationMs: 12345, byStatus: { pass: 3 },
    byPlan: { checkout: { runs: 2, passed: 2, straight: 1 } },
  });
  assert.equal(populated[0], 'runs: 4 (+1 resumed)');
  assert.ok(populated[1].includes('pass rate: 75.0%'), populated[1]);
  assert.ok(populated[1].includes('straight-through (no decider action): 50.0%'), populated[1]);
  assert.ok(populated[1].includes('needed an agent: 25.0%'), populated[1]);
  assert.ok(populated[2].includes('decider calls: 5'), populated[2]);
  assert.ok(populated[2].includes('est. cost: $0.1235'), populated[2]);
  assert.ok(populated[2].includes('avg duration: 12.3s'), populated[2]);
  // One line per plan, indented under the totals.
  assert.equal(populated[3], '  checkout: 2 run(s), 2 pass, 1 straight');
  assert.equal(populated.length, 4);
});

test('reflex stats --json on a workspace with two records: exit 0, one marker, no error', () => {
  writeWorkspace(RECORDS);
  const { code, marker, markers, stderr } = cli(['stats', '--json', '--workspace', root]);
  assert.equal(code, 0, stderr);
  assert.equal(markers.length, 1, markers.join('\n'));
  assert.equal(marker.ok, true);
  assert.equal(marker.runs, 2);
  assert.equal(marker.passRate, 0.5);
  assert.ok(!stderr.includes('error'), stderr);
});

test('reflex stats without --json: the human lines go to stderr, stdout stays the marker only', () => {
  writeWorkspace(RECORDS);
  const { code, markers, stderr } = cli(['stats', '--workspace', root]);
  assert.equal(code, 0, stderr);
  assert.equal(markers.length, 1, markers.join('\n'));
  const lines = stderr.split('\n');
  assert.ok(lines.includes('runs: 2'), stderr);
  assert.ok(lines.some((line) => line.startsWith('  checkout: ')), stderr);
  assert.ok(lines.some((line) => line.startsWith('  signup: ')), stderr);
});
