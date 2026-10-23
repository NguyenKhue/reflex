/**
 * deviceBackend.js — device control through `agent-device` (Callstack) instead of Appium.
 *
 * agent-device is ESM-only and is therefore imported lazily inside the default client
 * factory, so this module stays CommonJS and stays requireable without the optional dep.
 * Every call the Jev agent loop needs is normalised here — one flat snapshot shape,
 * pinned refs, shared settle options — so callers never touch the raw client protocol.
 *
 * Also exports a mock backend so the whole loop can be exercised without a device.
 */
const fs = require('fs');
const path = require('path');
const { parseUiautomatorDump } = require('./uiautomator');
const { execFileSync } = require('child_process');

const APP_OPEN_TIMEOUT_MS = 120000;
// A busy debug build (a mini app just opened, JS thread flooded) made the helper time out at 6 s and the fallback capture
// take 9 more: 15 s cancelled a snapshot that was about to land, and the run died "Daemon request timed out" (Galaxy M21,
// 2026-10-23). REFLEX_SNAPSHOT_TIMEOUT_MS overrides it.
const SNAPSHOT_TIMEOUT_MS = Number(process.env.REFLEX_SNAPSHOT_TIMEOUT_MS) > 0 ? Number(process.env.REFLEX_SNAPSHOT_TIMEOUT_MS) : 30000;
/**
 * agent-device's messages when a system window (not the app) is in front. The wording differs by agent-device version and device:
 * "insufficient foreground app content" (0.21.20, phone), "insufficient application window content" and "only non-application
 * windows" (0.21.12, emulator).
 */
const NO_APP_CONTENT = /(insufficient (foreground )?app(lication)?( window)? content|only non-application windows)/i;
const SYSTEM_UI_DUMP = '/sdcard/reflex-window.xml';
const ADB_MAX_BUFFER = 32 * 1024 * 1024;
// adb `input text` types ASCII only; anything else (dấu tiếng Việt) must go through the client.
const ASCII_TEXT = /^[A-Za-z0-9@._+-]*$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NOT_INSTALLED = 'agent-device is not installed — run: npm install --prefix reflex (requires Node >= 22.12)';

/** Last dotted segment of a native type, lowercased: android.widget.TextView → textview. */
function shortRole(type) {
  return String(type || '').split('.').pop().toLowerCase();
}

// XCUITest element types that take text. agent-device reports no `editable` flag on iOS, so the
// type is the evidence; Android nodes carry the flag themselves.
const IOS_INPUT_TYPES = new Set(['TextField', 'SecureTextField', 'TextView', 'SearchField']);
// An app's iOS phone field can be a plain `Other` (the text input is not in the tree) with a test ID.
const INPUT_TEST_ID = /^input_/;
// On-screen keyboard keys ("1", "Delete") are not app text.
const IOS_KEYBOARD_TYPES = new Set(['Key', 'Keyboard']);
// Windows that hold the on-screen keyboard and its accessory views, not app content.
const IOS_KEYBOARD_WINDOWS = new Set(['UIRemoteKeyboardWindow', 'UITextEffectsWindow']);
const TEXT_ENTRY_MISMATCH = /text entry verification failed/;
const TEST_ID_PREFIX = /^[\w.\/-]+$/;
const XCTEST_TYPE_FAILURE = /XCTest recorded a failure while executing type/;
// Every field is typed one key at a time, at least this far apart: fields that reformat or search
// while typing (a phone field, Compose fields) drop, double or reorder faster keystrokes, and
// a scrambled password costs a login attempt.
const MIN_CHAR_DELAY_MS = 150;
// A tap this far inside a field's trailing edge lands past its text: the caret goes to the end.
const COMPOSE_EDGE_INSET = 6;
const COMPOSE_FOCUS_SETTLE_MS = 400;
// Rounds of "read the field, delete what it holds" before a Compose field counts as stuck.
const COMPOSE_CLEAR_ROUNDS = 3;

/**
 * A Compose Multiplatform text field on iOS is a bare `Other` whose accessibility value is its
 * text (or its placeholder): no label, no test ID. Treated as a field, its value (a prefilled
 * phone) stays out of Jev state and traces like any other field's. Focused, the same field may
 * surface as a `TextView` whose label repeats its value, which XCTest cannot type into either.
 */
