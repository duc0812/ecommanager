# Gửi lần đầu một dòng chưa đi trên đơn Shopify đã fulfilled

- **Ngày:** 11/20/2026, viết lại 11/21/2026 theo ý chủ shop ("các đơn bị hủy task là đang chưa ship mà")
- **Trạng thái:** §2.2 đã làm một phần trên prod 11/22/2026 (504bb5c + 83bdaae, chủ shop: "Trạng thái đơn shopify đã fulfilled chỉ áp dụng được với đơn 1 item thôi"). Các phần §2.3–§2.4 (Shipment.sentAfterFulfilledAt, late_tracking, hiển thị) vẫn là đề xuất, chờ chủ shop duyệt.
- **Khu vực:** Fulfillment / Tracking / Design Studio / Chuyển xưởng
- **Nguồn:** chủ shop 11/20/2026 (LIT5121_1): "Xử lý lại logic hủy task, logic shipping lại… Nếu cần thì thay đổi hoàn toàn sheet tracking của các bên theo logic mới."
- **Liên quan:** `docs/superpowers/specs/2026-09-05-auto-fulfill-tracking-design.md` (Auto Fulfilled từ sheet), NOTES.md "Reopened tasks are never auto-cancelled" (PR 13, prod 11/20/2026), NOTES.md "Line-level export".

## 0. Bản trước viết sai bài toán

Bản 11/20 gọi trường hợp này là **"ship lại"** và đề xuất `Shipment.attempt`, mã xưởng `LIT5121_1_R2`, 3 cột sheet mới. Đó là bài toán **hàng đã giao bị lỗi / thất lạc, phải làm và gửi lần hai** — một bài toán khác, chủ shop chưa yêu cầu. Phần đó dời xuống §6 "Để sau".

Bài toán thật, kiểm tra trên prod 11/21/2026:

- `#LIT5121` có 2 dòng. Dòng 2 (hoodie Mango) đi một kiện `UL624708308YP`. Ngày 10/25 kiện đó được fulfill cho **cả đơn** trên Shopify (trước khi có luật "chỉ fulfill dòng đã export", 11/06), nên dòng 1 (hoodie Merchize) cũng mang tracking Mango dù **chưa từng gửi xưởng nào**: không export, không dòng sheet, không push.
- Task LIT5121_1 bị sync huỷ 10/25, mở lại 11/04 lại bị huỷ, mở lại 11/06 → duyệt → DONE. Hôm 11/20 11:40 UTC có Sleeve v2 tải lên. Dòng vẫn chưa đi Merchize.
- 36 task khôi phục ngày 11/20 (route `restore-unsent`) đều cùng dạng: đơn fulfilled, dòng không có dấu gửi xưởng nào.

Tức là: **không có lần giao thứ hai nào cả. Đây là lần giao đầu tiên của một dòng, trên một đơn mà Shopify đã coi là giao xong.**

## 1. Vấn đề — tool chặn ở đâu

Trên prod (đơn từ 10/01/2026) có **42 dòng** như vậy: đơn fulfilled, dòng không export / không sheet WRITTEN / không push CREATED, task còn mở hoặc DONE — 30 REJECTED (hầu hết REMI10xx Bondre đặt tay), 8 DONE, 4 NEW. Phần lớn thực ra đã được gửi **ngoài tool** (đặt tay Bondre, Mango cùng kiện); tool không biết. Chỉ người làm đơn biết dòng nào thật sự chưa đi, nên mọi bước dưới đây đều do người bấm, không tự động.

| Chỗ | Hôm nay | Hệ quả |
|---|---|---|
| Chuyển xưởng — `readyLines` (`src/lib/line-export.ts`, `isOrderClosed`) và các `where` của hub (`src/lib/supplier-handoff.ts`, `NOT_FULFILLED`, `SEND_STATUSES`) | đơn `pipelineStatus` FULFILLED hoặc `fulfillmentStatus` fulfilled = đơn đóng → không có dòng nào "sẵn sàng" | dòng LIT5121_1 dù DONE **không hiện** trong "Chờ chuyển xưởng", không export CSV, không ghi sheet Jomall/Mango, không push API được |
| Trang đơn / CS agent (`src/lib/cs/order-context.ts` `orderItemsOf`) | dòng lấy tracking theo `Shipment` của chính nó; `Shipment` được dựng từ fulfillment Shopify (`build-shipments.ts`: fulfillment phủ line item nào thì dòng đó mang tracking) | dòng 1 hiện "đã giao UL624708308YP"; chỉ có cảnh báo "không tìm được thông tin gửi xưởng" cho CS |
| Auto Fulfilled (`src/lib/fulfillment/auto-fulfill.ts` `settleFromDb`, `build-fulfill-plan.ts`) | đơn FULFILLED → `already_fulfilled`, bỏ qua mọi dòng sheet của đơn | khi Merchize ghi `#LIT5121_1` + tracking mới vào sheet, tool **không ghi nhận**, Shopify không có số mới, khách không nhận email |
| Shopify | line item đã fulfill không fulfill lần hai được | chỉ còn cách **thêm tracking vào fulfillment cũ** (`fulfillmentTrackingInfoUpdate`, helper `updateFulfillmentTracking` trong `src/lib/shopify-orders.ts`, đang dùng cho last-mile) |
| Task design | task mở lại trên đơn FULFILLED bị sync huỷ | **đã sửa**, prod 11/20/2026 (PR 13 + c751845): task do người mở lại không bao giờ tự huỷ; dòng chưa gửi xưởng giữ task kể cả đơn fulfilled |

