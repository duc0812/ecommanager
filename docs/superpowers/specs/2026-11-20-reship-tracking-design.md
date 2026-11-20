# Ship lại một dòng đơn — nhiều lần giao, tracking riêng từng lần

- **Ngày:** 11/20/2026
- **Trạng thái:** Đề xuất — chờ chủ shop duyệt trước khi đổi schema / sheet
- **Khu vực:** Fulfillment / Tracking / Design Studio
- **Nguồn:** chủ shop 11/20/2026 (LIT5121_1): "Xử lý lại logic hủy task, logic shipping lại… Nếu cần thì thay đổi hoàn toàn sheet tracking của các bên theo logic mới."
- **Liên quan:** `docs/superpowers/specs/2026-09-05-auto-fulfill-tracking-design.md` (Auto Fulfilled từ sheet), `docs/superpowers/specs/2026-05-19-fulfillment-pod-design.md`, NOTES.md "Design Studio → Task sync" và "Line-level export".

## 1. Vấn đề

Hôm nay tool chỉ biết **một lần giao cho mỗi dòng**:

| Chỗ | Hôm nay | Hệ quả khi ship lại |
|---|---|---|
| `Shipment` | 1 dòng / (order, lineKey) — unique `orderId_lineKey` | tracking mới **ghi đè** tracking cũ (sheet, sync Shopify) hoặc **bị bỏ** (`upsertLineTracking` bỏ qua khi dòng đã có fulfillment + tracking) |
| Auto Fulfilled (sheet đọc về) | đơn đã FULFILLED → `already_fulfilled`, bỏ qua dòng | tracking ship lại trên sheet **không bao giờ** lên Shopify, khách không biết |
| Shopify | 1 line item chỉ fulfill được 1 lần | chỉ còn cách **cập nhật tracking** trên fulfillment cũ (`fulfillmentTrackingInfoUpdate`, có sẵn trong `push-lastmile.ts`) |
| Push API (Merchize, Bondre, CatKissFish, Printway, Pgprints) | 1 push sống / (order × supplier); gửi lại = `<order>-R2` nhưng **chỉ khi push cũ đã huỷ** | push cũ đã giao nên không huỷ được → không gửi lại qua API |
| Task design | task mở lại trên đơn FULFILLED bị sync **tự huỷ sau ≤ 15 phút** | đã sửa trong nhánh `feat/reship-task-cancel` (xem §2) |
| Sheet ghi cho xưởng (Jomall, Mango qua sheet-channel) | mã dòng `LIT5121_1` | ghi lại cùng mã → xưởng không biết là lần 2, tool không phân biệt được |

LIT5121_1 là ví dụ: dòng 2 (Mango) giao → cả đơn FULFILLED trên Shopify → task dòng 1 bị huỷ dù chưa sản xuất; khi mở lại thì 2 phút sau bị huỷ tiếp.

## 2. Đã làm (nhánh `feat/reship-task-cancel`, không đổi schema)

Luật huỷ task mới — **cái gì được phép huỷ, cái gì không**:

| Ai huỷ | Khi nào | Task do người mở lại |
|---|---|---|
| Sync 15 phút (`syncDesignTasks`) | đơn FULFILLED (tool hoặc Shopify) và task đang mở, dòng có file | **không** — ghi 1 dòng SYSTEM "Đơn đã fulfilled trên Shopify — task do người mở lại nên giữ nguyên (chỉ leader huỷ)" rồi để yên |
| Sync | đơn CANCELLED / REFUNDED | **không** — ghi "Đơn đã huỷ / hoàn tiền — task do người mở lại nên giữ nguyên" |
| Sync | dòng đánh dấu dropship | **không** |
| Leader bấm "Huỷ task" | mọi task đang mở | có — người quyết |

"Người mở lại" = sự kiện có người thực hiện (không phải Design Agent): REJECT "Mở lại để sửa (đã gửi xưởng) — <lý do>: <ghi chú>", STATUS "Mở lại để sửa" (nút cũ), STATUS "Mở lại task đã huỷ"; và sau sự kiện đó **chưa có** lần tự huỷ nào. Vết để lại trên task:

