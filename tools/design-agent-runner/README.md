# Design Agent runner

## Nó làm gì

Chạy trên máy tính của shop. Khi designer reject một design (hoặc khi chủ shop bấm giao việc), Ecom Manager xếp một job vào hàng đợi. Runner này hỏi máy chủ xem có job không (long-poll, tối đa 5 job cùng lúc), với mỗi job nó tạo một thư mục riêng và tải về các file hiện tại của task.

- Job `FIX`, `MAKE`, `MOCKUP`: runner điều khiển tối đa 3 vòng. Mỗi vòng có một **phiên sửa** (prompt `fix` / `make` / `mockup`) chỉ làm file trong thư mục job, rồi một **phiên QA mới** (prompt `qa`, không phải phiên đã làm file) chấm theo danh sách kiểm tra cố định. QA đạt thì **chính runner** tải file lên và gửi duyệt; các phiên không bao giờ gọi máy chủ.
- Job `LIBRARY_APPLY`: như trước, một phiên duy nhất làm việc, giao file qua `agent_api.py` và ghi `result.json`.

Runner báo nhịp tim mỗi 60 giây, giới hạn 90 phút cho cả job, rồi báo kết quả cho máy chủ. Agent không bao giờ duyệt task, không liên hệ xưởng hay khách: mọi thứ dừng ở REVIEW.

| File | Việc |
|---|---|
| `agent_api.py` | hợp đồng với máy chủ: lớp `AgentApi` (runner dùng để giao file) và CLI (`upload`, `submit`, `reopen`, `note`, `download`) cho phiên `library-apply` và cho người |
| `runner.py` | cấu hình, log, tìm Codex, thư mục job, prompt, dòng lệnh, vòng sửa/QA, kiểm `READY.json` và kết quả QA, giao file, vòng nhận job, khóa, `main` |
| `prompts/fix.md`, `make.md`, `mockup.md` | phiên sửa: chỉ làm file, kết thúc bằng `READY.json` hoặc `result.json` NEEDS_OWNER |
| `prompts/qa.md` | phiên QA độc lập: danh sách kiểm tra 8 mục, ghi `QA-claude/round-N-result.json` |
| `prompts/library-apply.md` | phiên duy nhất của job thư viện (giao qua `agent_api.py`) |
| `install-task.ps1` | đăng ký tác vụ Task Scheduler (chỉ chủ shop chạy); `-PrintOnly` để xem trước |
| `tests/` | test với máy chủ giả và `claude` giả |

## Cài đặt (chủ shop)

1. Trên trang cài đặt của Ecom Manager, tạo token cho runner (chỉ hiện một lần).
2. Tạo file `%USERPROFILE%\.design-agent\runner.env` (mỗi dòng `KEY=VALUE`):

| Key | Ý nghĩa | Mặc định |
|---|---|---|
| `ECOM_URL` | địa chỉ Ecom Manager (`https://…`; `http://localhost…` chỉ để thử) | bắt buộc |
| `DESIGN_AGENT_TOKEN` | token vừa tạo | bắt buộc |
| `PROJECT_DIR` | thư mục dự án mà các phiên dùng (có `CLAUDE.md` và skill) | bắt buộc |
| `MAX_CONCURRENT` | số job chạy cùng lúc (1 đến 10) | `5` |
| `CLAUDE_BIN` | lệnh `claude` (file `.cmd` / `.bat` bị từ chối) | `claude` |
| `CODEX_BIN` | đường dẫn `codex.exe`; để trống = bản mới nhất đi kèm app Codex | trống |
| `ARTWORK_BUILDER` | thư mục gốc chứa thư mục job | `D:\Ecom manager\artwork-builder` |
| `CLAUDE_ALLOWED_TOOLS` | các tool phiên được dùng | `Bash,Read,Write,Edit,Glob,Grep,Skill` |
| `CLAUDE_DISALLOWED_TOOLS` | lệnh phiên bị cấm (cách nhau bằng dấu phẩy; `none` = không cấm) | các script push thẳng DB (`push-local-renders`, `push-shared-prints`, `push_s2n`, `apply_chunk`, `process-new-orders`), `ssh`, `scp`, và mọi lệnh Bash nhắc tới `runner.env`, `.design-agent`, `agent_api` hay đường dẫn `design-agent/runner` của máy chủ, cộng `Read(~/.design-agent/**)` (xem "Rào chắn") |
| `CLAUDE_PERMISSION_MODE` | chế độ quyền | `dontAsk` |
| `CLAUDE_MODEL` | model của phiên sửa và phiên thư viện (tuỳ chọn) | trống |
| `CLAUDE_QA_MODEL` | model của phiên QA | bằng `CLAUDE_MODEL` |
| `JOB_TIMEOUT_MINUTES` | giới hạn thời gian mỗi job | `90` |
| `BASH_TIMEOUT_MS` | thời gian tối đa của một lệnh Bash trong phiên | `600000` (10 phút) |

