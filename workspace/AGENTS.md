# AGENTS.md — viết và chạy test bằng `reflex`

Workspace này là nơi agent (Claude Code, Codex, …) biến một yêu cầu tự nhiên như
"mở màn Pin trong app Cài đặt rồi quay lại" thành **plan** (chuỗi chặng màn hình), rồi chạy plan đó trên thiết
bị thật bằng tool `reflex` (agent-device + bộ quyết định, hiện là Jev). Kiến thức "làm sao đi qua từng màn" nằm trong `screens/`,
dùng chung cho mọi plan và được runner **tự học thêm** mỗi khi Jev xử lý được một tình huống mới.

`reflex` bên dưới = `node ../reflex/bin/reflex.js` khi chạy từ thư mục workspace này (hoặc
`npm link` trong `reflex/` một lần). Không gán lệnh vào biến shell (`$MT`) — zsh không tách từ.

```bash
node ../reflex/bin/reflex.js doctor --platform android   # Node ≥ 22.12, adb/device, agent-device, .env
```

MCP (tuỳ chọn): `claude mcp add reflex -- node <abs>/reflex/bin/reflex.js mcp` — tool `context_show`,
`plan_validate`, `snapshot`, `screen_capture`, `screen_identify`, `run_start` + `run_status` (poll), `resume_start`.

## Bố cục

| Đường dẫn | Nội dung |
|---|---|
| `reflex.workspace.json` | `apps.<key>` (package/activity/bundleId), `defaults.platform`, `report.brand` / `report.uploadUrl` (tuỳ chọn). Không để tài khoản hay URL nội bộ ở đây |
| `.env` (gitignored) / `.env.example` | `REFLEX_TEST_PHONE`, `REFLEX_TEST_PASSWORD`, `REFLEX_TEST_PIN`, `JEV_CONFIDENCE_THRESHOLD` (0.75), `TYPESAFE_API_KEY`, `REPORT_UPLOAD_URL`. Biến shell thắng `.env`. `REFLEX_TEST_PHONE_ANDROID` / `_IOS` (và `PASSWORD_*`, `PIN_*`) thắng biến chung: chạy Android + iOS cùng lúc phải khác tài khoản, không thì đăng nhập bên này đá phiên bên kia |
| `screens/_shared/exceptions.yml` | luật cho mọi app, kiểm **đầu tiên** (eKYC/khuôn mặt → FAIL). Chỉ sửa tay |
| `screens/<app>/_app/` | `context.md` (ghi chú app), `exceptions.yml` (popup cấp app), `routes.yml` (máy ghi), `source/` (gợi ý từ `context build`) |
| `screens/<app>/core/<screen>/` | màn của app chủ: `screen.md`, `normal.yml`, `exceptions.yml`, `history.yml` |
| `screens/<app>/<miniapp>/_miniapp/` | `context.md`, `exceptions.yml` chung của mini app (vd `payments`) |
| `screens/<app>/<miniapp>/<screen>/` | màn trong mini app |
| `plans/<app>/*.plan.md` | plan = chuỗi chặng màn hình; `status: passed` khi đã PASS live |
| `reports/<runId>/` | report.html, status.json, resume.json, screenshots (gitignored) |

Screen id có dạng `<group>/<screen>`, `group` là `core` hoặc tên mini app: `core/home`, `core/battery`, mini app: `payments/confirm`.

### Một màn hình

- **`screen.md`**: front-matter `id`, `identify`, `inputs`. Thân là mô tả cho agent và Jev (≤ ~80 dòng).
  ```yaml
  ---
  id: core/home
  identify:                    # tất cả điều kiện có mặt phải đúng; so fold dấu, contains
    anyId: ["searchBar"]       # test ID (identifier hoặc node text dạng btn_continue) — ổn định nhất
    allText: ["Giao dịch", "Ưu đãi"]
    # anyText: [...]           # ít nhất một
    # noneText: [...]          # không được có (phân biệt màn giống nhau / popup vẽ đè)
  inputs: [phone]              # TÊN input màn này nhận (không phải giá trị)
  ---
  ```
  Không dùng text hay đổi (placeholder xoay vòng, lời chào theo giờ, số dư, ngày giờ) làm `identify`.
