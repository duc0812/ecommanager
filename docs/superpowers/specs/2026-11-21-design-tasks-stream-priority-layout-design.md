# Design Tasks — bố cục "luồng việc → nhóm ưu tiên" (Phương án C)

Ngày: 2026-11-21 · Trạng thái: **owner đã duyệt 11/21/2026 · đã code, xem plan `docs/superpowers/plans/2026-11-21-design-tasks-stream-priority-layout.md`** · Trang: `/design-studio` (`src/app/design-studio/page.tsx`)
Demo bấm được: `docs/superpowers/mockups/2026-11-20-design-tasks-layout-demo.html` (nút "Phương án C").

## 1. Mục đích và lý do

Trang Design Tasks hiện xếp task theo **trạng thái** (Bị trả lại / Đang hỏi khách / Mới / Đang làm / Chờ duyệt / Xong hôm nay) trong một cột 290px, còn hàng chip phía trên trộn ba thứ khác nhau: độ sẵn sàng (Tự động đạt / Cần chỉnh / Làm tay), "Của tôi", và các màn khác (Duyệt mẫu / Duyệt sản xuất / Đã chuyển xưởng). Các vấn đề thực sự chặn việc — dòng chưa map xưởng, chưa có template in, task quá hạn SLA — chỉ hiện sâu trong chi tiết task hoặc ở trang Dashboard / Tồn đọng, không hiện trên danh sách.

Owner muốn **phân cấp dữ liệu để xử lý**: nhìn vào là biết luồng nào cần ưu tiên. Cấp 1 là *luồng việc* (ai làm: mapping, template, file in, duyệt, gửi xưởng), cấp 2 là *nhóm ưu tiên* trong luồng (gấp → sắp quá hạn → còn hạn). Ví dụ owner đưa: trong Files in có "files in gấp", "files in cần sửa gấp (bị reject nhưng quá hạn)"; trong Duyệt mẫu có "quá hạn cần duyệt gấp", "sắp quá hạn cần duyệt".

## 2. Mục tiêu · Không làm · Phải tránh

**Mục tiêu**
- Mỗi task mở nằm trong đúng **một** luồng và đúng **một** nhóm ưu tiên; số đếm trên stepper và trên các chip cộng lại bằng danh sách đang hiện.
- Người làm mở luồng của mình là thấy việc gấp ở trên cùng, không phải cuộn hay mở từng task để biết nó vướng gì.
- Giữ nguyên mọi nghiệp vụ hiện có: trạng thái task, chuyển trạng thái, cách tính độ sẵn sàng, nội dung workspace, thẻ duyệt, thẻ gửi xưởng, bảng đã chuyển xưởng, đồng bộ task, tìm kiếm.

**Không làm**
- Không thêm trạng thái task mới, không đổi máy trạng thái, không đổi SLA.
- Không sửa trang Dashboard, Tồn đọng, Sản phẩm, trang mapping; chỉ liên kết sang.
- Không đổi bố cục bên trong workspace (TaskHeader, ImagePanes, LowerGrid) ngoài các băng cảnh báo ở đầu.
- Không đụng bot Lark / Design Agent work board / Trello.

**Phải tránh**
- Một task xuất hiện ở hai luồng, hoặc biến mất khỏi mọi luồng.
- Xếp luồng theo `DesignTask.supplierSnapshot` (ảnh chụp lúc sync, có thể cũ) thay vì mapping hiện tại của dòng đơn.
- API danh sách chậm đi rõ rệt vì tra template từng task một.

## 3. Ràng buộc

- Next.js, mọi page `'use client'`, Tailwind token trong `tailwind.config.ts`, icon `material-symbols-outlined`, pattern card / section header / button như `CLAUDE.md`.
- API: `GET /api/design-studio/tasks` (list), `GET /api/design-studio/tasks/review`, `GET /api/design-studio/handoff` (+ `?view=sent`). Quyền qua `API_ACCESS_RULES`, không đổi.
- Test không đụng `dev.db`; integration test tự tạo fixture.
- Ngày giờ hiển thị kiểu US (en-US).
- Chữ trên UI tiếng Việt.

