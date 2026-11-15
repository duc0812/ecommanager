# Duyệt ở máy local trước khi lên Drive (Local Review Queue)

Ngày: 2026-11-15. Trạng thái: chờ chủ shop duyệt. Xây trên "Giao file in qua API" (`2026-11-15-artwork-delivery-api-design.md`, đã deploy ngày 11/15).

## 1. Vì sao làm

Hiện nay file in làm xong ở PC được upload lên Drive và giao lên prod ở trạng thái Chờ duyệt. Người duyệt mở tool trên cloud, chờ ảnh tải về (VPS ở Đức → văn phòng ~265 KB/s, nên tool dùng ảnh thu nhỏ của Google, mà ảnh đó chỉ có sau khi Google xử lý file mới). Bị trả lại thì sửa, xoá, upload lại.

Chủ shop muốn (11/15): "Duyệt xong mới up driver sẽ nhanh hơn là up driver duyệt sửa xóa up lại." Ảnh đọc thẳng từ ổ đĩa PC thì hiện tức thì.

## 2. Quyết định của chủ shop (11/15)

- Cách A: hàng chờ duyệt ở máy local; quá 3 tiếng không duyệt thì chuyển lên duyệt trên cloud.
- Dòng duyệt ở local lên prod là **Đã duyệt luôn**.
- Nhân sự ở ngoài LAN → họ vẫn duyệt trên cloud (dòng quá 3 tiếng). Chỉ chủ shop dùng trang local.
- Agent chỉ **đề xuất sửa**, không được duyệt. Có nút **gọi Agent sửa** (Claude hoặc Codex), sửa xong bản mới về lại hàng chờ.
- Chỉ ở bản local; prod chỉ thêm phần tối thiểu cần cho "duyệt luôn".

## 3. Mục tiêu

1. Mở một dòng trong hàng chờ: file in + mockup hiện dưới 1 giây (đọc từ ổ đĩa, ảnh xem trước tạo sẵn).
2. Duyệt một dòng xong thì trong vài phút dòng đó ở prod là Đã duyệt, có đủ file trên Drive, ghi tên chủ shop là người duyệt.
3. Không có file của một dòng bị trả lại nào lên Drive.
4. Không dòng nào bị kẹt: quá 3 tiếng chưa duyệt (và không đang được agent sửa) thì tự lên prod ở Chờ duyệt.
5. Gọi Agent sửa bằng một nút, kèm lý do; bản sửa quay về đúng dòng, có lịch sử bản.

## 4. Ngoài phạm vi

- Cho nhân sự ngoài LAN mở trang local (Tailscale) — có thể làm sau, dùng chung trang này.
- Thay đổi trang duyệt trên cloud.
- Dòng tạo ra trên cloud (designer upload trên tool) — vẫn như cũ.
- Agent tự duyệt.

## 5. Điều không được xảy ra

- Một dòng vừa được duyệt ở local vừa được giao lên Chờ duyệt (giao hai lần).
- Dòng quá 3 tiếng bị bỏ quên vì trang local không mở hoặc PC vừa khởi động lại.
- Duyệt ở local một dòng mà prod đã có người khác xử lý (đã nhận làm tay, đã huỷ) — phải bị chặn như lệnh giao hiện có.
- Đường duyệt ở local cho phép ai khác ngoài chủ shop duyệt thay (token worker bị lộ thì cũng không biến thành quyền duyệt tuỳ ý — xem 7.4).
- Agent được gọi sửa mà ghi đè file gốc hoặc file của dòng khác.

## 6. Ràng buộc

- Mọi phần mới chạy trên PC chính (Windows). Không thêm việc nặng cho VPS.
- Dùng lại client giao file đã có (`scripts/lib/delivery-client.mjs`, `delivery-drive-upload.mjs`, `api-delivery.mjs`, `plan-to-api.mjs`) và chế độ `--via api` của hai script đẩy.
- Agent: Claude headless (`claude -p`) và Codex desktop (`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe exec`). Server hàng chờ được Windows task khởi chạy (không từ một phiên Claude, nên không bị lỗi lồng phiên). Job bị khoá chặt hơn Designer Agent runner: chỉ đọc/ghi thư mục job (Claude: `--add-dir` chỉ thư mục job, `dontAsk`, không MCP; Codex: `-C <job>`), không có token nào trong môi trường của job.
- Code: xây trong repo chính (nhánh mới từ `origin/main`): `scripts/review-queue/*` và thư viện dùng chung. Cờ `--to-queue` thêm vào hai script đẩy đang chạy ở worktree `peaceful-villani-d3d860` theo đúng cách đã làm với `--via api` (chỉ thêm, import động).
- Chỉ đọc, không sửa: các file nguồn của các luồng khác. Bản agent sửa nằm trong thư mục riêng của hàng chờ.

