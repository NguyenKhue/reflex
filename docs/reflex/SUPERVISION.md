# Supervised recovery

What happens when a run stops with `needs_agent`, and how reflex keeps an agent useful without letting it near credentials.
Verified on 2026-10-05 on an Android 8.1 emulator with the Settings app (see `ADD_AN_APP.md`); the commands and outputs below are real unless marked "example".

## The rule, and where the tool enforces it

**An agent never enters a password, PIN, OTP or any credential, and never starts a run or resume that does.** A human or CI starts those runs.
Since Phase 4 the tool itself refuses, for callers that identify as an agent:

| Caller | How it identifies | What is refused |
|---|---|---|
| MCP tools `run_start`, `resume_start` | always an agent (they spawn the CLI with `--agent`) | a plan with a sensitive leg; a resume whose remaining legs are sensitive |
| CLI `reflex run … --agent`, `reflex resume … --agent`, `reflex supervise … --agent` | the flag | the same |
| CLI without `--agent` | a human or CI | nothing: secrets come from that person's environment |

Refusals use the status `refused` (exit code 1) and an error starting with `requires_human:`, for example
`requires_human: plan "p" has sensitive leg(s) 2 that enter credentials; start it yourself or from CI: reflex run <plan file>`.
They happen BEFORE any report folder, device session or knowledge write exists.

**Limit, stated honestly:** this is a guard for callers that say they are agents (MCP, `--agent`). It cannot stop a process that simply calls the CLI without the flag; for an
agent such as Claude Code that remains a rule it follows (`AGENTS.md`), now backed by the MCP guard for the tools it is given.

## Which legs are sensitive

`reflex plan validate <plan>` prints `sensitive: { sensitive, legs: [{ index, at, to, reasons }] }`. A leg is sensitive when:

| Reason | Meaning |
|---|---|
| `explicit` | the leg has `sensitive: true` in the plan |
| `own-steps` | the leg's own `steps`/`checks` use a `{password}`-like placeholder (an input marked `secret: true`, or `password`, `pin`, `otp`) |
| `screen-input:<id>` | a screen on a known path from `at` to `to` (the destination excluded) declares a secret input |
| `case-step:<id>` | a known case on that path types a secret placeholder |
| `unknown-route` | no known path from `at` to `to` and the plan declares a secret input (a decider or an agent would choose the route) |
| `screen-name` | `at` is a screen named like `…pin`, `…password`, `…otp`, `…passcode` |

A leg that only ARRIVES at a credential screen is not sensitive; the next leg, which types there, is. Mark anything the analysis cannot see with `sensitive: true`:

```yaml
flow:
  - { at: core/payment_confirm, to: core/payment_result, sensitive: true, intent: "Confirm and pay" }
```

When a run stops, `resume.json` records `sensitive: { remaining: [...], blocksAgent }` for the legs from the stopped one to the end.

## The handoff

