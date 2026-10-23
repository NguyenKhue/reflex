/**
 * writer.js — the only module that writes a knowledge file, and it never overwrites a decision
 * another run made while this one was on the device.
 *
 * One `flush(ops)` per run, at the very end (also after a failure or a `needs_agent` stop). Each
 * file is treated as a small transaction: take `<file>.lock`, re-read the file as it is NOW,
 * apply the ops by their merge key, write `<file>.tmp-<pid>` and rename. A lock that cannot be
 * taken within `lockWaitMs` skips that file and says so — the run's verdict is never the
 * business of this module.
 *
 * Files are read and written with the `yaml` document API, so hand-written comments survive an
 * `outcome` (only the `status` scalar the lifecycle owns is rewritten). Items that are replaced or
 * removed are appended to `history.yml` next to them, newest last, ten at most.
 *
 * The run counters (`stats`) go to the machine-local ledger (`stats.js`), never into a screen
 * file: a file only changes when what it teaches does. The ledger lock is taken before any file
 * lock of its workspace and held for the whole flush, so two flushes can never deadlock.
 */
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { applyOutcome, isShared, historyFileOf } = require('./learn');
const { workspaceOf, statsFileOf, statsKeyOf, readStats, writeStats } = require('./stats');

const LOCK_RETRY_MS = 100;
const HISTORY_LIMIT = 10;
const RULE_ID_ATTEMPTS = 100;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The merge key of one document item: `to|steps` for a case, `id` for a rule, `path` for a route. */
function nodeKeyOf(node) {
  if (!YAML.isMap(node)) return null;
  const to = node.get('to');
  if (to !== undefined) return `${to}|${JSON.stringify(node.get('steps'))}`;
  const id = node.get('id');
  if (id !== undefined) return String(id);
  const routePath = node.get('path');
  if (routePath !== undefined) return routeKeyOf(plainOf(routePath));
  return null;
}

/** The key a NEW item will be looked up by (must match `nodeKeyOf` on the written node). */
function caseKeyOf(item) {
  return `${item.to}|${JSON.stringify(item.steps)}`;
}

/** `S1>S2>…`: a screen id never contains `>`, so the joined path is the route's own key. */
function routeKeyOf(list) {
  return (Array.isArray(list) ? list : []).join('>');
}

function emptyDoc() {
  const doc = new YAML.Document();
  doc.contents = doc.createNode([]);
  doc.contents.flow = false;
  return doc;
}

/**
 * The layout hand-written screen files use, so a learned item reads like its neighbours and a
 * git diff shows only what changed: one block mapping per item, short maps (`when`, `do`,
 * `stats`, each step) and lists inline.
 */
const INLINE_KEYS = new Set(['when', 'do', 'path']);

function styleItem(node) {
  if (!YAML.isMap(node)) return node;
  node.flow = false;
  for (const pair of node.items) {
    const key = YAML.isScalar(pair.key) ? pair.key.value : pair.key;
    const value = pair.value;
    if (INLINE_KEYS.has(key) && (YAML.isMap(value) || YAML.isSeq(value))) value.flow = true;
    if (key === 'steps' && YAML.isSeq(value)) {
      value.flow = false;
      for (const step of value.items) if (YAML.isMap(step)) step.flow = true;
    }
  }
  return node;
}

/** A missing file is an empty sequence; a file that is not a sequence is an error to report. */
function readDoc(file) {
  if (!fs.existsSync(file)) return emptyDoc();
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return emptyDoc();
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(`${file}: invalid YAML: ${doc.errors[0].message}`);
  if (!doc.contents) return emptyDoc();
  if (!YAML.isSeq(doc.contents)) throw new Error(`${file}: expected a list`);
  // `[]` (an empty flow list) would force JSON-like output onto everything appended to it.
  if (!doc.contents.items.length) doc.contents.flow = false;
  return doc;
}

function writeDoc(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, doc.toString({ flowCollectionPadding: true, lineWidth: 0 }));
  fs.renameSync(tmp, file);
}

