/**
 * identify.js — which ONE of the candidate screens does this snapshot show?
 *
 * Many screens look alike, so a call that several screens match is never a coin flip: the
 * most specific `identify` wins, and a true tie is reported as `ambiguous` (the leg loop
 * warns and carries on) instead of silently driving the run from the wrong screen.
 */
const { screenIndex, matchWhen, specificity } = require('./match');

/** -> { id: string|null, ambiguous: string[] } — only `ids` are considered. */
function identifyScreen(snapshot, store, ids) {
  const index = screenIndex(snapshot);
  const matches = [];
  const seen = new Set();
  for (const id of ids || []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const screen = store.screens.get(id);
    if (screen && matchWhen(index, screen.identify)) matches.push(id);
  }
  if (!matches.length) return { id: null, ambiguous: [] };
  if (matches.length === 1) return { id: matches[0], ambiguous: [] };
  const best = Math.max(...matches.map((id) => specificity(store.screens.get(id).identify)));
  const winners = matches.filter((id) => specificity(store.screens.get(id).identify) === best);
  if (winners.length === 1) return { id: winners[0], ambiguous: [] };
  return { id: null, ambiguous: winners };
}

module.exports = { identifyScreen };
