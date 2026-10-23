---
name: settings_open_battery
app: settings
platforms: [android]
goal: "Open the Battery screen of Settings and come back to the main list (read-only)"
request: "Open Battery in Settings and go back"
status: draft
inputs: []
start: { launch: relaunch }
flow:
  - { at: core/home, to: core/battery }
  - { at: core/battery, to: core/home }
verify:
  - { tool: assert_text, args: { text: "Network & Internet", exact: true, timeout: 5000 } }
---

# Settings — open Battery and back

Read-only navigation: nothing is toggled. `launch: relaunch` restarts the app without wiping its data (never `fresh` for a system app).
