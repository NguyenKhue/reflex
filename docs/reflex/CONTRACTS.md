# Where each plugin contract stands (contract version 0.1.0)

Written 2026-10-06 from what the code and the runs actually did, not from what was intended. "Exercised" means a real run, not only a test with a mock.
Types for authors: `reflex/types/plugins.d.ts`. Required methods: `reflex/src/core/contracts.js`. Freeze criteria: `VERSIONING.md`.

| Kind | Required methods | Built-ins | Exercised for real | Verdict |
|---|---|---|---|---|
| `device` | `open`, `resetApp`, `snapshot`, `press`, `fill`, `scroll`, `back`, `screenshot`, `close`, `meta` (optional: `swipe`, `clearLogcat`, `readLogcat`) | `agent-device` (Android and iOS in one backend, with the `uiautomator` fallback for system windows), `mock` | the Android **Settings** app on an emulator (Phase 3) and the earlier app-specific runs of the original authors | **v1 candidate.** The shape held through the system-window fallback. Open questions: `press` takes four target forms (node, ref string, `{selector}`, `{x,y}`); `fill` is one key at a time by design. Needs a second unrelated app on a physical device before it is called frozen. |
| `decider` | `decide` | `jev` (adapter over the Jev client) | only through mocks in this repository; the Settings runs never needed a decider (0 calls) | **v0, stays.** One real implementation. Freeze needs a second one, for example a rules-based decider or another model. |
| `account` | `get` | `env` (`REFLEX_TEST_*`, then the manifest) | plans that log in (the original authors); Settings needs no account | **v0, stays.** One provider; the "which names" question (`phone`, `password`, `pin`) is shaped by one kind of app. |
| `otp` | `getOtp` | none (the service client of the original app was removed in Phase 6) | no | **v0, a placeholder.** Write a provider for your service; a second app with an OTP is needed to learn what is generic. |
| `reporter` | `report` | `upload`, `google-chat` (thin wrappers over `report.js`) | **Never in a pipeline here**: `report.js` `uploadReport` / `notifyGoogleChat` have no callers in the runner | **v0, unproven.** Either wire them into `run`/`supervise` as optional steps or drop the kind before 1.0. |
| `extractor` | `extract` | none registered (the Kotlin hints in `context/extractKotlin.js` are not behind the contract) | no | **v0, a placeholder.** Implement the Kotlin extractor behind it or remove the kind. |

## Reading the table
- Only `device` has earned a "v1 candidate". Do not freeze anything else on the strength of tests with mocks.
- The contract tests (`reflex/test/core/*.test.js`) pin the shapes; `reflex/types/check.ts` pins them for TypeScript authors, including the errors a wrong plugin must produce.
- What is still shaped by one kind of app, even after Phase 6: the `phone` / `password` / `pin` input names assumed by `account`, and the `fill_otp_from_api` tool (an OTP typed from an API-provided code).
