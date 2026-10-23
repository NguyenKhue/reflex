/**
 * deviceTools.js — deterministic, agent-callable tools over an agent-device backend.
 *
 * This is the replay half of the Jev work: the same vocabulary a checklist recipe
 * already speaks (tap_text / fill / wait_text / scroll / back …) but pointed at
 * agent-device instead of Appium, plus two Jev-assisted tools (jev_verify for a
 * probabilistic screen assertion, jev_recover for a bounded agentic detour).
 *
 * Every method returns a plain object and never throws for a device-level failure:
 * the recipe executor fails a step on `ok === false`, or on `found === false` for the
 * assertion tools listed in DEVICE_ASSERTIONS.
 */
const fs = require('fs');
const path = require('path');
const { findNodes, toJevState, visibleTexts, foldText, publicText, editableNodes } = require('./screenState');
const { runAgent } = require('../jev/agentLoop');
const { noul } = require('../jev/jevClient');

const LOG_POLL_MS = 1000;

const DEVICE_TOOL_SPECS = [
  { name: 'meta', args: {}, desc: 'backend, platform, device serial and current app package' },
  { name: 'launch_app', args: { package: 'app package (defaults to the session app)', activity: 'optional activity', relaunch: true, extras: 'Android-only launch extras { key: value }' }, desc: 'open or relaunch the app under test' },
  { name: 'tap_text', args: { text: 'visible text', exact: false, timeout: 5000, index: 0, settle: true, raw: false }, desc: 'wait for a text and tap the matching element (raw: true looks in the full, uncollapsed tree: for a node the default tree hides)' },
  { name: 'tap_within', args: { text: 'visible text or label of the container', exact: false, fx: 'fraction 0..1 across the container', fy: 'fraction 0..1 down the container', timeout: 5000, settle: true }, desc: 'tap a point inside an element by fraction of its box, for canvases and web views that expose no text of their own (a seat map)' },
  { name: 'swipe_within', args: { text: 'visible text or label of the container', exact: false, fx1: 0.5, fy1: 0.75, fx2: 0.5, fy2: 0.25, timeout: 5000 }, desc: 'drag from one point to another, both given as fractions of the container box: scrolls lists that ignore the scroll command (a swipe up scrolls down)' },
  { name: 'tap_if_present_text', args: { text: 'visible text', exact: false, timeout: 1500, settle: true }, desc: 'tap an optional element; never fails the step' },
  { name: 'fill', args: { label: 'field label/placeholder, or a list of them for a rotating placeholder (optional)', index: 0, text: 'value to type', timeout: 5000, verify: true, charDelayMs: 0, bulk: false }, desc: 'type into an editable field (bulk: true = clear with one adb call and type the whole value with one, Android ASCII only; with verify it falls back to key-by-key when the app scrambled it), read it back and retype slowly if the app scrambled it (charDelayMs: pause after every key, for fields that search on each key); the value is never echoed back' },
  { name: 'fill_otp_from_api', args: { phone: 'login phone', waitText: 'text that marks the OTP screen (optional)', unlessText: 'text meaning OTP was skipped (optional)', timeout: 20000, index: 0, label: 'field label/placeholder (optional; needed on iOS Compose, where only the placeholder is in the tree)', attempts: 5, intervalMs: 2000 }, desc: 'fetch the login OTP from the UAT OTP API and type it into the OTP field; the code is never echoed back' },
  { name: 'wait_text', args: { text: 'visible text', exact: false, timeout: 10000 }, desc: 'wait until a text is visible' },
  { name: 'wait_any_text', args: { texts: ['…'], timeout: 10000 }, desc: 'wait for the first of several branching texts' },
  { name: 'wait_stable_texts', args: { pattern: 'regex over visible texts', minMatches: 1, stableMs: 15000, timeout: 300000, continueOnTimeout: false }, desc: 'wait until the visible texts matching a regexp stop changing (progress counters without a done marker); continueOnTimeout accepts the budget cut-off instead of failing' },
  { name: 'assert_text', args: { text: 'visible text', exact: false, timeout: 3000 }, desc: 'assert a text is visible now' },
  { name: 'assert_absent', args: { text: 'visible text', exact: false, timeout: 3000 }, desc: 'assert a text is no longer visible' },
  { name: 'assert_value', args: { value: '{capturedKey}', match: 'regex (optional)', notMatch: 'regex (optional)' }, desc: 'assert a captured value (interpolated from data) matches / does not match a regexp' },
  { name: 'scroll', args: { direction: 'down|up', amount: 0.5 }, desc: 'scroll the current screen once' },
  { name: 'scroll_to_text', args: { text: 'visible text', direction: 'down', maxSwipes: 6 }, desc: 'scroll until a text is visible' },
  { name: 'back', args: {}, desc: 'press the system back button' },
  { name: 'keyboard', args: { action: 'enter|dismiss' }, desc: 'press the on-screen keyboard action key (enter: submits a search field and closes the keyboard) or hide it (dismiss); unlike back it never leaves the screen' },
  { name: 'clear_logcat', args: {}, desc: 'Android-only: clear the logcat buffer' },
  { name: 'expect_logcat', args: { pattern: 'regex', timeout: 60000 }, desc: 'Android-only: wait for a regexp to appear in logcat' },
  { name: 'jev_verify', args: { expect: 'expected screen outcome', threshold: 0.8 }, desc: 'ask Jev whether the current screen satisfies an expectation' },
  { name: 'jev_recover', args: { goal: 'short goal', maxSteps: 5, inputs: {} }, desc: 'bounded Jev agentic detour to reach a state' },
  { name: 'screenshot', args: { name: 'screen' }, desc: 'capture a screenshot artifact' },
  { name: 'snapshot_text', args: {}, desc: 'visible texts of the current screen' },
  { name: 'capture_texts', args: { pattern: 'regex', contextPattern: 'regex (optional)', startAfter: 'text (optional)', pages: 0, direction: 'down', joiner: ' · ', required: true }, desc: 'collect visible texts matching a regexp (optionally prefixed by the nearest preceding context text), scrolling up to `pages` times' },
  { name: 'capture_values', args: { fields: { key: 'label text' }, valuePattern: 'regex for a value', window: 3, startAfter: 'text (optional)', joiner: ' · ', required: true }, desc: 'read label → value pairs from the screen (value = first matching text right after the label)' }
];

