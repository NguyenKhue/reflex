# Screen knowledge — chạy test theo màn hình, học case từ Jev

> Thay thế các mục 3 (context pack → interruption), 4 (plan format) và phần L1/L2 của mục 5 trong
> `2026-09-24-old-tool-tool-design.md`. Các phần khác của spec đó (agent-device backend, resume,
> report, privacy, exit code, `the old marker name`) giữ nguyên trừ khi ghi rõ bên dưới.

## Context

`old-tool` hiện chạy plan theo **từng step** viết tay. Chạy thật luồng đăng nhập Acme UAT
(`com.acme.app`) cho thấy:

- Mỗi tính năng mới phải viết lại 15–30 step, không tái dùng được giữa các luồng (login → Home được
  viết lại trong mỗi plan; `blocks/` chỉ giải quyết một phần).
- Tình huống thực tế trên app rất nhiều (popup vân tay, "Bạn ơi, Acme gặp chút lỗi", nút đổi nhãn
  "Đăng nhập"/"Tiếp tục" theo trạng thái, màn giới thiệu quyền thông báo…). Mỗi lần gặp tình huống
  mới, step kẹt → chờ timeout → Jev (L2) sửa, nhưng cách sửa **không được nhớ**: lần sau lại chờ và
  gọi Jev. Một run login mất 86 s vì một step kẹt 47 s; sau khi sửa tay plan còn ~34 s.
- `interruptions.yml` là cấp app, không biết popup đó thuộc màn nào.

Hướng mới: kiến thức được tổ chức **theo màn hình** của từng app / mini app. Mỗi màn biết cách nhận
diện chính nó, các case bình thường để đi sang màn khác và các exception có thể gặp. Plan chỉ là
chuỗi chặng màn hình. Khi gặp tình huống chưa biết, Jev quyết định; quyết định đủ tự tin được lưu lại
vào màn đó, lần sau chạy thẳng không cần Jev.

## Quyết định đã chốt (2026-09-24)

| # | Quyết định |
|---|---|
| 1 | Plan = chuỗi chặng màn hình `at → to`; cách đi qua mỗi màn nằm trong knowledge base của màn đó, dùng chung cho mọi luồng. |
| 2 | Case học từ Jev lưu **nháp** (`learned`), dùng ngay lần sau, tự lên `verified` hoặc tự hạ cấp / gỡ theo kết quả chạy. |
| 3 | Với ngoại lệ, Jev chỉ được **vượt qua giữ nguyên ý định test** (đóng popup, thử lại, quay lại) hoặc **dừng** (`fail` / `blocked`). Không đổi dữ liệu test (hết mệnh giá 100k thì không tự chọn 50k). |
| 4 | Ngưỡng tự tin của Jev mặc định **0.75**, cấu hình được. |
| 5 | Acme là super-app: cấp **mini app** nằm giữa app và màn hình (`mobile_topup` gồm nhiều màn). |
| 6 | Cấu hình phone / password / PIN / ngưỡng / token trong file **`.env`** của workspace. |
| 7 | Đổi tên workspace `acme-app-testing-usecases` → **`workspace`**. |
| 8 | Clean break: bỏ plan dạng `steps:` cấp plan, `blocks/`, `examples/`, `interruptions.yml`, `legacy.workspace.local.json`. |

## Goals

- Viết plan tính năng mới chỉ bằng danh sách chặng màn hình; màn đã có được tái dùng nguyên vẹn.
- Tình huống đã gặp một lần (Jev xử lý đủ tự tin) được xử lý deterministic từ lần sau — không chờ
  timeout, không gọi Jev.
- Case học sai tự hạ cấp / tự gỡ, không lặp lỗi mãi.
- Phân biệt kết quả `fail` (bug / kỳ vọng sai) với `blocked` (môi trường: UAT lỗi, hết hàng).
- Mọi thay đổi knowledge base review được bằng git diff và liệt kê trong report.

## Non-Goals

- Tự khám phá app để dựng toàn bộ đồ thị màn hình.
- Sinh `identify` tự động từ source Kotlin (`context build` chỉ còn là gợi ý cho agent).
- Chia sẻ knowledge base giữa máy ngoài git.
- Jev tự chọn phương án thay thế làm đổi dữ liệu test.
- Tối ưu độ trễ của agent-device (settle, snapshot helper) — việc riêng, không thuộc spec này.

## Design

### 1. Bố cục workspace `workspace/`