const COMPOSE_FIELD_TYPES = new Set(['Other', 'TextView']);
function isComposeField(node) {
  if (!node || !COMPOSE_FIELD_TYPES.has(node.type) || node.identifier || !node.rect) return false;
  const value = String(node.value || '').trim();
  return !!value && (!node.label || String(node.label).trim() === value);
}

function isEditable(node) {
  if (node.editable) return true;
  if (IOS_INPUT_TYPES.has(node.type)) return true;
  if (node.type === 'Other' && INPUT_TEST_ID.test(String(node.identifier || ''))) return true;
  return isComposeField(node);
}

/**
 * iOS keeps every presented view controller in the tree: the phone screen stays under the OTP
 * screen it presented, fields included, so "the first field" would be a covered one. Under each
 * window only the LAST full-window UITransitionView is on top; nodes under earlier ones are
 * covered and dropped. Android trees have no such role, so they pass through untouched.
 */
function coveredIndexes(rawNodes) {
  const byIndex = new Map();
  for (const node of rawNodes) if (Number.isInteger(node.index)) byIndex.set(node.index, node);
  const layersByWindow = new Map();
  for (const node of rawNodes) {
    const parent = byIndex.get(node.parentIndex);
    if (node.role !== 'UITransitionView' || !parent || parent.type !== 'Window') continue;
    const fullWindow = node.rect && parent.rect && node.rect.height >= parent.rect.height && node.rect.width >= parent.rect.width;
    if (!fullWindow) continue;
    if (!layersByWindow.has(parent.index)) layersByWindow.set(parent.index, []);
    layersByWindow.get(parent.index).push(node.index);
  }
  const covered = new Set();
  for (const layers of layersByWindow.values()) for (const index of layers.slice(0, -1)) covered.add(index);
  for (const node of rawNodes) if (IOS_KEYBOARD_WINDOWS.has(node.role)) covered.add(node.index);
  if (!covered.size) return covered;
  const result = new Set();
  for (const node of rawNodes) {
    for (let at = node; at; at = byIndex.get(at.parentIndex)) {
      if (covered.has(at.index)) {
        result.add(node.index);
        break;
      }
    }
  }
  return result;
}

/**
 * A raw iOS tree gives React Native containers the joined labels of everything inside them (one
 * transfer screen: 229 containers, ~109k characters): noise for identify, taps and Jev. A plain
 * `Other` whose label contains a direct child's label is such a container; its own test ID stays.
 */
function aggregatedLabels(rawNodes) {
  const childLabels = new Map();
  for (const node of rawNodes) {
    const label = String(node.label || '').trim();
    if (!label || node.parentIndex === undefined || node.parentIndex === null) continue;
    if (!childLabels.has(node.parentIndex)) childLabels.set(node.parentIndex, []);
    childLabels.get(node.parentIndex).push(label);
  }
  const result = new Set();
  for (const node of rawNodes) {
    if (node.type !== 'Other' || !node.label) continue;
    const labels = childLabels.get(node.index) || [];
    if (!labels.some((label) => node.label.includes(label))) continue;
    // "<testID>|<its one text>" is how React Native names a touchable (the card code
    // denomination "…/TouchableOpacity|50.000đ"): a test ID the cases tap, not an aggregate.
    const bar = node.label.indexOf('|');
    if (bar > 0 && TEST_ID_PREFIX.test(node.label.slice(0, bar)) && labels.includes(node.label.slice(bar + 1).trim())) continue;
    result.add(node.index);
  }
  return result;
}

/**
 * Flatten one raw agent-device snapshot into the shape the rest of the module uses.
 * Nodes from other packages (systemui status bar, IME windows) are dropped when the
 * app package is known; nodes without a bundleId are kept because the app's own
 * Compose/RN nodes often carry none.
 */