function findNode(doc, key) {
  const items = doc.contents.items;
  for (let index = 0; index < items.length; index += 1) {
    if (nodeKeyOf(items[index]) === key) return { node: items[index], index };
  }
  return null;
}

/**
 * Drop one item. A hand-written note above the last item is prose a human wrote, so it moves to
 * the top of the file instead of vanishing with the item it happened to sit above.
 */
function deleteItem(doc, index) {
  const node = doc.contents.items[index];
  doc.contents.delete(index);
  if (!doc.contents.items.length && node && node.commentBefore && !doc.commentBefore) {
    doc.commentBefore = node.commentBefore;
  }
}

function appendItem(doc, item) {
  doc.contents.add(styleItem(doc.createNode(item)));
}

/** A learned item goes into the file without its counters; they start the ledger entry instead. */
function appendLearned(doc, item, stats, key) {
  const { stats: counters, ...rest } = item;
  appendItem(doc, rest);
  if (counters) stats.set(key, counters);
}

/**
 * One file's lock, retried until `waitMs` is up: `null` means another run owns the file.
 * The attempt budget is counted as well as the clock: an injected `now` may not advance.
 */
async function acquire(file, waitMs, now) {
  const lock = `${file}.lock`;
  const budget = Math.max(0, waitMs);
  const end = now() + budget;
  const attempts = Math.max(1, Math.ceil(budget / LOCK_RETRY_MS) + 1);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      return fs.openSync(lock, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (now() >= end || attempt + 1 >= attempts) return null;
      await wait(Math.min(LOCK_RETRY_MS, Math.max(1, end - now())));
    }
  }
  return null;
}

function release(file, fd) {
  try {
    fs.closeSync(fd);
  } catch (_) { /* the lock file is what matters */ }
  try {
    fs.unlinkSync(`${file}.lock`);
  } catch (_) { /* a missing lock is already unlocked */ }
}

/** Key-order-independent comparison: two rules are the same rule when their `when` says so. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

/** `yaml` nodes expose `toJSON`; a plain value is returned as it is. */
function plainOf(value) {
  return value && typeof value.toJSON === 'function' ? value.toJSON() : value;
}

/**
 * A rule whose id is taken by a DIFFERENT rule gets `_2`, `_3`, …: two popups can slug to the
 * same id, and the second one would otherwise be lost.
 */
function withFreeRuleId(doc, item) {
  for (let suffix = 2; suffix < RULE_ID_ATTEMPTS; suffix += 1) {
    const id = `${item.id}_${suffix}`;
    if (!findNode(doc, id)) return { ...item, id };
  }
  return null;
}

/** The same rule id is the same rule only when its `when` says the same thing. */
function sameRule(node, item) {
  return JSON.stringify(canonical(plainOf(node.get('when')))) === JSON.stringify(canonical(item.when));
}

/** The archived item is the knowledge itself; `file`/`key` are where it lives, not what it is. */
function archived(item) {
  const { file, key, ...rest } = item;
  return rest;
}

/** One line of `history.yml`: what left the file, why, and which run made it leave. */
function historyEntry(op, item, reason, at) {
  return { item: archived(item), reason, runId: op.runId || null, at, file: op.file };
}

/**
 * Apply one op to one document. Returns the events a reviewer should see, the item to put in
 * `history.yml` when something was replaced or removed, and whether the file changed at all.
 * Only ops that changed a status are events: a plain stats bump would drown the report.
 */