```
workspace/
  legacy.workspace.json            # marker + apps + defaults + URL dịch vụ (giữ nguyên)
  .env                           # gitignored — phone, password, PIN, ngưỡng, token
  .env.example                   # committed — khoá rỗng / mặc định
  AGENTS.md                      # quy trình cho agent (viết lại theo spec này)
  screens/
    _shared/exceptions.yml       # mọi app (eKYC/khuôn mặt → fail)
    acme/
      _app/
        context.md               # ghi chú chung app
        exceptions.yml           # popup cấp app (vân tay, lỗi UAT chung…)
      core/                      # màn của app chủ (không phải mini app)
        login_phone/  login_otp/  login_password/  home/
      mobile_topup/              # mini app
        _miniapp/
          context.md             # mini app làm gì, điểm vào, nghiệp vụ
          exceptions.yml         # lỗi chung của mini app
        main/  card_code/  confirm/  result/
    example/
      _app/ …
      core/ …                    # app không có mini app → chỉ có core/
  plans/
    acme/buy_card_code.plan.md
    example/login.plan.md
  reports/<runId>/               # gitignored, như cũ
```

**Screen id** có namespace `<group>/<screen>` trong một app: `core/home`, `mobile_topup/card_code`.
`group` là `core` hoặc tên mini app. Tên thư mục: `[a-z0-9_]+`. Plan luôn thuộc một app (front-matter
`app:`), nên screen id không cần tiền tố app.

### 2. Một màn hình: `screen.md`, `normal.yml`, `exceptions.yml`

**`screen.md`** — front-matter cho máy, thân cho agent (≤ ~80 dòng):

```yaml
---
id: mobile_topup/card_code
identify:
  anyId: ["card_code_tab"]               # test ID (identifier) — ưu tiên, ổn định nhất
  allText: ["Mua mã thẻ"]                # tất cả phải có
  anyText: ["Viettel", "Mobifone"]       # ít nhất một
  noneText: ["Xác nhận thanh toán"]      # không được có (phân biệt màn giống nhau)
inputs: [amount]                         # tên input màn này có thể điền (không phải giá trị)
---
Màn chọn nhà mạng và mệnh giá mã thẻ. Mệnh giá hết hàng hiển thị mờ + "Tạm hết".
```

`identify` khớp khi **mọi** điều kiện có mặt đều đúng (so khớp fold dấu, contains; `anyId` so với
`identifier` của node). Phải có ít nhất một điều kiện. `plan validate` từ chối `identify` rỗng.

**`normal.yml`** — case để đi sang màn khác, khoá theo màn đích:

```yaml
- to: mobile_topup/confirm
  intent: "Pick the denomination from data and continue to payment confirmation"
  steps:
    - { tool: tap_text, args: { text: "{amount_label}", exact: true } }
    - { tool: tap_text, args: { text: "btn_continue", exact: true } }
  status: verified            # draft | learned | verified
  confidence: null            # confidence của Jev khi học (learned)
  learnedFrom: null           # runId
```

- Bộ đếm `stats` (`ok`, `fail`, `streak`, `failStreak`, `lastOk`, `lastFail`) **không** nằm trong file
  màn: chúng đổi sau mỗi run nên hai người chạy cùng plan trên hai branch luôn conflict. Runner ghi
  chúng vào `<workspace>/.agentic/stats.json` (gitignore, riêng từng máy), key
  `<file tương đối workspace>#<merge key>`. File màn chỉ đổi khi `status` đổi. `stats:` còn sót trong
  file cũ được đọc làm giá trị khởi đầu, và bị xoá khi file đó đổi `status`.

- `steps` dùng đúng DSL tool hiện tại (`DEVICE_TOOL_SPECS`, `when`, `saveAs`, `settle`). Giá trị
  bí mật luôn là placeholder `{input}`, không bao giờ là giá trị thật.
- `to` của case luôn là **màn kế tiếp ngay sau** màn này (một bước chuyển màn), không bao giờ là màn
  xa hơn. Case không được trải qua nhiều màn.
- Nhiều case cùng `to` được phép; runner thử theo thứ tự `verified` → `learned` → `draft`, trong
  cùng trạng thái theo `streak` giảm dần.
- Chặng trong plan có thể dài hơn một bước chuyển màn (ví dụ `core/login_phone → core/home` đi qua
  `login_method`, `login_otp`, `login_password`): runner nối các case một-bước bằng `routes` — §4
  bước 4, §5.

**`exceptions.yml`** — tình huống không phụ thuộc màn đích:

```yaml
- id: fingerprint_unlock_offer
  when: { allText: ["Mở khoá bằng vân tay", "ĐỂ SAU"] }   # anyText | allText | anyId | noneText
  do: { tap: "ĐỂ SAU" }        # đúng một: tap | back | retry | fail | blocked
  status: verified
  confidence: null
  learnedFrom: null
```

- `tap: <text|testId>` — bấm rồi nhận diện lại màn.
- `back: true` — back trong app nếu có nút "‹"/`btn_navigation_back`, không thì system back.
- `retry: { wait: 2000, max: 2 }` — đợi rồi chạy lại case bình thường của chặng (lỗi mạng tạm thời).
- `fail: <reason>` — case FAIL (bug hoặc kỳ vọng bị vi phạm).
- `blocked: <reason>` — case BLOCKED (môi trường / dữ liệu: UAT lỗi, hết hàng, bảo trì).

### 3. Tầng exception

Kiểm theo thứ tự, dừng ở rule khớp đầu tiên:

1. `screens/_shared/exceptions.yml` — **luôn đầu tiên**; chứa policy eKYC/khuôn mặt/CCCD → `fail`.
   Rule trong `_shared` không bị runner học/hạ cấp/gỡ (chỉ sửa tay).
2. `exceptions.yml` của màn hiện tại (nếu nhận diện được).
3. `_miniapp/exceptions.yml` của mini app chứa màn hiện tại (hoặc mini app của chặng khi chưa nhận
   diện được màn).
4. `_app/exceptions.yml`.

Exception được kiểm **trước** case bình thường ở mỗi vòng, nên popup che màn (a11y tree chỉ còn popup)
được xử lý trước khi runner kết luận "không nhận diện được màn".

### 4. Runner — chạy một chặng `at → to`

Plan:

```yaml
---
name: buy_card_code
app: acme
platforms: [android]
goal: "Buy a mobile card code with the Acme wallet"
request: "test tính năng mua mã thẻ trên app Acme"
status: draft                        # draft | passed (thay cho promote sang examples/)
inputs:
  - { name: phone, required: true }
  - { name: password, required: true, secret: true }
  - { name: amount_label, required: true }
start: { launch: fresh }             # fresh = pm clear + grant quyền thông báo | relaunch | attach
flow:
  - { at: core/login_phone, to: core/home }
  - { at: core/home, to: mobile_topup/main }
  - { at: mobile_topup/main, to: mobile_topup/card_code }
  - at: mobile_topup/card_code
    to: mobile_topup/confirm
    checks:                          # assertion trên màn `to`, không bao giờ lên Jev
      - { tool: capture_values, args: { … }, saveAs: price }
  - { at: mobile_topup/confirm, to: mobile_topup/result }
verify:
  - { tool: assert_text, args: { text: "Giao dịch thành công" } }
---
| id | amount_label |
|---|---|
| r1 | 10.000đ |
```

`at` của chặng đầu là màn bắt đầu kỳ vọng; `at` của chặng sau phải bằng `to` của chặng trước
(`plan validate` kiểm). Một chặng có thể thêm `steps:` riêng — khi đó runner chạy chúng thay cho
`normal.yml` và **không** học từ chặng đó (dùng cho thao tác đặc thù của một plan).

Vòng lặp mỗi chặng (ngân sách: `legTimeoutMs`, mặc định 60 s; tối đa `maxJevCallsPerLeg`, mặc định 6):

1. **Snapshot + nhận diện.** Ứng viên: `at`, `to`, mọi màn cùng group với `at`/`to`, `core/*`. Kết
   quả: 0 hoặc 1 màn (nhiều màn khớp → chọn màn có nhiều điều kiện `identify` nhất; hoà → coi như 0
   và ghi cảnh báo "identify mơ hồ").
2. **Exception** (§3). Khớp → thực thi `do`. `tap`/`back`/`retry` → về bước 1. `fail`/`blocked` →
   kết thúc case với status tương ứng.
   Chống lặp: rule `tap`/`back` mà vòng ngay sau vẫn khớp lại **chính nó** bị ghi 1 `fail` và **bỏ qua
   tới hết chặng** (rơi xuống các bước sau / Jev). `retry` bị giới hạn bởi `retry.max` tính **cho cả
   chặng** (mặc định 2, trần cứng 3).
