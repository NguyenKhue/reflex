---
name: example_login_basic
app: example
platforms: [android]
goal: "Sign in to the example app and reach the password screen"
request: "test cho tôi luồng login"
status: draft
inputs:
  - { name: phone, required: true }
  - { name: password, required: true, secret: true }
start: { launch: relaunch }
flow:
  - { at: core/home, to: core/password, intent: "Sign in with phone, OTP and password" }
verify:
  - { tool: assert_text, args: { text: "Nhập mật khẩu", exact: true, timeout: 5 } }
---
# Login

| id | phone | password |
|---|---|---|
| r1 | 0900000003 | 111111 |
| r2 | 0900000002 | {env:FIXTURE_PASSWORD} |
