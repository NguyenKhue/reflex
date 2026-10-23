# reflex Phase 3 — a second real app, "add an app" docs, system-UI fallback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (this session implements) or hand a task to opencode via
> `docs/reflex/DELEGATION.md`. Steps use checkbox (`- [ ]`) syntax. Tick them as you go and update `docs/reflex/STATUS.md`.

**Goal:** Prove reflex is not a Acme tool: add a second, unrelated app (the Android **Settings** app) with its own screens and plan, make adding an app a
one-command job, and let the runner read system UI (share sheet, pickers, permission dialogs) that `agent-device snapshot` cannot see.

**Architecture:** `reflex app init` scaffolds an app (manifest entry + `screens/<key>/_app/`). The second app is authored with the existing tools
(`screen capture`, `plan validate`, `run`) on an emulator; whatever is still Acme-shaped shows up as findings. The system-UI fallback adds a second snapshot source
(`adb shell uiautomator dump`) to the device backend, used only when `agent-device` reports "insufficient foreground app content" repeatedly.

**Tech Stack:** Node >= 22.12, CommonJS, `node:test`, `adb`, `agent-device`. No new npm dependencies.

**Spec:** `docs/reflex/ROADMAP.md` (Phase 3), `docs/reflex/DESIGN.md` (D7: a second real app before contracts are frozen).

## Global Constraints
- Package folder `reflex/`, tests `reflex/test/`. Test command (main session only): `npm test --prefix reflex`. Baseline before this phase: 384 tests, 383 pass, 1 skipped.
- CommonJS, 2-space indent, single quotes, semicolons, English comments that explain why. Every file ends with a newline.
- The agent never enters credentials and never changes device system settings. The Settings app plan is READ-ONLY navigation (open a screen, read it, go back); `start.launch` is
  `relaunch`, NEVER `fresh` (`fresh` wipes the app's data container; for Settings that is a system change).
- Environment facts (2026-10-05): the user's phone was not connected; an emulator `Medium_Phone` (Android 8.1, API 27, `emulator-5554`) was booted for this phase. `agent-device open com.android.settings`
  works on it and the main list is readable as text.
- Secrets never leave the process (existing rules). Nothing in this phase needs a credential.

## Review Focus
- `app init` must refuse to overwrite: an existing manifest key or an existing `screens/<key>/` leaves every file byte-for-byte unchanged.
- `app init` must validate the key and the package/bundle id before writing anything, and write the manifest LAST so a failure leaves no half-registered app.
- The uiautomator fallback must only engage after repeated agent-device failures, never replace a working snapshot, and must never be a source of secrets (same redaction as the normal path).
- A fallback node must be pressable: coordinates come from the node's bounds, and a stale tree must not be tapped blindly.
- Running a plan on the Settings app must not change a device setting (read-only legs only).

## File structure
```
reflex/src/cli/appCommands.js          T1  appInit
reflex/src/cli/index.js                T1  usage line + `case 'app'`
reflex/test/cli/appInit.test.js        T1
workspace/screens/settings/…    T2  second app knowledge (captured on the emulator)
workspace/plans/settings/…      T2  read-only plan(s)
reflex/src/device/…                    T3  uiautomator fallback (files decided after reading deviceBackend.js)
docs/reflex/ADD_AN_APP.md              T4  how to add an app
```

---

### Task 1: `reflex app init`

**Files:**
- Create: `reflex/src/cli/appCommands.js`
- Create: `reflex/test/cli/appInit.test.js`
- Modify: `reflex/src/cli/index.js` (usage line + `case 'app'`)

**Interfaces:**
- Consumes: `workspace.root()` (`src/util/workspace.js`); the manifest is `reflex.workspace.json`, or the legacy `legacy.workspace.json` when that is what the workspace has.
- Produces: `appInit({ key, package, activity, bundleId, root })` → `{ ok: true, app, manifest, created }` where `manifest` is the manifest's file name and `created` the
  workspace-relative paths written (`screens/<key>/_app/context.md`, `exceptions.yml`, `routes.yml`). It also adds `apps.<key>` to the manifest:
  `android: { package, activity? }` when `package` is given, `ios: { bundleId }` when `bundleId` is given.
- Errors (exact messages, tests assert them):
  - bad key: `app init requires an app key: lowercase letters, digits and underscores, starting with a letter (got "<key>")`
  - nothing to launch: `app init requires --package <android package> and/or --bundle-id <ios bundle id>`
  - bad id: `"<value>" is not a valid package / bundle id (expected dotted names such as com.example.app)`
  - duplicate: `app "<key>" is already in <manifest file name>` ; existing dir: `<relative dir> already exists`
  - unreadable manifest: `<manifest file name> is not valid JSON: <parser message>`

- [x] **Step 1: Create `src/cli/appCommands.js`**

```js
/**
 * appCommands.js — `reflex app init`: register a new app in the workspace so a plan can name it.
 *
 * It writes only what is app-specific and safe to commit: the manifest entry (package / activity / bundle id) and the
 * `screens/<key>/_app/` notes. It never touches an existing app and never writes a credential. Everything is validated
 * before the first write, and the manifest is written LAST, so a failure cannot leave a half-registered app behind.
 */
const fs = require('fs');
const path = require('path');
const workspace = require('../util/workspace');

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const DOTTED_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const MANIFEST_NAMES = ['reflex.workspace.json', 'legacy.workspace.json'];

function contextTemplate(key) {
  return [
    `# ${key} — notes`,
    '',
    'Notes for the people and the decider working on this app. Keep it short and factual.',
    '',
    '- What the app is and how a test starts (signed in? onboarding? a fresh install?).',
    '- How elements are found: visible text, test ids (btn_...), content descriptions.',
    '- Popups and errors this app shows: which are harmless (dismiss) and which are real failures (fail / blocked).',
    '- Slow screens and how long they take (waitMs).',
    '',
  ].join('\n');
}

