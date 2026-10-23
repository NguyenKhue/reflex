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