function applyOp(doc, op, at, stats) {
  if (op.kind === 'addCase' || op.kind === 'addRule') {
    const key = op.kind === 'addCase' ? caseKeyOf(op.item) : String(op.item.id);
    const found = findNode(doc, key);
    // Learning the same transition twice is a use of the knowledge, not a change to it, so the
    // existing item takes the outcome instead.
    if (found && (op.kind === 'addCase' || sameRule(found.node, op.item))) {
      return applyOutcomeOp(doc, { ...op, kind: 'outcome', key, ok: true }, at, found, stats);
    }
    const wanted = found ? withFreeRuleId(doc, op.item) : op.item;
    if (wanted === null) return { events: [], history: null, changed: false };
    const addedKey = op.kind === 'addCase' ? key : String(wanted.id);
    appendLearned(doc, wanted, stats, addedKey);
    return { events: [{ action: 'added', key: addedKey }], history: null, changed: true };
  }

  if (op.kind === 'replaceCase') {
    const newKey = caseKeyOf(op.item);
    const found = findNode(doc, op.key);
    if (!found) {
      appendLearned(doc, op.item, stats, newKey);
      return { events: [{ action: 'added', key: newKey }], history: null, changed: true };
    }
    if (op.key === newKey) return applyOutcomeOp(doc, { ...op, kind: 'outcome', key: newKey, ok: true }, at, found, stats);
    const removed = withStats(found.node.toJSON(), stats.get(op.key));
    stats.delete(op.key);
    deleteItem(doc, found.index);
    appendLearned(doc, op.item, stats, newKey);
    return {
      events: [{ action: 'replaced', key: newKey }],
      history: historyEntry(op, { ...removed, key: op.key }, op.reason || 'replaced by a learned case', at),
      changed: true,
    };
  }

  if (op.kind === 'outcome') return applyOutcomeOp(doc, op, at, null, stats);

  if (op.kind === 'addRoute') {
    const key = routeKeyOf(op.path);
    if (findNode(doc, key)) return { events: [], history: null, changed: false };
    appendItem(doc, { path: op.path });
    return { events: [{ action: 'route', key }], history: null, changed: true };
  }

  return { events: [], history: null, changed: false };
}

/** The ledger's counters win; a `stats:` left in the file (an older checkout) is the fallback. */
function withStats(plain, counters) {
  return counters ? { ...plain, stats: counters } : plain;
}

function applyOutcomeOp(doc, op, at, found, stats) {
  const hit = found || findNode(doc, op.key);
  // An outcome for something that is no longer in the file (another run removed it) is a no-op.
  if (!hit) return { events: [], history: null, changed: false };
  const plain = withStats(hit.node.toJSON(), stats.get(op.key));
  const { item, event } = applyOutcome(
    { ...plain, file: op.file, key: op.key },
    op.ok !== false,
    { today: at.slice(0, 10) },
  );
  if (event === 'removed') {
    stats.delete(op.key);
    deleteItem(doc, hit.index);
    return {
      events: [{ action: 'removed', key: op.key }],
      history: historyEntry(op, item, 'removed after repeated failures', at),
      changed: true,
    };
  }
  if (item.stats) stats.set(op.key, item.stats);
  // Only the scalar the lifecycle owns is rewritten, so every other comment and layout stays.
  // A missing `status` means `draft` (the schema default), and writing that default out would be
  // a diff nobody asked for.
  const before = plain.status === undefined || plain.status === null ? 'draft' : plain.status;
  const after = item.status === undefined || item.status === null ? 'draft' : item.status;
  if (after === before) return { events: [], history: null, changed: false };
  hit.node.set('status', after);
  // The file changes anyway, so a `stats:` an older checkout left behind goes with it: the ledger
  // holds the counters now.
  hit.node.delete('stats');
  return { events: event ? [{ action: event, key: op.key }] : [], history: null, changed: true };
}

function appendHistory(entry) {
  const file = entry.historyFile || historyFileOf(entry.file);
  const doc = readDoc(file);
  appendItem(doc, { at: entry.at, runId: entry.runId, reason: entry.reason, item: entry.item });
  // Newest last, ten at most: an old attempt is interesting, an archive is not.
  while (doc.contents.items.length > HISTORY_LIMIT) doc.contents.delete(0);
  writeDoc(file, doc);
}

/**
 * The ledger of each workspace a flush touches: locked on first use, read once, written once when
 * the flush ends. A ledger another run holds is still read — a lifecycle decision needs the
 * counters — but this run's counters are then dropped and the skip is reported.
 */
