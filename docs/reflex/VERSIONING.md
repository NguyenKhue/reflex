# Versioning

reflex has two version numbers, on purpose.

| What | Where | Today |
|---|---|---|
| **Package version** (the tool, its CLI, its file formats) | `reflex/package.json`, `reflex version`, `CHANGELOG.md` | `0.5.0` |
| **Contract version** (the plugin interfaces: `device`, `decider`, `account`, `otp`, `reporter`, `extractor`) | `CONTRACT_VERSION` in `reflex/src/core/contracts.js`, `reflex version` | `0.1.0` |

`reflex version` (or `reflex --version`) prints both, and the Node version: `reflex 0.5.0 (contracts 0.1.0, node v22.23.2)`.

## Package version: semver, with the usual 0.x caveat

- `0.MINOR.PATCH` until the contracts are frozen. While the major is 0, a MINOR release may change behaviour or a file format; the change is written under **Changed** or **Deprecated** in `CHANGELOG.md`.
  A PATCH release only fixes bugs.
- `1.0.0` is declared when the contracts are frozen (below) and the legacy names are gone.
- Every release: tests green (`npm test --prefix reflex`), `npm run typecheck --prefix reflex`, `npm run hygiene --prefix reflex` at 0 findings, a `CHANGELOG.md` entry whose heading is the new version
  (a test fails if the changelog's top heading and `package.json` disagree), `package.json` and `package-lock.json` bumped together.

## Contract version

- A plugin MAY declare `contractVersion: '<major>.<minor>.<patch>'`. When it does and its MAJOR differs from `CONTRACT_VERSION`'s, creating it fails with
  `<kind> plugin targets contract <declared> but this reflex provides <CONTRACT_VERSION>`, before any run starts. A plugin that declares nothing is accepted.
- Bump the contract MINOR for an addition (a new optional method), the MAJOR for a break (a renamed or removed required method, a changed meaning). While the major is 0 nothing is promised; a plugin written today may need a change.
- `reflex/types/plugins.d.ts` mirrors the contracts for TypeScript authors; a test fails if it drifts from `contracts.js`.

### When do the contracts freeze (`1.0.0`)?

All of these (see `CONTRACTS.md` for where each kind stands today):
1. every kind that ships a built-in has been exercised end to end by two unrelated apps;
2. `decider` has a second real implementation (not only Jev), `reporter` and `otp` have run in a real pipeline, `extractor` is either implemented behind the contract or removed;
3. the types and the contract tests describe exactly the same thing, and no breaking change was needed for one full phase.

## Deprecation

Nothing is deprecated today: version 0.5.0 carries no legacy aliases (D12). From now on a name or format that is going away is announced under **Deprecated** in `CHANGELOG.md`, keeps working, and is removed no sooner than the next MINOR release.

## Dependencies

- `agent-device` is pinned to an exact version. Raise it only after the full suite AND a live run on an emulator or device (Phase 4 showed that unit tests do not see daemon behaviour).
- `typescript` is a dev-only dependency used by `typecheck`; nothing at run time needs it.
- No new runtime dependency without a decision recorded in `DESIGN.md`.
