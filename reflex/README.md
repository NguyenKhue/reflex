# reflex (package `reflex-test`)

Runs agent-authored test plans (`*.plan.md`, a chain of screen legs) on a real device or emulator through
[agent-device](https://github.com/callstack/agent-device). How to cross each screen lives in the workspace's per-screen
knowledge base (`screens/`); a decider (Jev from TypeSafe, optional) handles only what the knowledge base does not cover, and a
confident, successful choice is learned back into it. See the repository `README.md` and `docs/reflex/` for the full picture.

## Install

```bash
npm ci --prefix reflex          # Node >= 22.12; agent-device and @typesafe-ai/sdk are optional dependencies
cp workspace/.env.example workspace/.env   # only plans that log in need an account
npm test --prefix reflex        # no device needed
```

Workspace resolution (first hit wins): `--workspace <dir>` → `REFLEX_PROJECT_DIR` → `~/.reflex/app-testing/js_repo.txt` → walk up from the
current folder for `reflex.workspace.json` → a sibling `workspace/`. The CLI then loads `<workspace>/.env` (shell variables win).

## Commands

```
reflex — run agent-authored app flow plans on agent-device (decider fallback)

Usage: reflex <command> [options] [--workspace <dir>] [--json]

  doctor [--platform android|ios] [--serial s]        toolchain, device, agent-device, Jev key, workspace
  context build --app <key> --src <app source dir>    source hints → screens/<app>/_app/source/
  context show --app <key>                            app notes + screens (case counts) + plans
  plan validate <plan>                                check a flow plan and its screens without touching the device
  run <plan> [--case id] [--serial s] [--platform p] [--app pkg]
             [--screenshots all|fail|none] [--no-jev] [--jev-threshold n] [--no-learn] [--run-id id] [--max-jev-calls n] [--agent]
  resume <runId> [--plan p] [--agent]                continue a run that stopped with needs_agent (from its leg)
  --agent                                             mark the caller as an agent: refuse plans/resumes that would enter credentials (always on for the MCP server)
  snapshot [--serial s] [--platform p] [--app key]    visible texts on the device now
  screen capture --as <group/screen> --app <key> [--serial s] [--platform p]   snapshot → draft screen.md
  screen list --app <key>                             screens of an app + case counts by status
  screen identify --app <key> [--serial s] [--platform p]   which screen the device shows now
  stats [--plan name] [--platform p] [--since date]    pass / straight-through / decider-call rates from the run ledger
  knowledge review --app <key> [--status review|all|learned|draft|verified]   cases and rules the runner learned, with their counters
  app init <key> --package <android package> [--activity a] [--bundle-id <ios id>]   register a new app: manifest entry + screens/<key>/_app/
  supervise <plan> [run options] [--agent-cmd "<cmd>"] [--agent-env A,B] [--max-rounds n] [--no-resume] [--agent-timeout-min n] [--agent]
             run; on needs_agent hand the run to an agent command, keep its knowledge edits provisional
  supervise approve|reject|status <runId>             a human keeps (approve) or undoes (reject) what the agent changed
  hygiene scan [--root dir] [--rules a.json,b.json] [--no-defaults]   find internal hosts, tokens, keys, secret literals and real-looking phone numbers before sharing
  version                                             print the reflex version, the plugin contract version and the Node version (also: --version)
  explore --app <key> --goal "<english goal>" [--inputs '{"name":"value"}'] [--max-steps 20]
  mcp                                                 MCP server on stdio

A plan is a chain of screen legs (at → to); how to walk each screen lives in
screens/<app>/ of the workspace. Exit codes: 0 pass/ok, 1 fail/blocked/error/invalid, 3 needs_agent.
```

Every command prints exactly one `REFLEX_JSON {…}` line on stdout (human text goes to stderr). Exit codes: 0 pass/ok, 1 fail/blocked/error/invalid/refused, 3 needs_agent.

## Scripts

| Script | What |
|---|---|
| `npm test` | the test suite (no device) |
| `npm run typecheck` | checks `types/plugins.d.ts` and the contract examples with `tsc` |
| `npm run hygiene` | `reflex hygiene scan` over the whole repository: must report 0 findings before anything is shared |
