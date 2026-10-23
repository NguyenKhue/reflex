---
name: bad_plan
app: example
platforms: [ios]
goal: "Break every rule"
inputs: [phone]
start: { launch: fresh }
flow:
  - { at: core/home, to: core/ghost }
  - { at: core/login, to: core/password }
  - at: core/password
    to: core/home
    data: { nope: 1 }
    steps:
      - { tool: jev_recover, args: { goal: "x" } }
      - { tool: nope }
      - intent: "Do something vague"
      - { tool: tap_text, args: { text: "{ghost}" }, colour: red, expect: { text: "a", absent: "b" } }
    checks:
      - { tool: fill, args: { index: 0, text: "{phone}" }, expect: { text: "Tiếp tục" } }
verify:
  - { intent: "x" }
---
| id | phone | email |
|---|---|---|
| a | 1 | x |
| a | 2 | y |