Không cần: mã `_R2`, cột sheet mới, `Shipment.attempt`. Mã dòng vẫn là `LIT5121_1` vì xưởng chưa từng thấy nó.

## 2. Đề xuất

### 2.1 Khái niệm: "dòng chưa gửi xưởng trên đơn đã fulfilled"

Một dòng là **chưa gửi xưởng** khi `lineWentToSupplier` (`src/lib/design-tasks.ts`) trả về false: không có dấu export của dòng hay của đơn, không có `SupplierSheetWrite` WRITTEN, và (bổ sung) không có `SupplierOrderPush` CREATED của đúng xưởng phủ dòng đó (`isSentToSupplier` trong `auto-fulfill.ts` đã tính push; gộp hai hàm làm một chỗ duy nhất).

Dòng chưa gửi xưởng + đơn fulfilled + task DONE (người mở lại rồi duyệt) = **"gửi muộn"** (late send). Đây là trạng thái cần xử lý; tool chỉ phát hiện và cho người gửi, không tự gửi.

### 2.2 Chuyển xưởng: chặn theo dòng, không theo đơn

> **Đã làm 11/22/2026 (504bb5c + 83bdaae):** `isLateSendOrder` + `readyLines` (`src/lib/line-export.ts`): đơn không huỷ/hoàn, FULFILLED, nhiều hơn 1 dòng sản phẩm (đếm như `lineKeysOf`, bỏ dòng phí/addon) → offer dòng DONE chưa có dấu xuất (export của đơn kiểu cũ vẫn tính), không dropship, không trong push sống chưa đánh dấu, **không có kiện riêng** (tracking chỉ dùng chung với dòng cùng xưởng = đã gửi ngoài tool). Lần lưu CSV trước không giữ dòng. `pendingHandoffWhere` thêm nhánh cho các đơn này, CSV export không bỏ qua, thẻ mang `LATE_SEND_NOTE`. Không có nhóm hub riêng: dòng nằm trong tab xưởng của nó kèm cảnh báo. Push API dùng cơ chế sẵn có (gửi sau `-R2` nếu cùng xưởng đã có push). Chưa làm: ghi `sentAfterFulfilledAt` và xoá tracking mượn khi gửi (§2.2 đoạn cuối), §2.3, §2.4. Auto Fulfilled không đổi.

- `readyLines`: với đơn fulfilled, thay vì trả `[]`, trả các dòng **chưa gửi xưởng** và task DONE (dòng khác của đơn vẫn bị loại vì đã đi). Đơn CANCELLED / REFUNDED / VOIDED vẫn đóng hẳn.
- Hub "Chờ chuyển xưởng": thêm nhóm **"Đơn đã fulfilled còn dòng chưa gửi"** (query riêng: `fulfillmentStatus` fulfilled + có task DONE + dòng chưa có dấu gửi). Thẻ ghi rõ "Đơn đã giao kiện khác ngày MM/DD/YYYY — dòng này chưa gửi xưởng nào". Không trộn vào nhóm thường để leader nhìn thấy và quyết.
- Export CSV / ghi sheet Jomall–Mango / push API cho dòng này **đúng như lần đầu**: mã `LIT5121_1`, cùng cột, cùng file. Push API: dòng của đơn chưa có push → push mới bình thường; đơn đã có push CREATED của xưởng khác → push mới cho xưởng này (per-supplier như nay); đơn đã có push CREATED của **cùng** xưởng (đã giao) → `externalOrderId = <order>-R2` theo cơ chế sẵn có, không đòi huỷ push cũ (đây là chỗ duy nhất đụng tới hậu tố, và chỉ ở phía API, xưởng không thấy mã dòng khác).
- Khi gửi, tool ghi dấu lên `Shipment` của dòng: **`sentAfterFulfilledAt = now`** (cột mới, xem §3), xoá tracking mượn của kiện cũ trên dòng này (`trackingNumber`, `trackingUrl`, `carrier` về null, `status` PENDING, giữ `shopifyFulfillmentId` để còn biết fulfillment nào phải cập nhật). Một event SYSTEM trên task: "Gửi xưởng <tên> ngày MM/DD/YYYY — đơn đã fulfilled từ trước bởi kiện <số cũ>".

