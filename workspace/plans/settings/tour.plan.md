---
name: settings_tour
app: settings
platforms: [android]
goal: "Visit Network & Internet and Battery from the main list and return each time (read-only)"
request: "Walk through two Settings screens and come back"
status: draft
inputs: []
start: { launch: relaunch }
flow:
  - { at: core/home, to: core/network }
  - { at: core/network, to: core/home }
  - { at: core/home, to: core/battery }
  - { at: core/battery, to: core/home }
verify:
  - { tool: assert_text, args: { text: "Connected devices", exact: true, timeout: 5000 } }
---

# Settings — tour of two screens

Read-only. Four legs, each a single known hop, so a healthy run asks the decider zero times.
