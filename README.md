# reflex

**Agentic mobile test automation that learns its own reflexes.**

You describe a test as a chain of screens. `reflex` drives a real Android device or emulator through it with
[agent-device](https://github.com/callstack/agent-device). Each screen knows how to recognise itself, how to get to the
next screen and which popups to dismiss. When it meets something it has not seen, a **decider** (an LLM) picks **one
action from a closed set**; if that action works, reflex writes it into the knowledge base, so the next run goes straight
through without asking anyone.

```
request ─▶ agent ─▶ plan ─▶ runner ─▶ device
                              │ known screen ─▶ run the known case          (L0, cheap, deterministic)
                              │ popup/error  ─▶ apply the exception rule    (L1)
                              │ unknown      ─▶ decider picks 1 action ─▶ learned into the screen   (L2)
                              └ stuck        ─▶ stop (needs_agent) ─▶ agent fixes knowledge ─▶ resume (L3)
```

The goal is simple: most runs finish at **L0**, with no model call at all. The model is the fallback, not the engine.

## Why

Scripted UI tests are brittle (one moved button breaks them) and "let an LLM drive the app" tests are slow, expensive and
non-deterministic. reflex splits the problem:

- a **plan** says *where to go* (`at → to`), never *what to tap*;
- a per-app **knowledge base** says how to cross each screen, and is shared by every plan;
- a **runner** executes the knowledge deterministically and only asks a model when the knowledge runs out;
- what the model does successfully is **learned**, promoted after repeated passes and demoted when it stops working.

## Features

- **Plans as screen legs.** `flow: [{ at: home, to: search }, { at: search, to: results }]`; the route between two screens
  can span several known hops.
- **Self-identifying screens.** `identify` blocks match on visible text, test IDs, and negative text, so look-alike screens
  and stacked mini-app screens can be told apart.
- **A learning knowledge base.** Cases move `draft → learned → verified` (3 passes in a row) and drop back on failure; a
  case that fails twice is removed. Learning only comes from legs that passed.
- **Exception rules** for popups and errors: `tap`, `back`, `retry`, `fail` (a real bug) or `blocked` (an environment problem).
- **A closed action set for the decider.** It chooses an action id; it never generates text. Values to type are looked up
  by input *name* in-process.
- **Pluggable deciders.** TypeSafe's Jev (needs your own key) or any free `opencode/*-free` model through the bundled
  `opencode` decider (`REFLEX_DECIDER=opencode`).
- **Supervised recovery.** On `needs_agent`, `reflex supervise` hands the run to an agent command, keeps its knowledge
  edits provisional, resumes, and lets a human `approve` or `reject` the changes.
- **A raw look when stuck.** If every case failed, the runner takes one full (uncollapsed) accessibility tree so rules and the
  decider can see nodes the default tree hides (for example a debug panel covering a button).
- **Device tools for awkward UIs:** `tap_text`, `fill` (with a fast `bulk` mode), `tap_within` / `swipe_within` (by fraction of
  an element, for canvases and web views), `scroll`, `wait_text`, assertions, and more.
- **Reports, run ledger and stats.** An HTML report per run, `reflex stats` for pass rate, straight-through rate and decider cost.
- **An MCP server** (`reflex mcp`) so an agent can start runs and read results.
- **A hygiene scanner** (`reflex hygiene scan`) that finds internal hosts, tokens, keys, secret literals and phone numbers
  before you share a repository.

## Safety model

These rules are enforced by the tool where possible and are part of the design:

- The agent **never enters credentials, passwords, PINs or OTPs**, and never starts a run that does. Secrets come from the
  environment or a gitignored `.env`; they never reach the decider, traces, reports or committed knowledge files.
- `reflex run --agent` (and the MCP tools) **refuse plans with sensitive legs** (`requires_human:`).
- A payment or an agreement is **never confirmed automatically**; plans stop on the screen before it.
- Identity / face / eKYC verification is never automated.
- The decider acts only above a confidence threshold (default `0.75`) and only from a closed set of actions.

## Quick start

Requirements: Node.js ≥ 22.12, `adb` on your `PATH`, and an Android device or emulator.
`agent-device` is installed as an optional dependency.

```bash
npm ci --prefix reflex
npm test --prefix reflex                 # unit tests, no device needed

# run the bundled, read-only example (the Android Settings app) on an attached device or emulator
cd workspace
node ../reflex/bin/reflex.js doctor --platform android
node ../reflex/bin/reflex.js run plans/settings/open_battery.plan.md --no-jev
```

`--no-jev` means "no decider": a leg that no known case can finish stops as `needs_agent` instead of asking a model.
Every command prints one `REFLEX_JSON {...}` line and exits `0` (pass), `1` (fail / blocked / error) or `3` (needs an agent).

## What a plan and a screen look like

A plan (`workspace/plans/settings/open_battery.plan.md`):

```yaml
---
name: settings_open_battery
app: settings
platforms: [android]
goal: "Open the Battery screen of Settings and come back to the main list (read-only)"
start: { launch: relaunch }
flow:
  - { at: core/home,    to: core/battery }
  - { at: core/battery, to: core/home }
verify:
  - { tool: assert_text, args: { text: "Network & Internet", exact: true, timeout: 5000 } }
---
```

A screen (`workspace/screens/settings/core/home/screen.md`) says how to recognise itself, and its `normal.yml` says how to
leave it:

```yaml
- to: core/battery
  intent: "Open the Battery screen"
  steps:
    - { tool: tap_text, args: { text: "Battery", exact: true } }
  status: verified
```

To add your own app, register it with `reflex app init <key> --package <android.package>` and follow
[`docs/reflex/ADD_AN_APP.md`](docs/reflex/ADD_AN_APP.md) (capture screens, write cases, write a plan, run it, watch it learn).

## Commands

| Command | What it does |
|---|---|
| `reflex doctor` | check Node, adb/device, agent-device, decider key and the workspace |
| `reflex run <plan>` | run a plan on a device |
| `reflex resume <runId>` | continue a run that stopped with `needs_agent` |
| `reflex supervise <plan>` | run; on `needs_agent` hand over to an agent, then `approve` / `reject` its edits |
| `reflex plan validate <plan>` | check a plan and its screens without touching a device |
| `reflex screen capture / identify / list` | build and check screen knowledge from a live device |
| `reflex app init <key> --package <id>` | register an app |
| `reflex knowledge review --app <key>` | list what the runner learned, with counters |
| `reflex stats` | pass rate, straight-through rate, decider calls and cost from the run ledger |
| `reflex hygiene scan` | find secrets and internal details before sharing |
| `reflex mcp` | MCP server on stdio |

## Repository layout

| Path | Role |
|---|---|
| `reflex/` | the code (Node.js, CommonJS), package `reflex-test`, bin `reflex` |
| `reflex/src/runner/` | the run and the leg loop (`flow.js`): snapshot → identify → exception → arrived? → known case → decider |
| `reflex/src/screens/` | knowledge store, matching, learning |
| `reflex/src/device/` | the agent-device backend, device tool vocabulary, screen state |
| `reflex/src/jev/` | decider clients (Jev, opencode) and the closed action set |
| `reflex/src/supervisor/` | handoff, knowledge snapshot, `supervise` |
| `workspace/` | a workspace: manifest, `screens/`, `plans/`, `reports/`, `.env` (never committed) |
| `docs/reflex/` | design and handoff docs |

## Documentation

| Doc | What |
|---|---|
| [`docs/reflex/DESIGN.md`](docs/reflex/DESIGN.md) | architecture, extension points, decisions |
| [`docs/reflex/KNOWLEDGE.md`](docs/reflex/KNOWLEDGE.md) | the per-screen knowledge base and the leg loop |
| [`docs/reflex/ADD_AN_APP.md`](docs/reflex/ADD_AN_APP.md) | add an app step by step |
| [`docs/reflex/SUPERVISION.md`](docs/reflex/SUPERVISION.md) | the agent boundary, handoff and approval flow |
| [`docs/reflex/CONTRACTS.md`](docs/reflex/CONTRACTS.md) | where each plugin contract stands |
| [`docs/reflex/VERSIONING.md`](docs/reflex/VERSIONING.md) | package vs contract versions |
| [`docs/reflex/STATUS.md`](docs/reflex/STATUS.md) | current state and next steps |
| [`docs/reflex/SHARING.md`](docs/reflex/SHARING.md) | the checklist before sharing a workspace |

## Status

Early (version 0.5.0). Android is the exercised platform; iOS code paths exist but are less tested. The plugin
contracts (`device`, `decider`, `account`, `otp`, `reporter`, `extractor`) are v0 and not frozen. See `CHANGELOG.md`.

## Notes on dependencies and keys

- Jev is a vendor service from TypeSafe: using it needs **your own** `TYPESAFE_API_KEY` (set it in `workspace/.env` or the
  environment; never commit it). Without a key, reflex runs fine with `--no-jev` or with the free opencode decider.
- The `opencode` decider only accepts models named `opencode/<name>-free`.

## Licence

No licence has been chosen yet, so by default all rights are reserved. Add one before reusing or redistributing the code.
