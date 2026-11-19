# Design Agent runner

## Nó làm gì

Chạy trên máy tính của shop. Khi designer reject một design (hoặc khi chủ shop bấm giao việc), Ecom Manager xếp một job vào hàng đợi. Runner này hỏi máy chủ xem có job không (long-poll, tối đa 5 job cùng lúc), với mỗi job nó tạo một thư mục riêng và tải về các file hiện tại của task.

- Job `FIX`, `MAKE`, `MOCKUP`: runner điều khiển tối đa 3 vòng. Mỗi vòng có một **phiên sửa** chỉ làm file trong thư mục job — một phiên Claude (prompt `fix` / `make` / `mockup`, mặc định) hoặc một phiên Codex (`MAKER_ENGINE=codex`, prompt `codex-maker`) — rồi một **phiên QA mới**, luôn là Claude (prompt `qa`, không phải phiên đã làm file), chấm theo danh sách kiểm tra cố định. QA đạt thì **chính runner** tải file lên và gửi duyệt; các phiên không bao giờ gọi máy chủ.
- Job `FIX` có `source: "AUTO_HOLD"` mà không có file `PRINT` hiện tại (dòng AUTO bị auto render hằng giờ giữ, chưa từng được đẩy): runner chép bản render bị giữ trong `ARTWORK_BUILDER\flat-text\_out\<TASKKEY>\` (nếu có) sang `current\held\` kèm `index.json`, không đụng bản gốc, rồi chạy như job MAKE (prompt `make` / đoạn MAKE của `codex-maker`, thêm mục "Dòng AUTO bị giữ"; QA chấm như job make). Giao file giữ nguyên: QA, runner tải lên, gửi duyệt về REVIEW.
- Job `LIBRARY_APPLY`: như trước, một phiên duy nhất làm việc, giao file qua `agent_api.py` và ghi `result.json`.

Runner báo nhịp tim mỗi 60 giây, giới hạn 90 phút cho cả job, rồi báo kết quả cho máy chủ. Agent không bao giờ duyệt task, không liên hệ xưởng hay khách: mọi thứ dừng ở REVIEW.

| File | Việc |
|---|---|
| `agent_api.py` | hợp đồng với máy chủ: lớp `AgentApi` (runner dùng để giao file) và CLI (`upload`, `submit`, `reopen`, `note`, `download`) cho phiên `library-apply` và cho người |
| `runner.py` | cấu hình, log, tìm Codex, thư mục job, prompt, dòng lệnh, vòng sửa/QA, kiểm `READY.json` và kết quả QA, giao file, vòng nhận job, khóa, `main` |
| `work_board.py` | bảng việc: đọc hàng duyệt local và danh sách luồng (chỉ đọc), đăng lên máy chủ mỗi 2 phút, kiểm lại hàng duyệt trước khi chạy một job |
| `prompts/fix.md`, `make.md`, `mockup.md` | phiên sửa Claude: chỉ làm file, kết thúc bằng `READY.json` hoặc `result.json` NEEDS_OWNER |
| `prompts/codex-maker.md` | phiên sửa Codex (FIX, MAKE, MOCKUP; runner chỉ giữ đoạn `<!-- kind:… -->` của loại job): đọc SKILL.md và luật của design, sửa ở nguồn dựng lớp trước, cùng hợp đồng `READY.json` / NEEDS_OWNER |
| `prompts/qa.md` | phiên QA độc lập: danh sách kiểm tra 8 mục, ghi `QA-claude/round-N-result.json` |
| `prompts/library-apply.md` | phiên duy nhất của job thư viện (giao qua `agent_api.py`) |
| `install-task.ps1` | đăng ký tác vụ Task Scheduler (chỉ chủ shop chạy); `-PrintOnly` để xem trước |
| `tests/` | test với máy chủ giả, `claude` giả và `codex` giả |

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
| `CODEX_BIN` | đường dẫn `codex.exe`; để trống = bản mới nhất đi kèm app Codex (`%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`) | trống |
| `MAKER_ENGINE` | ai làm phiên sửa của FIX / MAKE / MOCKUP: `claude` hoặc `codex` (QA luôn là Claude, LIBRARY_APPLY không đổi) | `claude` |
| `CODEX_MODEL` | (chỉ khi `codex`) thêm `-m <model>`; trống = model trong `~/.codex/config.toml` của chủ shop | trống |
| `CODEX_EXTRA_ARGS` | (chỉ khi `codex`) cờ thêm cho `codex exec`, tách như shell (dùng `/` trong đường dẫn), ví dụ `-c model_reasoning_effort=high` | trống |
| `ARTWORK_BUILDER` | thư mục gốc chứa thư mục job | `D:\Ecom manager\artwork-builder` |
| `REVIEW_QUEUE_DB` | file `queue.db` của hàng duyệt local (runner chỉ đọc) | `D:\Ecom manager\review-queue\queue.db` |
| `CLAUDE_ALLOWED_TOOLS` | các tool phiên được dùng | `Bash,Read,Write,Edit,Glob,Grep,Skill` |
| `CLAUDE_DISALLOWED_TOOLS` | lệnh phiên bị cấm (cách nhau bằng dấu phẩy; `none` = không cấm) | các script push thẳng DB (`push-local-renders`, `push-shared-prints`, `push_s2n`, `apply_chunk`, `process-new-orders`), `ssh`, `scp`, và mọi lệnh Bash nhắc tới `runner.env`, `.design-agent`, `agent_api` hay đường dẫn `design-agent/runner` của máy chủ, cộng `Read(~/.design-agent/**)` (xem "Rào chắn") |
| `CLAUDE_PERMISSION_MODE` | chế độ quyền | `dontAsk` |
| `CLAUDE_MODEL` | model của phiên sửa và phiên thư viện (tuỳ chọn) | trống |
| `CLAUDE_QA_MODEL` | model của phiên QA | bằng `CLAUDE_MODEL` |
| `JOB_TIMEOUT_MINUTES` | giới hạn thời gian mỗi job | `90` |
| `BASH_TIMEOUT_MS` | thời gian tối đa của một lệnh Bash trong phiên | `600000` (10 phút) |

3. Giữ `claude` đã đăng nhập trên máy này (và Codex, khi `MAKER_ENGINE=codex`).
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
| `round-N\codex-last-message.txt` | Codex (`-o`) | tin nhắn cuối của phiên sửa Codex; chỉ để đọc, không bao giờ là kết quả |
| `QA-claude\round-N-result.json` | phiên QA | `{ "verdict": "PASS" \| "FAIL", "summary": "…", "findings": [ { "piece", "problem", "fix", "passCondition" } ] }` |
| `result.json` | phiên sửa (chỉ `NEEDS_OWNER`) hoặc phiên thư viện | `{ "outcome", "summary", "ask", … }`; `ask` = một câu ngắn cho chủ shop (cần đưa gì / quyết định gì) |
| `session.log` / `session-round-N-maker.log` / `session-round-N-qa.log` | runner | mọi sự kiện stream-json của phiên Claude (với Codex: stdout + stderr của `codex exec`), ghi ngay khi xảy ra, token được che; kết quả không bao giờ lấy từ log |
| `stage.txt` | phiên | bước đang làm (runner xoá trước mỗi phiên) |
| `api-calls.jsonl` | `agent_api.py` | mọi lần phiên thư viện gọi CLI |
| `runner-state.json` | runner | vòng, pha, kết quả QA, kết quả cuối |

Khi job chạy lại (lần 2), mọi file và thư mục của lần trước (`result.json`, `round-N`, `QA-claude`, log, prompt của vòng) được đổi tên thành `prev-<giờ>-…`: lần sau không bao giờ thừa hưởng một vòng cũ.

### FIX, MAKE, MOCKUP: vòng sửa, QA độc lập, runner giao

Mỗi vòng N (1 đến 3), trong cùng một đồng hồ của job (`JOB_TIMEOUT_MINUTES`; mỗi phiên chỉ được phần thời gian còn lại):

1. **Phiên sửa** (`CLAUDE_MODEL`, hoặc Codex khi `MAKER_ENGINE=codex`). Vòng 2 và 3 được dặn đọc `QA-claude/round-<N-1>-result.json` và chỉ sửa các mảnh trong `findings`, bắt đầu từ file của chính nó ở vòng trước. Phiên phải kết thúc bằng đúng một trong hai:
   - `round-N/READY.json` + file trong `round-N/deliver/`. Runner kiểm: đúng `round`, có file, mỗi file nằm trong `round-N/deliver/`, tồn tại, không rỗng, đuôi `.jpg`/`.jpeg`/`.png`, không trùng vùng, có `changed` và `unchanged`; job FIX: vùng in `PRINT` phải có trong file hiện tại của task; job MOCKUP: chỉ file `MOCKUP`.
   - `result.json` với `outcome: "NEEDS_OWNER"`: báo nguyên văn lên máy chủ, không chạy QA. Trường `ask` của phiên (một câu, chỉ nói chủ shop cần đưa gì hoặc quyết định gì) được gửi kèm trong `result.ask`, đã bỏ xuống dòng, cắt còn 160 ký tự; đó là dòng ngắn dành cho nhóm Lark. Kết quả do runner tự viết (QA chưa đạt sau 3 vòng, các lỗi `fail`) không có `ask`.
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

### Phiên sửa bằng Codex (`MAKER_ENGINE=codex`)

Đổi engine: thêm `MAKER_ENGINE=codex` vào `runner.env` rồi khởi động lại runner (cấu hình chỉ đọc lúc khởi động); bỏ dòng đó hoặc ghi `claude` để quay lại. Chỉ phiên sửa của FIX / MAKE / MOCKUP đổi; phiên QA vẫn là một phiên Claude mới (`CLAUDE_QA_MODEL`), LIBRARY_APPLY vẫn là một phiên Claude. Mọi thứ khác giữ nguyên: cùng đồng hồ job, nhịp tim, diệt cả cây tiến trình khi quá giờ hay khi dừng, gỡ `.ps-lock` theo `ps-lock.held`, kiểm `READY.json` / `result.json`, sha256 trước QA, runner giao file.

Dòng lệnh (cwd = thư mục job, stdin đóng, stdout + stderr nối vào `session-round-N-maker.log` với token bị che):

```
<codex.exe> exec -C "<thư mục job>" --skip-git-repo-check --color never --add-dir "<ARTWORK_BUILDER>" -o "<thư mục job>\round-N\codex-last-message.txt" [-m <CODEX_MODEL>] [<CODEX_EXTRA_ARGS>…] "<prompt codex-maker của vòng>"
```

- `--add-dir <ARTWORK_BUILDER>` để `.ps-lock` (nằm ngoài thư mục job) ghi được khi sandbox của Codex là `workspace-write`; với `danger-full-access` nó vô hại.
- Không có cờ model hay sandbox mặc định: Codex chạy với `~/.codex/config.toml` của chính chủ shop, như khi chủ shop dùng hằng ngày (hiện là `danger-full-access`, `approval: never`), tức là **toàn quyền trên máy**. Vì vậy luật "không liên lạc máy chủ, không đọc `runner.env` / `.design-agent`, không chạy file nào trong `tools/design-agent-runner`" với Codex **chỉ là luật trong prompt**, không có danh sách cấm nào ép nó (khác với `--disallowedTools` của phiên Claude). Thứ thật sự giữ an toàn vẫn là cách làm: token không có trong môi trường, phiên không có bước giao nào, runner chỉ giao sau khi một phiên QA Claude khác chấm đạt.
- Môi trường của Codex: như phiên Claude (không `DESIGN_AGENT_TOKEN`), và bỏ thêm mọi biến `CLAUDE*`, `ANTHROPIC*`, `MCP_*`, `DESIGN_AGENT_ENV`, `DESIGN_AGENT_HOME`. Môi trường của phiên Claude không đổi.
- Codex không có skill của Claude: prompt bảo nó đọc `%USERPROFILE%\.claude\skills\processing-litzzy-orders\SKILL.md` và luật của design (`flat-text/<CODE>-RULES.md`, `design-rules/<CODE>.*`) trước, và **sửa ở nguồn dựng lớp** (PSD / TIF trong `//TMTEAM/TEMPLATE/LIBRARY/products/<CODE>` hay `//TMTEAM/TEMPLATE/2026/…`, build script / spec trong `artwork-builder`) thay vì cắt vá tấm in phẳng; không có nguồn thì phải nói trong `changed`.
- Codex thoát trong 90 giây mà không để lại gì, hoặc không khởi động được: `fail` tạm `Codex không chạy được (…)` và ngừng nhận job 30 phút, như với Claude.

### Bảng việc và kiểm tra trước khi chạy (`work_board.py`)

Để bot Lark không giao cho Agent một dòng đã có người làm, runner đăng **toàn bộ bảng việc** của máy này lên máy chủ (`PUT /api/design-agent/runner/board`) ngay khi khởi động và sau đó mỗi 120 giây, trên một luồng riêng; luồng này không bao giờ làm dừng vòng nhận job. Hai nguồn, đều **chỉ đọc**:

- **Hàng duyệt local** (`REVIEW_QUEUE_DB`, mở bằng `file:…?mode=ro`): với mỗi mã dòng trong `item_keys` (một mục nhóm có nhiều mã thì đăng đủ mọi mã), chỉ xét **mục mới nhất** (theo `enteredAt`). Mục đó đang `waiting`, `qa_failed`, `needs_look`, `held`, `rejected`, `fixing` thì đăng một dòng `LOCAL_QUEUE`, worker `Hàng duyệt local`; mục mới nhất đã `cloud` / `approved` / `removed` thì mã đó không còn trên bảng. `etaAt` = `enteredAt` + 1 giờ cho `waiting` và `qa_failed`. `detail` = `statusReason`, không có thì các dòng QA, cắt còn 300 ký tự.
- **Danh sách luồng**: **mọi** thư mục `ARTWORK_BUILDER\_streams-*`, mỗi thư mục đọc riêng. Bảng luồng trong `README.md` (`| số | file.md | …`) cho biết file danh sách của từng luồng; mã dòng là ô đầu của các dòng có dạng `LIT123_1`. Mỗi dòng `KEY | luồng a | luồng b | …` trong `handoff.md` chuyển mã đó sang luồng b. Luồng còn hiệu lực khi file danh sách hoặc một file `progress-luong{n}*.md` được sửa trong 48 giờ qua; luồng hết hiệu lực thì không đăng dòng nào của nó. Khi `README.md` ghi "mọi dòng REJECTED … thuộc luồng n" và luồng n còn hiệu lực, runner gửi `rejectedOwner: "Luồng n"` (nhiều thư mục cùng ghi thì lấy luồng có file sửa gần nhất). Một mã nằm trong danh sách của nhiều luồng còn hiệu lực (cùng hay khác thư mục) thuộc về luồng có file sửa gần nhất; bằng nhau thì luồng phụ trách REJECTED thắng. Thêm file vào một thư mục cũ không làm đổi gì: chỉ giờ sửa của file danh sách và file tiến độ được tính. `detail` ghi `<thư mục>/<file>`.

Không đọc được `queue.db` (hoặc không thấy thư mục `ARTWORK_BUILDER`, không đọc được danh sách luồng, hoặc bảng vượt 5000 dòng): **không đăng gì**, ghi một dòng log; bảng trên máy chủ tự thành cũ sau 10 phút và bot sẽ không kết luận "chưa ai làm". Lỗi lặp lại chỉ ghi log một lần cho tới khi đổi hoặc hết.

Trước **mỗi lần nhận job**, runner thử đọc `queue.db` (cùng cách mở chỉ đọc). Không đọc được: không nhận job, ghi một dòng log, ngừng nhận 300 giây rồi thử lại (job đang chạy không bị ảnh hưởng; `--once` thì thoát luôn, không nhận gì); đọc lại được thì ghi một dòng và nhận tiếp. Thư mục `ARTWORK_BUILDER` có mà không có `_streams-*` nào thì vẫn đăng các dòng của hàng duyệt.

Ngay trước khi chạy một job vừa nhận (mọi loại trừ `LIBRARY_APPLY`), runner đọc lại hàng duyệt: mục mới nhất của dòng đó đang mở và **không phải `held`** thì runner gọi `POST …/jobs/{id}/busy` (`worker: "Hàng duyệt local"`, `detail` = trạng thái, bản, lý do) và không tạo thư mục job, không mở phiên. Mục `held` được đăng (để bot nêu lý do) nhưng không chặn job. Không đọc được hàng duyệt đúng lúc này (hiếm, vì đã kiểm trước khi nhận): không chạy, báo `fail` tạm `không đọc được hàng duyệt local`.

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

## Giới hạn đã biết

- Trường custom trùng tên (ví dụ hai "Custom Name" trên áo jersey: trước và sau): máy chủ dựng `task.customFields` là một object `{ tên: giá trị }` (`src/lib/design-agent/runner.ts`, `customFields[f.key] = f.value`), nên giá trị trước đã bị ghi đè trước khi tới runner. Runner ghi `job.json` đúng như máy chủ gửi và không khôi phục được giá trị đã mất; cần sửa ở máy chủ (gửi danh sách `{ key, value }`).

## Chưa kiểm chứng

Chỉ chạy thật mới biết: một `codex exec` thật với đúng dòng lệnh trên (prompt dài trên dòng lệnh Windows, `-o` khi thư mục `round-N` đã có, Codex có tự đọc SKILL.md và dùng Photoshop / công cụ ảnh của nó trong thời gian còn lại không); một phiên `claude -p` thật với đúng các cờ này trên một job thật (đặc biệt: `dontAsk` cùng các tool cho phép có cho phiên ghi vào thư viện NAS không, `Skill` có nạp skill của người dùng ở chế độ print không, và CLI đang cài có khớp `Bash(*…*)` / `Read(~/…)` đúng như mong đợi không); một vòng Codex thật do phiên khởi động; phiên QA thật có tự đo đủ 8 mục trong thời gian còn lại không; năm phiên chạy cùng lúc; tác vụ Task Scheduler; việc gỡ `.ps-lock` sau một lần diệt thật.

## Test

```
python -m pytest tools/design-agent-runner/tests -q -p no:cacheprovider
```

`tests/fake_claude.py` chọn việc theo từng pha và vòng qua `FAKE_CLAUDE_PLAN` (JSON, ví dụ `{"maker": ["ready"], "qa": ["fail", "pass"]}`), hoặc `FAKE_CLAUDE_MODE` cho mọi phiên. `tests/fake_codex.py` thay `codex.exe` (`Deps.codex_cmd`): `FAKE_CODEX_PLAN` (danh sách theo vòng) hoặc `FAKE_CODEX_MODE` = `ready`, `needs-owner`, `nothing`, `hang`.