- **`normal.yml`**: case **một bước** sang màn kế tiếp. Nhiều case cùng `to` được phép. Runner thử theo thứ tự
  `verified` → `learned` → `draft`.
  ```yaml
  - to: core/login_method        # màn NGAY SAU, không bao giờ xa hơn
    intent: "Enter the phone number and continue"
    steps:                        # DSL tool của reflex (tap_text, fill, wait_text, …)
      - { tool: fill, args: { index: 0, text: "{phone}" } }
      - { tool: tap_text, args: { text: "btn_continue", exact: true } }
    waitMs: 25000                 # tuỳ chọn: màn sau tới chậm (backend)
    status: verified              # draft | learned | verified
  ```
- **`exceptions.yml`**: tình huống không phụ thuộc màn đích.
  ```yaml
  - id: otp_resend_popup
    when: { allText: ["Bạn chưa nhận được mã OTP?"] }   # anyId | allText | anyText | noneText
    do: { tap: "Huỷ" }            # đúng một: tap | back | retry {wait,max} | fail | blocked
  ```
  `fail` = bug hoặc kỳ vọng sai. `blocked` = môi trường (UAT lỗi, hết hàng, bảo trì), không phải bug.
  Exception được kiểm theo tầng: `_shared` → màn → `_miniapp` → `_app`.

### Plan

```yaml
---
name: settings_open_battery
app: settings
platforms: [android]
goal: "Open the Battery screen of Settings and come back to the main list (read-only)"   # tiếng Anh, cho bộ quyết định
request: "mở màn Pin trong app Cài đặt rồi quay lại"
status: draft                                               # passed sau khi PASS live
inputs: []                                                  # plan có đăng nhập thì khai báo: { name: password, required: true, secret: true }
start: { launch: relaunch }      # fresh = xoá data app (KHÔNG dùng cho app hệ thống; iOS: chỉ simulator) | relaunch | attach
flow:
  - { at: core/home, to: core/battery }                     # một chặng có thể đi qua nhiều màn
  - at: core/battery
    to: core/home
    checks:                      # assertion trên màn `to` — không bao giờ lên bộ quyết định
      - { tool: assert_text, args: { text: "Network & Internet", exact: true } }
verify:
  - { tool: assert_text, args: { text: "Network & Internet", exact: true, timeout: 5000 } }
---
```

Mỗi chặng có thể có `intent`, `data` (ghi đè giá trị row cho riêng chặng đó), `checks`, và `steps` (thao tác
riêng của plan, chạy thay `normal.yml`, không được học). `at` của chặng sau phải bằng `to` của chặng trước.
Thiếu cột data thì lấy lần lượt từ `{env:VAR}`, `.env` (`REFLEX_TEST_PHONE/PASSWORD/PIN`), rồi `defaults.account` của manifest (chỉ giá trị không nhạy cảm).

## Quy trình khi nhận yêu cầu test

1. **Xác định app + phạm vi.** App là key trong `apps` của `reflex.workspace.json` (vd `settings` = package
   `com.android.settings`; thêm app mới bằng `reflex app init`). Yêu cầu mơ hồ thì hỏi người dùng. Nhiều tính năng thì mỗi tính năng một plan.
2. **Tìm plan có sẵn** trong `plans/<app>/`. Có plan phù hợp thì chạy luôn (bước 6).
3. **Phác thảo chặng**, tham khảo plan đã có. Ví dụ: Home → Pin → quay lại Home. `reflex context show --app <key>` liệt kê màn và plan đã có.
4. **Màn đã có** trong `screens/` thì dùng lại nguyên vẹn. **Màn thiếu** thì tạo màn `draft`:
   - Đưa app tới màn đó (chạy plan tới chặng trước, hoặc thao tác tay), rồi
     `reflex screen capture --as <group>/<screen> --app <key> --serial <s>`. Lệnh ghi `screen.md` với text
     và test ID thật (đã lọc riêng tư) làm gợi ý `identify`.
   - Sửa `identify` cho chắc (ưu tiên test ID; thêm `noneText` nếu giống màn khác), viết `normal.yml` với
     case `status: draft` đoán từ màn đã chụp hoặc từ source app.
   - Mini app mới thì thêm `screens/<app>/<miniapp>/_miniapp/context.md`.
   - Kiểm tra: `reflex screen identify --app <key> --serial <s>` phải ra đúng màn đang đứng.
5. `reflex plan validate plans/<app>/<slug>.plan.md`, sửa tới khi ok.
6. `reflex run plans/<app>/<slug>.plan.md --serial <s> --screenshots fail --json` rồi đọc dòng
   `REFLEX_JSON`. Exit: `0` pass, `1` fail/blocked/error/invalid, `3` needs_agent.
