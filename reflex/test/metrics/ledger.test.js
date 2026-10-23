/**
 * ledger.test.js — the run ledger is the only thing that can say whether reflex is actually learning, so its numbers
 * are pinned here: a run that passed without asking the decider is counted, a resumed run is not counted twice, a
 * damaged line never hides the others, and no input value can ever reach a record.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { LEDGER_FILE, ledgerFileOf, recordOf, appendRun, readRuns, summarize } = require('../../src/metrics/ledger');

const NOW = Date.parse('2026-10-05T10:00:00Z');
const AT = '2026-10-05T10:00:00.000Z';

function tmpRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-ledger-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** The typical `execute()` summary: two passing legs, one exception rule, no decider call. */
function typicalSummary() {
  return {
    runId: 'r1',
    plan: 'p',
    app: 'pkg',
    platform: 'android',
    status: 'pass',
    total: 2,
    passed: 2,
    failed: 0,
    blocked: 0,
    duration_ms: 5000,
    rows: [
      { id: 'a', status: 'pass', levels: { L0: 3, L1: 1, L2: 0, L3: 0 } },
      { id: 'b', status: 'pass', levels: { L0: 2, L1: 0, L2: 0, L3: 0 } },
    ],
    jev: { calls: 0, cost_usd: 0 },
    knowledge: [{ action: 'added' }, { action: 'promoted' }, { action: 'skipped' }],
  };
}

/** A hand-written record, so the rate arithmetic is tested without going back through `recordOf`. */
function record(overrides) {
  return Object.assign({
    v: 1,
    at: '2026-10-05T09:00:00.000Z',
    runId: null,
    plan: 'p',
    app: 'pkg',
    platform: 'android',
    status: 'pass',
    rows: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    duration_ms: 0,
    levels: { L0: 0, L1: 0, L2: 0, L3: 0 },
    jevCalls: 0,
    jevCostUsd: 0,
    straight: true,
    resumed: false,
    learned: { added: 0, replaced: 0, removed: 0, promoted: 0, demoted: 0, route: 0 },
  }, overrides);
}

test('1. recordOf turns a typical summary into the exact record, straight included', () => {
  assert.deepEqual(recordOf(typicalSummary(), NOW), {
    v: 1,
    at: AT,
    runId: 'r1',
    plan: 'p',
    app: 'pkg',
    platform: 'android',
    status: 'pass',
    rows: 2,
    passed: 2,
    failed: 0,
    blocked: 0,
    duration_ms: 5000,
    levels: { L0: 5, L1: 1, L2: 0, L3: 0 },
    jevCalls: 0,
    jevCostUsd: 0,
    straight: true,
    resumed: false,
    learned: { added: 1, replaced: 0, removed: 0, promoted: 1, demoted: 0, route: 0 },
  });
});

test('2. straight needs a pass AND no decider action: L2 > 0 kills it, a non-pass kills it, L1 alone does not', () => {
  const base = { runId: 'r', plan: 'p', app: 'pkg', platform: 'android', status: 'pass', total: 1, passed: 1 };

  const asked = recordOf(Object.assign({}, base, { rows: [{ id: 'a', levels: { L0: 1, L1: 0, L2: 1, L3: 0 } }] }), NOW);
  assert.equal(asked.straight, false);

  const failed = recordOf(Object.assign({}, base, {
    status: 'failed',
    rows: [{ id: 'a', levels: { L0: 1, L1: 0, L2: 0, L3: 0 } }],
  }), NOW);
  assert.equal(failed.straight, false);

  const blocked = recordOf(Object.assign({}, base, {
    status: 'needs_agent',
    rows: [{ id: 'a', levels: { L0: 1, L1: 0, L2: 0, L3: 0 } }],
  }), NOW);
  assert.equal(blocked.straight, false);

  const exceptionOnly = recordOf(Object.assign({}, base, {
    rows: [{ id: 'a', levels: { L0: 2, L1: 3, L2: 0, L3: 0 } }],
  }), NOW);
  assert.equal(exceptionOnly.straight, true);
});