## 4. Các phương án đã cân nhắc

| | Mô tả | Được | Mất |
|---|---|---|---|
| **A** | Giữ 2 cột, thêm stepper 4 bước + hàng tab trạng thái có số đếm + hàng lọc riêng | Ít thay đổi nhất, quen tay | Vẫn xếp theo trạng thái, việc gấp và việc bị chặn không nổi lên |
| **B** | Bảng rộng toàn chiều ngang kiểu Etsy, bấm dòng mở workspace toàn màn | Nhìn được nhiều cột | Mất cảnh "danh sách + workspace cùng lúc" mà designer cần khi làm liên tục |
| **C** (chọn) | Stepper 6 luồng việc; trong luồng chia nhóm ưu tiên; cột danh sách gom theo nhóm; bộ lọc độ sẵn sàng và "Của tôi" thành lọc phụ | Đúng cách owner muốn phân cấp dữ liệu; mỗi người thấy luồng của mình và việc gấp trước | Bỏ hàng tab trạng thái (trạng thái vẫn hiện bằng pill trên từng dòng); API danh sách phải trả thêm 2 cờ |

Một bản trung gian của C (một dải "Cần xử lý" 7 ô song song với tab trạng thái) đã bị owner bác vì trùng lặp giữa các hàng; bản chốt là phân cấp hai tầng như dưới đây.

## 5. Thiết kế đã chốt

### 5.1 Cấp 1 — luồng việc (stepper 6 bước)

Thứ tự đúng theo pipeline: **Mapping → Template → Files in → Duyệt mẫu → Duyệt sản xuất → Đã chuyển xưởng**.

Quy tắc xếp một task mở (status ∈ NEW, ASSIGNED, DOING, REVIEW, REJECTED, ASK_CUSTOMER) vào luồng — xét theo thứ tự, vướng gì thì tính luồng đứng trước:

| Luồng | Điều kiện | Ai làm |
|---|---|---|
| Mapping | dòng đơn chưa có xưởng: `OrderLine.resolvedSupplierId == null` | fulfillment / leader |
| Template | đã có xưởng, `templateForLine(...) == null`, **và task chưa bắt đầu** (`status` ∈ NEW, ASSIGNED) | leader / người dựng template |
| Duyệt mẫu | `status == REVIEW` | leader |
| Files in | mọi task mở còn lại (NEW, ASSIGNED, DOING, REJECTED, ASK_CUSTOMER) | designer |
| Duyệt sản xuất | theo **đơn**, từ `listHandoffCards` như hiện nay (không phải task) | fulfillment |
| Đã chuyển xưởng | theo đơn, từ `listSentCards` như hiện nay | theo dõi |

Task không có template nhưng đã bắt đầu (DOING, REVIEW, REJECTED, ASK_CUSTOMER) **ở lại** Files in / Duyệt mẫu: làm tay không template là luồng hợp lệ lâu nay (khoảng 30% task mở, chủ yếu Jomall và Mangoshao với SKU chỉ theo size; `requiredSlotsFor` trả rỗng, thẻ duyệt vẫn cho duyệt). Dòng của chúng mang pill "chưa template" (owner chốt 11/21/2026). Mapping thì ngược lại bắt mọi task mở chưa có xưởng, kể cả đang làm hay chờ duyệt, vì không có xưởng thì không biết template nào và không gửi xưởng được.

Mỗi bước trên stepper hiện: icon luồng, tên, tổng số (task hoặc đơn), và nhãn đỏ "N gấp" = số phần tử đã quá hạn trong luồng (0 thì không hiện). Bước đang xem tô màu secondary; **không** đánh dấu check cho bước đứng trước (stepper ở đây là chuyển màn, không phải tiến độ của một đơn). Stepper được phép xuống dòng khi màn hẹp.

Task DONE trong ngày không thuộc luồng nào ở trên; chúng hiện ở nhóm cuối "Xong hôm nay" của luồng Files in (giữ đầu mục cũ), không tính vào số "task mở".