3. **Đã ở `to`** → chạy `checks` của chặng → chặng xong.
4. **Ở một màn đã biết `S`** (`at` hoặc màn trung gian — quy tắc giống nhau): danh sách case ứng viên
   = (a) case trong `S/normal.yml` có `to == chặng.to`; rồi (b) case có `to` là **màn ngay sau `S`**
   trên một route đã ghi nhận từ `S` tới `chặng.to` (`routes.yml`, §5); rồi (c) mọi case còn lại của
   `S` có `to` là màn ứng viên của bước 1 và **chưa đi qua** trong chặng này (không bao giờ quay lui),
   ưu tiên `to` cùng group với `chặng.to` trước `core/*`.
   Trong mỗi nhóm sắp theo `verified` → `learned` → `draft`, rồi `streak` giảm dần. Nhờ (c), lần chạy
   đầu của chặng nhiều màn (routes rỗng, kể cả khi `--no-learn`) vẫn đi được bằng case viết tay mà
   không cần Jev. Không có ứng viên → bước 6.
5. **Chạy case** (L0: step deterministic + đợi một màn khác `S` được nhận diện, tối đa 10 s; trong
   lúc đợi, mỗi lần poll cũng kiểm exception — popup xuất hiện thì xử lý ngay, không chờ hết 10 s). Tới
   `to` hoặc màn trung gian đã biết → ghi `ok` → bước 1. Không đổi màn / lỗi tool → ghi `fail`, thử
   case kế tiếp; hết case → bước 6.
6. **Jev.** State gửi Jev (tiếng Anh, không có giá trị input): `goal`, intent chặng (`at → to` +
   `context.md` rút gọn của màn `to`), thân `screen.md` của màn hiện tại (nếu có), lỗi vừa gặp,
   text hiển thị. Tập action: tập đóng hiện tại (press / fill theo TÊN input / scroll / back / wait)
   + verdict `fail`, `blocked`, `arrived` (Jev cho rằng đã tới `to` — chỉ là claim, bước 1 quyết
   định).
   - Gọi Jev **một action mỗi lần** (API `askOnce(state, actions)` tách từ `resolveStep`, không dùng
     vòng lặp nội bộ của resolver): vòng lặp chặng tự nhận diện lại màn sau mỗi action, và tự giữ
     phát hiện lặp (cùng `screenSignature` + cùng action 2 lần → `needs_agent`, như `seen` hiện tại).
   - Action `fill` chỉ được đưa cho các input = `inputs:` của màn ∩ inputs của plan.
   - confidence ≥ ngưỡng → thực thi, ghi action vào bộ đệm học, về bước 1.
   - confidence < ngưỡng, hoặc hết ngân sách Jev → `needs_agent` (L3 như hiện tại: giữ session,
     `resume.json` ghi `legIndex` + màn nhận diện được + snapshot redacted).
   - Jev chọn `fail`/`blocked` với confidence ≥ ngưỡng → kết thúc case với status đó, reason =
     text nổi bật của màn (đã redact).
7. **Không nhận diện được màn và không exception nào khớp** → bước 6 (Jev phân loại: vượt qua /
   fail / blocked).

Kết thúc chặng thành công mà có action từ Jev → sinh case học (§5).

**Tham số và nơi đặt:** `legTimeoutMs`, `maxJevCallsPerLeg` nằm trong `options:` của plan (mặc
định như trên); `--max-jev-calls` cấp run giữ nguyên (mặc định 30). MCP `run_start` nhận thêm
`noLearn`, `jevThreshold`.

**Giới hạn của Decision 3:** Jev vẫn được đưa mọi nút hiển thị (kể cả "50.000đ" khi data là
"100.000đ"), nên "không đổi dữ liệu test" chỉ được đảm bảo ở mức prompt. Bù lại: action `press` có
nhãn trùng giá trị của **row khác** trong bảng data bị loại khỏi tập action; `checks`/`verify` bắt
sai lệch còn lại; case `learned` được review qua git diff.

`start.launch`: `fresh` = `pm clear` + `pm grant POST_NOTIFICATIONS` + mở app không relaunch;
`relaunch` = force-stop + mở; `attach` = không đụng app (dùng cho resume / chạy tiếp từ màn đang
đứng). Android-only cho `fresh`; iOS chỉ hỗ trợ `relaunch`/`attach`.

Resume: `prefixHash` tính trên các chặng `[0..k-1]`; agent chỉ được sửa chặng `k` trở đi **hoặc** sửa
knowledge base của màn (không ảnh hưởng hash). `resume` chạy lại chặng `k` từ bước 1 với `attach`.