test('3. a missing or empty summary is an error record of zeros, not a crash', () => {
  for (const source of [{}, null]) {
    assert.deepEqual(recordOf(source, NOW), {
      v: 1,
      at: AT,
      runId: null,
      plan: null,
      app: null,
      platform: null,
      status: 'error',
      rows: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      duration_ms: 0,
      levels: { L0: 0, L1: 0, L2: 0, L3: 0 },
      jevCalls: 0,
      jevCostUsd: 0,
      straight: false,
      resumed: false,
      learned: { added: 0, replaced: 0, removed: 0, promoted: 0, demoted: 0, route: 0 },
    });
  }
});

test('4. resumedFrom marks the record as a resume', () => {
  assert.equal(recordOf(Object.assign(typicalSummary(), { resumedFrom: { legIndex: 1 } }), NOW).resumed, true);
  assert.equal(recordOf(typicalSummary(), NOW).resumed, false);
  assert.equal(recordOf({ resumedFrom: null }, NOW).resumed, false);
});

test('5. no secret can reach the record: only the fixed field list is serialised', () => {
  const summary = {
    runId: 'r1',
    plan: 'p',
    app: 'pkg',
    platform: 'android',
    status: 'failed',
    total: 1,
    failed: 1,
    duration_ms: 10,
    rows: [{ id: 'a', status: 'failed', error: 'boom', captures: { secret: 'TOPSECRET' }, levels: {} }],
    data: { password: 'TOPSECRET' },
    knowledge: [{ action: 'added', key: 'x', text: 'TOPSECRET' }],
  };
  const written = recordOf(summary, NOW);
  const text = JSON.stringify(written);
  assert.equal(text.includes('TOPSECRET'), false);
  assert.equal(text.includes('boom'), false);
  assert.equal(text.includes('captures'), false);
  // the counters it does keep: one row, one knowledge event, no level counts because `levels` was empty
  assert.equal(written.rows, 1);
  assert.equal(written.failed, 1);
  assert.deepEqual(written.levels, { L0: 0, L1: 0, L2: 0, L3: 0 });
  assert.deepEqual(written.learned, { added: 1, replaced: 0, removed: 0, promoted: 0, demoted: 0, route: 0 });
});

test('6. appendRun creates .agentic/runs.jsonl and appends one line per run', (t) => {
  const root = tmpRoot(t);
  const file = path.join(root, '.agentic', 'runs.jsonl');
  assert.equal(LEDGER_FILE, path.join('.agentic', 'runs.jsonl'));
  assert.equal(ledgerFileOf(root), file);
  assert.equal(fs.existsSync(file), false);

  const first = appendRun(root, typicalSummary(), { now: NOW });
  assert.equal(fs.existsSync(file), true);
  const second = appendRun(root, Object.assign(typicalSummary(), { runId: 'r2' }), { now: NOW + 1000 });

  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), first);
  assert.deepEqual(JSON.parse(lines[1]), second);
  assert.deepEqual(second, recordOf(Object.assign(typicalSummary(), { runId: 'r2' }), NOW + 1000));
});

test('7. readRuns returns [] for a missing ledger and skips blank, truncated and non-object lines', (t) => {
  const root = tmpRoot(t);
  assert.deepEqual(readRuns(root), []);

  const good1 = record({ runId: 'a', at: '2026-10-05T09:00:00.000Z' });
  const good2 = record({ runId: 'b', at: '2026-10-05T10:00:00.000Z' });
  const file = ledgerFileOf(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    JSON.stringify(good1),
    '',
    '{"v":1,',
    '[1,2]',
    JSON.stringify(good2),
    '',
  ].join('\n'));

  assert.deepEqual(readRuns(root), [good1, good2]);
});

test('8. summarize on an empty ledger gives null rates and empty maps', () => {
  assert.deepEqual(summarize([]), {
    runs: 0,
    resumes: 0,
    passRate: null,
    straightRate: null,
    needsAgentRate: null,
    jevCalls: 0,
    jevCostUsd: 0,
    avgDurationMs: null,
    byStatus: {},
    byPlan: {},
  });
});

