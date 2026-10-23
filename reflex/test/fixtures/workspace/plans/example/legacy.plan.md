---
name: legacy_steps
app: example
goal: "A plan written in the old step format"
steps:
  - tool: launch_app
    args: { relaunch: true }
---
Old-format plan: `steps:` is rejected by the loader.
