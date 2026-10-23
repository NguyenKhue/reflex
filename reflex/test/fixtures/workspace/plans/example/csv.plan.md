---
name: csv_plan
app: example
goal: "Open the app"
inputs: [phone]
start: { launch: relaunch }
flow:
  - { at: core/home, to: core/login }
---
@data: data/rows.csv
