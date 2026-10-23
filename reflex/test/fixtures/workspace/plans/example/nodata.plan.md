---
name: no_data
app: example
goal: "Open the app"
inputs:
  - { name: phone, required: true }
  - { name: pin }
  - { name: mode, default: "fast" }
options: { legTimeoutMs: 30000 }
start: { launch: attach }
flow:
  - at: core/home
    to: core/login
    intent: "Open the login screen"
---
No data table: this plan runs one implicit row (`default`).