## 7. Thiết kế

### 7.1 Các phần

| Phần | Ở đâu | Việc |
|---|---|---|
| Hàng chờ | `D:\Ecom manager\review-queue\queue.db` (SQLite) + `items\<id>\v<n>\` | Lưu từng dòng chờ duyệt, các bản, lịch sử |
| Đưa vào hàng chờ | `--via api --to-queue` của hai script đẩy | Thay vì giao, chép file vào hàng chờ |
| Trang duyệt | Server nhỏ `scripts/review-queue/server.mjs`, `http://localhost:3020` | Hiện dòng, nút Duyệt / Trả lại / Gọi Agent sửa |
| Bộ đếm 3 tiếng | `scripts/review-queue/tick.mjs`, Windows task mỗi 10 phút | Giao các dòng quá hạn ở Chờ duyệt |
| Duyệt luôn | Prod: tuỳ chọn `approve` của `commit` | Sau khi ghi file, chuyển task sang Đã duyệt |

### 7.2 Đưa vào hàng chờ

- Hai script đẩy nhận thêm `--to-queue` (chỉ dùng cùng `--via api`). Thay cho bước giao, mỗi dòng API (định dạng `runApiDelivery`) được ghi vào hàng chờ: chép file in/mockup vào `items\<id>\v1\`, tạo ảnh xem trước JPEG 1600 px cho từng file, lưu kèm `taskKey`, `action`, `expectedStatus`, `planIds`, `retire`, đường dẫn spec/ledger gốc, thông tin custom (tên, lựa chọn) lấy từ bản snapshot prod, ảnh khách đặt (preview Customall nếu có), mockup trên store.
- Một dòng đã có trong hàng chờ (chưa duyệt, chưa giao) thì bản mới thay bản cũ thành `v<n+1>`, không tạo dòng thứ hai.
- Auto render hằng giờ dùng `PUSH_VIA=queue` (mới) để đưa dòng vào hàng chờ thay vì giao. Các luồng làm tay dùng `--to-queue` khi chủ shop muốn tự duyệt; không có cờ thì giao thẳng như hôm nay.
- QA của agent: lúc đưa vào hàng chờ, các kết quả kiểm tra máy đã có (safe zone, khung tên, kích thước theo template — các bước trong `auto_render.py` / `safe_zone.py`) được lưu thành danh sách "đề xuất sửa" của bản đó. Không có QA nào thì danh sách rỗng.

### 7.3 Trang duyệt (localhost:3020, chỉ nghe 127.0.0.1)

- Danh sách: dòng đang chờ, sắp theo giờ vào hàng chờ; mỗi dòng hiện còn bao lâu tới mốc 3 tiếng, số đề xuất sửa, trạng thái (chờ / agent đang sửa / đã giao).
- Một dòng: file in và mockup từ ảnh xem trước (mở bản gốc khi bấm), ảnh khách đặt, mockup store, thông tin custom, đề xuất sửa của agent, lịch sử bản.
- **Duyệt**: chạy `runApiDelivery` cho đúng dòng đó với `approve: true` (upload Drive → commit). Thành công → dòng "đã giao, Đã duyệt"; lỗi (stale, sai trạng thái, thiếu phần) → hiện lỗi, dòng ở lại hàng chờ.
- **Trả lại**: nhập lý do; dòng ở lại hàng chờ với cờ "bị trả lại" và **không tính giờ** cho tới khi có bản mới hoặc chủ shop bấm "Cho lên cloud".
- **Gọi Agent sửa** (chọn Claude / Codex, kèm lý do): xem 7.5. Trong lúc agent sửa, không tính giờ.
- **Cho lên cloud ngay**: giao luôn ở Chờ duyệt (như hết 3 tiếng).
- Phím tắt: ←/→ chuyển dòng, D duyệt, T trả lại.

### 7.4 Duyệt luôn (phần duy nhất trên prod)

- `POST …/tasks/[key]/commit` nhận thêm `approve: true` (chỉ với `push` và `replace`).
- Server kiểm tra như hiện nay, ghi file, rồi chuyển task sang Đã duyệt bằng chính đường duyệt của app (`transitionTask(key, actor, { to: 'DONE' })` — giữ mọi bước kiểm tra và hook khi duyệt), với `actor` là người dùng ghi trong `AppSetting delivery.localApprover` (tài khoản của chủ shop). Event thêm: "Duyệt ở máy local".
- Không có `delivery.localApprover`, hoặc người đó không có quyền duyệt → 409 `approve_not_allowed`, không ghi gì.
- Đủ file mà duyệt bị app từ chối (ví dụ kiểm tra cắt in) → file vẫn ghi, task ở Chờ duyệt, trả `warnings` "Không duyệt được: <lý do>"; trang local hiện lý do.
- Duyệt cần token duyệt riêng (mục 12.6), không phải token worker chung. Mỗi lần duyệt có event ghi rõ "Duyệt ở máy local"; tắt được bằng cách xoá `delivery.localApprover`.

### 7.5 Gọi Agent sửa

- Bấm nút → tạo job trong `items\<id>\jobs\<n>\`: `BRIEF.md` (task, lý do của chủ shop, các đề xuất sửa, đường dẫn file bản hiện tại, template, spec flat-text / design-rules nếu có, quy tắc: chỉ ghi trong thư mục job, không đụng NAS/thư viện/prod, xuất file vào `out\` cùng tên phần), bản sao file hiện tại.
- Claude: `claude -p` headless (như Designer Agent runner), Codex: `codex.exe exec -C <job> --skip-git-repo-check -o <last-message> "<đọc BRIEF.md và làm đúng>"`. Chạy nền, một job một lúc, giới hạn 60 phút.
- Xong: file trong `out\` → bản mới `v<n+1>` (QA máy chạy lại nếu có), trạng thái "chờ duyệt lại", đồng hồ 3 tiếng bắt đầu lại. Lỗi/hết giờ → dòng hiện "agent không sửa được" kèm tin nhắn cuối của agent; không tính giờ.

### 7.6 Bộ đếm 3 tiếng

- `tick.mjs` chạy mỗi 10 phút (Windows task "EcomManager Review Queue Tick"): dòng ở trạng thái chờ, không bị trả lại, không đang sửa, vào hàng chờ (hoặc có bản mới) quá 3 tiếng → giao bằng `runApiDelivery` không `approve` (Chờ duyệt). Dùng chung ledger giao của hàng chờ nên không giao hai lần.
- Hàng chờ có khoá (một tiến trình giao một lúc) để Duyệt trên trang và tick không chạy cùng một dòng.
- PC tắt quá 3 tiếng: lần tick đầu sau khi bật giao ngay các dòng quá hạn.

## 8. Các hướng đã cân nhắc

| | Cách | Được | Mất |
|---|---|---|---|
| **A (chọn)** | Hàng chờ local, quá 3 tiếng lên cloud | Ảnh tức thì, không file lỗi trên Drive, không đổi trang cloud | Dòng chỉ được duyệt nhanh khi chủ shop ở máy |
| B | A + nhân sự mở trang local qua Tailscale | Gần như mọi dòng duyệt ở local | Cài Tailscale từng máy, PC phải luôn bật — để sau |
| C | Chỉ làm ảnh trên cloud nhanh hơn | Không đổi quy trình | Vẫn upload trước, file lỗi vẫn lên Drive |

## 9. Kiểm thử và nghiệm thu

- Test cho: đưa vào hàng chờ (bản mới thay bản cũ), duyệt thành công / bị chặn (stale, sai trạng thái), trả lại không tính giờ, agent sửa thành bản mới, tick giao đúng dòng quá hạn và không giao dòng đã duyệt, khoá chống chạy song song, phía server `approve` (có/không `localApprover`, app từ chối duyệt).
- Chạy thử: 3 dòng thật qua hàng chờ — 1 duyệt, 1 trả lại rồi gọi Codex sửa và duyệt, 1 để quá hạn lên cloud.

## 10. Để người xây quyết

- Thư viện SQLite (dùng `@libsql/client` như các script), giao diện trang (HTML tĩnh + fetch là đủ), cách tạo ảnh xem trước (sharp như `stagePreview`).
- Cách lấy ảnh khách đặt và mockup store (thư mục `_pers`, preview Customall đã có trong các luồng).

## 11. Điểm người viết tự quyết (chủ shop chưa nói)

1. Trang là một server Node nhỏ riêng ở cổng 3020, chỉ nghe 127.0.0.1 — không phụ thuộc tool local (code cũ ở peaceful-villani) hay dev.db.
2. Dòng bị trả lại và dòng agent đang sửa không tính giờ (không tự lên cloud) cho tới khi có bản mới hoặc chủ shop bấm "Cho lên cloud".
3. Đồng hồ 3 tiếng tính lại từ đầu khi có bản mới.
4. Các luồng làm tay chỉ vào hàng chờ khi dùng `--to-queue`; auto render vào hàng chờ khi `PUSH_VIA=queue`.
5. Duyệt ở local ghi tên chủ shop qua `AppSetting delivery.localApprover`.
6. Một job agent một lúc, tối đa 60 phút.

## 12. Trả lời các câu hỏi của người soát (người viết tự quyết)

1. **Render lại mỗi giờ:** auto render bỏ qua dòng đã có trong hàng chờ (mọi trạng thái, kể cả bị trả lại). Một bản chỉ tính là bản mới khi nội dung file khác (so sha256); bản giống hệt không tạo `v<n+1>`, không đặt lại đồng hồ.
2. **Nhóm dùng chung (đơn không custom):** nhóm chỉ dùng lại một file đã có trên Drive (không có art mới) không vào hàng chờ — giao thẳng như hôm nay. Nhóm có art mới (dòng đầu upload) vào hàng chờ như **một mục**: một lần Duyệt / Trả lại cho cả nhóm, xem trước bằng file của dòng đầu. Hàng chờ dùng chung ledger của script đẩy (`<out>/api-ledger.json`) để các dòng sau tìm được mã Drive của dòng đầu.
3. **Duyệt luôn, thứ tự:** bấm Duyệt → gửi `dryRun` trước; nếu dòng sẽ không lên được Chờ duyệt (thiếu phần, sai trạng thái) thì báo lỗi, **không ghi gì**, không upload. Gửi lại một lần đã ghi (`alreadyApplied`) có `approve: true` thì server duyệt nếu task đang Chờ duyệt (che trường hợp mất phản hồi giữa ghi và duyệt). `replace` trên dòng Đã duyệt: `approve` bị bỏ qua (dòng vẫn Đã duyệt).
4. **Prod biết dòng đang chờ duyệt local:** lúc vào hàng chờ, thêm một ghi chú hệ thống lên task trên prod: "Đang chờ chủ shop duyệt ở máy local (tối đa 3 giờ)" (route mới `POST …/delivery/tasks/[key]/note`, cùng token). Không đổi trạng thái task.
5. **Tick gặp dòng đã bị đổi trên prod (stale/sai trạng thái):** dừng đồng hồ, chuyển dòng sang mục "Prod đã thay đổi — cần xem" trên trang; không giao, không xoá. Chủ shop chọn "Bỏ khỏi hàng chờ" hoặc "Lập lại từ snapshot mới".
6. **Token duyệt riêng:** `approve: true` chỉ được nhận khi request mang thêm header `X-Delivery-Approve` là một token riêng (hash trong `AppSetting delivery.approveTokenHash`), tạo trên PC chính và chỉ lưu ở đó (`%USERPROFILE%\.review-queue\approve.env`). Token worker chung (đang dùng cho artwork worker, auto render) không đủ để duyệt.
7. **Job agent:** khoá như mục 6 (ràng buộc); không dùng nguyên cấu hình của Designer Agent runner (runner đó được ghi prod).

## 13. Dòng auto render bị kiểm tra báo lỗi (chủ shop chốt 11/15: "Vào hàng chờ local")

- Dòng mà kiểm tra của auto render báo lỗi (tên tràn khung, lệch khổ, không đo được…) **vào hàng chờ local** thay vì báo `/hold` lên prod. Lỗi của kiểm tra là "đề xuất sửa" của bản đó; dòng mang nhãn **Lỗi QA**.
- Dòng Lỗi QA không có nút Duyệt cho tới khi có bản mới qua kiểm tra (hoặc chủ shop bấm "Duyệt dù có lỗi" — cần xác nhận lần hai).
- Người viết tự quyết: dòng Lỗi QA **không tự lên cloud ở Chờ duyệt**. Nếu 3 tiếng không ai đụng tới, nó được báo `/hold` lên prod như hôm nay (để Designer Agent / nhân sự trên cloud xử lý), và rời hàng chờ local.
- Gọi Agent sửa xong, bản mới chạy lại kiểm tra của auto render (cùng hàm trong `auto_render.py` / `safe_zone.py`, gọi qua một lệnh `auto_render.py --qa-item <thư mục bản>` mới); qua kiểm tra thì nhãn Lỗi QA bỏ đi.