### 5. Học và vòng đời case

**Sinh case khi chặng xong có action của Jev.** Đơn vị học là một **lượt ở màn `S`**: từ lúc nhận
diện `S` tới lúc nhận diện một màn khác `T`.

- Lượt ở `S` kết thúc bằng `T ≠ S` và có action của Jev → case `normal` mới trong `S/normal.yml`,
  `to: T`. `steps` = **toàn bộ chuỗi thao tác của lượt đó theo thứ tự**: các step của case đã chạy dở
  trong lượt **đã chạy thành công** (nếu có) + mọi action Jev (không chỉ action cuối), **trừ** các
  action đã được phân loại là đóng popup (bullet dưới — chúng thành exception, không nằm trong case).
  Case chạy dở bị thay (vào `history.yml`).
  Chuyển action → DSL: `press` → `tap_text` theo test ID nếu node có `identifier`, không thì theo text
  hiển thị `exact: true`; `fill` → `fill` với `text: "{input}"` và `index` = thứ tự của ô trong các ô
  nhập ở snapshot **trước** khi điền — **không bao giờ ghi `label`** (trên Android nhãn của EditText
  sau khi điền chính là giá trị); `scroll` → `scroll`; `back` → `back`;
  `wait` của Jev bị bỏ (bước đợi `T` được nhận diện đã bao phủ). Không lưu ref, toạ độ. `index` của
  `fill` tính theo đúng cách `deviceTools.fill` liệt kê ô nhập (`waitFor({ editable: true })`, thứ
  tự cây) để lúc học và lúc chạy khớp nhau.
- Action Jev được phân loại là **đóng popup** chỉ khi: `S` vẫn được nhận diện (hoặc vẫn không nhận
  diện được) sau action **và** node vừa bấm (text/test ID) **không còn** trong snapshot sau action.
  Node vừa bấm vẫn còn hiện (chip mệnh giá được chọn, tab, toggle) → đó là thao tác trên màn, nằm
  trong case. Action đóng popup → exception mới: ở tầng màn `S` nếu
  `S` đã nhận diện; chưa nhận diện thì ở `_miniapp` của group chặng, group `core` thì ở `_app`.
  `when.allText` = tiêu đề popup + nhãn nút đã bấm (≤ 3 text). Text quá chung (một nút đơn như
  "Xác nhận", "Đóng", "OK" mà không có tiêu đề) → **không học** exception đó.
- Verdict `fail`/`blocked` của Jev → exception mới `do: { fail|blocked: <reason> }` với `when` lấy
  theo cách trên.
- **Lọc riêng tư cho mọi thứ được học** (steps, `when`, `reason`, route): text nào bằng hoặc chứa giá
  trị **đã resolve** của một input (kể cả lấy từ `.env` / `defaults.account`) hoặc một giá trị
  `saveAs` được thay bằng placeholder `{tên}`;
  text còn lại dạng số điện thoại, số tiền, ngày giờ, OTP (chuỗi số ≥ 4 chữ số) bị loại khỏi `when` /
  `reason`, và nếu nằm trong một `tap_text` thì **không học** case đó (report ghi lý do). Đây là luật
  riêng tư của AGENTS.md áp cho knowledge base (file được commit).
- `routes`: mỗi chuỗi `S1 → S2 → … → to` quan sát được trong một chặng thành công được ghi vào
  `screens/<app>/_app/routes.yml` (máy ghi, không sửa tay) để bước 4 đi qua màn trung gian.
- Case sinh ra có `status: learned`, `confidence`, `learnedFrom: <runId>`; ledger local bắt đầu `ok = 1`.
- Không học khi: chặng có `steps:` riêng, chạy với `--no-learn`, hoặc run kết thúc `needs_agent` ở
  chính chặng đó (quyết định chưa được kiểm chứng tới đích).

**Trạng thái:**

| Trạng thái | Nguồn | Chuyển |
|---|---|---|
| `draft` | agent viết khi tạo màn | 3 lần `ok` liên tiếp → `verified`; sai → không tính lỗi, rơi xuống Jev; Jev sửa được → thay bằng `learned` |
| `learned` | Jev ≥ ngưỡng, chặng qua | 3 `ok` liên tiếp → `verified`; 2 `fail` liên tiếp → gỡ (vào `history.yml`) |
| `verified` | lên hạng hoặc người đặt tay | 1 `fail` → hạ `learned` (streak = 0) |

