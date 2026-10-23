---
name: clamtone_tabs_tour
app: clamtone
platforms: [android]
goal: "From the first-run screen reach the Listen tab, visit Nights, Journal and You, and come back to Listen (read-only)"
request: "Tour the four tabs of ClamTone"
status: draft
inputs: []
options: { legTimeoutMs: 120000, stepTimeoutMs: 70000 }
start: { launch: fresh }
flow:
  - { at: main/onboarding, to: main/listen }
  - { at: main/listen, to: main/nights }
  - { at: main/nights, to: main/journal }
  - { at: main/journal, to: main/you }
  - { at: main/you, to: main/listen }
verify:
  - { tool: assert_text, args: { text: "Start the match", timeout: 5000 } }
---

# ClamTone — tab tour

Read-only: nothing is saved, no sound is started. `launch: fresh` clears the app's own data to show onboarding.
