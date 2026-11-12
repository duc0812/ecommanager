# Auto render hàng giờ (`tools/auto-render-hourly`)

Mỗi giờ máy shop tự render các dòng đơn mới bằng bộ script xử lý đơn có sẵn, kiểm tên khách trong từng file in, đẩy lên prod (REVIEW) những dòng đạt và đang AUTO, giữ lại những dòng còn lại kèm lý do.

## Nó làm gì

Một lần chạy (`run.ps1` → `auto_render.py`):

1. Giữ mutex `Local\EcomManagerAutoRenderHourly`. Lần trước chưa xong thì ghi log "lần chạy trước chưa xong — bỏ qua lần này" và thoát 0.
2. Kiểm ổ D: còn dưới 30 GB thì dừng (mã 3).
3. Tool local (`LOCAL_URL`, mặc định `http://localhost:3013`): không trả lời thì bật `next dev` trong `TOOL_WORKTREE` và chờ tối đa 120 giây; đăng nhập bằng `local-login.txt`, mở thử một task. Lỗi (không phải 2xx) thì dừng với "tool local lỗi <mã>" — đây là bẫy "render 0" im lặng.
4. Chạy `process-new-orders.mjs --since <hôm nay − 14 ngày>` **không** `--push` (tối đa 30 phút).
5. Kiểm tên trong file in (`safe_zone.py`): khách chọn "No" thì file không được có tên; tên nằm trong khung thiết kế (dung sai 3 px); khung và tên nằm trong vùng in trừ mép an toàn.
6. Dòng đạt và prod đang **AUTO** được đẩy lên prod dưới khoá `artwork-builder\.push-lock` (chờ tối đa 30 phút, không bao giờ phá khoá của người khác): render local từng dòng qua `push-local-renders.mjs --line`, dòng dùng chung file cũ và flat-text qua `push-shared-prints.mjs` với bản spec đã lọc (`*.auto.json`). Task dừng ở REVIEW / AUTO như hiện nay.
7. Dòng bị giữ: có cấu hình `/hold` thì báo `POST /api/design-agent/runner/hold` (mỗi dòng một lần cho mỗi lý do); không có thì chỉ ghi log.
8. Ghi log và summary JSON, giữ 30 ngày; xoá snapshot prod mà lần chạy tự tạo (~180 MB).

Không có AI trong lần chạy; không duyệt, không đụng xưởng, không email khách.

## Cài đặt (chủ shop)

Tạo file `%USERPROFILE%\.auto-render\config.env`, mỗi dòng `KEY=VALUE` (dòng `#` là ghi chú):

| Khoá | Bắt buộc | Ý nghĩa |
|---|---|---|
| `TOOL_WORKTREE` | có | worktree tool chứa `scripts\process-new-orders.mjs`, `push-local-renders.mjs`, `push-shared-prints.mjs`, `node_modules\next` |
| `MAIN_CHECKOUT` | có | bản checkout chính (chứa `dev.db`, `db-backups`, `storage`) |
| `ARTWORK_BUILDER` | có | thư mục `artwork-builder` (chứa `g5\tools\name_render.py`, `flat-text`, `design-rules`, `.push-lock`) |
| `LOCAL_URL` | không | mặc định `http://localhost:3013` |
| `ECOM_URL` | không | `https://…` của app; cùng với `DESIGN_AGENT_TOKEN` để báo `/hold`. Thiếu một trong hai thì dòng bị giữ chỉ ghi log |
| `DESIGN_AGENT_TOKEN` | không | token `dag_…` của Design Agent (không bao giờ ghi vào log) |
| `SINCE_DAYS` | không | mặc định 14 |
| `NAME_BOX_TOLERANCE_PX` | không | dung sai khung tên, mặc định 3 |

Thiếu file, thiếu khoá bắt buộc hay thiếu một script thì lần chạy dừng ngay với mã 2.

Những thứ máy phải có sẵn, tool này không cấu hình: `node` và `python` 3.12 trên PATH; `<MAIN_CHECKOUT>\.superpowers\local\local-login.txt` (email dòng 1, mật khẩu dòng 2); `%USERPROFILE%\.artwork-worker\local.env`; SSH key mà các script dùng (`%USERPROFILE%\.ssh\ecommanager_vps_ed25519`).

Lần đầu chạy tay: `powershell -ExecutionPolicy Bypass -File run.ps1 -DryRun`, đọc summary (`logs\run-*.json`). Chạy thử làm mọi bước trừ đẩy và báo `/hold`. Sau đó mới chạy `install-task.ps1` (chỉ chủ shop, hoặc agent khi chủ shop bảo). `install-task.ps1 -PrintOnly` chỉ in ra sẽ đăng ký gì: task "EcomManager Auto Render Hourly", mỗi giờ từ giờ chẵn kế tiếp, giới hạn 55 phút, IgnoreNew, StartWhenAvailable, người dùng hiện tại không nâng quyền.

`run.ps1 -KeepSnapshot` giữ lại snapshot prod của lần chạy (để xem lại).

## Kết quả một lần chạy

- Log: `%USERPROFILE%\.auto-render\logs\<ngày>.log` (kể cả output của các script, mỗi dòng có tiền tố `process|`, `push-local-renders|`…). Tool local bật bởi lần chạy ghi vào `logs\tool-<ngày>.log`.
- Summary: `logs\run-<YYYYMMDD-HHMMSS>.json`:

| Khoá | Ý nghĩa |
|---|---|
| `startedAt`, `finishedAt`, `dryRun`, `exitCode`, `since`, `snapshot` | thông tin lần chạy |
| `rendered` | mọi dòng ứng viên (prod NEW, chưa có file in) mà lần chạy có file để kiểm |
| `pushed` | dòng đã lên prod — chỉ khi ledger của script ghi `applied` sau lúc bắt đầu chạy |
| `held` | dòng AUTO bị giữ: `taskKey, source, guard, reason, reported, jobId` |
| `notAuto` | dòng prod không phải AUTO (vẫn render ở máy, không bao giờ đẩy) |
| `unchecked` | dòng được đẩy nhưng không kiểm được safe zone, kèm lý do |
| `skipped` | dòng không thuộc lần chạy (cm-builder) hoặc prod bỏ qua lúc đẩy |
| `errors` | `{stage, taskKey?, message}` của mọi bước không làm được |

Log và summary giữ 30 ngày.

| Mã thoát | Nghĩa |
|---|---|
| 0 | chạy hết (kể cả: lần trước chưa xong; có dòng bị giữ) |
| 1 | một bước lỗi (tool local, process-new-orders, đo tên, khoá, đẩy, `/hold`) |
| 2 | thiếu/sai cấu hình, thiếu script, hoặc không chạy được python |
| 3 | ổ D dưới 30 GB |

## Dòng bị giữ

Ba kiểm tra, theo thứ tự:

- **"No"**: khách chọn No (và không có Yes) thì file in phải là bản không tên. Lý do: `khách chọn No nhưng file in có tên`.
- **Khung tên**: phần mực của tên phải nằm trong khung thiết kế cho tên, dung sai 3 px. Lý do: `tên vượt khung {n} px ({mảnh} · {field})`; mảnh có tên mà không thấy mực: `file dựng không thấy tên ({mảnh})`.
- **Safe zone**: khung và mực phải cách mép vùng in ít nhất `safeIn × dpi` (hoặc `minimumCutClearancePx` của spec nếu lớn hơn). Lý do: `tên chạm safe zone: lấn {n} px vào mép an toàn {inset} px ({mảnh} · {field})`.

Không có hình học để kiểm (không template, thiếu artwork gốc trên máy, spec Photoshop) thì dòng **vẫn được đẩy**, summary ghi `không kiểm được safe zone (…)`. Đo hỏng thì dòng không được đẩy và lần chạy thoát 1 (`không đo được khung tên: …`).

Dòng bị giữ thì giữ lại chứ không tự thu nhỏ tên. Có `/hold` (và công tắc `agent.autoFixOnReject` bật trên app) thì dòng thành một việc cho Design Agent; mỗi dòng chỉ báo một lần cho mỗi lý do (`holds.json`), lý do đổi thì báo lại. Dòng bị giữ vẫn hiện trong summary mỗi giờ.

## Giới hạn đã biết

- Render của worker không báo khung mực: mực của tên = chỗ khác nhau giữa file in và `artwork.png` gốc của mảnh trong thư viện (ngưỡng 64 mức). Artwork gốc nằm trên Drive mà không có trong cache worker của máy thì không kiểm được safe zone (vẫn đẩy). File `-noname` là bản không tên do server đặt tên.
- Entry vẽ bằng Photoshop (`design-rules\*.json`, `renderer: "photoshop"`) không so pixel được (bản PSD khác `artwork.png` trên cả trang — đo trên LIT6302_1, LIT6295_1, LIT6252_1): khung là `targets` × `maxW`/`maxH` của quy tắc, kiểm khung tên do chính renderer làm (3 px); ở đây chỉ kiểm safe zone. Quy tắc chỉ có `nativeSpec` thì không kiểm được.
- Flat-text: đo bằng chính `render_text` + `place` của `name_render.py`, chỉ tính mực đặc (chữ, viền, faux bold, uốn cong, xoay), **bỏ quầng glow** (glow luôn lan 150–350 px ra ngoài khung). Với `fit: "size"` khung chỉ chặn theo chiều chữ chạy (chân chữ được ra khỏi khung, safe zone vẫn kiểm). Trên mẫu 12 spec mỗi kiểu chữ, ba thiết kế viền/uốn (TN2209261813, DN0310260203, TN2209261821) vẫn vượt 4–33 px với tên dài hoặc có chân chữ và sẽ bị giữ; muốn nới thì tăng `NAME_BOX_TOLERANCE_PX`.
- Spec flat-text được tìm lại theo đúng bộ lọc của `flat_text_batch.py`; khớp 0 hoặc hơn 1 spec thì dòng là lỗi, không đẩy.
- Nhóm cm-builder (file `path` trong `spec-shared.json`) chứa thiết kế khách tự làm, không đo được: không đẩy trong lần chạy này, ghi ở `skipped`.
- Dòng không AUTO vẫn được render ở máy mỗi giờ (script không lọc readiness) nhưng không bao giờ được đẩy.
- Người chạy `process-new-orders` bằng tay cùng phút sẽ dùng chung `dev.db` và tool local với lần chạy.
- Bản spec đã lọc `*.auto.json` được ghi cạnh spec gốc (`db-backups\process-new-orders\auto-…\` và `artwork-builder\flat-text\_out\`), vì đường dẫn trong spec tính theo thư mục của nó.

## Chưa kiểm chứng

Chưa chạy thật: task đã lên lịch, một lần đẩy thật lên prod, một lần gọi `/hold` thật, một lần chạy đủ một giờ trong 55 phút. Tất cả mới chỉ được thử bằng test với script giả, server giả và ảnh tạo trong test.

## Test

```
python -m pytest tools/auto-render-hourly/tests -q -p no:cacheprovider
```