On `needs_agent` reflex writes `reports/<runId>/handoff.json` and `handoff.md`: where it stopped (leg, screen, reason), the public text on screen (editable fields are never
included, at most 40 lines), what the agent may do (fix the app's knowledge under `screens/<app>/`), what it must not do (credentials, `_shared`, pinned items, earlier legs),
and how to continue: `reflex resume <runId> --agent` when no remaining leg is sensitive, otherwise "ask the human or CI". Only fields that are already safe in `resume.json`
are copied; captures and data never are.

## `reflex supervise`

For a human or CI. It runs the plan; when the run stops for an agent it hands over, keeps the agent's knowledge edits provisional, and resumes:

```bash
reflex supervise plans/settings/network_only.plan.md --serial emulator-5554 --no-jev \
  --agent-cmd "node /path/to/agent-script.js" --agent-env ANTHROPIC_API_KEY
```
Options: `--agent-cmd "<shell command>"` (without it the run stops as `awaiting_agent` after writing the handoff), `--agent-env A,B` (extra variables the agent may inherit),
`--max-rounds n` (default 2), `--no-resume`, `--agent-timeout-min n` (default 30), `--agent` (treat the supervisor itself as an agent: apply the guards above), plus the usual run options.

What it does, in order: run (a child process) → on `needs_agent`, snapshot `screens/<app>/` and `screens/_shared/` into `reports/<runId>/knowledge-before/` → write the handoff →
run the agent command in the workspace folder with `REFLEX_HANDOFF`, `REFLEX_RUN_ID`, `REFLEX_REPORT_DIR` set → diff the knowledge → `resume` (a child process) → repeat up to `--max-rounds`.
Run and resume are separate processes on purpose: that is what a human or CI does.

**The agent never inherits your environment.** Its environment is `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TERM`, `TMPDIR`, `ANDROID_SERIAL`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`,
the three `REFLEX_*` variables, and whatever you name in `--agent-env`. So `REFLEX_TEST_*`, `TYPESAFE_API_KEY` and OTP tokens in your shell or `.env` cannot reach it. An agent CLI that
needs its own API key gets it only if you list it. (Tested with a real child process: a secret set in the parent is not visible to the agent command.)

### States (`reports/<runId>/supervisor.json`)

| State | Meaning | Exit code |
|---|---|---|
| `finished` | the run ended without a stop and nothing is pending | the run's |
| `awaiting_agent` | stopped, no `--agent-cmd`; handoff written, snapshot taken | 3 |
| `awaiting_approval` | the agent changed knowledge and a human has not approved it yet; `runStatus` says how the run ended | the run's |
| `no_change` | the agent ran but changed nothing | 3 |
| `max_rounds` | still stopped after `--max-rounds` agent rounds | 3 |
| `rejected_forbidden` | the agent touched `screens/_shared/` (policy): everything of that round was restored | 1 |
| `agent_failed` / `agent_timeout` | the agent command exited non-zero / ran past its timeout | 1 |
| `error_no_resume` | the run stopped but wrote no `resume.json` | 1 |
| `approved` / `rejected` | after a human step | — |

A real run (stand-in agent that adds the missing case; the first resume hit an agent-device timeout and was retried, see below):

```
supervise: run settings_network_only_20261006_001007 is awaiting_approval (run status: pass, 1 agent round(s), 1 knowledge change(s))
REFLEX_JSON {"ok":true,"runId":"…","state":"awaiting_approval","runStatus":"pass","rounds":1,"changed":[{"file":"screens/settings/core/home/normal.yml","kind":"modified","forbidden":false}],…}
```
`reports/<runId>/knowledge-diff.md` holds the diff (`diff -u` with `before/…` and `after/…` labels).

### Approve or reject

```bash
reflex supervise status  <runId>    # status: run <runId> is awaiting_approval
reflex supervise approve <runId>    # approve: run <runId> is approved      (the snapshot is dropped, the edits stay)
reflex supervise reject  <runId>    # reject: run <runId> is rejected       (screens/<app>/ and _shared restored byte for byte, files the agent added are removed)
```
Doing either twice is an error: `run "<id>" is "approved", not awaiting_approval` / `run "<id>" has no knowledge snapshot to restore (state: rejected)`.
Until a human decides, the agent's edits are ACTIVE (the resume needs them) but provisional; one snapshot is taken before the first agent edit, so a rejection undoes every round.
The per-machine counters in `.agentic/stats.json` are not part of the snapshot.

## Wiring a real agent

The agent command is any shell command that reads `$REFLEX_HANDOFF`, edits files under `screens/<app>/` and exits 0. Example (NOT verified in this repo; adapt to your agent CLI):

```bash
reflex supervise plans/x.plan.md --serial <s> --agent-cmd 'claude -p "Read $REFLEX_HANDOFF and fix the knowledge it describes. Follow its rules." --permission-mode acceptEdits' --agent-env ANTHROPIC_API_KEY
```
In CI run `reflex supervise` as a normal step (secrets from the CI secret store), keep `reports/` as artifacts, and gate a merge or a deploy on `reflex supervise approve <runId>` being run by a person.

## Verified with a real agent (2026-10-06)

`reflex supervise` with `claude -p` as the agent, Android emulator, Settings plan `open_battery` with the battery→home case removed: the run stopped with `needs_agent`, the agent read `handoff.md` and re-added only that case (`status: draft`, nothing outside `screens/settings/`), the resume (retried once after a daemon timeout) passed, state `awaiting_approval`; `supervise reject` restored the snapshot. Note: the snapshot is taken when the run stops, so rejecting restores the knowledge as it was THEN (here the deliberately broken file), not the file as it was before you broke it.

## Known issues

- **agent-device daemon timeouts.** On the Android 8.1 emulator, a reflex process that started soon after another reflex process often failed its first request with `Daemon request timed out` (about 2.5 minutes, then
  the next attempt worked). `supervise` therefore retries a resume that ends with exactly that error: `resumeRetries` (default 2) after `resumeRetryDelayMs` (default 15000). Any other error is a verdict and is not retried.
  Not seen on the physical phone; aligning the package's `agent-device` pin with the global CLI (now both 0.21.20) did not remove it.
- A rejected or approved run cannot be undone; keep `reports/` if you need an audit trail.
- The sensitivity analysis is static: it cannot see credentials typed by a plan-specific step through a path the knowledge base does not describe (`unknown-route` covers the common case; `sensitive: true` covers the rest).
