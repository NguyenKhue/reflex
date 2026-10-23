# settings — notes

The stock Android Settings app (`com.android.settings`), used as reflex's second, unrelated app.

- No login, no account: a test needs nothing from `.env`.
- READ-ONLY plans only: open a screen, read it, go back. Never toggle a switch, never change a value.
- Never use `start.launch: fresh` (it wipes the app's data container: a system change). Use `relaunch`.
- Rows are found by their visible title text (no test ids). Titles are localized: this knowledge is written for English.
- Subtitles under a row change with device state (battery %, storage used): never use them in `identify`.