/** Tools whose `found` flag is an assertion outcome, not an action result. */
const DEVICE_ASSERTIONS = new Set(['wait_text', 'wait_any_text', 'wait_stable_texts', 'assert_text', 'assert_absent', 'assert_value', 'expect_logcat', 'jev_verify']);

/** A readable number: optional sign, digits, an optional `a / b` ratio, an optional unit. */
const DEFAULT_VALUE_PATTERN = '^-?[\\d.,]+(\\s*/\\s*[\\d.,]+)?\\s*(ms|%|MB|GB|KB|fps)?$';

/** A tap rejected because the screen re-rendered under it; the ref has to be minted again. */
const STALE_REF = /superseded|stale/i;
const STALE_REF_RETRIES = 2;
const OFF_SCREEN = /off-screen/i;
const SIDEWAYS_SWIPES = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Typed-value read-back of `fill`: how long a field may take to show what was typed, how many
// slow retypes a scrambled value gets, and which values can be compared at all.
const FILL_SETTLE_MS = 1500;
const FILL_RETRIES = 2;
const VERIFIABLE_TEXT = /^[A-Za-z0-9@._+-]+$/;
const MASKED = /^[•●*·]+$/;
/** A formatted value ("034 876 8190", "0348-768-190") compares equal to what was typed. */
const normalizeTyped = (value) => String(value || '').replace(/[\s.\-]/g, '');