### 5.2 Cấp 2 — nhóm ưu tiên trong luồng

Mức khẩn của một task lấy từ `dueAt`, dùng đúng ngưỡng của `timeLeft` trong `components/model.ts` (một nguồn duy nhất): **gấp** = đã quá hạn; **sắp quá hạn** = còn ≤ 4h; **còn hạn** = phần còn lại, kể cả chưa đặt hạn. Trong một nhóm, task xếp theo hạn gần lên trước (như `byDue` hiện có).

| Luồng | Nhóm, theo thứ tự ưu tiên (trái → phải, trên → dưới) |
|---|---|
| Files in | **Files in gấp** (NEW/ASSIGNED/DOING, quá hạn) · **Files in cần sửa gấp** (REJECTED, quá hạn) · Sắp quá hạn (NEW/ASSIGNED/DOING, ≤ 4h) · Cần sửa (REJECTED, còn hạn) · Chờ khách trả lời (ASK_CUSTOMER, mọi hạn) · Còn hạn (NEW/ASSIGNED/DOING còn lại) · Xong hôm nay (DONE hôm nay) |
| Mapping | **Cần mapping gấp** · Sắp quá hạn · Còn hạn |
| Template | **Thiếu template gấp** · Sắp quá hạn · Còn hạn |
| Duyệt mẫu | **Quá hạn — cần duyệt gấp** · Sắp quá hạn — cần duyệt · Còn hạn |
| Duyệt sản xuất | **Quá hạn — cần gửi xưởng gấp** · Sắp quá hạn · Còn hạn (theo đơn, xem 5.5) |
| Đã chuyển xưởng | giữ nguyên các tab giai đoạn hiện có (`SENT_STAGE_LABELS`: Chờ xuất CSV, Đã xuất CSV, Đã gửi API…, Có tracking…) |

Màu nhóm: gấp = tone `bad` (đỏ), sắp quá hạn = `warn` (vàng), còn lại = `idle`. Task thuộc nhóm đầu tiên khớp điều kiện.

### 5.3 Bố cục trang (trên → dưới)

1. **Header** như hiện nay: tiêu đề, người xem, "Đồng bộ lần cuối", nút "Đồng bộ task".
2. **Stepper 6 luồng** (5.1) — thay cho các nút Duyệt mẫu / Duyệt sản xuất / Đã chuyển xưởng ở hàng chip cũ.
3. **Hàng nhóm ưu tiên** của luồng đang xem: tiêu đề luồng + ai làm + tổng; chip "Tất cả N" rồi một chip mỗi nhóm với số đếm (chip 0 làm mờ); bấm chip để lọc danh sách theo nhóm, bấm lại để bỏ. Bên phải cùng hàng là **lọc phụ**: chip Tự động đạt / Cần chỉnh / Làm tay (bật/tắt một cái) và Của tôi — chỉ hiện ở Mapping / Template / Files in / Duyệt mẫu. Số trên các chip nhóm phản ánh lọc phụ đang bật, để số luôn khớp danh sách. Với Đã chuyển xưởng, hàng này chỉ là tiêu đề; tab giai đoạn nằm trong `SentGrid` như cũ.
4. **Thân trang** tùy luồng:
   - Mapping / Template / Files in: lưới `290px + phần còn lại` như hiện nay — cột trái là `Queue` (ô tìm kiếm ở đầu cột như hiện có, danh sách gom theo nhóm ưu tiên với tiêu đề nhóm tô màu theo tone), bên phải là workspace của task đang chọn.
   - Duyệt mẫu: cột trái `Queue` (task REVIEW gom theo nhóm), bên phải `ReviewGrid` hiện các thẻ duyệt gom theo cùng nhóm, có tiêu đề nhóm; bấm chip nhóm lọc cả hai bên.
   - Duyệt sản xuất: không có cột trái; `HandoffGrid` toàn chiều ngang, thẻ đơn gom theo nhóm ưu tiên với tiêu đề nhóm.
   - Đã chuyển xưởng: không có cột trái; `SentGrid` toàn chiều ngang như hiện nay.