`streak` được đếm theo từng máy (ledger local): một case chỉ lên `verified` khi chính máy đó thấy
3 `ok` liên tiếp; `status` mới được commit và dùng chung.

Vòng đời này áp dụng cho cả case `normal.yml` lẫn rule trong `exceptions.yml` (trừ `_shared`).

- "`fail` của case" = chạy case mà không đổi được màn, hoặc exception `tap` xong vẫn khớp đúng rule
  đó ở vòng sau. **Không** tính `fail` khi vòng ngay sau khớp một exception khác (popup UAT chen vào
  giữa case) — case được chạy lại sau khi exception xử lý xong.
- Case/rule bị thay hoặc gỡ được chuyển vào `history.yml` của màn đó (một file mỗi màn, giữ 10 mục
  mới nhất) cùng lý do + runId + thời điểm — case bị gỡ không còn chỗ giữ history của chính nó.
- Rule trong `_shared` và case có `pinned: true` không bao giờ bị runner đổi.

**Ghi file:**

- Runner gom thay đổi trong bộ nhớ, ghi **một lần khi kết thúc run** (kể cả fail / needs_agent).
- Áp cho mọi file runner ghi: `normal.yml`, `exceptions.yml`, `routes.yml`. Khoá merge: exception theo
  `id`, case theo `to` + `steps`, route theo cả chuỗi `S1→…→to`. `--no-learn` không ghi gì, kể cả
  `routes` và `stats`.
- Ghi file tạm + rename, khoá bằng file `.lock` cạnh file YAML (chờ tối đa 5 s, không lấy được →
  bỏ lần ghi, report cảnh báo). Đọc lại file ngay trước khi ghi và merge theo `id`/`to`+`steps`, để
  hai run song song không đè thay đổi của nhau.
- Giữ comment YAML viết tay: file màn được đọc/ghi bằng package `yaml` (document API, giữ comment) —
  dependency mới duy nhất; `js-yaml` hiện có làm mất comment khi ghi nên chỉ còn dùng cho front-matter
  chỉ đọc. Ledger `.agentic/stats.json` khoá bằng `.lock` riêng, lấy trước mọi file của workspace
  và giữ tới hết lần ghi; ledger bị run khác giữ → file màn vẫn ghi, bộ đếm của run này bỏ và report
  cảnh báo.
- Report có mục **"Knowledge đã thay đổi"**: thêm / lên hạng / hạ cấp / gỡ, kèm file + id.

### 6. Cấu hình `.env`

`workspace/.env` (gitignored) và `.env.example` (committed):

```bash
LEGACY_TEST_PHONE=
LEGACY_TEST_PASSWORD=
LEGACY_TEST_PIN=
JEV_CONFIDENCE_THRESHOLD=0.75
TYPESAFE_API_KEY=
BYPASS_LOGIN_OTP_TOKEN=
```

- Nạp bằng `process.loadEnvFile(<workspace>/.env)` (Node ≥ 22, không thêm dependency), **không** ghi đè
  biến đã có trong môi trường shell.
- Thứ tự giá trị input: cột data của plan → `{env:VAR}` / env shell → `.env` →
  `LEGACY_TEST_PHONE/PASSWORD/PIN` → `defaults.account` của `legacy.workspace.json`.
- Ngưỡng Jev: `--jev-threshold` > `JEV_CONFIDENCE_THRESHOLD` > 0.75. Giá trị ngoài (0, 1] → lỗi
  validate trước khi mở session.
- `legacy.workspace.local.json` bị bỏ; `doctor` cảnh báo nếu còn file này và chỉ cách chuyển sang `.env`.
- `doctor` báo biến nào đã đặt / chưa đặt, không bao giờ in giá trị.
- Repo không có docker-compose / manifest deploy, nên không có chỗ nào khác cần mirror biến env.

### 7. CLI

| Lệnh | Thay đổi |
|---|---|
| `run <plan>` | chạy `flow`; thêm `--jev-threshold`, `--no-learn`; exit code như cũ, thêm status `blocked` (exit 1, phân biệt trong JSON) |
| `resume <runId>` | theo chặng (§4) |
| `plan validate` | kiểm `flow`: màn tồn tại, `at` nối `to`, `identify` không rỗng, input hợp lệ, YAML màn đúng schema |
| `screen capture --as <group/screen> [--serial]` | **mới**: snapshot màn đang đứng → tạo/cập nhật `screen.md` (draft) với text + test ID thật làm gợi ý `identify`; không bao giờ ghi text của ô nhập |
| `screen list [--app]` | **mới**: liệt kê màn + số case theo trạng thái |
| `screen identify [--serial]` | **mới**: màn đang đứng khớp màn nào (debug `identify`) |
| `context show` | in `_app/context.md` + danh sách màn/plan thay cho example/block |
| `context build` | giữ, output chỉ còn là gợi ý (`screens/<app>/_app/source-hints.md`) |
| `plan apply-patch`, `plan promote` | bỏ (học tự động thay apply-patch; `status: passed` thay promote) |

