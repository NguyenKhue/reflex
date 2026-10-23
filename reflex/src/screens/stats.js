/**
 * stats.js — the per-machine ledger of how each case/rule fared: `ok`, `fail`, `streak`, …
 *
 * The counters change on every run, so keeping them in the committed screen files made two people
 * running the same plan on two branches conflict on every case they both used. They live in
 * `<workspace>/.agentic/stats.json` instead (gitignored); the screen files only change when a
 * lifecycle decision does (promoted, demoted, removed). A streak is therefore counted per machine.
 *
 * The ledger is keyed by `<file relative to the workspace>#<merge key>`. A `stats:` still written
 * in a screen file (an older checkout) is read as the starting value until the ledger has one.
 */
const fs = require('fs');
const path = require('path');

const STATS_FILE = path.join('.agentic', 'stats.json');

/** `<workspace>` of a knowledge file: the parent of its nearest `screens/` ancestor. */
function workspaceOf(file) {
  let dir = path.dirname(path.resolve(String(file || '')));
  while (path.basename(dir) !== 'screens') {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return path.dirname(dir);
}

function statsFileOf(workspaceRoot) {
  return path.join(workspaceRoot, STATS_FILE);
}

/** Forward slashes, so a ledger reads the same on every OS. */
function statsKeyOf(workspaceRoot, file, key) {
  return `${path.relative(workspaceRoot, path.resolve(file)).split(path.sep).join('/')}#${key}`;
}

/** A missing or unreadable ledger is an empty one: the counters are a convenience, not a contract. */
function readStats(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeStats(file, ledger) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const sorted = Object.fromEntries(Object.keys(ledger).sort().map((key) => [key, ledger[key]]));
  fs.writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

module.exports = { STATS_FILE, workspaceOf, statsFileOf, statsKeyOf, readStats, writeStats };
