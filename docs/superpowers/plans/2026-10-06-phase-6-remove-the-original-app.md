# reflex Phase 6 — remove everything that belongs to the original app — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans, or hand a task to opencode via `docs/reflex/DELEGATION.md`.

**Goal (user decision 2026-10-06, "nothing related to the original app"):** the project contains no knowledge, name, host, account, flow, label or legacy alias of the app it was derived from. The scanner proves it.

**Decision D12 — a hard cut.** No legacy compatibility is kept: no legacy environment names, manifest file name, marker, state folder, pointer folder or bin alias. Anyone with an old workspace re-creates it with the current names; the original repository (`the original repository`, untouched) is where the old material lives. A fictional brand ("Acme") replaces the old name in test fixtures and in prose that needs an example.

## What was found (2026-10-06)
1,096 mentions in 136 files; 9 paths whose NAME carries the old name; the old HTML reports in `workspace/reports/` carry the old brand in their header.
- **Knowledge and plans of the original app:** `workspace/screens/acme/` (50 files), `plans/acme/` (3), `screens/example/` + `plans/example/` (the original app's example harness), `docs/upstream/` (2), the original tool's design and plan documents under `docs/superpowers/` (3), `workspace/reports/` and `.agentic/` (run artefacts, regenerable).
- **Legacy aliases in code:** `ACME_*` environment names (account provider, `workspace.js`, `doctor`, MCP spawn env), the `legacy.workspace.json` fallback and its `.local` variant, the `the old marker name` marker, the `~/.legacy/` pointer and `legacy-state` state folder, the `old-tool` bin and its shim file.
- **A service client of the original app:** `src/util/otpApi/` (a login-OTP HTTP client with the original service's path and headers), `src/core/otp/uatApi.js` and its registration, the `authOtpApi` manifest section, the OTP token checks in `doctor`.
- **Product-specific text in code:** `report.js` `targetBusinessLabel` / `businessStepTitle` (about 90 lines of Vietnamese labels for the original app's cash-in/out, transfer and top-up flows, and tool names that no longer exist), comments in `deviceBackend.js` and `extractKotlin.js`.
- **Names in tests and fixtures:** the fixture workspace (`legacy.workspace.json`, package `com.acme.example`, `com/acme/...` Kotlin fixture folder), texts such as "Đăng nhập Acme" in about 30 test files.
- **Prose:** README, AGENTS, `docs/reflex/*`, the phase plans, `workspace/AGENTS.md` and `.env.example`.

## Tasks
| # | Task | Who | State |
|---|---|---|---|
| T1 | Delete the trees and artefacts listed above | main session | done (user approved) |
| T2a | Remove every legacy alias from the code and fix the tests that tested them | opencode (edits only) | |
| T2b | Remove the OTP client and its registration | main session | done |
| T2c | Replace the original app's flow labels in `report.js` by generic ones; reword the product comments | opencode (edits only) | |
| T3 | Rename fixtures and test strings to the fictional brand | main session (scripted) | |
| T4 | Sanitise the prose (README, AGENTS, docs, phase plans, workspace docs, `.env.example`) | main session (scripted + reviewed) | |
| T5 | Guard: a scanner rule that fails when the old name reappears, in contents and in file names | main session | |

## Acceptance
`grep -rIil <old name> .` (excluding `node_modules`) prints nothing; `find . -iname '*<old name>*'` prints nothing; `reflex hygiene scan --root .` reports 0 findings with the guard rule active; the suite, `typecheck` and `hygiene` are green.
(The guard rule's pattern is written as a character class so the rule file does not itself contain the name.)

## T2a — spec (legacy aliases out)
`util/workspace.js`: one manifest name (`reflex.workspace.json`), `MANIFEST_LABEL` = that name; `envOf` reads `REFLEX_<name>` only; project-dir variable `REFLEX_PROJECT_DIR` only; pointer file `~/.reflex/app-testing/js_repo.txt` only; `stateDir()` always `<root>/.reflex`; remove `LOCAL_MANIFEST_NAME` and its export; `defaults(platform)` reads `REFLEX_TEST_PHONE|PASSWORD|PIN` (with the `_ANDROID`/`_IOS` suffix first) instead of the old names; header comments.
`util/markers.js`: only `MARKER = 'REFLEX_JSON'` and `parseMarker` for that marker (no legacy marker, no `LEGACY_MARKER` export). `cli/appCommands.js`: `MANIFEST_NAMES = ['reflex.workspace.json']`. `core/accounts/env.js`: comment only (`REFLEX_TEST_*`, then the manifest). `plan/data.js`, `util/env.js`: comments. `cli/doctor.js`: only `REFLEX_TEST_*` names, labels without the old alternative, remove the legacy-manifest check. `mcp/handlers.js`: spawn env `REFLEX_PROJECT_DIR`. `mcp/server.js`, `cli/screenCommands.js`, `plan/validate.js`: messages say `reflex.workspace.json`.
Tests to update: `test/core/rename.test.js` (keep only the cases about the current names: marker, `reflex.workspace.json`, `REFLEX_PROJECT_DIR`, `.reflex` pointer and state folder; delete the legacy cases; rename the file to `workspaceNames.test.js` by creating the new file and emptying the old one is NOT allowed: edit it in place), `test/util/workspace.test.js`, `test/core/envAccounts.test.js`, `test/cli/doctor.test.js`, `test/cli/appInit.test.js` (drop the legacy-manifest case), `test/supervisor/superviseChild.test.js` (drop the legacy-marker case), `test/cli/cli.test.js` and `test/cli/screenCommands.test.js` (`BIN` → `bin/reflex.js`).
## T2c — spec (report labels)
Replace `targetBusinessLabel(target)` by the generic fallback only (quoted text from `text=`/`content-desc=`/`contains(...)`/`[...]`, else the generic sentence) and `businessStepTitle(step, data)` by: `step.title || step.name`, else the label of the target when there is one, else `Thực hiện thao tác “<tool>”`; delete every branch about the original app's flows and tool names. Reword the product-specific comments in `device/deviceBackend.js` and `context/extractKotlin.js` generically. No behaviour change elsewhere.
