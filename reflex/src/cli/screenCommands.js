/**
 * screenCommands.js — the three commands that grow a screen knowledge base from a real device:
 * `capture` (what the screen shows now → a draft `screen.md`), `list` (what the base knows) and
 * `identify` (which screen the device shows — the debugger for an `identify` block).
 *
 * Privacy: this is the one path where DEVICE text is written into the committed tree, so every
 * text and test id goes through the same filter learned knowledge uses (`learn.placeholderize`
 * plus its sensitive patterns) — a text that still carries a value the app printed (a phone, an
 * amount, an OTP) is REFUSED, never redacted, and counted in `dropped`. Editable fields are not
 * read at all: on Android an EditText's label IS its typed value.
 */
const fs = require('fs');
const path = require('path');
const YAML = require('js-yaml');
const workspace = require('../util/workspace');
const { parseFrontMatter } = require('../plan/loader');
const { visibleTexts } = require('../device/screenState');
const { loadStore } = require('../screens/store');
const { identifyScreen } = require('../screens/identify');
const { placeholderize, secretsOf } = require('../screens/learn');

/** `<group>/<screen>` — the same shape `schema.SCREEN_ID` accepts. */
const SCREEN_AS = /^[a-z0-9_]+\/[a-z0-9_]+$/;
/** A node text that is really a test id (see `screens/match.screenIndex`), so it is no prose. */
const TEST_ID = /^[a-z][A-Za-z0-9_.\/-]*$/;
/** A shorter text matches half the app: useless as an identity. */
const IDENTIFY_MIN_CHARS = 3;
const IDENTIFY_TEXTS = 2;
/** `_note` in the manifest account is prose, not a value: only the values are filtered for. */
const ACCOUNT_VALUES = ['phone', 'password', 'pin'];

const CAPTURE_SESSION = 'reflex-screen-capture';
const IDENTIFY_SESSION = 'reflex-screen-identify';

const createRealBackend = (options) => require('../device/deviceBackend').createDeviceBackend(options);

/** The app package of a workspace app key: without it the snapshot would keep other windows. */
function appPackage(app, platform) {
  if (!app) throw new Error('--app <key> is required (the app key of reflex.workspace.json)');
  const apps = (workspace.tryRoot() && workspace.manifest().apps) || {};
  const entry = (apps[app] || {})[platform];
  const target = entry && (entry.package || entry.bundleId);
  if (!target) {
    throw new Error(`unknown app "${app}" for ${platform}: reflex.workspace.json has no apps.${app}.${platform}.package / .bundleId`);
  }
  return target;
}

/**
 * Values that must never reach a `screen.md`: the resolved account (`.env` / `REFLEX_TEST_*` /
 * `defaults.account`), i.e. exactly what the app can print back on a screen.
 */
function accountSecrets() {
  // Every account a run may use (shared + per-platform): a capture on either device may show any of them.
  const values = {};
  for (const platform of [undefined, 'android', 'ios']) {
    const account = workspace.defaults(platform).account || {};
    for (const name of ACCOUNT_VALUES) {
      if (!account[name]) continue;
      const key = values[name] === undefined || values[name] === account[name] ? name : `${name}_${platform}`;
      values[key] = account[name];
    }
  }
  return secretsOf(values);
}

/** One text, one list item: a captured text may carry newlines, which would break the list. */
function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * The items that may be written, plus how many were refused. A placeholder left in the text
 * means the text carried a value we hold, and `null` means the text still looks like data the
 * app printed; both are refused rather than redacted, because a committed hint that carries a
 * value is worse than no hint at all.
 */
function safeItems(items, secrets) {
  const safe = [];
  let refused = 0;
  for (const item of items) {
    const out = placeholderize(oneLine(item), secrets);
    if (out === null || out.includes('{')) {
      refused += 1;
      continue;
    }
    if (!safe.includes(out)) safe.push(out);
  }
  return { safe, refused };
}

