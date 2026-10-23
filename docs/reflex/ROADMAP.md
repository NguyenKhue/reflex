# reflex — roadmap

Each phase ends with working, tested software (`npm test` green) and an updated `STATUS.md`.
Detailed task lists live in `docs/superpowers/plans/`; later phases are outlined here and get a plan when they start
(re-read the code first: it will have changed).

| Phase | Goal | Plan | State |
|---|---|---|---|
| 0 | Clone, baseline, handoff docs | — | done 2026-10-05 |
| 1 | Contracts + registry + rename (no behaviour change) | `2026-10-05-phase-1-contracts-and-registry.md` | done 2026-10-05 (T1–T6) |
| 2 | Measure and protect learning | `2026-10-05-phase-2-measure-and-protect-learning.md` | done 2026-10-05 (T1–T5) |
| 3 | A second real app + "add an app" docs + system-UI fallback | `2026-10-05-phase-3-second-app-and-system-ui.md` | done 2026-10-05 (T1–T4) |
| 4 | Supervised recovery (agent/CI loop around `needs_agent`) | `2026-10-05-phase-4-supervised-recovery.md` | done 2026-10-06 (T1–T6) |
| 5 | Hygiene, TypeScript decision, versioning | `2026-10-06-phase-5-hygiene-and-versioning.md` | done 2026-10-06 (T1–T6) |

## Phase 1 — contracts and registry (no behaviour change)
T1 contracts, T2 registry + built-ins + wiring `run.js`, T3 `Decider` (Jev behind `decide`), T4 `AccountProvider`
(`resolveRowData` account fallback), T5 `OtpProvider` + `Reporter` split out of `report.js`, T6 rename
(`REFLEX_*`, `reflex` bin, marker, folder). Exit: all 299 baseline tests still pass, plus new contract tests.

## Phase 2 — measure and protect learning
- **Run ledger:** one JSON record per run (pass-straight rate, decider calls, `needs_agent` count, duration, cost);
  `reflex stats` summarises. Without numbers nobody can tell whether it improves.
- **Learning gate:** a learned case becomes trusted only after N clean runs (or a human approves); a confident but
  wrong decision must not become permanent knowledge.
- **Popup-vs-error corpus:** fixture screens for dismiss-safe popups and for real errors that must `fail`; tests
  prove the exception rules and the decider cannot "heal" a real error.

## Phase 3 — a second real app, and system UI
- Pick a simple second app (login + a couple of screens), write its screens/plans, find what is still shaped by one app.
- Docs: "add an app in N steps". `extractor` for another language, or none.
- System-UI fallback: share sheet / pickers / permission dialogs are invisible to `agent-device snapshot`
  ("insufficient foreground app content", screenshots empty); read them via `android layout --no-idle` (all windows).

## Phase 4 — supervised recovery
- Mark legs/inputs as **sensitive**; the supervisor never auto-resumes a sensitive leg.
- A wrapper that, on exit code 3, hands `resume.json` + report to an agent session, collects the knowledge diff
  and waits for human approval before it becomes permanent.

## Phase 5 — hygiene and decisions
Remove the original app's internals from core, TypeScript yes/no, version the plugin contracts, optional `git init`.

## Phase 6 — remove everything that belongs to the original app
User decision 2026-10-06 (D12): nothing of the original app stays. Plan: `docs/superpowers/plans/2026-10-06-phase-6-remove-the-original-app.md`.
Done 2026-10-06: all tasks complete (files deleted with the user's approval, OTP client removed, guard rule active).