- Mở lại trên đơn đã giao: thêm SYSTEM `Đơn đã giao — mở lại để ship lại dòng này; sync không tự huỷ task`.
- Mở lại task đã CANCELLED (chỉ leader, qua cùng form "Mở lại để sửa" hoặc nút "Mở lại task"): thêm SYSTEM `Task đã huỷ được mở lại — sync không tự huỷ lại`.
- Lý do mới trong form: **"Ship lại — hàng lỗi / thất lạc"**.
- Duyệt design của dòng ship lại: thông báo Lark `Đơn <mã> đã giao cho khách, có design mới để ship lại — check design rồi gửi xưởng <xưởng> làm lại nhé.` và dòng nằm trong "Đã update design / Cần báo xưởng" (đơn fulfilled chỉ hiện khi là ship lại).
- Hàng đợi review ở máy local nhận file cho task này dù đơn đã đóng (`commit` không còn 409 "Đơn đã giao hoặc đã đóng").
- Agent vẫn **không** được tự mở lại dòng của đơn đã giao.

## 3. Đề xuất: mỗi dòng có nhiều lần giao

### 3.1 Dữ liệu — `Shipment` thêm "lần ship" (khuyến nghị)

Giữ bảng `Shipment`, mỗi **lần giao** là một dòng:

```prisma
model Shipment {
  ...
  attempt        Int       @default(1)     // 1 = lần giao đầu, 2 = ship lại lần 1 …
  reshipReason   String?                   // lý do mở lại (LINE_FIX_REASONS) — null ở lần 1
  reshipNote     String?                   // "Cần sửa ở đâu" khi mở lại
  reshipTaskEventId String?                // sự kiện REJECT mở lại trên DesignTask (để truy ngược)
  supplierPushId String?                   // push API tạo ra lần giao này (null: sheet / tay)
  supersededAt   DateTime?                 // lần giao này đã bị lần sau thay (khách không cần theo dõi nữa)
  @@unique([orderId, lineKey, attempt])    // thay cho @@unique([orderId, lineKey])
}
```

- **Lần giao hiện tại** của dòng = `attempt` lớn nhất. Helper `currentShipment(orderId, lineKey)` thay cho mọi `findUnique({ orderId_lineKey })` (≈ 10 chỗ: `repos/shipments.ts`, `supplier-push-core.ts`, `build-fulfill-plan.ts`, `auto-fulfill.ts`, trang tracking, CS order items).
- Lần giao 2 được **tạo khi duyệt design** của task mở lại với lý do "Ship lại" (hoặc bất kỳ lý do nào trên đơn đã giao): `attempt = n+1`, status `PENDING`, chưa có tracking; lần 1 giữ nguyên tracking cũ.
- Phương án B (không khuyến nghị): bảng riêng `LineReship` chứa các lần sau, `Shipment` vẫn là "lần hiện tại". Ít chỗ phải sửa hơn nhưng 2 bảng cho cùng một thứ, trang tracking / CS phải ghép 2 nguồn.

### 3.2 Mã dòng cho xưởng: `LIT5121_1_R2`

Một quy ước duy nhất cho sheet ghi, sheet đọc về và push API: **`<đơn>_<dòng>_R<lần>`** (`R2` = lần giao 2). Lần 1 giữ nguyên `LIT5121_1`.

- `lineKeysOf` / `orderLineKey` / `normalizeBaseOrder` hiểu hậu tố `_R<n>` → (lineKey, attempt). Hôm nay `_R2` bị coi là một mã dòng lạ → Auto Fulfilled giữ lại (needs_manual), không gây hại nhưng không chạy.
- Push API: `externalOrderId = <order>-R2` đã có sẵn cho trường hợp push cũ bị huỷ; mở rộng cho push cũ **đã giao** (không đòi huỷ push cũ), `Shipment.supplierPushId` nối tracking về đúng lần giao.

### 3.3 Sheet của các xưởng

**Sheet tool ghi cho xưởng** (Jomall, Mango qua `supplier.sheetChannels`): **một dòng mỗi lần giao**, cùng cột như nay, thêm 3 cột cuối:

| Cột mới | Nội dung |
|---|---|
| `Lần ship` | 1, 2, … (= `attempt`) |
| `Lý do ship lại` | lý do mở lại + ghi chú ngắn (rỗng ở lần 1) |
| `Ngày mở lại` | MM/DD/YYYY |

