# Design Agent runner

## Nó làm gì

Chạy trên máy tính của shop. Khi designer reject một design (hoặc khi chủ shop bấm giao việc), Ecom Manager xếp một job vào hàng đợi. Runner này hỏi máy chủ xem có job không (long-poll, tối đa 5 job cùng lúc), với mỗi job nó tạo một thư mục riêng, tải về các file hiện tại của task, rồi mở một phiên Claude Code chạy ngầm với một trong bốn prompt cố định (`fix`, `make`, `mockup`, `library-apply`). Phiên đó làm việc, giao file qua `agent_api.py`, và ghi `result.json`. Runner báo nhịp tim mỗi 60 giây, giới hạn 90 phút, đọc `result.json` rồi báo kết quả cho máy chủ. Agent không bao giờ duyệt task, không liên hệ xưởng hay khách: mọi thứ dừng ở REVIEW.

| File | Việc |
|---|---|
| `agent_api.py` | hợp đồng với máy chủ: lớp `AgentApi` (cho runner) và CLI cho phiên (`upload`, `submit`, `reopen`, `note`, `download`) |
| `runner.py` | cấu hình, log, tìm Codex, thư mục job, prompt, dòng lệnh, một job từ nhận đến báo, vòng nhận job, khóa, `main` |
| `prompts/fix.md`, `make.md`, `mockup.md`, `library-apply.md` | nội dung cố định mỗi phiên nhận được |
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
| `CLAUDE_DISALLOWED_TOOLS` | lệnh phiên bị cấm (cách nhau bằng dấu phẩy; `none` = không cấm) | các script push thẳng DB (`push-local-renders`, `push-shared-prints`, `push_s2n`, `apply_chunk`, `process-new-orders`), `ssh`, `scp` |
| `CLAUDE_PERMISSION_MODE` | chế độ quyền | `dontAsk` |
| `CLAUDE_MODEL` | model (tuỳ chọn) | trống |
| `JOB_TIMEOUT_MINUTES` | giới hạn thời gian mỗi job | `90` |
| `BASH_TIMEOUT_MS` | thời gian tối đa của một lệnh Bash trong phiên | `3600000` |

3. Giữ `claude` đã đăng nhập trên máy này.
4. Chạy runner từ một bản checkout của commit đã duyệt, và không phiên nào được đổi nhánh trong thư mục đó (prompt được đọc lại cho mỗi job). Không bao giờ khởi động runner từ bên trong một phiên Claude Code.
5. Lần đầu chạy có người xem, từ terminal thường: `python tools\design-agent-runner\runner.py --once`
6. Sau đó mới đăng ký tác vụ: `powershell -ExecutionPolicy Bypass -File tools\design-agent-runner\install-task.ps1` (chỉ chủ shop, hoặc agent theo lời chủ shop). Xem trước: thêm `-PrintOnly`.

## Một job chạy thế nào

Thư mục job: `<ARTWORK_BUILDER>\<MÃ TASK>-agent-<id job>\`, gồm: `job.json` (toàn bộ ngữ cảnh; chữ của designer chỉ nằm ở đây, là dữ liệu), `current\` (file hiện tại của task + `index.json`), `prompt.md`, `session.log` (token được che), `stage.txt` (phiên ghi bước đang làm), `QA-claude\`, `round-N\`, `result.json`, `api-calls.jsonl` (mọi lần phiên gọi `agent_api.py`), `runner-state.json`. Tên thư mục có dạng `…-agent-…` nên disk-janitor dọn sau 24 giờ kể từ khi dòng được gửi xưởng.

Dòng lệnh (cwd = `PROJECT_DIR`, stdin đóng):

```
claude -p "<prompt>" --output-format json --permission-mode dontAsk --allowedTools Bash Read Write Edit Glob Grep Skill --disallowedTools "Bash(*push-local-renders*)" … --add-dir "<thư mục job>" "<ARTWORK_BUILDER>" [--model <CLAUDE_MODEL>]
```

- Nhịp tim mỗi 60 giây, kèm bước đọc từ `stage.txt` và số vòng (số thư mục `round-N`).
- Quá 90 phút: diệt cả cây tiến trình, báo `fail` vĩnh viễn (không chạy lại mù).
- Phiên kết thúc trong 90 giây mà không có `result.json`: coi là Claude CLI không chạy được (chưa đăng nhập, hết hạn mức); báo `fail` tạm và ngừng nhận job 30 phút.
- Máy chủ trả 409 cho nhịp tim: server không còn giữ job, phiên bị diệt, không báo gì thêm.
- Máy chủ trả 401: token bị thu hồi, diệt mọi phiên, runner thoát với mã 3.
- Phiên có `result.json` hợp lệ: báo `result` với đúng `outcome`, `summary`, `rounds` và các trường còn lại. File sai dạng: `fail` vĩnh viễn.
- Phiên kết thúc mà không có `result.json`: `fail` tạm. **Thiếu result.json là lỗi, không bao giờ là xong.**
- Mã task hoặc id job không an toàn làm tên thư mục: từ chối ngay, không tạo thư mục.
- Khi phiên bị diệt lúc đang giữ `.ps-lock` của Photoshop, runner gỡ khóa chỉ khi thư mục job có file `ps-lock.held`; khóa không có dấu của job thì để yên.

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

Chỉ chạy thật mới biết: một phiên `claude -p` thật với đúng các cờ này trên một job thật (đặc biệt: `dontAsk` cùng các tool cho phép có cho phiên ghi vào thư viện NAS không, và `Skill` có nạp skill của người dùng ở chế độ print không); một vòng Codex thật do phiên khởi động; năm phiên chạy cùng lúc; tác vụ Task Scheduler; việc gỡ `.ps-lock` sau một lần diệt thật.

## Test

```
python -m pytest tools/design-agent-runner/tests -q
```