function createDeviceSession({ backend, jev = null, reportDir, appDefaults = {}, pollMs = 250, otpProvider = null }) {
  if (!backend) throw new Error('createDeviceSession requires a device backend');
  const root = reportDir || process.cwd();
  const defaults = appDefaults || {};
  const poll = Math.max(1, Number(pollMs) || 250);
  // No built-in OTP service: a run that needs one passes an otpProvider (function or { getOtp }).
  const fetchOtp = typeof otpProvider === 'function'
    ? otpProvider
    : otpProvider
      ? (phone) => otpProvider.getOtp(phone)
      : () => { throw new Error('no OTP provider configured: pass an otp plugin (contract: getOtp(phone))'); };

  /**
   * Snapshot until `findNodes` matches, or the timeout expires. `text` may list alternatives (a
   * placeholder that rotates between phrases): the first one on screen wins.
   */
  async function waitFor({ text, exact = false, editable, timeout = 0, raw = false }) {
    const deadline = Date.now() + Math.max(0, Number(timeout) || 0);
    const texts = Array.isArray(text) ? text : [text];
    for (;;) {
      const snapshot = raw ? await backend.snapshot({ raw: true }) : await backend.snapshot();
      for (const each of texts) {
        const nodes = findNodes(snapshot, { text: each, exact, editable });
        if (nodes.length) return { nodes, snapshot };
      }
      if (Date.now() >= deadline) return { nodes: [], snapshot };
      await sleep(poll);
    }
  }

  /** The same field in a fresh snapshot: by test id when it has one, else by screen position. */
  async function currentField(node, index) {
    let snapshot;
    try {
      snapshot = await backend.snapshot();
    } catch (_) {
      return undefined; // mid-transition: the screen cannot be read right now
    }
    const fields = editableNodes(snapshot);
    if (node.identifier) return fields.find((field) => field.identifier === node.identifier) || null;
    return fields[index] || null;
  }

  /**
   * true = the field holds `text` (spaces / dots / dashes of a formatted value ignored),
   * null = cannot tell (masked content, or the field is gone — a 6-digit PIN submits itself and
   * the app moves on), false = it holds something else after FILL_SETTLE_MS.
   */
  async function fieldHolds(node, index, text) {
    const wanted = normalizeTyped(text);
    const deadline = Date.now() + FILL_SETTLE_MS;
    for (;;) {
      const field = await currentField(node, index);
      if (!field) return null; // gone, or unreadable mid-transition: nothing to compare
      const content = String(field.value || field.text || '');
      // Masked: only the length can be checked — enough to catch a doubled or dropped key.
      if (field.password || MASKED.test(content)) {
        if (MASKED.test(content) && content.length === String(text).length) return true;
        if (!content || !MASKED.test(content)) return null; // not rendered as dots: cannot tell
        if (Date.now() >= deadline) return false;
        await sleep(pollMs);
        continue;
      }
      if (field && normalizeTyped(content) === wanted) return true;
      if (Date.now() >= deadline) return false;
      await sleep(pollMs);
    }
  }

  async function attempt(run) {
    try {
      return await run();
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  }

  /**
   * Every visible text in screen order, duplicates kept. visibleTexts() de-duplicates,
   * which silently drops a module tally that repeats another ("2 fail" twice).
   */
  function screenTexts(snapshot) {
    return ((snapshot && snapshot.nodes) || []).map(publicText).filter(Boolean);
  }

  /** The texts from `startAfter` (folded match) onwards; the whole screen when absent. */
  function afterStart(texts, startAfter) {
    if (!startAfter) return texts;
    const at = texts.findIndex((text) => foldText(text) === foldText(startAfter));
    return at >= 0 ? texts.slice(at + 1) : texts;
  }

  /**
   * Press a freshly resolved node. The Home screen re-renders constantly (live CPU/FPS
   * numbers), so the ref resolved from one snapshot is often rejected by the next one:
   * "minted from a superseded snapshot generation". Re-resolving and pressing again is
   * the only way to land the tap; any other press error keeps its own outcome.
   * `settle: false` skips the quiet-wait and is forwarded as-is: a step whose successor
   * waits for the UI anyway pays that wait twice otherwise.
   */
  /**
   * A node left or right of the screen sits in a horizontal strip scrolled away (the iOS card code
   * tab "Mã thẻ" at x = -66): swipe that row toward it. False when the node is not beside the screen.
   */
  async function revealSideways(node, snapshot) {
    if (!backend.swipe || !node.rect) return false;
    const app = ((snapshot && snapshot.nodes) || []).find((item) => item.role === 'application' && item.rect);
    const width = (app && Number(app.rect.width)) || 0;
    const { x, y, width: w = 0, height: h = 0 } = node.rect;
    if (!width || (x >= 0 && x + w <= width)) return false;
    const row = Math.round(y + h / 2);
    const [from, to] = x < 0 ? [0.25, 0.85] : [0.75, 0.15];
    await backend.swipe({ x: Math.round(width * from), y: row }, { x: Math.round(width * to), y: row });
    return true;
  }

  async function pressFresh({ text, exact, timeout, index, settle, raw = false }) {
    let swipes = 0;
    for (let tries = 0; ; tries += 1) {
      const { nodes, snapshot } = await waitFor({ text, exact, timeout, raw });
      const node = nodes[index];
      if (!node) return { node: null, error: null };
      try {
        await backend.press(node, { settle });
        return { node, error: null };
      } catch (error) {
        const message = error.message || String(error);
        if (tries < STALE_REF_RETRIES && STALE_REF.test(message)) continue;
        if (swipes < SIDEWAYS_SWIPES && OFF_SCREEN.test(message) && await revealSideways(node, snapshot)) {
          swipes += 1;
          continue;
        }
        return { node, error: message };
      }
    }
  }

  return {
    async meta() {
      return { ok: true, ...backend.meta() };
    },

    async launch_app({ package: appPackage, activity, relaunch = true, extras } = {}) {
      const app = appPackage || defaults.package;
      if (!app) return { ok: false, error: 'launch_app requires a package' };
      const selectedActivity = activity || defaults.activity;
      return attempt(async () => {
        const result = await backend.open({ app, activity: selectedActivity, relaunch, extras });
        return { ok: true, app: (result && result.app) || app };
      });
    },

    async tap_text({ text, exact = false, timeout = 5000, index = 0, settle = true, raw = false } = {}) {
      const { node, error } = await pressFresh({ text, exact, timeout, index, settle, raw });
      if (!node) return { ok: false, found: false, error: `no element with text "${text}"` };
      if (error) return { ok: false, error };
      return { ok: true, found: true, label: node.text };
    },

    async tap_within({ text, exact = false, fx, fy, timeout = 5000, settle = true } = {}) {
      const inside = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1;
      if (!inside(fx) || !inside(fy)) return { ok: false, error: 'tap_within needs fx and fy between 0 and 1' };
      const { nodes } = await waitFor({ text, exact, timeout });
      const rect = nodes[0] && nodes[0].rect;
      if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
        return { ok: false, found: false, error: `no element with text "${text}" and a box to tap in` };
      }
      return attempt(async () => {
        await backend.press({ x: Math.round(rect.x + rect.width * Number(fx)), y: Math.round(rect.y + rect.height * Number(fy)) }, { settle });
        return { ok: true, found: true };
      });
    },

    async swipe_within({ text, exact = false, fx1, fy1, fx2, fy2, timeout = 5000 } = {}) {
      const inside = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1;
      if (![fx1, fy1, fx2, fy2].every(inside)) return { ok: false, error: 'swipe_within needs fx1, fy1, fx2, fy2 between 0 and 1' };
      if (!backend.swipe) return { ok: false, error: 'this backend cannot swipe' };
      const { nodes } = await waitFor({ text, exact, timeout });
      const rect = nodes[0] && nodes[0].rect;
      if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
        return { ok: false, found: false, error: `no element with text "${text}" and a box to swipe in` };
      }
      const at = (fx, fy) => ({ x: Math.round(rect.x + rect.width * Number(fx)), y: Math.round(rect.y + rect.height * Number(fy)) });
      return attempt(async () => {
        await backend.swipe(at(fx1, fy1), at(fx2, fy2));
        return { ok: true, found: true };
      });
    },

    async tap_if_present_text({ text, exact = false, timeout = 1500, settle = true } = {}) {
      const { node, error } = await pressFresh({ text, exact, timeout, index: 0, settle });
      if (!node) return { ok: true, found: false };
      // An optional tap that could not land must not fail the step, but the
      // reason stays in the result for the report.
      return error ? { ok: true, found: true, label: node.text, error } : { ok: true, found: true, label: node.text };
    },

    async fill({ label, index = 0, text, timeout = 5000, verify = true, charDelayMs = 0, bulk = false } = {}) {
      let { nodes } = await waitFor({ text: label, editable: true, timeout: label && backend.typeText ? 0 : timeout });
      if (!nodes[index] && label && backend.typeText) {
        // A Compose text field on iOS is not a text field in the tree, only its placeholder is:
        // focus it by that text and type into whatever holds the focus. Nothing reads the value
        // back (the tree has no field), so the next screen is the check.
        const shown = await waitFor({ text: label, timeout });
        const editable = shown.nodes.filter((item) => item.editable);
        if (editable.length) nodes = editable;
        else if (shown.nodes.length) {
          return attempt(async () => {
            await backend.press(shown.nodes[0]);
            await backend.typeText(text, { charDelayMs });
            return { ok: true, focused: true };
          });
        }
      }
      if (!nodes[index] && label) {
        // A rotating placeholder may show a text no list anticipated, and an empty Android EditText
        // carries no label at all (its label IS its value): fall back to the field by index.
        ({ nodes } = await waitFor({ editable: true, timeout: 0 }));
      }
      const node = nodes[index];
      if (!node) {
        return { ok: false, error: label ? `no editable field labelled "${[].concat(label).join('" | "')}"` : 'no editable field on the screen' };
      }
      // Idempotent: a field that already holds the value is not typed again (a retried case, a second pass).
      // Typing makes some apps emit events (a debug panel popped over the page after each) and costs seconds.
      if (verify && !node.password && !node.hintShowing && String(text) !== '' && VERIFIABLE_TEXT.test(String(text))
        && String(node.value || node.text || '') === String(text)) {
        return { ok: true, unchanged: true };
      }
      return attempt(async () => {
        // The backend types every field one key at a time; `charDelayMs` only slows it further.
        const paced = { charDelayMs: Math.max(0, Number(charDelayMs) || 0) };
        // bulk: clear and type in one go, then verify; any retry below is the careful key-by-key path
        const typed = await backend.fill(node, text, bulk ? { ...paced, bulk: true } : paced);
        if (typed && typed.ok === false) return typed;
        // Read the field back: a field that reformats itself while typing can reorder, drop or
        // double fast keystrokes, and a wrong value only shows up screens later. The comparison
        // stays in-process; neither the value nor the field content ever reaches the result.
        if (!verify || !VERIFIABLE_TEXT.test(String(text))) return { ok: true };
        for (let round = 0; ; round += 1) {
          const held = await fieldHolds(node, index, text);
          if (held !== false) return { ok: true, ...(round ? { retyped: round } : {}) };
          if (round >= FILL_RETRIES) break;
          const fresh = await currentField(node, index);
          if (!fresh) break;
          const retyped = await backend.fill(fresh, text, paced);
          if (retyped && retyped.ok === false) return retyped;
        }
        return { ok: false, error: 'the field does not hold the typed value (the app dropped or reordered keystrokes)' };
      });
    },

    async fill_otp_from_api({ phone, waitText, unlessText, timeout = 20000, index = 0, label, attempts = 5, intervalMs = 2000 } = {}) {
      if (!String(phone || '').trim()) return { ok: false, error: 'fill_otp_from_api requires phone' };

      if (waitText || unlessText) {
        const deadline = Date.now() + Math.max(0, Number(timeout) || 0);
        for (;;) {
          const snapshot = await backend.snapshot();
          // The trusted-device branch goes straight to the password screen, so
          // "OTP was skipped" is checked before the OTP screen is expected.
          if (unlessText && findNodes(snapshot, { text: unlessText }).length) {
            return { ok: true, found: false, skipped: true, matched: unlessText };
          }
          const arrived = waitText
            ? findNodes(snapshot, { text: waitText }).length > 0
            : findNodes(snapshot, { text: label, editable: true }).length > 0;
          if (arrived) break;
          if (Date.now() >= deadline) {
            return { ok: false, found: false, error: `OTP screen "${waitText || 'editable field'}" did not appear` };
          }
          await sleep(poll);
        }
      }

      const maxAttempts = Math.max(1, Number(attempts) || 1);
      const pause = Math.max(0, Number(intervalMs) || 0);
      let otp = null;
      let used = 0;
      let lastError = '';
      for (let tries = 1; tries <= maxAttempts; tries += 1) {
        try {
          otp = String(await fetchOtp(String(phone).trim()));
          used = tries;
          break;
        } catch (error) {
          lastError = (error && error.message) || String(error);
          if (tries < maxAttempts) await sleep(pause);
        }
      }
      if (otp === null) {
        return { ok: false, error: `OTP API failed after ${maxAttempts} attempt(s): ${lastError}` };
      }

      let { nodes } = await waitFor({ text: label, editable: true, timeout: label ? 0 : 5000 });
      // A placeholder is no label on Android (an empty EditText's label IS its value): by index then.
      if (!nodes[index] && label) ({ nodes } = await waitFor({ editable: true, timeout: 5000 }));
      const node = nodes[index];
      if (!node && label && backend.typeText) {
        // Same move as `fill`: a Compose text field on iOS is not a field in the tree, only its
        // placeholder is. Focus it by that text and type into whatever holds the focus.
        const shown = await waitFor({ text: label, timeout: 5000 });
        if (shown.nodes.length) {
          return attempt(async () => {
            await backend.press(shown.nodes[0]);
            await backend.typeText(otp);
            return { ok: true, found: true, attempts: used, focused: true };
          });
        }
      }
      if (!node) return { ok: false, error: 'no editable field for the OTP' };
      return attempt(async () => {
        await backend.fill(node, otp);
        // The OTP is deliberately absent from the result: only its attempt count travels.
        return { ok: true, found: true, attempts: used };
      });
    },

    async wait_text({ text, exact = false, timeout = 10000 } = {}) {
      const { nodes } = await waitFor({ text, exact, timeout });
      return { ok: true, found: nodes.length > 0 };
    },

    async wait_any_text({ texts = [], timeout = 10000 } = {}) {
      const wanted = (Array.isArray(texts) ? texts : [texts]).filter((text) => typeof text === 'string' && text);
      const deadline = Date.now() + Math.max(0, Number(timeout) || 0);
      for (;;) {
        const snapshot = await backend.snapshot();
        for (const text of wanted) {
          // `value` lets a `saveAs` keep which branch appeared, for a later step's `when`.
          if (findNodes(snapshot, { text }).length) return { ok: true, found: true, matched: text, value: text };
        }
        if (Date.now() >= deadline) return { ok: true, found: false };
        await sleep(poll);
      }
    },

    async wait_stable_texts({ pattern, minMatches = 1, stableMs = 15000, timeout = 300000, continueOnTimeout = false } = {}) {
      let matcher;
      try {
        matcher = new RegExp(pattern);
      } catch (error) {
        return { ok: false, error: `invalid pattern: ${pattern}` };
      }
      const needed = Math.max(1, Number(minMatches) || 1);
      const stableFor = Math.max(0, Number(stableMs) || 0);
      const deadline = Date.now() + Math.max(0, Number(timeout) || 0);
      let signature = null;
      let since = 0;
      let lastValue = '';
      for (;;) {
        const matched = visibleTexts(await backend.snapshot()).filter((text) => matcher.test(text));
        // A snapshot with too few matches is a partial read (screen mid-redraw): it
        // must neither advance nor break stability, or a transient frame decides.
        if (matched.length >= needed) {
          const next = matched.join('\n');
          if (next !== signature) {
            signature = next;
            since = Date.now();
          }
          lastValue = matched.join(' · ');
          if (Date.now() - since >= stableFor) return { ok: true, found: true, value: lastValue, stable_ms: Date.now() - since };
        }
        if (Date.now() >= deadline) {
          // A flow may accept the budget cut-off instead of failing: the counters read
          // now are still the answer (a suite that never finished counts as idle). With
          // no accepted counters at all there is nothing to report and it stays a miss.
          if (continueOnTimeout && lastValue) return { ok: true, found: true, timed_out: true, value: lastValue };
          return { ok: true, found: false, value: lastValue };
        }
        await sleep(poll);
      }
    },

    async assert_text({ text, exact = false, timeout = 3000 } = {}) {
      const { nodes } = await waitFor({ text, exact, timeout });
      return { ok: true, found: nodes.length > 0 };
    },

    async assert_absent({ text, exact = false, timeout = 3000 } = {}) {
      const deadline = Date.now() + Math.max(0, Number(timeout) || 0);
      for (;;) {
        const snapshot = await backend.snapshot();
        if (!findNodes(snapshot, { text, exact }).length) return { ok: true, found: true };
        if (Date.now() >= deadline) return { ok: true, found: false };
        await sleep(poll);
      }
    },

    async assert_value({ value, match, notMatch } = {}) {
      if (!match && !notMatch) return { ok: false, error: 'assert_value requires match or notMatch' };
      let matchMatcher = null;
      let notMatchMatcher = null;
      try {
        if (match) matchMatcher = new RegExp(match);
        if (notMatch) notMatchMatcher = new RegExp(notMatch);
      } catch (error) {
        return { ok: false, error: `invalid pattern: ${match || notMatch}` };
      }
      const text = String(value === undefined || value === null ? '' : value);
      const found = (!matchMatcher || matchMatcher.test(text)) && (!notMatchMatcher || !notMatchMatcher.test(text));
      return { ok: true, found, value: text };
    },

    async scroll({ direction = 'down', amount } = {}) {
      return attempt(async () => {
        await backend.scroll(direction, amount);
        return { ok: true };
      });
    },

    async scroll_to_text({ text, direction = 'down', maxSwipes = 6 } = {}) {
      const max = Math.max(0, Number(maxSwipes) || 0);
      for (let swipe = 0; swipe <= max; swipe += 1) {
        const snapshot = await backend.snapshot();
        const nodes = findNodes(snapshot, { text });
        if (nodes.length) return { ok: true, found: true, label: nodes[0].text };
        if (swipe === max) break;
        await backend.scroll(direction);
      }
      return { ok: false, found: false, error: `no element with text "${text}" after ${max} scrolls` };
    },

    async back() {
      return attempt(async () => {
        await backend.back();
        return { ok: true };
      });
    },

    async keyboard({ action = 'dismiss' } = {}) {
      if (!['enter', 'dismiss'].includes(action)) return { ok: false, error: `keyboard action must be enter or dismiss, got "${action}"` };
      if (typeof backend.keyboard !== 'function') return { ok: false, error: 'this device backend has no keyboard control' };
      return attempt(async () => backend.keyboard(action));
    },

    async clear_logcat() {
      return attempt(async () => {
        await backend.clearLogcat();
        return { ok: true };
      });
    },

    async expect_logcat({ pattern, timeout = 60000 } = {}) {
      let matcher;
      try {
        matcher = new RegExp(pattern);
      } catch (error) {
        return { ok: false, error: `invalid logcat pattern: ${pattern}` };
      }
      const deadline = Date.now() + Math.max(0, Number(timeout) || 0);
      for (;;) {
        const match = matcher.exec(String((await backend.readLogcat()) || ''));
        if (match) return { ok: true, found: true, match: match[0] };
        if (Date.now() >= deadline) return { ok: true, found: false };
        await sleep(LOG_POLL_MS);
      }
    },

    async jev_verify({ expect, threshold = 0.8 } = {}) {
      if (!jev) return { ok: false, error: 'jev_verify requires TYPESAFE_API_KEY' };
      return attempt(async () => {
        const snapshot = await backend.snapshot();
        const state = { expectation: expect, screen: toJevState(snapshot) };
        const response = await jev.ask(state, {
          verdict: noul('Does the current app screen in `screen` satisfy `expectation`? Answer yes only if the screen visibly shows it.')
        });
        const answer = (response && response.answers && response.answers.verdict) || {};
        const probability = Number(answer.noul);
        if (!Number.isFinite(probability)) return { ok: false, error: 'jev_verify received no noul score' };
        return { ok: true, found: probability >= Number(threshold), probability };
      });
    },

    async jev_recover({ goal, maxSteps = 5, inputs = {} } = {}) {
      if (!jev) return { ok: false, error: 'jev_recover requires TYPESAFE_API_KEY' };
      return attempt(async () => {
        // Nothing to act on (app not in foreground, device lost): Jev would only guess.
        const { nodes } = await backend.snapshot();
        if (!nodes || !nodes.length) return { ok: false, status: 'error', error: 'jev_recover: empty screen, nothing to recover' };
        const result = await runAgent({ backend, jev, task: goal, inputs, maxSteps, timeoutMs: 60000 });
        return { ok: result.status === 'pass', status: result.status, steps: result.steps.length };
      });
    },

    async screenshot({ name = 'screen' } = {}) {
      const safeName = String(name || 'screen').replace(/[^A-Za-z0-9_-]+/g, '_');
      const filePath = path.join(root, 'screenshots', `${safeName}_${Date.now()}.png`);
      return attempt(async () => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        await backend.screenshot(filePath);
        return { ok: true, path: filePath, screenshot: filePath };
      });
    },

    async snapshot_text() {
      const snapshot = await backend.snapshot();
      return { ok: true, value: visibleTexts(snapshot) };
    },

    async capture_texts({ pattern, contextPattern, startAfter, pages = 0, direction = 'down', joiner = ' · ', required = true } = {}) {
      let matcher;
      try {
        matcher = new RegExp(pattern);
      } catch (error) {
        return { ok: false, error: `invalid pattern: ${pattern}` };
      }
      let contextMatcher = null;
      if (contextPattern) {
        try {
          contextMatcher = new RegExp(contextPattern);
        } catch (error) {
          return { ok: false, error: `invalid contextPattern: ${contextPattern}` };
        }
      }
      const maxPages = Math.max(0, Number(pages) || 0);
      const seen = new Set();
      const items = [];
      const outcome = await attempt(async () => {
        for (let page = 0; page <= maxPages; page += 1) {
          const texts = afterStart(screenTexts(await backend.snapshot()), startAfter);
          // Context is per page: a module name seen on page 1 must not label page 2.
          let context = null;
          for (const text of texts) {
            if (contextMatcher && contextMatcher.test(text)) context = text;
            if (!matcher.test(text)) continue;
            const entry = contextMatcher ? (context ? `${context}: ${text}` : text) : text;
            if (seen.has(entry)) continue;
            seen.add(entry);
            items.push(entry);
          }
          if (page < maxPages) await backend.scroll(direction);
        }
        return { ok: true, items };
      });
      if (!outcome.ok) return { ok: false, error: outcome.error };
      const captured = outcome.items;
      const result = { ok: !required || captured.length > 0, found: captured.length > 0, value: captured.join(joiner), items: captured };
      if (required && !captured.length) result.error = `no text matched /${pattern}/`;
      return result;
    },

    async capture_values({ fields, valuePattern, window = 3, startAfter, joiner = ' · ', required = true } = {}) {
      if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length) {
        return { ok: false, error: 'capture_values requires a non-empty fields mapping' };
      }
      let valueMatcher;
      try {
        valueMatcher = new RegExp(valuePattern || DEFAULT_VALUE_PATTERN);
      } catch (error) {
        return { ok: false, error: `invalid valuePattern: ${valuePattern}` };
      }
      // How many texts after a label may still be that label's own value.
      const scan = Math.max(1, Number(window) || 1);
      const outcome = await attempt(async () => {
        const texts = afterStart(screenTexts(await backend.snapshot()), startAfter);
        const values = {};
        const missing = [];
        for (const [key, label] of Object.entries(fields)) {
          const at = texts.findIndex((text) => foldText(text) === foldText(label));
          let value = null;
          for (let offset = 1; at >= 0 && offset <= scan; offset += 1) {
            const candidate = texts[at + offset];
            if (candidate !== undefined && valueMatcher.test(candidate)) {
              value = candidate;
              break;
            }
          }
          if (value === null) missing.push(key);
          else values[key] = value;
        }
        return { ok: true, values, missing };
      });
      if (!outcome.ok) return { ok: false, error: outcome.error };
      const { values, missing } = outcome;
      const result = {
        ok: !required || missing.length === 0,
        found: missing.length === 0,
        value: Object.entries(values).map(([key, value]) => `${key}=${value}`).join(joiner),
        values,
        missing
      };
      if (required && missing.length) result.error = `missing: ${missing.join(', ')}`;
      return result;
    }
  };
}

module.exports = { createDeviceSession, DEVICE_TOOL_SPECS, DEVICE_ASSERTIONS };