Hàng chip cũ (độ sẵn sàng + Của tôi + chuyển màn) và các đầu mục trạng thái trong cột trái bị thay bằng 2 và 3 ở trên. Dòng task trong `Queue` giữ nguyên nội dung (ảnh, mã, hạn, sản phẩm, pill độ sẵn sàng, pill trạng thái, avatar).

**Tìm kiếm:** khi ô tìm kiếm có chữ, danh sách bỏ gom theo luồng/nhóm và hiện kết quả toàn cục như hôm nay (kể cả các mục Đã duyệt / Đã huỷ) — tìm kiếm là tra cứu, không phải hàng đợi làm việc. Xoá chữ thì về lại luồng đang xem.

### 5.4 Băng cảnh báo trong workspace (`Flags`)

Thêm vào đầu workspace, trên băng "Bị trả lại" hiện có:
- **Quá hạn**: băng đỏ "Quá hạn Nh — cần file in gấp" (ở Mapping: "cần mapping gấp"; Template: "cần dựng template gấp"; Duyệt mẫu: "cần duyệt gấp"), kèm hành động sẵn có của task (Nhận task / Bắt đầu làm / Render tự động).
  - Ghi chú khi code: băng quá hạn không có nút riêng vì `TaskHeader` ngay bên dưới đã mang sẵn các hành động của task.
- **Đang vướng** (băng vàng): "chưa map xưởng → Mở Product Mapping (`/fulfillment/mapping`)" và/hoặc, với task ở luồng Template, "chưa có template in → Mở Tồn đọng (`/design-studio/backlog`) · Mở trang sản phẩm (`productPageUrl`)"; kèm dòng "Task này không render tự động được cho tới khi gỡ xong". Task **đã bắt đầu** mà không có template chỉ có băng vàng ngắn "Không có template — tự kiểm tra khổ file trước khi gửi duyệt" (cùng ý với cảnh báo đang có trên thẻ duyệt), không có dòng "không render tự động".
- **Cần chỉnh** (băng vàng, readiness LOW, không vướng gì): "máy đã render file tự động, sửa tay rồi mới gửi duyệt".

### 5.5 API

- `GET /api/design-studio/tasks`: mỗi `TaskRow` thêm `hasSupplier: boolean` (từ `OrderLine.resolvedSupplierId`, đã nằm trong `order.lines` mà `listTasks` load sẵn) và `hasTemplate: boolean` (`templateForLine` ≠ null). Tra template phải **theo lô** (gom dòng theo store rồi gọi `loadTemplateContext` một lần mỗi store, như `src/lib/artwork-slots.ts` đang làm), không gọi từng task. Trả thêm `handoffOverdue: number` cạnh `handoffCount` để stepper hiện "N gấp" cho Duyệt sản xuất mà không phải mở màn đó.
- `GET /api/design-studio/handoff`: mỗi `HandoffCard` thêm `dueAt: string | null` = hạn **sớm nhất** trong các design task của đơn (bỏ task CANCELLED). Owner chốt 11/21/2026: mức gấp của Duyệt sản xuất chính là mức quá hạn design của đơn, tính từ lúc khách đặt — đơn quá hạn design bao nhiêu thì ở đây hiện đúng bấy nhiêu, không có đồng hồ riêng cho khâu gửi xưởng và không thêm setting. Chấp nhận rằng phần lớn đơn chờ gửi sẽ ở nhóm gấp: đó là điều owner muốn nhìn thấy. Nhóm ưu tiên ở 5.2 cho Duyệt sản xuất tính từ `dueAt` này, cùng ngưỡng với các luồng khác.
- Việc xếp luồng và nhóm làm ở client bằng hàm thuần trong `components/streams.ts` (`streamOf(task)`, `groupOf(defs, item, now?)`, `urgencyOf(dueAt, now?)`), có unit test. API `review` và `sent` không đổi hình dạng (thẻ duyệt đã có `task.dueAt`).
- Các field thêm vào đều là bổ sung; client cũ (work board, bot) không hỏng.

### 5.6 URL và trạng thái

