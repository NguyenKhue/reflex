# Add an app to reflex

A recipe, verified on 2026-10-05 by doing it for the Android **Settings** app (`com.android.settings`) on an emulator (`emulator-5554`, Android 8.1).
Every command below was run; short outputs are quoted. The second app needed **no change in the runner**: only knowledge (screens, cases, plans).

`reflex` below is `node reflex/bin/reflex.js` (or the `reflex` bin once linked). Run commands from the workspace folder (`workspace/`), or pass `--workspace <dir>`.

## 0. Before you start

- A device or emulator that `adb devices` lists, with the app installed. Pass `--serial <id>` (or set `ANDROID_SERIAL`).
- Decide what the first plan will do and keep it **small and read-only**: open a screen, read it, go back.
- You do NOT need an account, a decider key (`TYPESAFE_API_KEY`) or `.env` for an app without a login. `reflex doctor` still lists
  `REFLEX_TEST_*` as warnings when unset: they are informational and only matter for plans that log in.

## 1. Register the app

```bash
reflex app init settings --package com.android.settings
```
```
✓ app "settings" registered in reflex.workspace.json; created screens/settings/_app/context.md, screens/settings/_app/exceptions.yml, screens/settings/_app/routes.yml
REFLEX_JSON {"ok":true,"app":"settings","manifest":"reflex.workspace.json","created":[…]}
```
It adds `apps.settings.android.package` to the manifest and creates the three `_app` files. Options: `--activity .Main` (a launch activity), `--bundle-id <id>` (iOS).
A second `app init` with the same key fails (`app "settings" is already in reflex.workspace.json`) and changes nothing. The key is lowercase letters, digits and underscores.

Edit `screens/settings/_app/context.md`: one short page of facts about the app (how a test starts, how elements are found, which popups are harmless, slow screens).

## 2. Capture the first screens

Open the app on the device first: `screen capture` records the screen that is in front now, it does not launch the app.

```bash
adb -s emulator-5554 shell monkey -p com.android.settings -c android.intent.category.LAUNCHER 1
reflex screen capture --as core/home --app settings --serial emulator-5554
```
```
✓ created screens/settings/core/home/screen.md (17 texts, 15 ids, 0 dropped)
```
A screen id is `<group>/<screen>`: `core` for the main app, or a mini-app name. The draft `screen.md` lists the visible texts and test ids and guesses an `identify` block.

**Rewrite `identify` by hand** so it uses stable text only (all conditions must be true; text is matched without accents and by "contains"):

```yaml
---
id: core/home
identify:
  allText: [Network & Internet, Connected devices, Apps & notifications]
inputs: []
---
Main list of the Settings app. … (a short description for people and for the decider)
```
- Never match on text that changes: times, battery %, balances, greetings, rotating placeholders.
- Use `noneText` to tell look-alike screens apart (a popup drawn over a screen), `anyId` for test ids when the app has them.
- Check it: `reflex screen identify --app settings --serial emulator-5554` → `screen: core/home`.

Repeat for each screen: navigate there (by hand or with `adb`), `screen capture --as core/battery …`, then fix its `identify`.

## 3. Write the cases (how to get from one screen to the next)

`screens/settings/core/home/normal.yml` — one hop per case:

```yaml
- to: core/battery
  intent: "Open the Battery screen"
  steps:
    - { tool: tap_text, args: { text: "Battery", exact: true } }
  status: draft
```
and on the sub screens, `steps: [ { tool: back } ]` with `to: core/home`. Tools you will use most: `tap_text`, `fill` (an input NAME, never a value), `back`, `wait_text`, `assert_text`, `scroll_to_text`
(see `DEVICE_TOOL_SPECS` in `reflex/src/device/deviceTools.js`). Start every case as `draft`; the runner promotes it by itself (see step 6).

Known popups and errors go in `exceptions.yml` (app-wide in `_app/`, per screen next to `screen.md`): `do: { tap: … }` for a harmless popup, `do: { fail: "…" }` for a real error,
`do: { blocked: "…" }` for an environment problem (maintenance, out of stock). Rules are checked in this order and the first one that matches wins: `screens/_shared/` (policy, never touched by the runner), the screen's own file, its mini app's `_miniapp/`, then `_app/`.
So put an error that must stop the leg (`fail`) where it is checked before a harmless-popup `tap` that could match the same screen.