test('9. rates come from the non-resumed records: 3 pass of 4, 2 of them straight', () => {
  const records = [
    record({ status: 'pass', straight: true, duration_ms: 1000 }),
    record({ status: 'pass', straight: true, duration_ms: 2000 }),
    record({
      status: 'pass',
      straight: false,
      duration_ms: 3000,
      levels: { L0: 1, L1: 0, L2: 2, L3: 0 },
      jevCalls: 2,
      jevCostUsd: 0.01,
    }),
    record({ status: 'needs_agent', straight: false, duration_ms: 4000 }),
  ];
  const result = summarize(records);
  assert.equal(result.runs, 4);
  assert.equal(result.resumes, 0);
  assert.equal(result.passRate, 0.75);
  assert.equal(result.straightRate, 0.5);
  assert.equal(result.needsAgentRate, 0.25);
  assert.equal(result.avgDurationMs, 2500);
  assert.equal(result.jevCalls, 2);
  assert.deepEqual(result.byStatus, { pass: 3, needs_agent: 1 });
  assert.deepEqual(result.byPlan, { p: { runs: 4, passed: 3, straight: 2 } });
});

test('10. a resume is counted as a resume, not a run, but its decider calls and cost are real', () => {
  const records = [
    record({ status: 'pass', straight: true, duration_ms: 1000, jevCalls: 0, jevCostUsd: 0 }),
    record({
      status: 'error',
      straight: false,
      resumed: true,
      duration_ms: 9999,
      jevCalls: 3,
      jevCostUsd: 0.25,
    }),
  ];
  const result = summarize(records);
  assert.equal(result.runs, 1);
  assert.equal(result.resumes, 1);
  assert.equal(result.passRate, 1);
  assert.equal(result.straightRate, 1);
  assert.equal(result.needsAgentRate, 0);
  // duration ignores the resume (1000, not 5499.5)
  assert.equal(result.avgDurationMs, 1000);
  assert.equal(result.jevCalls, 3);
  assert.equal(result.jevCostUsd, 0.25);
  assert.deepEqual(result.byStatus, { pass: 1 });
  assert.deepEqual(result.byPlan, { p: { runs: 1, passed: 1, straight: 1 } });
});

test('11. plan, platform and since each narrow the set', () => {
  const records = [
    record({ at: '2026-10-05T09:00:00.000Z', plan: 'p1', platform: 'android', status: 'pass', straight: true }),
    record({ at: '2026-10-05T10:00:00.000Z', plan: 'p2', platform: 'ios', status: 'pass', straight: true }),
    record({ at: '2026-10-06T10:00:00.000Z', plan: 'p1', platform: 'android', status: 'failed', straight: false }),
  ];

  assert.equal(summarize(records, { plan: 'p1' }).runs, 2);
  assert.equal(summarize(records, { platform: 'ios' }).runs, 1);
  // '2026-10-06' as a plain date: the 10-05 records sort before it as strings
  assert.equal(summarize(records, { since: '2026-10-06' }).runs, 1);
  assert.equal(summarize(records, { since: '2026-10-06T10:00:00.000Z' }).runs, 1);
  assert.equal(summarize(records, { since: '2026-10-05' }).runs, 3);
  assert.equal(summarize(records, { plan: 'p1', platform: 'android', since: '2026-10-06' }).runs, 1);
  assert.equal(summarize(records, { plan: 'nope' }).runs, 0);

  assert.deepEqual(summarize(records, { since: '2026-10-06' }).byPlan, { p1: { runs: 1, passed: 0, straight: 0 } });
});

test('12. jevCostUsd rounds to 6 decimals and avgDurationMs rounds the mean', () => {
  const records = [
    record({ duration_ms: 1000, jevCostUsd: 0.1 }),
    record({ duration_ms: 1003, jevCostUsd: 0.2 }),
  ];
  const result = summarize(records);
  assert.equal(result.jevCostUsd, 0.3);
  assert.equal(result.avgDurationMs, 1002); // 1001.5 rounded up
  assert.equal(summarize([record({ jevCostUsd: 0.0000004 })]).jevCostUsd, 0);
  assert.equal(summarize([record({ jevCostUsd: 0.0000005 })]).jevCostUsd, 0.000001);
});
