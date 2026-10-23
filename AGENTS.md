# AGENTS.md — reflex

Guidance for coding agents (Claude Code, Codex, …) working **on** this repository. Humans: see `README.md`.

## START HERE (every new session)

1. Read `docs/reflex/STATUS.md` — where the work stands, what is next, open questions. It is the source of truth.
2. Read `docs/reflex/DESIGN.md` — the target architecture and the decisions already made (do not re-litigate them).
3. Open the plan named in STATUS (`docs/superpowers/plans/…`) and continue at the first unchecked task.
4. When you finish a task or learn something durable, update STATUS (see "Keeping the handoff current").

Do not rely on conversation memory from an earlier session: if it is not in `docs/reflex/`, it is lost.

## What this is

**reflex** is a framework for agentic mobile test automation: a plan is a chain of screen legs (`at → to`); a
per-app **knowledge base** says how to get across each screen; a runner drives a real device; when a screen is
unknown a **decider** (today Jev, TypeSafe System One) picks ONE action from a closed set and, when it works, the
runner **learns** it so the next run needs no decider. The architecture is a set of plugins behind small contracts
(`docs/reflex/DESIGN.md`); the design of the knowledge base and the leg loop is in `docs/reflex/KNOWLEDGE.md`.

| Path | Role |
|---|---|
| `reflex/` | the code (Node CommonJS), package `reflex-test`, bin `reflex` |
| `workspace/` | the workspace: manifest `reflex.workspace.json`, `screens/`, `plans/`, `reports/`, `.env` (never copy values) |
| `docs/reflex/` | STATUS, DESIGN, ROADMAP, DELEGATION, ADD_AN_APP, SUPERVISION, CONTRACTS, VERSIONING, SHARING — the handoff set |
| `docs/superpowers/plans/` | implementation plans, one per phase |

Code layout (`reflex/src/`): `cli/` (commands, doctor, stats, knowledge review, app init), `core/` (contracts, registry, built-in plugins),
`device/` (agent-device backend, `uiautomator` fallback, tool vocabulary, screen state), `hygiene/` (scanner), `jev/` (decider client and the action set),
`mcp/` (stdio server), `metrics/` (run ledger), `plan/` (loader, validation, data), `report/` (HTML report), `runner/` (`run.js`, the leg loop `flow.js`, recipes, status),
`screens/` (knowledge store, matching, learning, writer, stats), `supervisor/` (sensitivity, handoff, knowledge snapshot, `supervise`), `util/` (workspace, env, markers, version).
The rules below hold unless DESIGN.md says otherwise.

## Commands

```bash
npm ci --prefix reflex          # Node >= 22.12
npm test --prefix reflex        # node:test, no device needed. 2026-10-06: 499 tests, 498 pass, 1 skipped
npm run typecheck --prefix reflex   # plugin types (types/plugins.d.ts)
npm run hygiene --prefix reflex     # must report 0 findings before anything is shared
```

## Rules (inherited, still binding)

- The leg loop is the contract: snapshot → identify → exception → arrived? (`checks`) → known case → decider.
  `checks`/`verify` never go to the decider. A decider "arrived" is only a claim; `identify` decides.
- The decider never generates text. Fills carry an input NAME; values are looked up in-process.
  Passwords, PINs, OTPs, tokens, typed values never reach the decider state, traces, reports, `resume.json`,
  `status.json`, logs or committed screen files.
- Knowledge is learned only from legs that passed; `_shared` and `pinned` are never written by the runner.
- Identity / face / eKYC verification is never automated.
- Credentials, API keys and OTP tokens come from env or a gitignored `.env`; never committed, never printed.
- Code style: CommonJS, 2-space indent, single quotes, semicolons, English comments that explain WHY.
- Every CLI command prints exactly one JSON marker line on stdout (`REFLEX_JSON` today, `REFLEX_JSON` after T6;
  both accepted) and exits 0 pass / 1 fail|blocked|error|invalid / 3 needs_agent.

## Safety boundaries for the agent (user decision, applies to every session)

- The agent never enters credentials, passwords, PINs or OTPs, and never starts a run/replay that does. A human or
  CI starts those runs; the agent reads `reports/<runId>/` and fixes knowledge afterwards.
- Never confirm a payment or an agreement. Never change device system settings without asking.
- Since Phase 4 the tool enforces the first rule for agent callers: MCP `run_start`/`resume_start` and CLI `--agent` refuse plans and resumes with sensitive legs (`requires_human:`), and `reflex supervise` gives the agent a scrubbed environment (details: `docs/reflex/SUPERVISION.md`). The guard cannot stop a process that calls the CLI without `--agent`: that stays a rule the agent follows.
- See `~/.claude/rules/mobile-device-loop.md` for driving a device with agent-device / the `android` CLI.

## Version control

There is **no git repository** (user decision 2026-10-05: the project is the user's own and starts from a clean
slate). Consequences:
- Before a risky or delegated edit, take a baseline copy and diff afterwards:
  `rsync -a --exclude node_modules ./ <scratchpad>/reflex-base/` … then `diff -ru <scratchpad>/reflex-base . -x node_modules`.
- Ask the user before running `git init`; a fresh history is fine once they agree.
- Before any public release run `npm run hygiene --prefix reflex` (it must report 0 findings) and read `docs/reflex/SHARING.md`.

## Delegating to opencode

See `docs/reflex/DELEGATION.md` (free model only, code-only prompts, the main session runs the one test pass).

## Keeping the handoff current

After every task: tick it in the plan, then update `docs/reflex/STATUS.md` (Done / Next / Decisions / Open
questions / Test baseline). A session that ends without updating STATUS has lost its work.