"Order Number"/"Order Vendor" của lần 2 mang `LIT5121_1_R2`. Không sửa dòng lần 1.

**Sheet xưởng ghi tracking về** (Mango, Jomall, Merchize, Printposs, Lenful, Bondre, Printway — Auto Fulfilled đọc): giữ 2 cột `Order Number, Tracking`; xưởng ghi `#LIT5121_1_R2` + tracking mới. Không đổi cấu trúc, chỉ thêm quy ước mã. Bondre vẫn 2 số (SDH + last mile) như nay, trên lần giao tương ứng.

### 3.4 Auto Fulfilled với lần giao ≥ 2

Đơn đã FULFILLED trên Shopify không còn là `already_fulfilled` mặc định:

1. Dòng sheet `_R2` (hoặc tracking push của lần 2) → tìm `Shipment` lần 2 của dòng (PENDING, chưa tracking).
2. Ghi tracking vào lần 2, `supersededAt` cho lần 1.
3. Shopify: `fulfillmentTrackingInfoUpdate` trên fulfillment cũ của dòng, **giữ cả số cũ và số mới** (`numbers: [cũ, mới]`, url = trang tracking của số mới), `notifyCustomer` **bật** để khách nhận email tracking mới (cần chủ shop xác nhận — xem §5).
4. Trang tracking của tool / CS agent đọc lần giao hiện tại; lịch sử các lần hiện dưới dòng.

Dòng sheet không có `_R` trên đơn đã fulfilled vẫn `already_fulfilled` như nay (không đoán).

### 3.5 Luồng đầy đủ cho một dòng lỗi (ví dụ LIT5121_1)

1. CS / chủ shop bấm **Mở lại để sửa** trên task (DONE hoặc đã huỷ), lý do "Ship lại — hàng lỗi / thất lạc" + ghi chú. Task → REJECTED, sync không huỷ nữa. *(đã có)*
2. Designer sửa (hoặc hàng đợi local đẩy file) → duyệt. Lark báo "ship lại". *(đã có)*
3. Duyệt tạo `Shipment` lần 2 (PENDING) và đưa dòng về "Chờ chuyển xưởng" với mã `LIT5121_1_R2` — gửi qua sheet hoặc push API đúng như lần 1, có thể chọn xưởng khác. *(mới)*
4. Xưởng ghi tracking `#LIT5121_1_R2` / push trả tracking → Auto Fulfilled cập nhật Shopify, email khách. *(mới)*
5. Trang đơn / CS thấy: lần 1 UL624708308YP (đã giao, bị thay), lần 2 <mới> (đang đi). *(mới)*

## 4. Việc phải làm nếu duyệt (ước lượng 3 PR)

1. **Schema + helper** — migration thêm cột, đổi unique; `currentShipment`; backfill `attempt = 1`. Bump `SCHEMA_VERSION`.
2. **Mã `_R<n>` + Auto Fulfilled + push API** — parse hậu tố, nhánh "cập nhật tracking trên fulfillment cũ", push `-R2` khi push cũ đã giao, `supplierPushId`.
3. **Duyệt ship lại → lần giao mới + sheet ghi 3 cột + UI** — tạo lần 2 khi duyệt task ship lại, sheet-channel ghi cột mới, trang tracking / đơn / CS hiện các lần.

Không đụng: cách tính P&L (xem câu hỏi 3), Bondre 2 số, ParcelPanel.

## 5. Câu hỏi cần chủ shop trả lời

1. **Cấu trúc dữ liệu:** đồng ý `Shipment` thêm `attempt` (3.1, khuyến nghị) hay muốn bảng riêng?
2. **Mã xưởng `LIT5121_1_R2`** cho cả sheet ghi, sheet đọc về và push API — được không, hay xưởng đang quen một kiểu khác?
3. **Sheet ghi cho xưởng:** thêm 3 cột cuối (Lần ship / Lý do ship lại / Ngày mở lại) — được không? Các sheet đọc về giữ nguyên 2 cột.
4. **Email khách** khi có tracking ship lại: gửi (notifyCustomer bật) hay chỉ CS báo tay?
5. **Chi phí ship lại** có cần ghi vào P&L của đơn không (thêm `reshipCost` trên lần giao)? Nếu không, bỏ qua ở đợt này.