function normalizeSnapshot(raw, appId) {
  const source = raw || {};
  const generation = source.refsGeneration;
  const nodes = [];
  const covered = coveredIndexes(source.nodes || []);
  const aggregated = aggregatedLabels(source.nodes || []);
  for (const node of source.nodes || []) {
    if (node.visibleToUser === false) continue;
    if (covered.has(node.index)) continue;
    if (IOS_KEYBOARD_TYPES.has(node.type)) continue;
    if (appId && node.bundleId && node.bundleId !== appId) continue;
    const ref = node.ref || null;
    const label = aggregated.has(node.index) ? '' : node.label || '';
    const value = node.value || '';
    nodes.push({
      ref,
      pinned: ref ? (generation === undefined || generation === null ? `@${ref}` : `@${ref}~s${generation}`) : null,
      type: node.type || '',
      role: shortRole(node.type),
      label,
      value,
      text: String(label || value || '').trim(),
      identifier: node.identifier || null,
      rect: node.rect || null,
      enabled: node.enabled !== false,
      hittable: !!node.hittable,
      editable: isEditable(node),
      focused: !!node.focused,
      password: !!node.password || node.type === 'SecureTextField',
      hintShowing: !!node.hintShowing
    });
  }
  // A custom input_ wrapper that holds a native field with the same test ID (the iOS password
  // field) is one field, not two: the native one is the field.
  const nativeIds = new Set(nodes.filter((node) => IOS_INPUT_TYPES.has(node.type) && node.identifier).map((node) => node.identifier));
  for (const node of nodes) {
    if (node.editable && node.type === 'Other' && nativeIds.has(node.identifier)) node.editable = false;
  }
  return {
    generation,
    truncated: !!source.truncated,
    sparse: (source.snapshotQuality && source.snapshotQuality.state) === 'sparse',
    appBundleId: source.appBundleId || null,
    takenAt: Date.now(),
    nodes
  };
}

/** Accepts a normalised node (its pinned ref), `{ selector }` or `{ x, y }` like the raw client. */
function targetArgs(target) {
  if (!target) throw new Error('an action needs a target');
  if (typeof target === 'string') return { ref: target };
  if (target.pinned) return { ref: target.pinned };
  if (target.ref) return { ref: target.ref };
  if (target.selector) return { selector: target.selector };
  if (target.x !== undefined && target.y !== undefined) return { x: target.x, y: target.y };
  // A node read through uiautomator has no ref: tap the centre of its box.
  if (target.rect && Number.isFinite(target.rect.x) && Number.isFinite(target.rect.width)) {
    return { x: Math.round(target.rect.x + target.rect.width / 2), y: Math.round(target.rect.y + target.rect.height / 2) };
  }
  throw new Error('unsupported target: expected a node, { selector } or { x, y }');
}