### 2.3 Hiển thị: dòng chưa gửi không được hiện "đã giao"

- `orderItemsOf` (CS agent) và trang đơn: dòng có `Shipment.shopifyFulfillmentId` nhưng **chưa gửi xưởng** → hiện **"Chưa gửi xưởng — đơn được đánh dấu giao bởi kiện <số> (dòng khác)"**, không hiện tracking như của mình. Sau khi gửi (`sentAfterFulfilledAt`), hiện "Đã gửi <xưởng> MM/DD/YYYY, chờ tracking". Có tracking riêng → hiện như dòng thường.
- Sync Shipment từ Shopify (`upsertOrderShipments`): dòng có `sentAfterFulfilledAt` **không** nhận lại tracking của fulfillment cũ; chỉ nhận tracking do Auto Fulfilled / push ghi cho chính nó. Nếu không có cột này, sync 15 phút sẽ ghi đè số cũ trở lại ngay.
- Tracking page của shop (`/apps/trackingorder`) không đổi: số cũ vẫn tra được, số mới thêm vào fulfillment (2.4).

### 2.4 Auto Fulfilled: tracking về cho dòng gửi muộn

Dòng sheet (hoặc tracking push) `LIT5121_1` + số mới, đơn đã FULFILLED:

1. `settleFromDb` / `buildFulfillmentPlan`: trước khi kết luận `already_fulfilled`, xem các `Shipment` của đơn. Nếu dòng sheet trỏ tới một `Shipment` có `sentAfterFulfilledAt` và **chưa có tracking riêng** → nhánh mới **`late_tracking`** thay vì `already_fulfilled`. Đơn fulfilled không có dòng nào như vậy → `already_fulfilled` như nay (không đoán).
2. Áp dụng: `updateFulfillmentTracking` trên `shopifyFulfillmentId` của dòng với `numbers: [số cũ, số mới]` và `urls` tương ứng (mở rộng helper: hôm nay chỉ nhận một `number`; `FulfillmentTrackingInput` của Shopify nhận `numbers`/`urls`). Khách thấy cả hai số trên đơn; dòng 2 cũng thấy hai số — không tránh được vì cùng một fulfillment, ghi rõ trong email CS nếu khách hỏi.
3. `notifyCustomer`: theo câu hỏi 1 (§5). Mặc định đề xuất **bật** — khách đang thiếu hàng, email tracking là thứ họ cần.
4. `Shipment` của dòng: `trackingNumber` mới, `carrier`, `status` FULFILLED, giữ `sentAfterFulfilledAt`. Chạy ParcelPanel / crawl như dòng thường.
5. Luật "chỉ fulfill theo sheet của xưởng đã nhận dòng" (11/06) giữ nguyên: sheet Merchize mới được ghi cho LIT5121_1, sheet Mango ghi `#LIT5121_1` sẽ bị giữ (`needs_manual`).
6. Kết quả hiện trong bảng Auto Fulfilled với trạng thái riêng "Cập nhật tracking (đơn đã fulfilled)" để đếm và soát.

### 2.5 Luồng đầy đủ cho LIT5121_1

1. Task DONE (đã có). Dòng 1 hiện trong hub nhóm "Đơn đã fulfilled còn dòng chưa gửi" với ghi chú kiện cũ. *(mới)*
2. Leader bấm gửi Merchize (push API) như dòng thường. Tool: push CREATED, `Shipment.LIT5121_1.sentAfterFulfilledAt`, xoá số Mango mượn, event trên task. *(mới)*
3. Merchize trả tracking (sync tracking Merchize đã có) → Auto Fulfilled nhánh `late_tracking`: thêm số vào fulfillment cũ, email khách (nếu chủ shop chọn), `Shipment` có số riêng. *(mới)*
4. Trang đơn / CS: dòng 1 "Merchize, <số mới>, đang đi"; dòng 2 "Mango, UL624708308YP, đã giao". *(mới)*

### 2.6 Dọn 42 dòng hiện có

Không tự động. Một route liệt kê (SUPERADMIN, dry-run như `restore-unsent`): đơn fulfilled + dòng chưa gửi xưởng + task không CANCELLED, kèm tracking đang mượn, xưởng map, trạng thái task. Chủ shop / leader duyệt từng dòng:

