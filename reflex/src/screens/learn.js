/**
 * learn.js — turn a confident Jev decision into screen knowledge (spec §5).
 *
 * The learning unit is one VISIT to a screen: from the moment the screen is identified until
 * another screen is identified. Everything that happened in between is buffered — the steps of a
 * case that ran there, and every action Jev chose. When the visit ends at another screen the
 * buffer becomes a case for the screen it started from. A press that left the screen the same and
 * took its own button away was a popup INSIDE the visit, not a step of the case, so it becomes an
 * exception rule instead.
 *
 * Two rules make the result safe to commit:
 *  - Nothing a run typed is ever written. Every text goes through `placeholderize`, and a text
 *    that still looks like a phone, an amount, a time, an OTP or a token is refused (on Android
 *    an EditText's label IS its value, so a field label must never be used either).
 *  - A decision is not knowledge until the leg reached its destination: `legEnd` commits a leg's
 *    buffer only when that leg PASSED. The stats of what ran are the exception — they are facts
 *    about the run itself, not guesses about how to move a screen.
 *
 * The pure functions of Task 3.1 are at the top; `createLearner` wires them to the flow hooks.
 */
const path = require('path');
const { foldText, visibleTexts } = require('../device/screenState');
const { screenIndex } = require('./match');
const { groupOf } = require('./store');

/** Shorter values would match too much screen text to be worth hiding. */
const SECRET_MIN_LENGTH = 3;
/** `ok` runs in a row that make a guess a verified case (spec §5, status table). */
const PROMOTE_STREAK = 3;
/** `fail` runs in a row that remove a learned case (a verified one is only demoted). */
const REMOVE_STREAK = 2;
const RULE_ID_LIMIT = 40;
const INTENT_LIMIT = 200;

/** What may not survive in a committed file: a value the app itself printed back. */
const SENSITIVE = [
  /\+?\d[\d\s.]{8,}\d/,                 // a phone-like run of digits
  /\d{4,}/,                             // an OTP or any long number
  /\d{1,3}([.,]\d{3})+\s*(đ|₫|vnd)?/i, // an amount
  /\b\d{1,2}[:/]\d{2}\b/,              // a time or a short date
  /eyJ[A-Za-z0-9_-]{10,}/,             // a JWT
];

/**
 * Words that mean "something went wrong". A dialog that says one of them is an ERROR, not a nuisance: pressing its button
 * may let the leg carry on, but that must never become a permanent auto-dismiss rule (it would hide the next real failure).
 * Matched on the original accent-aware text, not the folded one: folding "lỗi" (error) to "loi" would also catch "lợi" (benefit).
 */
const ERROR_HINTS = [
  /\blỗi\b/i, /\berror\b/i, /\bexception\b/i, /\bfail(ed|ure)?\b/i, /thất bại/i, /không thành công/i, /sự cố/i, /errorcode/i,
];

function looksLikeError(texts) {
  return (texts || []).some((text) => {
    const value = String(text || '').normalize('NFC');
    return ERROR_HINTS.some((pattern) => pattern.test(value));
  });
}

function todayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Values that must never be written: every non-empty resolved input and `saveAs` capture of this
 * row (≥ 3 characters), keyed by the NAME a placeholder carries. A value that came from `.env`
 * or `defaults.account` sits in `data` exactly like a row column does, so one scan covers all.
 */
function secretsOf(data, inputNames = [], captureNames = []) {
  const values = data && typeof data === 'object' ? data : {};
  const names = new Set([...(inputNames || []), ...(captureNames || []), ...Object.keys(values)]);
  const secrets = [];
  for (const name of names) {
    const value = values[name];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const text = String(value).trim();
    if (text.length < SECRET_MIN_LENGTH) continue;
    if (!secrets.some((secret) => secret.value === text)) secrets.push({ name: String(name), value: text });
  }
  // Longest first: replacing a short value first would leave a fragment of a longer one behind.
  return secrets.sort((a, b) => b.value.length - a.value.length);
}

/**
 * Replace every secret value inside `text` with `{name}`; `null` when what is left still looks
 * like data the app printed (a phone, an amount, a time, an OTP, a token) — that text may not be
 * written at all.
 */
function placeholderize(text, secrets = []) {
  if (typeof text !== 'string' || !text) return null;
  let out = text;
  for (const secret of secrets) {
    if (!secret.value || !out.includes(secret.value)) continue;
    out = out.split(secret.value).join(`{${secret.name}}`);
  }
  return SENSITIVE.some((pattern) => pattern.test(out)) ? null : out;
}