function createDeviceBackend({
  platform = 'android',
  serial,
  udid,
  session = 'reflex-jev',
  appId,
  clientFactory,
  adbPath = 'adb',
  settleQuietMs = 250,
  actionTimeoutMs = 8000,
  // Typing through adb is instant (no settle, no snapshot) where the client fill costs
  // seconds. iOS has no adb, so the default follows the platform.
  fastInput = platform === 'android',
  // Floor of the pause between typed keys; only tests lower it.
  minCharDelayMs = MIN_CHAR_DELAY_MS,
  // Read a system window (share sheet, permission dialog, picker) through `uiautomator` when agent-device cannot see it.
  systemUiFallback = true,
  execFile = execFileSync
} = {}) {
  let client = null;
  let currentApp = appId || null;

  function selection() {
    if (platform === 'ios') return udid ? { platform, udid } : { platform };
    return serial ? { platform, serial } : { platform };
  }

  function settleOptions() {
    return { settle: true, settleQuietMs, timeoutMs: actionTimeoutMs };
  }

  // The client is created on first use, never at construction: constructing a backend
  // for a platform that is not installed must not throw (env-check probes do that).
  async function getClient() {
    if (client) return client;
    if (clientFactory) {
      client = await clientFactory();
      return client;
    }
    let mod;
    try {
      mod = await import('agent-device');
    } catch (error) {
      throw new Error(NOT_INSTALLED);
    }
    client = mod.createAgentDeviceClient({
      session,
      lockPolicy: 'reject',
      lockPlatform: platform,
      responseLevel: 'full'
    });
    return client;
  }

  function adb(args) {
    const argv = serial ? ['-s', serial, ...args] : args;
    return execFile(adbPath, argv, { encoding: 'utf8', maxBuffer: ADB_MAX_BUFFER });
  }

  /**
   * The iOS `pm clear`: stop the app, then empty Documents / Library / tmp of its data container,
   * keeping the folders themselves (the app expects them). `get_app_container` only answers for
   * a simulator, which is what keeps a physical device out of this path.
   */
  function resetSimulatorApp(app) {
    if (!udid) throw new Error('fresh launch on iOS needs --udid of a simulator');
    let container;
    try {
      container = String(execFile('xcrun', ['simctl', 'get_app_container', udid, app, 'data'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    } catch (_) {
      throw new Error(`fresh launch on iOS needs a simulator with ${app} installed (physical devices cannot be wiped)`);
    }
    if (!container) throw new Error(`no data container for ${app} on simulator ${udid}`);
    try {
      execFile('xcrun', ['simctl', 'terminate', udid, app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (_) { /* not running */ }
    for (const folder of ['Documents', 'Library', 'tmp']) {
      const dir = path.join(container, folder);
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }

  /** A press either waits for the UI to go quiet or fires straight into the next command. */
  function pressOptions(settle) {
    return settle === false ? { settle: false, timeoutMs: actionTimeoutMs } : settleOptions();
  }

  // Internal on purpose: fill() presses without settling, and that press must not be
  // intercepted by a caller (or a test) that patches the public press().
  async function pressTarget(target, { settle = true } = {}) {
    const client_ = await getClient();
    await client_.interactions.press({ ...selection(), ...targetArgs(target), ...pressOptions(settle) });
  }

  async function takeSnapshot({ raw: wantRaw = false } = {}) {
    const client_ = await getClient();
    // forceFull is required: an unchanged screen otherwise comes back empty. On iOS the
    // compacted tree flattens every node onto the root, which hides what covers what (see
    // coveredIndexes): the raw tree keeps the view hierarchy.
    let raw;
    try {
      raw = await client_.capture.snapshot({ ...selection(), forceFull: true, ...(platform === 'ios' || wantRaw ? { raw: true } : {}), timeoutMs: SNAPSHOT_TIMEOUT_MS });
    } catch (error) {
      // Only the one failure that means "a window that is not the app is in front": any other error is not ours to hide.
      if (!systemUiFallback || platform !== 'android' || !NO_APP_CONTENT.test(String((error && error.message) || error))) throw error;
      const system = readSystemUi();
      if (system && system.nodes.length) return system;
      throw error;
    }
    return normalizeSnapshot(raw, currentApp);
  }

  /** The screen as `uiautomator` sees it (every window), or null when it cannot be read. */
  function readSystemUi() {
    try {
      adb(['shell', 'uiautomator', 'dump', SYSTEM_UI_DUMP]);
      return parseUiautomatorDump(adb(['exec-out', 'cat', SYSTEM_UI_DUMP]));
    } catch (_) {
      return null;
    }
  }

  /** iOS: one key per runner call, `pauseMs` apart. One multi-key call lets Compose lose keys. */
  async function typeKeys(text, pauseMs) {
    const client_ = await getClient();
    for (const key of String(text)) {
      await client_.interactions.type({ ...selection(), text: key });
      await sleep(pauseMs);
    }
  }

  /**
   * The field `rect` was read from, as it is now. The keyboard slides a popup up, so the field is
   * found again by its size (the nearest editable node of the same width and height), never by
   * its old position: a tap there lands on the backdrop, drops the focus or closes the popup.
   * null = not in the tree (focused and empty, a Compose field may drop out of it).
   */
  async function locateField(rect) {
    const { nodes } = await takeSnapshot();
    const same = nodes.filter((node) => node.editable && node.rect
      && Math.abs(node.rect.width - rect.width) <= 2 && Math.abs(node.rect.height - rect.height) <= 2);
    same.sort((a, b) => Math.abs(a.rect.y - rect.y) - Math.abs(b.rect.y - rect.y));
    return same[0] || null;
  }

  return {
    async open({ app = currentApp, activity, relaunch = true, extras } = {}) {
      if (!app) throw new Error('open requires an app package');
      const client_ = await getClient();
      // `activity` is deliberately NOT forwarded: on Android 14 agent-device then leaves
      // the launcher in front (verified on a Pixel 5). The package's launcher intent is
      // what we want; the activity is only needed for `am start` with extras below.
      await client_.apps.open({ ...selection(), app, relaunch, timeoutMs: APP_OPEN_TIMEOUT_MS });
      currentApp = app;
      if (extras && typeof extras === 'object' && Object.keys(extras).length) {
        if (platform !== 'android') throw new Error('launch extras are Android-only');
        // `am start -S -n pkg/activity -e key value` is the only reliable way to pass
        // launch extras; the agent-device open call has no extras option.
        if (!activity) throw new Error('launch extras require an activity (for example "com.acme.x/.MainActivity")');
        const argv = ['shell', 'am', 'start', '-S', '-n', `${app}/${activity}`];
        for (const [key, value] of Object.entries(extras)) argv.push('-e', key, String(value));
        adb(argv);
      }
      return { ok: true, app };
    },

    /**
     * `start.launch: fresh`: wipe the app's data and re-grant the permissions it asks for on
     * first run, so a run always starts from the same screen. On iOS only a simulator can do
     * this (its data container is a host folder); a physical device has no equivalent.
     */
    async resetApp({ app = currentApp, grants = ['android.permission.POST_NOTIFICATIONS'] } = {}) {
      if (!app) throw new Error('resetApp requires an app package');
      if (platform === 'ios') {
        resetSimulatorApp(app);
        currentApp = app;
        return { ok: true, app };
      }
      if (platform !== 'android') throw new Error('fresh launch is Android-only');
      adb(['shell', 'pm', 'clear', app]);
      for (const permission of grants || []) {
        // A build that does not declare the permission refuses the grant; that is not a failure.
        try {
          adb(['shell', 'pm', 'grant', app, permission]);
        } catch (_) { /* best effort */ }
      }
      currentApp = app;
      return { ok: true, app };
    },

    /**
     * `raw: true` asks agent-device for the full tree. The default Android tree collapses "helper" nodes (a lone
     * Minimize button of a debug panel, say), which then exist for nobody; the raw tree is ~2x slower and its
     * labels differ, so it is only taken when a leg is stuck (see flow.js).
     */
    async snapshot({ raw = false } = {}) {
      return takeSnapshot({ raw });
    },

    async press(target, { settle = true } = {}) {
      await pressTarget(target, { settle });
      return { ok: true };
    },

    /**
     * Every fill types one key at a time (unless `bulk` is set: one adb call clears, one types, the caller verifies), `charDelayMs` (at least MIN_CHAR_DELAY_MS) apart, deletes
     * included: fields that reformat or search on each key (a phone field, a recipient
     * search field, Compose fields) drop, double or reorder faster keystrokes.
     */
    async fill(target, text, { charDelayMs = 0, bulk = false } = {}) {
      const pause = Math.max(minCharDelayMs, Number(charDelayMs) || 0);
      // Fast path: only an editable field can receive adb input, and only when the
      // backend, the platform and the characters all qualify.
      if (fastInput && platform === 'android' && target && typeof target === 'object' && target.editable === true && ASCII_TEXT.test(String(text))) {
        // Focus the field without settling: the very next command types into it, so
        // waiting for the UI to go quiet buys nothing. On Android an EditText's label
        // IS its value, so a prefilled field is cleared before the caret gets text.
        await pressTarget(target, { settle: false });
        const existing = target.hintShowing === false ? String(target.value || target.text || '') : '';
        if (bulk) {
          // Bulk: ONE adb call clears the field and ONE types the whole value; the caller reads the field
          // back and falls back to the key-by-key path below when the app dropped or reordered keys.
          if (existing) adb(['shell', 'input', 'keyevent', 'KEYCODE_MOVE_END', ...Array(existing.length).fill('KEYCODE_DEL')]);
          if (String(text)) adb(['shell', 'input', 'text', String(text)]);
          return { ok: true };
        }
        if (existing) {
          adb(['shell', 'input', 'keyevent', 'KEYCODE_MOVE_END']);
          for (let i = 0; i < existing.length; i += 1) {
            adb(['shell', 'input', 'keyevent', 'KEYCODE_DEL']);
            await sleep(pause);
          }
        }
        // The typed value is never logged, returned or put in an error.
        for (const char of String(text)) {
          adb(['shell', 'input', 'text', char]);
          await sleep(pause);
        }
        return { ok: true };
      }
      const client_ = await getClient();
      if (platform === 'ios' && isComposeField(target)) {
        // XCTest cannot clear a Compose field: a tap on its middle leaves the caret mid-text, so
        // "clear and type" keeps the tail. Tap its trailing edge (caret at the end), then delete
        // what the field reports holding until it reads empty, and only then type.
        let rect = target.rect;
        const caretToEnd = async ({ relocate = true } = {}) => {
          // Where the field is right now: it may have moved since it was last seen.
          const seen = relocate ? await locateField(rect) : null;
          if (seen) rect = seen.rect;
          const { x, y, width, height } = rect;
          await pressTarget({ x: Math.round(x + width - COMPOSE_EDGE_INSET), y: Math.round(y + height / 2) }, { settle: false });
          // Keys sent while the tap is still moving the caret land where the caret was.
          await sleep(COMPOSE_FOCUS_SETTLE_MS);
          // The keyboard that tap raised may have moved the field.
          const now = await locateField(rect);
          if (now) rect = now.rect;
          return now;
        };
        let field = await caretToEnd({ relocate: false });
        // A field that moved under the tap (the popup slid up) holds no caret yet: tap it again
        // where it is now.
        if (field && (field.rect.y !== target.rect.y || field.rect.x !== target.rect.x)) field = await caretToEnd();
        for (let round = 0; ; round += 1) {
          const held = round ? String(((await locateField(rect)) || {}).value || '').length : String((field || {}).value || '').length;
          if (!held) break;
          if (round >= COMPOSE_CLEAR_ROUNDS) return { ok: false, error: 'the field could not be emptied before typing' };
          await typeKeys('\b'.repeat(held), pause);
        }
        // The typed value is never logged, returned or put in an error. The first key into the
        // empty field puts the caret back at the START (seen live: a phone came out as keys 2..10
        // then key 1, and a password would be rotated the same way unseen), so the caret is sent
        // to the end again before the rest.
        const keys = String(text);
        if (!keys) return { ok: true };
        await typeKeys(keys[0], pause);
        if (keys.length > 1) {
          await caretToEnd();
          await typeKeys(keys.slice(1), pause);
        }
        return { ok: true };
      }
      try {
        // iOS: agent-device compares the field with the typed text and fails on a field that
        // formats itself ("2000" shows as "2.000"); fill() in deviceTools reads it back itself.
        await client_.interactions.fill({ ...selection(), ...targetArgs(target), text, delayMs: pause, ...(platform === 'ios' ? { verify: false } : {}), ...settleOptions() });
      } catch (error) {
        // A field that submits on its last key (an iOS OTP field) is gone before XCTest's `type`
        // returns, and XCTest records that as a failure although every key landed. The caller
        // reads the field back / identifies the next screen, which is the real verdict.
        const message = String(error && error.message);
        if (platform === 'ios' && XCTEST_TYPE_FAILURE.test(message)) return { ok: true, uncertain: true };
        // The iOS runner checks the field itself, unconditionally, and its message quotes the
        // typed value. It misreads fields that format themselves ("2000" shows "2.000") or submit
        // on their last key (the payment PIN), so it is not a verdict: fill() in deviceTools reads
        // the field back and decides. The message (a password, an OTP) never travels on.
        if (platform === 'ios' && TEXT_ENTRY_MISMATCH.test(message)) return { ok: true, uncertain: true };
        throw error;
      }
      return { ok: true };
    },

    /**
     * Type into whatever holds the keyboard focus. iOS only: the fields it serves (Compose) are
     * not in the tree, and adb input already types into the focus on Android.
     */
    ...(platform === 'ios' ? {
      async typeText(text, { charDelayMs = 0 } = {}) {
        // The typed value is never logged, returned or put in an error.
        await typeKeys(text, Math.max(minCharDelayMs, Number(charDelayMs) || 0));
        return { ok: true };
      }
    } : {}),

    /** One swipe between two screen points (a horizontal tab strip has no scroll command). */
    async swipe(from, to) {
      const client_ = await getClient();
      await client_.interactions.swipe({ ...selection(), from, to });
      return { ok: true };
    },

    async scroll(direction = 'down', amount) {
      const client_ = await getClient();
      const args = { ...selection(), direction, ...settleOptions() };
      if (amount !== undefined && amount !== null) args.amount = amount;
      await client_.interactions.scroll(args);
      return { ok: true };
    },

    async back() {
      const client_ = await getClient();
      // System back can leave the app on some screens; the agent loop treats it as
      // any other action and the snapshot decides what happened.
      await client_.command.back({ ...selection(), ...settleOptions() });
      return { ok: true };
    },

    /** The on-screen keyboard: `enter` presses its action key (submits a search field), `dismiss` hides it. */
    async keyboard(action = 'dismiss') {
      const client_ = await getClient();
      // Only with the keyboard up: an action key sent with no keyboard left the search screen for Home on a
      // Samsung (S25 release build, 2026-10-23), so a hidden keyboard makes this a no-op.
      const status = await client_.command.keyboard({ ...selection(), action: 'status' });
      const visible = status && (status.visible ?? (status.data && status.data.visible));
      if (visible === false) return { ok: true, skipped: 'keyboard not visible' };
      await client_.command.keyboard({ ...selection(), action });
      return { ok: true };
    },

    async screenshot(filePath) {
      const target = path.resolve(String(filePath));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const client_ = await getClient();
      await client_.capture.screenshot({ ...selection(), path: target });
      return target;
    },

    async close() {
      try {
        const client_ = await getClient();
        await client_.sessions.close({});
      } catch (error) {
        // Closing a session that is already gone (or a backend that was never
        // started) is not an error worth propagating.
      }
    },

    async clearLogcat() {
      if (platform !== 'android') throw new Error('logcat is Android-only');
      adb(['logcat', '-c']);
      return { ok: true };
    },

    async readLogcat() {
      if (platform !== 'android') throw new Error('logcat is Android-only');
      return adb(['logcat', '-d', '-v', 'brief']);
    },

    meta() {
      return { backend: 'agent-device', platform, serial, udid, appId: currentApp };
    }
  };
}

/** A backend that never touches a device: the loop's tests inject it. */
function createMockBackend({ snapshots = [], rawSnapshots = null, appId, platform = 'android', serial, udid, logcat = '', onAction } = {}) {
  const list = (Array.isArray(snapshots) ? snapshots : [snapshots]).filter(Boolean);
  const actions = [];
  const screenshots = [];
  let index = 0;
  let currentApp = appId || null;
  let log = logcat;
  // What was typed into each field (by ref): on Android a field's label IS its value, and
  // `fill` reads the field back, so the mock shows typed text the way a device does.
  const typed = new Map();

  // A caller may pass raw agent-device fixtures or already-normalised snapshots.
  const isNormalized = (raw) => Array.isArray(raw && raw.nodes)
    && raw.nodes.length > 0
    && Object.prototype.hasOwnProperty.call(raw.nodes[0], 'pinned');

  function record(action) {
    actions.push(action);
    if (typeof onAction === 'function') onAction(action, backend);
    return action;
  }

  const backend = {
    actions,
    screenshots,
    get logcat() { return log; },
    set logcat(value) { log = value === undefined || value === null ? '' : String(value); },

    /** Move to the next fixture screen (stays on the last one). */
    advance() {
      index = Math.min(index + 1, Math.max(0, list.length - 1));
      return index;
    },

    async open({ app = currentApp, activity, relaunch = true, extras } = {}) {
      currentApp = app || currentApp;
      record({ kind: 'open', app, activity, relaunch, extras });
      return { ok: true, app };
    },

    async snapshot({ raw: wantRaw = false } = {}) {
      const source = wantRaw && rawSnapshots ? [].concat(rawSnapshots).filter(Boolean) : list;
      const raw = source[Math.min(index, Math.max(0, source.length - 1))];
      if (!raw) return normalizeSnapshot({ nodes: [] }, currentApp);
      const snap = isNormalized(raw) ? raw : normalizeSnapshot(raw, currentApp);
      if (!typed.size) return snap;
      return {
        ...snap,
        nodes: snap.nodes.map((node) => (typed.has(node.ref)
          ? { ...node, label: typed.get(node.ref), value: typed.get(node.ref), text: typed.get(node.ref), hintShowing: false }
          : node)),
      };
    },

    /** No device, so `fresh` is nothing to wipe: the caller only needs the call to exist. */
    async resetApp() {
      record({ kind: 'reset' });
      return { ok: true };
    },

    async press(target, options) {
      record({ kind: 'press', target, settle: options?.settle !== false });
      return { ok: true };
    },

    async fill(target, text) {
      record({ kind: 'fill', target, text });
      if (target && target.ref) typed.set(target.ref, String(text));
      return { ok: true };
    },

    async scroll(direction = 'down', amount) {
      record({ kind: 'scroll', direction, amount });
      return { ok: true };
    },

    async back() {
      record({ kind: 'back' });
      return { ok: true };
    },

    async keyboard(action = 'dismiss') {
      record({ kind: 'keyboard', action });
      return { ok: true };
    },

    async screenshot(filePath) {
      screenshots.push(filePath);
      return filePath;
    },

    async close() {},

    async clearLogcat() {
      log = '';
      return { ok: true };
    },

    async readLogcat() {
      return log;
    },

    meta() {
      return { backend: 'mock', platform, serial, udid, appId: currentApp };
    }
  };

  return backend;
}

module.exports = { createDeviceBackend, createMockBackend, normalizeSnapshot, isComposeField, shortRole };
