---
name: legacy_use
app: example
goal: "A plan that reuses a block"
flow:
  - at: core/home
    to: core/login
    steps:
      - { use: example/otp_login, params: { phone: "{phone}" } }
---
Old-format plan: `use:` blocks are rejected by the loader.