/**
 * Node texts and test ids as the DEVICE shows them (unfolded: the agent pastes these into
 * `identify`) and in screen order. `visibleTexts` is what may leave the process at all — it
 * already drops editable fields and on-screen tokens.
 */
function textsAndIds(snapshot) {
  const ids = [];
  for (const node of (snapshot && snapshot.nodes) || []) {
    if (node.identifier) ids.push(String(node.identifier));
    // RN test IDs often surface as a node text (e.g. "btn_continue"), not as `identifier`.
    if (!node.editable && TEST_ID.test(String(node.text || ''))) ids.push(String(node.text));
  }
  return { texts: visibleTexts(snapshot), ids };
}

/** A device session scoped to the app's own window, closed in `finally`: agent-device keeps
 * handles open until `close()`, so a leaked session would hang the process. */
async function snapshotOnce({ platform, serial, udid, appId, session, createBackend }) {
  const create = createBackend || createRealBackend;
  const backend = create({ platform, serial, udid, session, appId });
  try {
    return await backend.snapshot();
  } finally {
    try { await backend.close(); } catch (_) { /* best effort */ }
  }
}

/**
 * The `identify` a capture suggests: the first distinctive texts, plus the first test id when the
 * screen has one. `null` when the screen offers nothing to be recognized by — an empty
 * `identify` would make the screen unusable, so the caller must not write such a file.
 */
function suggestIdentify(texts, ids) {
  const allText = texts
    .filter((text) => text.length >= IDENTIFY_MIN_CHARS && !/^\d+$/.test(text) && !TEST_ID.test(text))
    .slice(0, IDENTIFY_TEXTS);
  // Android resource ids (`pkg:id/action_bar_root`) name framework containers every screen shares;
  // only an app test id tells this screen apart.
  const appIds = ids.filter((id) => !id.includes(':id/'));
  if (!allText.length && !appIds.length) return null;
  return {
    ...(allText.length ? { allText } : {}),
    ...(appIds.length ? { anyId: [appIds[0]] } : {}),
  };
}

/** `Texts:` / `Test IDs:` — both headings always appear, so the agent sees an empty one too. */
function listSection(heading, items) {
  return [heading, ...(items.length ? items.map((item) => `- ${item}`) : ['- (none)'])];
}

/** A brand new `screen.md`: front-matter for the machine, captured hints for the agent. */
function screenMarkdown({ id, identify, date, texts, ids }) {
  const frontMatter = YAML.dump({ id, identify, inputs: [] }, { lineWidth: 200, noRefs: true }).trimEnd();
  return [
    '---',
    frontMatter,
    '---',
    `Captured ${date} (draft — review identify before use).`,
    '',
    ...listSection('Texts:', texts),
    '',
    ...listSection('Test IDs:', ids),
    '',
  ].join('\n');
}

/** What a capture APPENDS to a screen that already exists: notes only, front-matter untouched. */
function captureSection({ date, texts, ids }) {
  return [
    '',
    `## Capture ${date}`,
    '',
    ...listSection('Texts:', texts),
    '',
    ...listSection('Test IDs:', ids),
    '',
  ].join('\n');
}

/** The `identify` of a file that already exists — read with the loader a run reads it with. */
function readIdentify(file) {
  const { meta } = parseFrontMatter(fs.readFileSync(file, 'utf8'), file);
  return meta.identify === undefined ? null : meta.identify;
}

/**
 * `screenCapture({ as, app, serial, platform, udid })` — snapshot the screen the device shows now
 * into `screens/<app>/<group>/<screen>/`.
 *
 * A screen with no `screen.md` gets a draft one (`identify` from the captured hints) plus the
 * empty `normal.yml` / `exceptions.yml` the store expects; an existing one only gets a
 * `## Capture <date>` section appended to its body, so a reviewed `identify` is never overwritten
 * by a device snapshot — the reviewed block is then reported back instead.
 * `dropped` counts both texts and test ids refused, and `identify` is the block written into a
 * new `screen.md` (for an existing one: the block a review could paste, or the one it carries).
 */
