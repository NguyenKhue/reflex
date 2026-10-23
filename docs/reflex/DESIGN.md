# reflex — design

Date: 2026-10-05. Status: draft for Phase 1. Source of the current behaviour: `docs/upstream/` and the code in
`reflex/src/`. This document says what changes; behaviour not mentioned here must stay as it is.

## Goal

An app-agnostic framework for agentic mobile test automation: the core (runner, knowledge store, plan,
report) knows nothing about a particular app, backend, account system or decision model; everything app- or
vendor-specific is a **plugin** behind a small contract, selected by configuration.

## Architecture

```
core (no app knowledge)
  Runner      leg loop: identify → exception → arrived? → known case → decider → needs_agent
  Knowledge   screens/<app>/…  (screen.md, normal.yml, exceptions.yml); learn, demote, lifecycle
  Plan        load, validate, per-row data
  Report      status.json, resume.json, HTML report, "Knowledge changes", metrics ledger
plugins (selected by config, created through the registry)
  device      DeviceBackend     agent-device (today) | mock | other
  decider     Decider           Jev (today) | other model | fixed rules | none
  account     AccountProvider   env/.env (today) | vault | API
  otp         OtpProvider       a provider you write (none built in) | none
  reporter    Reporter          local HTML (today) | upload | chat notification
  extractor   ContextExtractor  Kotlin source hints (today) | other languages | none
shell
  CLI (run / validate / screen capture / doctor)   MCP server (run_start, run_status, resume_start, …)
```

Seams that already exist in the code (Phase 1 formalises them, it does not invent them):
- `runner/run.js defaultDeps`: `createBackend`, `createJev`, `createSession`, `print`.
- `device/deviceTools.js createDeviceSession({ otpProvider })`.
- `jev/resolver.js askOnce({ jev, … })` and `jev/jevClient.js createMockJev` (a stand-in with the same `ask`).
- `device/deviceBackend.js createMockBackend` (a stand-in with the same methods).

## Contracts (Phase 1 task T1 implements these as `src/core/contracts.js`)

All plugin instances are plain objects; a contract is the set of required methods. `assertContract(kind, obj)`
throws a clear error naming the missing methods.

| kind | required methods | notes |
|---|---|---|
| `device` | `open`, `resetApp`, `snapshot`, `press`, `fill`, `scroll`, `back`, `screenshot`, `close`, `meta` | optional: `swipe`, `clearLogcat`, `readLogcat`. Matches `createDeviceBackend` / `createMockBackend`. |
| `decider` | `decide` | `decide({ state, instruction, options })` → `{ choice, confidence, usage?, latency_ms?, model? }`. `options` is `{ <actionId>: <description> }`. Jev is adapted in T3 (`ask` → `decide`). |
| `account` | `get` | `get(name, { platform, plan, row })` → string or undefined. Names today: `phone`, `password`, `pin`. |
| `otp` | `getOtp` | `getOtp(phone)` → Promise<string>. Same call as today's `otpProvider`. |
| `reporter` | `report` | `report(summary, { reportDir })` → Promise<void>. |
| `extractor` | `extract` | `extract({ rootDir })` → Promise<object>. Optional kind. |

`secretKeys`, redaction and the "values never reach the decider" rules stay in core and apply to every plugin.

## Registry (T2: `src/core/registry.js`)

`createRegistry()` → `{ register(kind, name, factory), has(kind, name), create(kind, name, options), list(kind) }`.
`create` calls the factory, validates the result with `assertContract`, and fails with a clear message for an
unknown kind or name. `src/core/builtins.js` registers the built-ins (`device:agent-device`, `device:mock`,
later `decider:jev`, `otp:uat-api`, …). Config (workspace manifest) selects plugins by name:
`{ "plugins": { "device": "agent-device", "decider": "jev" } }` — absent means today's defaults, so existing
workspaces keep working unchanged.

## Decisions (made 2026-10-05; defaults, the user may change them — record any change here)

| # | Decision | Why |
|---|---|---|
| D1 | Keep **Node CommonJS + JSDoc typedefs + contract tests** for now; decide on TypeScript at Phase 5. | The code works (299 tests); a language migration now would stall the real work. Contracts + tests give most of the safety. |
| D2 | **Personal project** of the user. The core must stay free of any one app's internals; an app is a set of knowledge files and, when needed, plugins. | User decision 2026-10-05 ("pet project"). |
| D3 | Name **reflex**. Package `reflex-test` (free on npm 2026-10-05), bin `reflex`. **Done (T6).** | Tests that build reflexes: ask once, then run straight. |
| D4 | Env prefix `REFLEX_*` (accounts: `REFLEX_TEST_*`; workspace: `REFLEX_PROJECT_DIR`, `REFLEX_HOME`). **Done.** | One consistent prefix, no aliases (D12). |
| D5 | No git history. Ask before `git init`. | User decision; the project starts from a clean slate. |
| D6 | The agent never starts runs that enter credentials; a human/CI does. Legs that use secret inputs are marked so a supervisor never auto-resumes them. | Safety boundary, see AGENTS.md. |
| D7 | Build against a **second real app** (Phase 3) before freezing any contract. | Contracts drawn without a second app will be wrong. Phase 1 contracts are explicitly "v0". |
| D8 | The project stays **personal** until the user decides to share (Phase 5 made it shareable, it shared nothing). | D2; `SHARING.md` is the checklist. |
| D9 | **No git** for now; `git init` only after a clean `reflex hygiene scan`. | D5 and the user's "bỏ git đi". |
| D10 | **TypeScript: stay JavaScript.** Plugin authors get `reflex/types/plugins.d.ts` and `npm run typecheck`; revisit only if contract churn or a second author makes a migration pay off. | 9,000+ tested lines work; types give most of the benefit at a fraction of the risk. |
| D12 | **Hard cut: nothing of the original app is kept** (knowledge, names, hosts, accounts, labels, legacy aliases). A scanner rule guards it. | User decision 2026-10-06; `docs/superpowers/plans/2026-10-06-phase-6-remove-the-original-app.md`. |
| D11 | **Versioning:** semver, `0.x` until the contracts freeze; package `0.5.0`, `CONTRACT_VERSION` `0.1.0`, a plugin may declare `contractVersion` (a different MAJOR is refused). | `VERSIONING.md`, `CONTRACTS.md`. |

## Hygiene before sharing

Run `npm run hygiene --prefix reflex` (it must report 0 findings) and follow `docs/reflex/SHARING.md`. Internal hosts, accounts and product text are not defaults anywhere in the code: the report-upload endpoint comes from
`REPORT_UPLOAD_URL` or the manifest, the report brand from `report.brand`, accounts from `.env`.

## Non-goals (for now)

Appium support, a GUI, cloud device farms, TypeScript, publishing to npm.