/**
 * Every secret value inside `text` replaced by `{name}`, nothing refused: for text that leaves
 * the process as evidence or as Jev state (the app itself prints the account's phone on its
 * login screens — "Số ví: 03… - <name>").
 */
function redactText(text, secrets = []) {
  let out = String(text === undefined || text === null ? '' : text);
  for (const secret of secrets) {
    if (secret.value && out.includes(secret.value)) out = out.split(secret.value).join(`{${secret.name}}`);
  }
  return out;
}

/**
 * Up to `max` texts a `when` or a reason may carry. A placeholder is dropped too: a rule has to
 * match the same screen text literally, and a rule the runner cannot evaluate is worse than a
 * rule that was never learned.
 */
function safeTexts(texts, secrets = [], max = 3) {
  const out = [];
  for (const text of Array.isArray(texts) ? texts : []) {
    if (out.length >= max) break;
    const safe = placeholderize(text, secrets);
    if (safe === null || safe.includes('{')) continue;
    if (!out.includes(safe)) out.push(safe);
  }
  return out;
}

/**
 * One visit's buffered items → the case's steps. `null` when an item cannot be written safely,
 * which means the whole case is refused (a step that points at the wrong thing is worse than no
 * case at all). Item kinds come from `createLearner`; `{ kind: 'step' }` items are steps of a case
 * that already ran, kept verbatim.
 */
function toCaseSteps(items, secrets = []) {
  const steps = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    if (item.kind === 'step') {
      steps.push(item.step);
      continue;
    }
    if (item.kind === 'press') {
      // A press is remembered by its test id when it has one (it survives a label change) and by
      // its visible text otherwise. No ref, no coordinates: they do not survive a re-render.
      if (item.identifier) {
        steps.push({ tool: 'tap_text', args: { text: String(item.identifier), exact: true } });
        continue;
      }
      const label = item.label ? placeholderize(item.label, secrets) : null;
      if (label === null) return null;
      steps.push({ tool: 'tap_text', args: { text: label, exact: true } });
      continue;
    }
    if (item.kind === 'fill') {
      // NEVER the label: after a fill an Android EditText's label is the typed value.
      if (!item.input || !Number.isInteger(item.fieldIndex) || item.fieldIndex < 0) return null;
      steps.push({ tool: 'fill', args: { index: item.fieldIndex, text: `{${item.input}}` } });
      continue;
    }
    if (item.kind === 'scroll') {
      steps.push({ tool: 'scroll', args: item.direction ? { direction: item.direction } : {} });
      continue;
    }
    if (item.kind === 'back') {
      steps.push({ tool: 'back', args: {} });
      continue;
    }
    // `wait` is dropped: the wait for the next screen to be identified already covers it.
  }
  return steps;
}

/**
 * A Jev press was a popup dismissal only when the SAME screen is still shown (an unidentified
 * screen counts as the same screen only while it stays unidentified) AND the node it pressed is
 * gone. A chip, tab or toggle that is still there is an action on the screen, so it belongs to
 * the case.
 */
function isPopupDismiss({ beforeId, afterId, pressed, afterIndex }) {
  if (beforeId !== afterId) return false;
  const label = pressed && pressed.label ? foldText(pressed.label) : '';
  const identifier = pressed && pressed.identifier ? foldText(pressed.identifier) : '';
  // An unnamed press proves nothing, so it is never classified as a dismissal.
  if (!label && !identifier) return false;
  const texts = (afterIndex && afterIndex.texts) || [];
  const ids = (afterIndex && afterIndex.ids) || [];
  const textGone = !label || !texts.some((text) => text.includes(label));
  const idGone = !identifier || ![...ids].some((id) => id === identifier);
  return textGone && idGone;
}

/** `<text>` → an ascii id fragment: "Cập nhật phiên bản" → "cap_nhat_phien_ban". */
function slugOf(text) {
  const folded = foldText(text).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return folded.slice(0, RULE_ID_LIMIT - 'learned_'.length) || 'rule';
}

/**
 * The rule learned from one interruption: a popup Jev dismissed, or the reason a `fail`/`blocked`
 * verdict gave. `null` when nothing specific enough can be said — a lone button ("Xác nhận",
 * "Đóng", "OK") with no other text would match half the app.
 */