function manifestFileOf(root) {
  const name = MANIFEST_NAMES.find((candidate) => fs.existsSync(path.join(root, candidate)));
  if (!name) throw new Error(`${root} has no ${MANIFEST_NAMES.join(' or ')}`);
  return name;
}

function checkId(value) {
  if (!DOTTED_ID.test(String(value))) {
    throw new Error(`"${value}" is not a valid package / bundle id (expected dotted names such as com.example.app)`);
  }
}

function appInit({ key, package: appPackage = null, activity = null, bundleId = null, root = null } = {}) {
  if (!key || !KEY.test(String(key))) {
    throw new Error(`app init requires an app key: lowercase letters, digits and underscores, starting with a letter (got "${key || ''}")`);
  }
  if (!appPackage && !bundleId) throw new Error('app init requires --package <android package> and/or --bundle-id <ios bundle id>');
  if (appPackage) checkId(appPackage);
  if (bundleId) checkId(bundleId);

  const base = root || workspace.root();
  const manifestName = manifestFileOf(base);
  const manifestFile = path.join(base, manifestName);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    throw new Error(`${manifestName} is not valid JSON: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(`${manifestName} is not valid JSON: expected an object`);
  const apps = manifest.apps && typeof manifest.apps === 'object' ? manifest.apps : {};
  if (apps[key]) throw new Error(`app "${key}" is already in ${manifestName}`);
  const appDir = path.join(base, 'screens', key);
  if (fs.existsSync(appDir)) throw new Error(`${path.join('screens', key)} already exists`);

  const entry = {};
  if (appPackage) entry.android = activity ? { package: appPackage, activity } : { package: appPackage };
  if (bundleId) entry.ios = { bundleId };

  const files = {
    [path.join('screens', key, '_app', 'context.md')]: contextTemplate(key),
    [path.join('screens', key, '_app', 'exceptions.yml')]: '[]\n',
    [path.join('screens', key, '_app', 'routes.yml')]: '[]\n',
  };
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(base, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  manifest.apps = { ...apps, [key]: entry };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ok: true, app: key, manifest: manifestName, created: Object.keys(files) };
}

module.exports = { appInit };
```

- [x] **Step 2: Edit `src/cli/index.js`** — (a) in `USAGE`, after the `knowledge review` line, add
  `  app init <key> --package <android package> [--activity a] [--bundle-id <ios id>]   register a new app: manifest entry + screens/<key>/_app/`;
  (b) in the `switch (command)`, before `case 'mcp':`, add:

```js
      case 'app': {
        if (sub === 'init') {
          const commands = require('./appCommands');
          const result = commands.appInit({
            key: positionals[2],
            package: str(flags, 'package'),
            activity: str(flags, 'activity'),
            bundleId: str(flags, 'bundle-id'),
          });
          if (!json) note(`✓ app "${result.app}" registered in ${result.manifest}; created ${result.created.join(', ')}`);
          emit(result, { json });
          return 0;
        }
        break;
      }
```

- [x] **Step 3: Create `test/cli/appInit.test.js`** (`node:test` + `node:assert/strict`; a temp workspace per test from `fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-appinit-'))` containing a manifest
  `{ "name": "t", "defaults": { "platform": "android" }, "apps": { "old": { "android": { "package": "com.example.old" } } } }`) — cases it MUST contain:
  1. success: `appInit({ key: 'settings', package: 'com.android.settings', activity: '.Settings', bundleId: 'com.apple.Preferences', root })` returns `ok: true`, `app: 'settings'`,
     `manifest: 'reflex.workspace.json'`, `created` of exactly the three relative paths; the manifest now has `apps.settings` with `android: { package, activity }` and `ios: { bundleId }`, keeps `apps.old` and
     `defaults` unchanged; the three files exist; `exceptions.yml` and `routes.yml` hold `[]`; `context.md` starts with `# settings — notes`.
  2. package only: no `activity` key, no `ios` key in the entry; bundle id only: no `android` key.
  3. the new app is usable: `loadStore(root, 'settings')` (`src/screens/store.js`) does not throw and has zero screens; `resolveApp({ name: 'p', app: 'settings' }, {}, 'android')`
     (`src/runner/app.js`, after `workspace.setOverride(root)` and `workspace.reset()` in a `finally`) returns `package: 'com.android.settings'`.
  4. refuses duplicates without writing anything: an existing manifest key (`old`) throws `app "old" is already in reflex.workspace.json`; an existing `screens/fresh/` dir throws
     `screens/fresh already exists` (use `path.join`); in both cases the manifest text is byte-for-byte unchanged and no new file appears.
  5. validation: keys `''`, `undefined`, `'Bad Key'`, `'1x'`, `'a-b'` throw the bad-key message with the key echoed; neither package nor bundle id throws the "requires --package" message;
     `'nodots'`, `'a..b'`, `'com.example.'` throw `"<value>" is not a valid package / bundle id (expected dotted names such as com.example.app)`; nothing is written in any of these cases.
  6. a workspace that only has the legacy `legacy.workspace.json` is updated in that file (`manifest: 'legacy.workspace.json'`).
  7. an invalid-JSON manifest (`{ nope`) throws a message starting `reflex.workspace.json is not valid JSON:` and creates no `screens/` directory.
  8. CLI: spawn `process.execPath [reflex/bin/reflex.js, 'app', 'init', 'newapp', '--package', 'com.example.newapp', '--json', '--workspace', <tmp>]`
     (`path.join(__dirname, '..', '..', 'bin', 'reflex.js')`); parse the `REFLEX_JSON ` stdout line → `ok: true`, `app: 'newapp'`, exit status 0; running the same command again exits 1 and its marker
     has `ok: false` and an `error` containing `already in`.
- [x] **Step 4: Run (main session)** `npm test --prefix reflex` → 384 + new tests, 0 failures.
- [x] **Step 5: Update `STATUS.md`** (tick T1).

---

### Task 2: The Settings app as the second app (main session, on the emulator)

**Deliverable:** `workspace/screens/settings/` (created with `reflex app init settings --package com.android.settings`), at least these screens captured with
`reflex screen capture --as <group>/<screen> --app settings --serial emulator-5554` and then edited by hand (`identify` that does not depend on rotating or localized-by-time text):
`core/home` (the main list, e.g. `allText: ["Network & Internet", "Battery"]`), `core/battery`, and one more (`core/network` or `core/storage`); `normal.yml` cases for the hops
(tap the row by its visible text) and a back case; `workspace/plans/settings/open_battery.plan.md` with `start: { launch: relaunch }`, legs `core/home → core/battery` and
`core/battery → core/home`, `verify` with an `assert_text`. Run it with `--no-jev --screenshots fail` (no credential, no decider key needed) until it passes twice in a row; a `verified` status
needs the runner's own `PROMOTE_STREAK` (3 ok runs) — let the runner promote, do not hand-edit statuses.
**Findings to record in `STATUS.md`:** every place where the framework was still Acme-shaped (messages, defaults, `doctor` warnings about `LEGACY_TEST_*` when no account is needed, marker/report titles
that say `old-tool`, the report title `(old-tool)` in `run.js`), with a proposed fix each. **Acceptance:** the plan passes on the emulator without touching a setting; `reflex stats` shows the runs;
`reflex knowledge review --app settings` lists what was learned; the whole suite is still green.

**Done 2026-10-05 (emulator `emulator-5554`, Android 8.1).** Registered `apps.settings` (by hand: equivalent of `app init`), captured `core/home` and `core/battery` with `screen capture`, wrote `core/network` by hand,
edited `identify` to stable rows, `normal.yml` for the three screens (tap row title / `back`), plans `settings/open_battery` (2 legs) and `settings/tour` (4 legs), both read-only with `launch: relaunch`.
Result: 6 runs, 6 pass, 6 straight-through (0 decider calls, no key, no account), avg 10.1 s; the runner promoted all 4 cases to `verified` (3 and 6 ok streaks);
`reflex stats` and `reflex knowledge review --app settings --status all` show it.

**Findings — what was still Acme-shaped or rough (2026-10-05):**
1. Log lines, the CLI banner/usage and `Error`/`note` prefixes still say `old-tool` / "Acme app flow plans"; the report title is `<plan> (old-tool)` (`runner/run.js`). Cosmetic, easy.
2. `doctor` warns about `LEGACY_TEST_PHONE`, `LEGACY_TEST_PASSWORD` and the OTP token even for an app that needs no account; it should warn per plan (the plan declares `inputs`). Also reads `LEGACY_TEST_*`, not `REFLEX_TEST_*`.
3. `screen capture` only captures the CURRENT screen (it does not launch the app); with the launcher in front it fails with "nothing on this screen can identify it". Document or add `--launch`.
4. `screen capture` copies volatile texts (battery %, storage used, times) into the body and picks the first two texts as `identify`; a human must rewrite `identify` to stable rows. A warning for digits/percent in `identify` would help.
5. The package pins `agent-device 0.21.12` while the global CLI is 0.21.20: running `reflex` and the global `agent-device` alternately makes the daemon restart ("version mismatch"). Align the pin or document it.
6. `app init` did not exist yet while doing this by hand (now it does, T1); the by-hand JSON edit worked because the manifest loader is tolerant.
7. Plans for a non-Acme app need no change in the runner: app resolution (`apps.<key>`), screens, plans, learner, ledger and review all worked unchanged. That is the evidence for D7.


### Task 3: System-UI fallback via `uiautomator` (spec-level — write the detailed steps after reading `device/deviceBackend.js`)

**Evidence (2026-10-05, emulator, `ResolverActivity`):** with a share chooser in front, `adb shell uiautomator dump /sdcard/w.xml` returned the chooser's texts
(`Share with`, `Gmail`, `Messages`, `JUST ONCE`, `ALWAYS`) while `agent-device` snapshots of such windows fail with "insufficient foreground app content" (seen on a physical phone).
**Deliverable:** in the device backend, a `snapshot()` that — only after `agent-device` failed that way on every attempt — falls back to a parsed `uiautomator` dump normalised to the same node shape
(`normalizeSnapshot`), plus `press`/`back` on those nodes by their bounds centre (`adb shell input tap`). **Acceptance:** unit tests with a recorded XML fixture (no device); the
fallback never runs when agent-device succeeds; the XML parser has no dependency and ignores nodes without text/id/description; on the emulator the share chooser opened by
`adb shell am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT hi` is identified as a screen of a throw-away `chooser` screen file.

**Done 2026-10-05 (main session).** New `reflex/src/device/uiautomator.js` (`parseUiautomatorDump`, `parseBounds`, `unescapeXml`: dependency-free, never throws) and three edits in
`device/deviceBackend.js`: option `systemUiFallback = true`; `takeSnapshot()` catches ONLY the "system window in front" failure and, on Android, reads `adb shell uiautomator dump /sdcard/reflex-window.xml` +
`adb exec-out cat …`; `targetArgs()` presses a ref-less node by the centre of its `rect`. Tests: `test/device/systemUi.test.js` (11) with a REAL chooser dump as fixture `test/fixtures/uiautomator-chooser.xml`.
**Found by running it live (not by the unit tests):** agent-device words the failure differently by version/device — `insufficient foreground app content` (0.21.20, phone), `insufficient application window content` and
`only non-application windows` (0.21.12, emulator). The first version matched only the first wording and did nothing on the emulator; the matcher now covers all three (`NO_APP_CONTENT`) and a test pins them.
**Verified live:** with the share sheet open, `reflex snapshot --app settings` printed `Share with / Gmail / Messages / JUST ONCE / ALWAYS` and `reflex screen identify` answered `screen: system/chooser`.
**Not done / limits:** iOS has no equivalent; a window with `FLAG_SECURE` may dump empty (then the original error is rethrown); pressing nodes of a stale dump is the caller's responsibility (the leg loop re-snapshots every turn).
### Task 4: "Add an app" documentation

**Deliverable:** `docs/reflex/ADD_AN_APP.md`, a numbered recipe verified by actually following it for the Settings app (T2): `app init`, `screen capture`, writing `identify`, a first plan, `plan validate`,
a first run with `--no-jev`, reading `stats`/`knowledge review`, and the traps found (never `launch: fresh` on a system app; text that changes with time or locale; what `blocked` vs `fail` mean).
Link it from `README.md` and `AGENTS.md`. **Acceptance:** every command in the doc was run, with its real output shape quoted where short.

**Done 2026-10-05:** `docs/reflex/ADD_AN_APP.md`, written from the T2 run and verified command by command (`app init` was re-run on a copy of the workspace to quote its real output), linked from `README.md` and `AGENTS.md`.

---

## Self-review (2026-10-05)
- Roadmap coverage: second real app (T2), "add an app" docs (T4, with the scaffold command T1), system-UI fallback (T3).
- T2–T4 are not delegable as written: T2 is device work with discovery, T3 needs a read of `deviceBackend.js` first, T4 documents what T2 found.
- Names: `appInit`, `key`, `bundleId` are used consistently between the code block, the CLI wiring and the tests.
