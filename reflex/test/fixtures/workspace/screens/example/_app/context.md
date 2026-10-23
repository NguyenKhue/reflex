# Example app (fixture) — the app reflex's own tests drive.

The device fixture (`test/fixtures/screens.js`) renders exactly the texts these screens
identify on, so a leg can walk it without a real device.

- Signed-out Home shows "Acme Example" and the "Đăng nhập" button; Home → login is one hop.
- The login screen asks for the phone ("Số điện thoại", one editable field) and continues with
  "Tiếp tục"; a trusted device can land on the password screen directly.
- Phone and password come from the plan's data rows — never from a knowledge file.
- The environment can show a maintenance screen: that is BLOCKED, not FAIL (`_app/exceptions.yml`).