function toException({
  disappeared = [], pressedLabel = null, pressedIdentifier = null, verdict = null,
  secrets = [], runId = null, confidence = null, today = todayOf(Date.now()),
}) {
  const stats = { ok: 1, fail: 0, streak: 1, lastOk: today };
  if (verdict) {
    const texts = safeTexts(disappeared, secrets, 3);
    if (!texts.length) return null;
    // The verdict IS the outcome of the screen: its reason is the most specific text it showed.
    return {
      id: `learned_${slugOf(texts[0])}`,
      when: { allText: texts },
      do: { [verdict]: `Jev: ${texts[0]}` },
      status: 'learned',
      confidence,
      learnedFrom: runId,
      stats,
    };
  }
  const tap = pressedIdentifier || (pressedLabel ? placeholderize(pressedLabel, secrets) : null);
  // A placeholder cannot be typed into a tap step: it is resolved from plan data, not from here.
  if (!tap || String(tap).includes('{')) return null;
  const label = pressedLabel ? placeholderize(pressedLabel, secrets) : null;
  const title = safeTexts((disappeared || []).filter((text) => text !== pressedLabel), secrets, 2);
  if (!title.length) return null;
  const allText = [label && !label.includes('{') ? label : null, ...title].filter(Boolean).slice(0, 3);
  return {
    id: `learned_${slugOf(title[0])}`,
    when: { allText },
    do: { tap: String(tap) },
    status: 'learned',
    confidence,
    learnedFrom: runId,
    stats,
  };
}

/** A rule in `screens/_shared/` is policy and is never touched by the runner (spec §3). */
function isShared(file) {
  return path.normalize(String(file || '')).split(path.sep).includes('_shared');
}

/**
 * The lifecycle of one case/rule after a run (spec §5, status table). Returns the item to write
 * back plus the event a reviewer needs to see: `promoted`, `demoted`, `removed` or `null`.
 * A pinned item and anything under `screens/_shared/` are returned unchanged.
 */
function applyOutcome(item, ok, { today = todayOf(Date.now()) } = {}) {
  if (!item) return { item, event: null };
  if (item.pinned || isShared(item.file)) return { item, event: null };
  const status = item.status === undefined || item.status === null ? 'draft' : item.status;
  const stats = { ...(item.stats || {}) };
  const count = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

  if (ok) {
    stats.ok = count(stats.ok) + 1;
    stats.streak = count(stats.streak) + 1;
    stats.failStreak = 0;
    stats.lastOk = today;
    const next = status === 'verified' || stats.streak < PROMOTE_STREAK ? status : 'verified';
    return { item: { ...item, status: next, stats }, event: next === status ? null : 'promoted' };
  }

  // A draft is a guess an agent wrote, not a promise: a failed run counts against nobody.
  if (status === 'draft') return { item, event: null };
  stats.fail = count(stats.fail) + 1;
  stats.streak = 0;
  stats.failStreak = count(stats.failStreak) + 1;
  stats.lastFail = today;
  if (status === 'learned' && stats.failStreak >= REMOVE_STREAK) {
    return { item: { ...item, stats }, event: 'removed' };
  }
  const next = status === 'verified' ? 'learned' : status;
  return { item: { ...item, status: next, stats }, event: next === status ? null : 'demoted' };
}

/** Texts the screen showed before an action and no longer shows after it. */
function disappearedTexts(before, after) {
  const next = new Set(visibleTexts(after));
  return visibleTexts(before).filter((text) => !next.has(text));
}

/** The Jev action, reduced to what a learned step needs — never a value, never a ref. */
function itemOfAction(record) {
  if (record.kind === 'press') {
    return { kind: 'press', label: record.label || '', identifier: record.identifier || null };
  }
  if (record.kind === 'fill') {
    return {
      kind: 'fill',
      input: record.input || null,
      fieldIndex: Number.isInteger(record.fieldIndex) ? record.fieldIndex : null,
    };
  }
  if (record.kind === 'scroll') return { kind: 'scroll', direction: record.direction || null };
  if (record.kind === 'back') return { kind: 'back' };
  return { kind: 'wait' };
}

/**
 * The file a new rule about `screenId` belongs in: the screen's own tier when the screen was
 * identified, otherwise the leg's mini app, and `_app` for a `core` mini app (spec §3).
 */
function tierFile(store, legGroup, screenId, name) {
  const screen = screenId ? store.screens.get(screenId) : null;
  if (screen) return path.join(screen.dir, name);
  const group = groupOf(legGroup || '');
  if (group === 'core' || !store.groups.has(group)) return path.join(store.appTier.dir, name);
  return path.join(store.groups.get(group).dir, '_miniapp', name);
}