MCP: `context_show`, `plan_validate`, `snapshot`, `run_start`, `run_status`, `resume_start` giữ;
thêm `screen_capture`, `screen_identify`.

### 8. Quy trình của agent (AGENTS.md mới)

Ví dụ "test mua mã thẻ trên Acme":

1. Tìm `plans/acme/` — có plan phù hợp → chạy.
2. Chưa có → phác thảo chặng: `core/login_phone → core/home → mobile_topup/main →
   mobile_topup/card_code → mobile_topup/confirm → mobile_topup/result`, tham khảo plan đã có.
3. Màn đã có trong `screens/acme/` → dùng lại. Thiếu → tạo màn `draft` (`screen.md` + `normal.yml`
   với case `draft` đoán từ context/source). Mini app mới → thêm `_miniapp/context.md`.
4. Khi có thể, đưa app tới màn thiếu và chạy `screen capture --as …` để `identify` dựa trên text/test
   ID thật.
5. `plan validate` → `run`. `needs_agent` → sửa màn/case hoặc chặng `k` → `resume` (tối đa 2 lần mỗi
   chặng rồi hỏi người dùng).
6. Báo cáo: status từng chặng (`pass`/`fail`/`blocked`), số lần gọi Jev, mục "Knowledge đã thay
   đổi", đường dẫn report. Plan PASS và người dùng muốn giữ → đặt `status: passed`.

Luật giữ nguyên: eKYC/khuôn mặt/CCCD → FAIL ngay; không bịa OTP/mật khẩu/token; không gửi giá trị
input cho Jev; so sánh số tiền bằng `capture_*` + `assert_value`; `intent`/`goal` tiếng Anh, text
màn hình giữ tiếng Việt.

### 9. Đổi tên và chuyển đổi

- `git mv acme-app-testing-usecases workspace`; cập nhật `AGENTS.md` gốc repo (đang mô tả
  L0–L3, `blocks/`, `examples/`, `interruptions.yml`), `workspace/AGENTS.md`, `README.md`, spec cũ
  (ghi chú "superseded by"), `package.json`, test fixture, mọi đường dẫn cứng. Workspace vẫn được tìm
  theo marker `legacy.workspace.json` nên code resolve không đổi.
- Xoá `.agentic/sessions/` cũ (artefact của Appium) khỏi git.
- `context/example/*` → `screens/example/_app/context.md` + `screens/example/core/<screen>/` tách theo
  màn đã có trong `glossary.json` (chỉ các màn luồng login dùng).
- `context/_shared/interruptions.yml` → `screens/_shared/exceptions.yml`;
  `context/acme/interruptions.yml` → `screens/acme/_app/exceptions.yml`.
- Luồng login Acme đã PASS live (run `acme_login_home_20260924_120903`) → màn `core/onboarding_notification`,
  `core/login_phone`, `core/login_method` (chọn OTP trên thiết bị mới), `core/login_otp`,
  `core/login_password`, `core/home` với case `verified`; exception `fingerprint_unlock_offer`,
  `generic_error_try_later` vào `_app`.
- `plans/acme_login_home.plan.md` → `plans/acme/login_home.plan.md` dạng `flow`; tương tự 2 plan
  example.
- `blocks/`, `examples/`, `legacy.workspace.local.json` bị xoá.

## Technical Approach

- **Module mới** trong `old-tool/src/`:
  - `screens/store.js` — nạp cây `screens/<app>/`, validate schema, tra case/exception, gom thay đổi,
    ghi an toàn (lock + merge).
  - `screens/identify.js` — hàm thuần: snapshot + danh sách màn → màn khớp (có test fixture).
  - `screens/learn.js` — chuyển action Jev → case/exception, cập nhật trạng thái/stats.
  - `runner/flow.js` — vòng lặp chặng (§4), thay `runner/ladder.js`. `recipe.js` (L0 step) và
    `jev/resolver.js` được dùng lại; resolver thêm verdict `arrived`/`fail`/`blocked` và trả
    `confidence` từng action.
  - `util/env.js` — nạp `.env`, thứ tự ưu tiên, đọc ngưỡng.