- `?stream=FILE|MAP|TPL|REVIEW|HANDOFF|SENT` (mặc định `FILE`) và `?group=<id nhóm>`; `?task=` giữ như cũ. Mở link có `task` thì trang tự chuyển sang luồng chứa task đó; `task` thắng `stream` khi hai tham số mâu thuẫn.
- Lọc phụ và chữ tìm kiếm không lên URL.

**Mở workspace ở luồng không có ô workspace** (quyết định của tôi sau builder check):
- Duyệt mẫu: bấm một dòng trong cột trái hoặc "Mở task" trên thẻ duyệt thì workspace của task **thay chỗ** `ReviewGrid` ở khung phải, có nút "← Thẻ duyệt" để quay lại lưới; cột trái và hàng nhóm ưu tiên giữ nguyên. Duyệt / Trả lại trong workspace vẫn hoạt động như hôm nay.
- Duyệt sản xuất, Đã chuyển xưởng và mọi link `?task=` từ nơi khác (Dashboard, redirect `/design-studio/[orderId]`, kết quả tìm kiếm Đã duyệt / Đã huỷ): trang chuyển sang luồng chứa task rồi mở workspace. Task không thuộc luồng nào (DONE trước hôm nay, CANCELLED) mở trong luồng **Files in** với workspace hiện đầy đủ; cột trái giữ danh sách của luồng, không chèn task đó vào, và đầu workspace có một dòng "Task này đã duyệt / đã huỷ, không nằm trong hàng đợi". Các việc chỉ làm được trong workspace (Sửa &amp; gửi lại, Hỏi khách, ghi chú CS, giao việc, file, lịch sử) nhờ vậy vẫn tới được từ mọi link cũ.

### 5.7 Giữ nguyên

Trạng thái và chuyển trạng thái; cách tính readiness; `Queue` row; `TaskHeader` / `ImagePanes` / `LowerGrid`; nội dung thẻ `ReviewGrid`, `HandoffGrid`, `SentGrid`; nút đồng bộ và nhãn "Đồng bộ lần cuối"; tự chọn task đầu tiên khi task đang chọn rời khỏi danh sách; Drive badge polling; quyền API.

## 6. Quyết định sau builder check (11/21/2026)

1. **Luồng Template chỉ bắt task chưa bắt đầu** (NEW / ASSIGNED). Task không template đã làm dở ở lại Files in / Duyệt mẫu với pill "chưa template" — owner chốt. Lý do: khoảng 30% task mở không resolve được template và vẫn được làm tay hợp lệ; kéo chúng sang Template sẽ làm leader không thấy mẫu chờ duyệt.
2. **Mức gấp của Duyệt sản xuất = mức quá hạn design của đơn** (hạn sớm nhất của task, tính từ lúc khách đặt), không có đồng hồ riêng cho khâu gửi xưởng — owner chốt, dù reviewer lưu ý phần lớn đơn chờ gửi sẽ hiện đỏ (486/691 task đã duyệt được duyệt sau hạn).
3. **Mở workspace ở luồng không có ô workspace** — quyết định của tôi, mô tả ở 5.6: Duyệt mẫu thì workspace thay chỗ lưới thẻ, có nút quay lại; task ngoài mọi luồng mở trong Files in kèm ghi chú.

## 7. Để builder quyết

- Tách component (`StreamStepper`, `PriorityRow`, helper gom nhóm cho `Queue` / `ReviewGrid` / `HandoffGrid`) và cách truyền định nghĩa nhóm.
- Cách gom lô tra template trong `listTasks` (theo store hay theo đơn) và có cache trong một request hay không; mục tiêu: danh sách ~300 task mở trả về không chậm hơn rõ rệt so với hiện nay.
- Số đếm cho bước Đã chuyển xưởng (có thể bỏ số hoặc thêm một count rẻ).
- Kiểu dáng chip / tiêu đề nhóm trong giới hạn token hiện có; cách stepper xuống dòng ở màn hẹp.
- Fixture cho integration test của hai cờ `hasSupplier` / `hasTemplate` và của `dueAt` trên thẻ gửi xưởng.
