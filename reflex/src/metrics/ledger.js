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
