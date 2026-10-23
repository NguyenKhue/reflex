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
