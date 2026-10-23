# Before you share reflex

Nothing here has been published or shared. This is the checklist for the day you decide to (D8: it stays a personal project until you say otherwise). Phases 5 and 6 did the parts that can be automated.

## 1. The scan (automated)

```bash
npm run hygiene --prefix reflex          # = node reflex/bin/reflex.js hygiene scan --root ..
```
It must say `hygiene: 0 finding(s)`. It looks for private IPv4 addresses, JWTs, private-key blocks, AWS key ids, quoted literals after `password` / `pin` / `token` / `api key` / `secret`, plausible Vietnamese mobile numbers, and the guard rule that fails
when the name of the app this project was derived from comes back (contents and file names). A finding never prints what it matched: only `file:line:column rule`.
Accepted exceptions live in the `allow` lists of `reflex/hygiene.rules.json`, each with a reason; narrow by rule and by directory, never `*` for a whole tree.
Add your own rules in a `hygiene.rules.json` (a rule is `{ id, description, regex, flags?, ignore? }`) and run the scan again after every change you make for sharing.

## 2. What the scan cannot decide (you decide)

| Item | Why it matters | Options |
|---|---|---|
| `docs/superpowers/` plans | the history of how this was built (provenance, mistakes and fixes) | keep (useful), or trim |
| `workspace/screens/settings/` and `plans/settings/` | the public example app (Android Settings, read-only) | keep as the example |
| `.env.example` key names | harmless names | keep |
| Your own plans and screens | they may describe a private app | keep them in a private repository |

## 3. History
There is no git history by design (D5/D9). `git init` only AFTER a clean scan; make the first commit from a tree you have read. `.gitignore` already ignores `node_modules/`, `.env`, `reports/` and media; confirm with `git status` that no `.env` or `reports/` content is staged.

## 4. Licence and packaging (not decided)
- **No licence is chosen.** Choose one before publishing; without it nobody may legally reuse the code. Check the licences and terms of what you depend on: `@modelcontextprotocol/sdk`, `js-yaml`, `yaml`, `agent-device`, and `@typesafe-ai/sdk`
  (an optional, vendor-run service: using Jev needs the user's own TypeSafe key; say so in the README).
- `reflex/package.json` is `"private": true`. To publish: set it to false, re-check that the name `reflex-test` is still free on npm, add a `files` whitelist, and inspect `npm pack --dry-run --prefix reflex`.
- Run, in order: `npm test --prefix reflex`, `npm run typecheck --prefix reflex`, `npm run hygiene --prefix reflex`, then update `CHANGELOG.md` and bump the version together (`VERSIONING.md`).

## 5. Things you still have to do yourself
Pick the licence; decide what is shared (section 2); write a README for strangers; test a fresh checkout on a clean machine (`npm ci`, `npm test`, `reflex version`) and one real run on a device you do not own.