/**
 * The intent of a learned case: the running leg's own words when this transition IS its
 * destination, the plan's words for a leg that ends here, and a plain phrase otherwise.
 */
function intentFor(leg, plan, toId) {
  if (leg && leg.to === toId && leg.intent) return String(leg.intent).slice(0, INTENT_LIMIT);
  const known = ((plan && plan.flow) || []).find((item) => item && item.to === toId && item.intent);
  return String((known && known.intent) || `Go to ${toId}`).slice(0, INTENT_LIMIT);
}

function historyFileOf(file) {
  return path.join(path.dirname(file), 'history.yml');
}

/**
 * `createLearner({ store, runId, data, plan, inputNames, captureNames })` — collect what a run
 * proved, in ops for `screens/writer.flush`.
 *
 * Ops are buffered per leg and committed by `legEnd` only when that leg passed; `ops()` and
 * `events()` are what the caller flushes and reports at the end of the run.
 */
function createLearner({
  store, runId, data = {}, plan = null, inputNames = [], captureNames = [], now = Date.now,
} = {}) {
  const runOps = [];
  const events = [];
  let legOps = [];
  let leg = null;
  let ownSteps = false;
  let visit = null;

  const secrets = () => secretsOf(data, inputNames, captureNames);
  const today = () => todayOf(now());
  const legGroup = () => groupOf((leg && (leg.to || leg.at)) || '');

  const skip = (file, reason) => events.push({ action: 'skipped', file, reason });

  /**
   * End the open visit at `toId`. A visit with no Jev action taught nothing (the cases already
   * know how to leave this screen), and a screen we could not identify has no file to write to.
   */
  const closeVisit = (toId) => {
    const closing = visit;
    visit = null;
    if (!closing || !closing.screenId || !toId || toId === closing.screenId) return;
    if (!closing.jev) return;
    const screen = store.screens.get(closing.screenId);
    if (!screen) return;
    const file = path.join(screen.dir, 'normal.yml');
    // A buffered case is a group of steps; `toCaseSteps` only knows single items.
    const items = closing.items.flatMap((item) => (item.kind === 'case' ? item.steps : [item]));
    const steps = toCaseSteps(items, secrets());
    if (steps === null) {
      skip(file, 'sensitive label');
      return;
    }
    // Every action was a popup dismissal: the rules carry them, there is no case to learn.
    if (!steps.length) return;
    const item = {
      to: toId,
      intent: intentFor(leg, plan, toId),
      steps,
      status: 'learned',
      confidence: closing.confidence,
      learnedFrom: runId,
      stats: { ok: 1, fail: 0, streak: 1, lastOk: today() },
    };
    legOps.push(closing.replaced && closing.replaced.file === file
      ? {
        file,
        kind: 'replaceCase',
        key: closing.replaced.key,
        item,
        historyFile: historyFileOf(closing.replaced.file),
        reason: 'superseded by a case learned in the same visit',
        runId,
      }
      : { file, kind: 'addCase', item });
  };

  return {
    /** A new leg: its ops are its own until `legEnd` decides whether they may be kept. */
    legStart(next, legIndex) {
      leg = {
        index: legIndex,
        at: (next && next.at) || null,
        to: (next && next.to) || null,
        intent: (next && next.intent) || null,
      };
      legOps = [];
      ownSteps = false;
      visit = null;
    },

    /** A leg with its own `steps:` is a plan-specific action: it is never learned from. */
    legOwnSteps() {
      ownSteps = true;
    },

    /** The flow identified `screenId`; a null identification is not "another screen". */
    visitStart(screenId, snapshot) {
      if (!screenId || (visit && visit.screenId === screenId)) return;
      closeVisit(screenId);
      visit = { screenId, items: [], jev: 0, confidence: null, replaced: null };
    },

    /** The steps of a case that ran on the current screen (only the ones that succeeded). */
    caseRan(item, steps) {
      if (!visit || !item || !Array.isArray(steps) || !steps.length) return;
      const buffered = steps.map((step) => ({ kind: 'step', step }));
      const entry = visit.items.find((bufferItem) => bufferItem.kind === 'case' && bufferItem.key === item.key);
      // A case re-run after a popup replaces its own entry instead of appearing twice.
      if (entry) entry.steps = buffered;
      else visit.items.push({ kind: 'case', key: item.key, steps: buffered });
    },

    /** Stats of a case that ran, and — when it failed — the case a new one would supersede. */
    caseOutcome(item, ok) {
      if (!item || !item.file || isShared(item.file)) return;
      legOps.push({
        file: item.file, kind: 'outcome', key: item.key, ok, runId, historyFile: historyFileOf(item.file),
      });
      if (!ok && visit && visit.screenId && !visit.replaced) visit.replaced = item;
    },

    ruleOutcome(rule, ok) {
      if (!rule || !rule.file || isShared(rule.file)) return;
      legOps.push({
        file: rule.file, kind: 'outcome', key: rule.key || rule.id, ok, runId, historyFile: historyFileOf(rule.file),
      });
    },

    /**
     * One Jev action, with the screen it was pressed on and the screen that came out of it. The
     * pair is what tells a dismissed popup from an action on the screen itself.
     */
    jevAction(record, beforeSnap, afterSnap, beforeId, afterId, confidence) {
      if (!record || record.kind === 'verdict' || !beforeSnap || !afterSnap) return;
      const value = Number.isFinite(confidence) ? confidence : null;
      if (record.kind === 'press') {
        const pressed = { label: record.label || '', identifier: record.identifier || null };
        if (isPopupDismiss({ beforeId, afterId, pressed, afterIndex: screenIndex(afterSnap) })) {
          const file = tierFile(store, legGroup(), beforeId, 'exceptions.yml');
          const gone = disappearedTexts(beforeSnap, afterSnap);
          // The leg may carry on after this press, but an error must not become a rule that hides the next one.
          if (looksLikeError(gone)) {
            skip(file, 'looks like an error: not learned as a dismissal');
            return;
          }
          const rule = toException({
            disappeared: gone,
            pressedLabel: pressed.label || null,
            pressedIdentifier: pressed.identifier,
            secrets: secrets(),
            runId,
            confidence: value,
            today: today(),
          });
          if (rule) legOps.push({ file, kind: 'addRule', item: rule });
          else skip(file, 'generic popup');
          return;
        }
      }
      if (!visit) return;
      visit.items.push(itemOfAction(record));
      visit.jev += 1;
      // The learned case is only as trustworthy as its shakiest decision.
      if (value !== null) visit.confidence = visit.confidence === null ? value : Math.min(visit.confidence, value);
    },

    /**
     * Jev stopped the leg: its verdict is the leg's outcome, whether or not the leg passed
     * (spec §4 step 6), so this rule is committed even when the leg did not.
     */
    verdict(kind, snapshot, screenId, group) {
      const file = tierFile(store, group || legGroup(), screenId, 'exceptions.yml');
      const rule = toException({
        disappeared: visibleTexts(snapshot),
        verdict: kind === 'blocked' ? 'blocked' : 'fail',
        secrets: secrets(),
        runId,
        confidence: null,
        today: today(),
      });
      if (!rule) {
        skip(file, 'no safe text');
        return;
      }
      legOps.push({ file, kind: 'addRule', item: rule, keep: true });
    },

    /** A path of at least two hops: the next run can walk it one case per hop (spec §5). */
    legPassed(route) {
      const list = (Array.isArray(route) ? route : []).filter(Boolean);
      if (list.length < 3) return;
      legOps.push({ file: path.join(store.appTier.dir, 'routes.yml'), kind: 'addRoute', path: list });
    },

    /**
     * The leg is over. A decision that never reached `to` is not knowledge, so only a passing leg
     * commits its cases, rules and routes. What ran is a fact about the run and is always kept,
     * and so is the rule a Jev verdict described — that verdict IS the leg's outcome.
     */
    legEnd(status) {
      const kinds = status === 'pass'
        ? (ownSteps ? ['outcome', 'addRule'] : ['outcome', 'addCase', 'replaceCase', 'addRule', 'addRoute'])
        : ['outcome'];
      for (const op of legOps) if (op.keep === true || kinds.includes(op.kind)) runOps.push(op);
      legOps = [];
      ownSteps = false;
      visit = null;
    },

    ops() {
      return runOps.slice();
    },

    events() {
      return events.slice();
    },
  };
}

module.exports = {
  redactText,
  secretsOf,
  historyFileOf,
  placeholderize,
  safeTexts,
  toCaseSteps,
  isPopupDismiss,
  looksLikeError,
  toException,
  applyOutcome,
  createLearner,
  isShared,
};