function openLedgers(lockWaitMs, now, skipped) {
  const open = new Map();
  const loose = {};

  async function forFile(file) {
    const root = workspaceOf(file);
    // A file outside any `screens/` tree has nowhere to keep counters: they live for this flush.
    if (!root) return viewOf({ data: loose }, (key) => `${file}#${key}`);
    if (!open.has(root)) {
      const statsFile = statsFileOf(root);
      let lock = null;
      try {
        lock = await acquire(statsFile, lockWaitMs, now);
        if (lock === null) skipped.push({ file: statsFile, reason: `locked by another run (waited ${Math.max(0, lockWaitMs)}ms)` });
      } catch (error) {
        skipped.push({ file: statsFile, reason: error.message || String(error) });
      }
      open.set(root, { statsFile, lock, data: readStats(statsFile), dirty: false });
    }
    return viewOf(open.get(root), (key) => statsKeyOf(root, file, key));
  }

  function viewOf(ledger, keyOf) {
    return {
      get: (key) => ledger.data[keyOf(key)],
      set: (key, counters) => { ledger.data[keyOf(key)] = counters; ledger.dirty = true; },
      delete: (key) => { delete ledger.data[keyOf(key)]; ledger.dirty = true; },
    };
  }

  function close() {
    for (const ledger of open.values()) {
      if (ledger.lock === null) continue;
      try {
        if (ledger.dirty) writeStats(ledger.statsFile, ledger.data);
      } catch (error) {
        skipped.push({ file: ledger.statsFile, reason: error.message || String(error) });
      } finally {
        release(ledger.statsFile, ledger.lock);
      }
    }
  }

  return { forFile, close };
}

/**
 * `flush(ops, { lockWaitMs, now })` -> `{ applied, skipped }`.
 *
 * `applied` = `{ action, file, key }` for every change a reviewer should see; `skipped` =
 * `{ file, reason }` for a file that could not be written (locked, unreadable, or policy).
 */
async function flush(ops, { lockWaitMs = 5000, now = Date.now } = {}) {
  const applied = [];
  const skipped = [];
  const byFile = new Map();
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || !op.file) continue;
    if (isShared(op.file)) {
      skipped.push({ file: op.file, reason: 'screens/_shared is hand-edited policy: the runner never writes it' });
      continue;
    }
    if (!byFile.has(op.file)) byFile.set(op.file, []);
    byFile.get(op.file).push(op);
  }

  const ledgers = openLedgers(lockWaitMs, now, skipped);
  try {
    for (const [file, fileOps] of byFile) {
      await flushFile(file, fileOps, await ledgers.forFile(file), { applied, skipped, lockWaitMs, now });
    }
  } finally {
    ledgers.close();
  }
  return { applied, skipped };
}

/**
 * Counter changes held back until their file is written: a case that never reached its file must
 * not leave counters behind in the ledger.
 */
function staged(stats) {
  const pending = new Map();
  return {
    get: (key) => (pending.has(key) ? pending.get(key) : stats.get(key)),
    set: (key, counters) => pending.set(key, counters),
    delete: (key) => pending.set(key, undefined),
    commit() {
      for (const [key, counters] of pending) {
        if (counters === undefined) stats.delete(key);
        else stats.set(key, counters);
      }
    },
  };
}

/** One file as one transaction: lock, re-read, apply the ops, write, then keep its counters. */
async function flushFile(file, fileOps, stats, { applied, skipped, lockWaitMs, now }) {
  let lock = null;
  try {
    lock = await acquire(file, lockWaitMs, now);
  } catch (error) {
    skipped.push({ file, reason: error.message || String(error) });
    return;
  }
  if (lock === null) {
    skipped.push({ file, reason: `locked by another run (waited ${Math.max(0, lockWaitMs)}ms)` });
    return;
  }
  const at = new Date(now()).toISOString();
  const counters = staged(stats);
  try {
    const doc = readDoc(file);
    let changed = false;
    for (const op of fileOps) {
      const result = applyOp(doc, op, at, counters);
      for (const event of result.events) applied.push({ ...event, file });
      if (result.history) appendHistory({ ...result.history, at });
      changed = changed || result.changed;
    }
    // A file whose ops all turned out to be no-ops is left exactly as it was.
    if (changed) writeDoc(file, doc);
    counters.commit();
  } catch (error) {
    skipped.push({ file, reason: error.message || String(error) });
  } finally {
    release(file, lock);
  }
}

module.exports = { flush };