async function screenCapture({ as, app, serial, platform = 'android', udid, createBackend, root: rootArg } = {}) {
  if (!as || !SCREEN_AS.test(String(as))) {
    throw new Error('screen capture requires --as <group>/<screen> (lowercase letters, digits and "_")');
  }
  const root = rootArg || workspace.root();
  // Validate the app before opening a session: a wrong key must not cost a device session.
  const appId = appPackage(app, platform);
  const snapshot = await snapshotOnce({ platform, serial, udid, appId, session: CAPTURE_SESSION, createBackend });
  const seen = textsAndIds(snapshot);
  const secrets = accountSecrets();
  const texts = safeItems(seen.texts, secrets);
  const ids = safeItems(seen.ids, secrets);
  const kept = { texts: texts.safe, ids: ids.safe, dropped: texts.refused + ids.refused };
  const identify = suggestIdentify(kept.texts, kept.ids);

  const dir = path.join(root, 'screens', String(app), ...String(as).split('/'));
  const file = path.join(dir, 'screen.md');
  const date = new Date().toISOString().slice(0, 10);
  const created = !fs.existsSync(file);
  if (created) {
    // Without an identity the store would refuse the screen, and the whole app's plans with it.
    if (!identify) {
      throw new Error(
        `nothing on this screen can identify it (no text of ${IDENTIFY_MIN_CHARS}+ characters and no test id): ` +
        `write screens/${app}/${as}/screen.md by hand with an "identify" block`,
      );
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, screenMarkdown({ id: as, identify, date, texts: kept.texts, ids: kept.ids }));
    for (const name of ['normal.yml', 'exceptions.yml']) {
      const target = path.join(dir, name);
      if (!fs.existsSync(target)) fs.writeFileSync(target, '[]\n');
    }
  } else {
    const current = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(file, `${current.endsWith('\n') ? '' : '\n'}${captureSection({ date, texts: kept.texts, ids: kept.ids })}`);
  }
  return {
    file: path.relative(root, file),
    created,
    texts: kept.texts.length,
    ids: kept.ids,
    dropped: kept.dropped,
    identify: identify || readIdentify(file),
  };
}

/** Case counts by status, the same tally `context show` reports for a screen. */
function countByStatus(items) {
  const counts = { verified: 0, learned: 0, draft: 0 };
  for (const item of items || []) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}

/** `screenList({ app })` — every screen of an app with its cases by status and its rule count. */
function screenList({ app, root: rootArg } = {}) {
  if (!app) throw new Error('screen list requires --app <key>');
  const store = loadStore(rootArg || workspace.root(), String(app));
  const screens = [...store.screens.values()]
    .map((screen) => ({
      id: screen.id,
      cases: countByStatus(screen.normal),
      exceptions: screen.exceptions.length,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return { app: String(app), screens };
}

/**
 * `screenIdentify({ app, serial, platform, udid })` — which ONE screen of the app the device
 * shows now, or `null` (`ambiguous` when several screens match equally well). Used to debug an
 * `identify` block that is too loose or too tight; the texts it matched on come back redacted.
 */
async function screenIdentify({ app, serial, platform = 'android', udid, createBackend, root: rootArg } = {}) {
  if (!app) throw new Error('screen identify requires --app <key>');
  const root = rootArg || workspace.root();
  // The tree is loaded before the session opens, like `plan validate` does for a run.
  const store = loadStore(root, String(app));
  const appId = appPackage(app, platform);
  const snapshot = await snapshotOnce({ platform, serial, udid, appId, session: IDENTIFY_SESSION, createBackend });
  const { id, ambiguous } = identifyScreen(snapshot, store, [...store.screens.keys()]);
  return {
    app: String(app),
    screen: id,
    ambiguous,
    texts: safeItems(visibleTexts(snapshot), accountSecrets()).safe,
  };
}

module.exports = { screenCapture, screenList, screenIdentify };