- **Bỏ**: `plan/loader.js` phần `use:` block, `runner/interruptions.js` (gộp vào store),
  `cli/planCommands.js` phần apply-patch/promote.
- **Test** (node:test, không cần thiết bị): identify (khớp / mơ hồ / noneText), thứ tự tầng exception
  (eKYC luôn thắng), vòng đời trạng thái, chuyển action → case (không lọt giá trị input, không lọt
  số tiền/SĐT vào `when`), ghi đồng thời hai run (merge), `.env` không ghi đè env shell, runner chặng
  với mock backend (case đúng / case sai → Jev → học / Jev thấp hơn ngưỡng → needs_agent / blocked).
- **Nghiệm thu live**: `plans/acme/login_home.plan.md` PASS trên `09261FDD4005PG`, 0 lần gọi Jev,
  không chậm hơn run hiện tại (~34 s). Một run cố ý xoá case `core/home` → Jev xử lý → case
  `learned` được ghi → run sau chạy lại 0 lần gọi Jev.

## Ghi chú triển khai (2026-09-24, sau khi chạy live)

Những điểm thêm vào so với thiết kế ban đầu, đều rút ra từ các lần chạy trên `09261FDD4005PG`:

- Case có `waitMs` (1–60000): màn kế tiếp tới chậm hơn `caseWaitMs` (mật khẩu → Home trên UAT ≈ 10 s).
- `options.unknownGraceMs` (mặc định 3000): màn chưa nhận diện được (thường là đang tải) được chờ một lần
  trước khi hỏi Jev.
- Case bị popup chen giữa được chạy lại một lần sau khi exception xử lý xong.
- Snapshot lỗi thoáng qua của agent-device ("insufficient foreground app content") được thử lại 3 lần.
- Tool `fill` đọc lại ô sau khi gõ (so sánh trong tiến trình, bỏ khoảng trắng/dấu chấm/gạch); sai thì gõ lại
  từng phím (tối đa 2 lần). Ô SĐT của Acme đảo/rơi phím khi `adb input text` gõ nhanh. Ô bị che (mật khẩu) hoặc
  biến mất sau khi gõ (PIN tự submit) thì không đọc lại.
- Text dạng JWT trên màn (bản debug in access token) không bao giờ là text công khai (`publicText`).
- Giá trị input mà app tự in lại trên màn ("Số ví: <SĐT> - …") được thay bằng `{tên}` trước khi gửi Jev và ghi
  `resume.json`.
- `history` nằm ở `history.yml` của màn (10 mục), không nằm trong từng case.
- Writer giữ layout của file viết tay: mỗi item là block map, `when`/`do`/từng step là flow map.
- Home Acme: placeholder ô tìm kiếm xoay vòng → nhận diện bằng test ID `searchBar` + tab bar.
- Nghiệm thu: `login_home` PASS 0 lần gọi Jev (37–46 s tuỳ UAT); xoá case mật khẩu → lần đầu Jev (0.79) làm và
  runner học case `learned`, lần sau 0 lần gọi Jev.

## Phân pha triển khai

1. Đổi tên workspace + `.env` + bỏ `blocks/`/`examples/`/`legacy.workspace.local.json`.
2. `store` / `identify` / `flow` + chuyển màn login Acme và example — nghiệm thu `login_home` với
   `--no-learn` (mặc định tắt học trong pha này).
3. Học + vòng đời + `routes` + lọc riêng tư — bật học mặc định; nghiệm thu "xoá case → Jev → learned →
   0 Jev lần sau".
4. `screen capture` / `list` / `identify` CLI + MCP, AGENTS.md mới.

Mỗi pha tự đứng được và qua `npm test`.

## Open Questions

- Luồng mua mã thẻ trên UAT có thực sự **thanh toán** tới cùng (trừ tiền ví UAT, cần PIN/mật khẩu
  thanh toán) hay dừng ở màn xác nhận? Quyết định khi viết plan `buy_card_code`, không ảnh hưởng kiến
  trúc.
- Dấu hiệu nhận biết mini app trên a11y tree (ví dụ tiền tố test ID `com.acme.<miniapp>/…` thấy trên tab
  bar) — xác nhận khi capture màn đầu tiên của `mobile_topup`; nếu ổn định có thể thêm
  `identify.anyIdPrefix` ở cấp `_miniapp`.