3. Giữ `claude` đã đăng nhập trên máy này.
4. Chạy runner từ một bản checkout của commit đã duyệt, và không phiên nào được đổi nhánh trong thư mục đó (prompt được đọc lại cho mỗi job). Không bao giờ khởi động runner từ bên trong một phiên Claude Code.
5. Lần đầu chạy có người xem, từ terminal thường: `python tools\design-agent-runner\runner.py --once`
6. Sau đó mới đăng ký tác vụ: `powershell -ExecutionPolicy Bypass -File tools\design-agent-runner\install-task.ps1` (chỉ chủ shop, hoặc agent theo lời chủ shop). Xem trước: thêm `-PrintOnly`.

## Một job chạy thế nào

Thư mục job: `<ARTWORK_BUILDER>\<MÃ TASK>-agent-<id job>\`. Tên có dạng `…-agent-…` nên disk-janitor dọn sau 24 giờ kể từ khi dòng được gửi xưởng.

| File | Ai ghi | Là gì |
|---|---|---|
| `job.json` | runner | toàn bộ ngữ cảnh; chữ của designer chỉ nằm ở đây, là dữ liệu |
| `current\` | runner | file hiện tại của task + `index.json` |
| `prompt.md` | runner | prompt gốc của loại job; `prompt-round-N-maker.md`, `prompt-round-N-qa.md` là prompt thật của từng phiên (có thêm mục "Vòng này") |
| `round-N\deliver\` | phiên sửa | file ứng viên của vòng N (`.jpg`, `.jpeg`, `.png`) |
| `round-N\READY.json` | phiên sửa | `{ "round": N, "files": [ { "kind": "PRINT" \| "MOCKUP", "printArea": "…", "file": "round-N/deliver/…" } ], "changed": "…", "unchanged": "…" }` |
| `round-N\work\` | phiên sửa | brief cho Codex, bản nháp, log Codex |
| `QA-claude\round-N-result.json` | phiên QA | `{ "verdict": "PASS" \| "FAIL", "summary": "…", "findings": [ { "piece", "problem", "fix", "passCondition" } ] }` |
| `result.json` | phiên sửa (chỉ `NEEDS_OWNER`) hoặc phiên thư viện | `{ "outcome", "summary", … }` |
| `session.log` / `session-round-N-maker.log` / `session-round-N-qa.log` | runner | mọi sự kiện stream-json của phiên, ghi ngay khi xảy ra, token được che; kết quả không bao giờ lấy từ log |
| `stage.txt` | phiên | bước đang làm (runner xoá trước mỗi phiên) |
| `api-calls.jsonl` | `agent_api.py` | mọi lần phiên thư viện gọi CLI |
| `runner-state.json` | runner | vòng, pha, kết quả QA, kết quả cuối |

Khi job chạy lại (lần 2), mọi file và thư mục của lần trước (`result.json`, `round-N`, `QA-claude`, log, prompt của vòng) được đổi tên thành `prev-<giờ>-…`: lần sau không bao giờ thừa hưởng một vòng cũ.

### FIX, MAKE, MOCKUP: vòng sửa, QA độc lập, runner giao

Mỗi vòng N (1 đến 3), trong cùng một đồng hồ của job (`JOB_TIMEOUT_MINUTES`; mỗi phiên chỉ được phần thời gian còn lại):

1. **Phiên sửa** (`CLAUDE_MODEL`). Vòng 2 và 3 được dặn đọc `QA-claude/round-<N-1>-result.json` và chỉ sửa các mảnh trong `findings`, bắt đầu từ file của chính nó ở vòng trước. Phiên phải kết thúc bằng đúng một trong hai:
   - `round-N/READY.json` + file trong `round-N/deliver/`. Runner kiểm: đúng `round`, có file, mỗi file nằm trong `round-N/deliver/`, tồn tại, không rỗng, đuôi `.jpg`/`.jpeg`/`.png`, không trùng vùng, có `changed` và `unchanged`; job FIX: vùng in `PRINT` phải có trong file hiện tại của task; job MOCKUP: chỉ file `MOCKUP`.
   - `result.json` với `outcome: "NEEDS_OWNER"`: báo nguyên văn lên máy chủ, không chạy QA.
   - Khác đi (không có gì, file sai dạng, cả hai cùng lúc, `DONE` do phiên tự ghi): `fail` tạm, có lý do tiếng Việt.
2. **Phiên QA** (`CLAUDE_QA_MODEL`), một phiên mới chưa làm file nào. Trước khi nó chạy, runner lưu sha256 của `READY.json` và mọi file trong `round-N/deliver/`; sau đó file nào khác đi là `fail` tạm. Thiếu hoặc sai dạng `QA-claude/round-N-result.json`: `fail` tạm.
3. QA `PASS`: **runner** tải từng file trong `READY.json` lên (`AgentApi.upload`, đúng vùng và loại), rồi `submit` (FIX, MAKE; MOCKUP chỉ tải lên), rồi báo `result` `DONE` với `rounds: N`, `summary` = `changed` của phiên sửa + `summary` của QA, `result: { "pushed": [...], "qa": "PASS", "rounds": N }`. Lỗi khi tải lên hay gửi duyệt: `fail` với mã và lời máy chủ (ví dụ `tải lên FRONT thất bại: máy chủ trả 413 (file quá lớn)`), vĩnh viễn với 4xx, tạm với 5xx và lỗi mạng; không phiên nào được bảo giao lại.
4. QA `FAIL`: sang vòng sau. FAIL ở vòng 3: báo `NEEDS_OWNER`, `rounds: 3`, summary `QA chưa đạt sau 3 vòng: <mảnh>: <lỗi>; …`, không tải gì lên.

Nhịp tim gửi suốt cả job: `vòng N: sửa`, `vòng N: QA`, `tải lên`; khi phiên đang chạy có ghi `stage.txt` thì gửi `vòng N: <dòng đó>`. Số vòng là N.

### LIBRARY_APPLY

Một phiên, như trước: phiên giao qua `agent_api.py` (luật `Bash(*agent_api*)` được bỏ khỏi danh sách cấm của riêng phiên này), ghi `result.json`; runner báo đúng `outcome`, `summary`, `rounds` và các trường còn lại. File sai dạng: `fail` vĩnh viễn. Không có `result.json`: `fail` tạm. **Thiếu result.json là lỗi, không bao giờ là xong.**

### Dòng lệnh

cwd = `PROJECT_DIR`, stdin đóng, token bị xoá khỏi môi trường, `DESIGN_AGENT_PHASE` (`maker` / `qa`) và `DESIGN_AGENT_ROUND` được đặt cho phiên của một vòng:

```
claude -p "<prompt của vòng>" --output-format stream-json --verbose --permission-mode dontAsk --allowedTools Bash Read Write Edit Glob Grep Skill --disallowedTools "Bash(*push-local-renders*)" … "Bash(*runner.env*)" "Bash(*.design-agent*)" "Bash(*agent_api*)" "Bash(*design-agent/runner*)" "Read(~/.design-agent/**)" --add-dir "<thư mục job>" "<ARTWORK_BUILDER>" [--model <CLAUDE_MODEL hoặc CLAUDE_QA_MODEL>]
```

### Các trường hợp khác

- Quá 90 phút (ở bất kỳ phiên nào): diệt cả cây tiến trình, báo `fail` vĩnh viễn (không chạy lại mù).
- Một phiên kết thúc trong 90 giây mà không để lại gì: coi là Claude CLI không chạy được (chưa đăng nhập, hết hạn mức); báo `fail` tạm và ngừng nhận job 30 phút.
- Máy chủ trả 409 cho nhịp tim: server không còn giữ job, phiên bị diệt, không báo gì thêm.
- Máy chủ trả 401: token bị thu hồi, diệt mọi phiên, runner thoát với mã 3.
- Mã task hoặc id job không an toàn làm tên thư mục: từ chối ngay, không tạo thư mục.
- Khi phiên bị diệt lúc đang giữ `.ps-lock` của Photoshop, runner gỡ khóa chỉ khi thư mục job có file `ps-lock.held`; khóa không có dấu của job thì để yên.
- `agent_api.py`: máy chủ trả 413 thành lỗi `máy chủ từ chối: file quá lớn (413)`, mất kết nối giữa lúc gửi file thành `mất kết nối khi đang tải lên`; CLI thoát mã khác 0 và không bao giờ ghi "status 0".

## Rào chắn (không phải ranh giới bảo mật)

Phiên sửa và phiên QA được dặn trong prompt là không gọi máy chủ, không đọc `runner.env` hay `.design-agent`, không chạy `agent_api.py`; token bị xoá khỏi môi trường; và danh sách cấm mặc định chặn các lệnh Bash nhắc tới những thứ đó. Đây là **rào chắn chống nhầm lẫn, không phải ranh giới bảo mật**: phiên chạy bằng cùng tài khoản Windows với runner, nên một lệnh viết khác đi (ghép chuỗi, script Python tự viết) vẫn đọc được file cấu hình. Thứ thật sự giữ an toàn là cách làm: phiên không còn bước giao nào để "gỡ rối", runner mới là bên giao file, và chỉ sau khi một phiên QA khác đã chấm đạt.

## Dừng

- Tắt công tắc Agent ở trang cài đặt: không nhận job mới.
- Thu hồi token: trong vòng một phút mọi phiên bị diệt và runner thoát với mã 3.
- Đóng cửa sổ của runner, hoặc `Stop-ScheduledTask -TaskName "EcomManager Design Agent Runner"`.
- Sau khi khởi động lại, các job đang chạy dở được máy chủ thu hồi theo lease (20 phút, tối đa 2 lần chạy); runner không tự báo gì về chúng.

## Mã thoát

| Mã | Nghĩa |
|---|---|
| 0 | dừng bình thường (`--once` xong, hoặc đã có một runner khác đang chạy) |
| 2 | thiếu hoặc sai cấu hình |
| 3 | máy chủ từ chối token (thu hồi token = công tắc dừng từ xa) |
| 4 | (`--once`) Claude CLI không chạy được |

## Log

`%USERPROFILE%\.design-agent\logs\runner-<ngày>.log`, giữ 30 ngày. Token không bao giờ xuất hiện (đổi thành `***`).

## Chưa kiểm chứng

Chỉ chạy thật mới biết: một phiên `claude -p` thật với đúng các cờ này trên một job thật (đặc biệt: `dontAsk` cùng các tool cho phép có cho phiên ghi vào thư viện NAS không, `Skill` có nạp skill của người dùng ở chế độ print không, và CLI đang cài có khớp `Bash(*…*)` / `Read(~/…)` đúng như mong đợi không); một vòng Codex thật do phiên khởi động; phiên QA thật có tự đo đủ 8 mục trong thời gian còn lại không; năm phiên chạy cùng lúc; tác vụ Task Scheduler; việc gỡ `.ps-lock` sau một lần diệt thật.

## Test

```
python -m pytest tools/design-agent-runner/tests -q -p no:cacheprovider
```

`tests/fake_claude.py` chọn việc theo từng pha và vòng qua `FAKE_CLAUDE_PLAN` (JSON, ví dụ `{"maker": ["ready"], "qa": ["fail", "pass"]}`), hoặc `FAKE_CLAUDE_MODE` cho mọi phiên.
