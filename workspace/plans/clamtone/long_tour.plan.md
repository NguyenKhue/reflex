---
name: clamtone_long_tour
app: clamtone
platforms: [android]
goal: "Walk all four tabs of ClamTone three times in different orders, ending on Listen (read-only)"
request: "Long tab tour of ClamTone"
status: draft
inputs: []
options: { legTimeoutMs: 120000, stepTimeoutMs: 70000 }
start: { launch: fresh }
flow:
  - { at: main/onboarding, to: main/listen }
  - { at: main/listen, to: main/you }
  - { at: main/you, to: main/journal }
  - { at: main/journal, to: main/nights }
  - { at: main/nights, to: main/listen }
  - { at: main/listen, to: main/journal }
  - { at: main/journal, to: main/you }
  - { at: main/you, to: main/nights }
  - { at: main/nights, to: main/you }
  - { at: main/you, to: main/listen }
  - { at: main/listen, to: main/nights }
  - { at: main/nights, to: main/journal }
  - { at: main/journal, to: main/listen }
verify:
  - { tool: assert_text, args: { text: "Start the match", timeout: 5000 } }
---

# ClamTone — long tab tour (all known cases: expect 13 legs at L0, no decider)
