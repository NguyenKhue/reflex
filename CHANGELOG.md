# Changelog

All notable changes to reflex. Versions follow `docs/reflex/VERSIONING.md` (semver, `0.x` until the plugin contracts freeze).

## 0.5.0 — 2026-10-06 (Phases 1–6)

### Fixed
- The leg loop no longer wanders: it tries a one-hop case that does not go straight to the destination only when the known cases can still reach the destination from there. Before, a leg with no known route walked through unrelated tabs and stopped far from where it started (found on ClamTone).
- `doctor` no longer asks for an OTP token.

### Removed (Phase 6, decision D12 — a hard cut)
- Everything of the app this project was derived from: its knowledge, plans, reports, docs, the OTP service client (`otp:uat-api` is no longer registered; a run that needs an OTP passes an `otp` plugin), the legacy bin alias, manifest name, environment names, marker, state folder and pointer folder. Fixtures and examples use a fictional brand. A scanner rule keeps the old name out.


### Added
- **Plugin architecture** (Phase 1): contracts and a registry for `device`, `decider`, `account`, `otp`, `reporter`, `extractor`; Jev behind the `decider` contract; env-based account provider (`REFLEX_TEST_*`, `LEGACY_TEST_*` as fallback);
  OTP and report upload/chat as plugins; the tool is `reflex` (package `reflex-test`), with `old-tool` kept as an alias; marker `REFLEX_JSON` (the old `the old marker name` is still parsed).
- **Measure and protect learning** (Phase 2): run ledger (`.agentic/runs.jsonl`) and `reflex stats`; `reflex knowledge review`; popup-vs-error fixtures; error-looking dialogs are never learned as dismiss rules.
- **Second app and system windows** (Phase 3): `reflex app init`; the Android Settings app as a second, unrelated app; a `uiautomator` fallback for windows agent-device cannot see (share sheet, permission dialogs); `docs/reflex/ADD_AN_APP.md`.
- **Supervised recovery** (Phase 4): sensitive-leg analysis, the tool-enforced agent boundary (`--agent`, MCP), handoff documents, knowledge snapshot/diff/restore, `reflex supervise [approve|reject|status]`; `docs/reflex/SUPERVISION.md`.
- **Hygiene and versioning** (Phase 5): `reflex hygiene scan` with generic and per-project rules; `reflex version`; a contract version checked when a plugin declares one; plugin type declarations (`types/plugins.d.ts`) and `npm run typecheck`.

### Changed
- No internal host is a default in code any more: the OTP service URL and the report upload endpoint come from the environment or the manifest only; the HTML report header/footer and logo come from `report.brand` (neutral by default).
- The shared test account was removed from the workspace manifest; put your own in `.env`.
- Real-looking phone numbers in tests and old documents were replaced by obvious fakes.
- `agent-device` pinned at 0.21.20 (was 0.21.12).

### Deprecated (still working; removal is announced in a later minor release)
- `LEGACY_TEST_*` environment names, `LEGACY_PROJECT_DIR` / `LEGACY_JS_REPO` / `LEGACY_HOME`, the `old-tool` bin, `legacy.workspace.json`, the `the old marker name` marker, `~/.legacy/…`, the `legacy-state` state folder.