- **"Đã gửi ngoài tool"** (Bondre đặt tay, Mango cùng kiện…): ghi dấu export của dòng (`OrderLine.exportedAt = <ngày>` + `exportedToSupplierId`, cơ chế có sẵn), kèm event SYSTEM "Chủ shop xác nhận đã gửi <xưởng> ngoài tool" và task → DONE nếu đang mở. Từ đó `lineWentToSupplier` = true, dòng ra khỏi danh sách, tracking đang mang được coi là của nó (đúng với Mango cùng kiện).
- **"Chưa gửi, cần làm"** (LIT5519_2 và những dòng chủ shop chỉ): giữ task, đi luồng 2.2 khi design xong.
- **"Không làm nữa"**: leader "Huỷ task" như nay.

## 3. Thay đổi schema (nhỏ)

```prisma
model Shipment {
  ...
  sentAfterFulfilledAt DateTime?   // dòng được gửi xưởng sau khi đơn đã fulfilled trên Shopify bởi kiện khác
}
```

Một cột, không đổi unique, không backfill. Migration tay (migrate dev im lặng trên PC này), bump `SCHEMA_VERSION`. Không có cột này thì sync Shopify 15 phút ghi đè tracking mượn trở lại và Auto Fulfilled không phân biệt được dòng nào đang chờ số riêng — tránh được bằng cách suy từ ngày export so với ngày fulfillment, nhưng `Shipment` không lưu ngày fulfillment, nên cột rõ ràng rẻ hơn.

Không đổi: sheet ghi cho xưởng (cột, mã), sheet đọc về (2 cột Order Number / Tracking), Bondre 2 số, ParcelPanel, P&L.

## 4. Việc phải làm nếu duyệt (ước lượng 2 PR)

1. **PR A — gửi muộn:** gộp `lineWentToSupplier` + `isSentToSupplier`; `readyLines` theo dòng trên đơn fulfilled; nhóm mới trong hub; dấu `sentAfterFulfilledAt` + xoá tracking mượn khi export / sheet / push; hiển thị "Chưa gửi xưởng" trên trang đơn và CS; sync Shipment không ghi đè; route liệt kê + xác nhận "đã gửi ngoài tool" (§2.6). Migration + `SCHEMA_VERSION`.
2. **PR B — tracking về:** nhánh `late_tracking` trong `buildFulfillmentPlan` / `settleFromDb`; `updateFulfillmentTracking` nhận nhiều số; `notifyCustomer` theo câu trả lời; trạng thái mới trong bảng Auto Fulfilled; test với fixture LIT5121.

Test: `tests/design-task-restore.integration.test.ts` đã có fixture đơn fulfilled + dòng chưa gửi, mở rộng cho `readyLines` và `orderItemsOf`; `build-fulfill-plan.test.ts` thêm case `late_tracking` và case đơn fulfilled không có dòng gửi muộn vẫn `already_fulfilled`.

## 5. Câu hỏi cần chủ shop trả lời

1. **Email khách** khi tracking của dòng gửi muộn về: tool gửi (notifyCustomer bật, khách thấy cả số cũ và số mới) hay chỉ CS báo tay?
2. **42 dòng hiện có:** chủ shop duyệt từng dòng qua route liệt kê (§2.6), hay chỉ cần xử lý LIT5121_1 và LIT5519_2, số còn lại đánh dấu "đã gửi ngoài tool" một lượt?

Hai điểm tôi tự quyết nếu chủ shop không nói khác: cột `Shipment.sentAfterFulfilledAt` (§3) và nhóm riêng trong hub thay vì trộn vào "Chờ chuyển xưởng" (§2.2).

## 6. Để sau — ship lại thật sự (hàng lỗi / thất lạc sau khi đã giao)

Chủ shop chưa yêu cầu. Khi cần, bài toán khác hẳn: dòng **đã** đi một lần, phải đi lần hai, xưởng đã thấy mã `LIT5121_1` nên cần mã mới. Bản 11/20 đã phác: `Shipment.attempt` + unique `(orderId, lineKey, attempt)`, mã `<đơn>_<dòng>_R<lần>` cho sheet ghi / sheet đọc / push, 3 cột sheet (Lần ship / Lý do ship lại / Ngày mở lại), tạo lần giao mới khi duyệt task có lý do "Ship lại — hàng lỗi / thất lạc". Lý do đó và thông báo Lark "ship lại" đã có trên prod từ PR 13; phần dữ liệu và sheet chỉ làm khi chủ shop gọi.
