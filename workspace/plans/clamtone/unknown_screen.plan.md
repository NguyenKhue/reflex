---
name: clamtone_text_size
app: clamtone
platforms: [android]
goal: "Open the Text size setting from the You tab and come back (read-only, nothing is changed)"
request: "Open Text size in ClamTone and go back"
status: draft
inputs: []
options: { legTimeoutMs: 120000, stepTimeoutMs: 70000 }
start: { launch: fresh }
flow:
  - { at: main/onboarding, to: main/listen }
  - { at: main/listen, to: main/you }
  - { at: main/you, to: main/text_size }
  - { at: main/text_size, to: main/you }
---

# ClamTone — Text size (the screen is NOT in the knowledge base on purpose: the run must stop with needs_agent)