## 4. Write a plan

`plans/settings/open_battery.plan.md`:

```yaml
---
name: settings_open_battery
app: settings
platforms: [android]
goal: "Open the Battery screen of Settings and come back to the main list (read-only)"
status: draft
inputs: []
start: { launch: relaunch }
flow:
  - { at: core/home, to: core/battery }
  - { at: core/battery, to: core/home }
verify:
  - { tool: assert_text, args: { text: "Network & Internet", exact: true, timeout: 5000 } }
---
```
`start.launch`: `relaunch` restarts the app, `attach` leaves it alone, **`fresh` wipes the app's data** (use it only for your own app, never for a system app).
`flow` is a chain of legs; `verify` and a leg's `checks` are assertions and never go to the decider. Inputs (`inputs:`) declare names such as `phone`, `password`;
their values come from `.env`/the environment, never from the plan.

```bash
reflex plan validate plans/settings/open_battery.plan.md
```
```
✓ settings_open_battery: 2 legs, 1 row(s)
```

## 5. Run it

```bash
reflex run plans/settings/open_battery.plan.md --serial emulator-5554 --no-jev --screenshots fail
```
`--no-jev` means no decider: a leg that no known case or rule can finish stops as `needs_agent` instead of asking a model. A passing run prints
`✓ leg 1 [L0] core/home → core/battery: arrived` lines, writes `reports/<runId>/index.html` and exits 0 (1 fail/blocked/error, 3 needs_agent).
The last stdout line is always one `REFLEX_JSON {…}` marker.

If a leg stops, `reports/<runId>/` has the screenshot and `resume.json`; fix the knowledge (a missing case, a wrong `identify`, a popup rule) and continue with `reflex resume <runId>`.

## 6. Watch it learn

Run the plan a few times, then:

```bash
reflex stats
```
```
runs: 6
pass rate: 100.0%   straight-through (no decider action): 100.0%   needed an agent: 0.0%
decider calls: 0   est. cost: $0.0000   avg duration: 10.1s
```
```bash
reflex knowledge review --app settings --status all
```
```
4 of 4 item(s) for app "settings" (status: all)
  core/battery  case to core/home  [verified]  ok 6 / fail 0, streak 6, last ok 2026-10-05
  …
```
A case starts `draft`, becomes `verified` after 3 passing runs in a row and drops back to `learned` on a failure; a learned case that fails twice in a row is removed.
When a decider is configured it can propose a step on an unknown screen; its choice becomes a `learned` case only if the leg then passed, and the dismissal of a dialog that
looks like an error is never learned. `reflex knowledge review --app <key>` (default status `review`) lists what a human should look at.

## 7. System windows (share sheet, permission dialogs, pickers)

agent-device cannot snapshot a window that is not the app (errors such as "insufficient foreground app content" / "only non-application windows"). reflex then reads the screen with
`adb shell uiautomator dump` (Android only) and presses by the centre of a node's box. You write such a screen like any other:

```yaml
---
id: system/chooser
identify:
  allText: [Share with, JUST ONCE]
inputs: []
---
```
Verified: with the share sheet open (`adb shell am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT hello`),
`reflex screen identify --app settings` answers `screen: system/chooser`. Switch the fallback off with `createDeviceBackend({ systemUiFallback: false })`.

## Traps found while doing this

- **Never `launch: fresh` on a system app.** It clears the app's data container.
- `screen capture` does not launch the app, and copies volatile text (battery %, storage used) into the body and a guessed `identify`: always rewrite `identify`.
- Row titles are localized: knowledge written for English fails on another language. Prefer test ids (`anyId`) when the app has them.
- The package pins `agent-device 0.21.12`; a newer global `agent-device` makes the shared daemon restart when the two are used alternately. Harmless, just slower.
- `reflex doctor` lists `REFLEX_TEST_PHONE` / `REFLEX_TEST_PASSWORD` as warnings when unset; they are informational and only matter for plans that log in.
- `blocked` is an environment problem (maintenance, out of stock, UAT down), `fail` is a bug or a wrong expectation. Do not turn a real error into a dismiss rule.
- The agent never types credentials: plans that log in are started by a human or CI (see `AGENTS.md`).