7. **Báo cáo**: status từng row (`pass`/`fail`/`blocked`/`needs_agent`), chặng dừng + lý do, `captures`, số
   lần gọi Jev, mục **"Knowledge changes"** (case/rule đã học, lên hạng, hạ cấp, gỡ) và đường dẫn report.
   Nhắc người dùng xem lại phần đã học bằng `reflex knowledge review --app <key>` trước khi tin nó.
8. Plan PASS live và người dùng muốn giữ thì đặt `status: passed`.

### Runner làm gì ở mỗi chặng (tool tự làm)

Mỗi vòng: snapshot → **nhận diện màn** → **exception** khớp thì xử lý → **đã tới `to`** thì chạy `checks` và
xong chặng → **case đã biết** của màn hiện tại thì chạy rồi đợi màn đổi → không có case thì **hỏi Jev** một
action (bấm / điền input theo TÊN / cuộn / back, hoặc verdict `arrived` / `fail` / `blocked`).

- Jev có confidence ≥ `JEV_CONFIDENCE_THRESHOLD` (mặc định 0.75, `--jev-threshold` để đổi) thì runner làm luôn.
  Chặng qua được thì cách làm đó được **lưu thành case `learned`** (hoặc exception `learned` nếu là đóng popup).
  Lần sau chạy thẳng, không cần Jev.
- Case `learned`/`draft` đúng 3 lần liên tiếp thì lên `verified`. `learned` sai 2 lần liên tiếp thì bị gỡ (vào
  `history.yml`). `verified` sai thì hạ xuống `learned`. `pinned: true` và `_shared` không bao giờ bị đổi.
- Jev không đủ tự tin, hết ngân sách, lặp action, hoặc màn không nhận diện được → dừng `needs_agent`.
- `--no-learn`: chạy mà không ghi gì vào `screens/` (CI, debug).

### Khi run trả `needs_agent` (exit 3)

Chặng `k` không vượt được. Session thiết bị vẫn giữ nguyên.

1. Đọc `reports/<runId>/resume.json` (`legIndex`, `screen` nhận diện được, lỗi, text đang hiện) và
   `reflex screen identify --serial <s>` / `reflex snapshot --serial <s>`.
2. Sửa **knowledge** (`identify` sai, case thiếu hoặc sai, exception thiếu) hoặc sửa chặng `k` trở đi của plan.
   Sửa chặng trước `k` thì resume bị từ chối (`resume_prefix_changed`), phải chạy lại từ đầu.
3. `reflex resume <runId>`. Tối đa 2 lần resume cho một chặng, sau đó dừng và hỏi người dùng.
4. `resume_lost_app` (app đã chết hoặc không còn foreground) thì chạy lại từ đầu.

## Luật bắt buộc

- Gặp xác thực tài khoản / khuôn mặt / eKYC / CCCD → **FAIL case ngay**, không bao giờ tự làm eKYC.
- Không bịa OTP, mật khẩu, token. OTP lấy bằng `fill_otp_from_api`; thiếu token thì hỏi người dùng.
- Không commit account thật, `TYPESAFE_API_KEY`, token. Account và token nằm trong `.env` (gitignored).
- Giá trị input (SĐT, mật khẩu, OTP), số tiền, token **không bao giờ** được ghi vào `screens/`, plan, report hay
  gửi cho Jev. Case dùng placeholder `{phone}`; `fill` học được không ghi `label` (trên Android nhãn của ô nhập
  chính là giá trị).
- Không đổi dữ liệu test để "cho qua" (hết mệnh giá 100k thì không tự chọn 50k): đó là `blocked`.
- So sánh số tiền, ngày, bộ đếm bằng `capture_*` + `assert_value` trong `checks`/`verify`, không giao cho Jev.
- `goal`/`intent` viết tiếng Anh; text trên màn hình giữ nguyên tiếng Việt trong `args` / `identify` / `when`.
- Back hệ thống có thể thoát app: runner ưu tiên nút back trong app ("‹", `btn_navigation_back`).
- iOS: simulator (`--platform ios --udid <sim>`, `fresh` xoá data container của app) hoặc máy thật (không có
  `fresh`, dùng `relaunch`/`attach`); prompt passcode là việc của người. Chạy iOS với `--no-learn` cho tới khi case
  của màn đã chạy được trên iOS (case trượt trên iOS sẽ hạ cấp case của Android). `identify` nên có test ID dùng
  chung hai nền tảng: tiêu đề nhiều màu và ô Compose trên iOS không lộ text; ô Compose điền bằng `fill` + `label`
  (placeholder).
