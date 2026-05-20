# Order Custom Classification & Trello Integration — Design Spec

**Status:** ✅ Approved by user — ready for implementation plan
**Created:** 2026-05-19
**Owner:** duc0812@gmail.com
**Target phase:** Phase 14

---

## 1. Mục tiêu

Thêm vào trang Orders (`/orders`) khả năng:

1. **Phân loại** mỗi order là **Custom** hoặc **Non-Custom** dựa trên Shopify line item data.
2. **Custom orders**: Tự động tạo Trello card cho Design team xử lý.
3. **Non-Custom orders**: Track per-SKU xem design đã được upload chưa; nếu chưa → cũng tạo Trello card.
4. **Trello → App sync** (polling): Khi card được move sang list DONE và đính kèm Drive link → app tự động mark Design = "Đã có".

---

## 2. Phân loại Custom / Non-Custom

### 2.1 Detect signal (từ Shopify line item data — đã confirmed qua API thực)

| Signal | Field | Ví dụ |
|---|---|---|
| **Primary** | `lineItem.customAttributes` có key `_print_files` | `[{"key":"_print_files","value":"[{...}]"}]` |
| **Secondary** | `lineItem.product.tags` chứa `"Custom Name"` | `["Custom Name", "customily", ...]` |

**Rule:** Nếu BẤT KỲ line item nào của order thỏa 1 trong 2 signal → order là **Custom**.  
Nếu KHÔNG có signal nào → **Non-Custom**.

### 2.2 Custom order — data cho Design team

Trích từ line item `customAttributes`:

| Key | Nội dung |
|---|---|
| `_customall_preview` | URL ảnh preview (thumbnail) |
| `_customall_print_file` | URL file in chính |
| `_print_files` | JSON array: `[{print_area, url, artwork_id, product_base_variant_id}]` |
| `_customized_url` | URL trang customization của khách |

---

## 3. Schema DB bổ sung

### 3.1 Field mới trên `Order`

```prisma
model Order {
  // ... existing fields ...
  orderType       String   @default("UNKNOWN")  // "CUSTOM" | "NON_CUSTOM" | "UNKNOWN"
  trelloCardId    String?                        // Trello card ID sau khi tạo
  trelloCardUrl   String?                        // link xem card
}
```

### 3.2 Model mới: `SkuDesign` (track design per SKU cho Non-Custom)

```prisma
model SkuDesign {
  id          String   @id @default(cuid())
  sku         String   @unique            // Shopify variant SKU
  designReady Boolean  @default(false)    // true khi Design team đã upload
  driveLink   String?                     // Google Drive link đính kèm từ Trello
  trelloCardId String?                    // card ID để sync ngược
  updatedAt   DateTime @updatedAt
  createdAt   DateTime @default(now())
}
```

### 3.3 AppSetting keys mới (Trello config)

Lưu vào bảng `AppSetting` hiện có (key/value):

| Key | Mô tả |
|---|---|
| `trello.apiKey` | Trello API Key |
| `trello.token` | Trello Token |
| `trello.boardId` | Board ID |
| `trello.listId` | List ID (để tạo card vào) |
| `trello.doneListId` | List ID của cột DONE (để polling) |
| `trello.syncFromOrderName` | `"LIT2341"` — chỉ tạo card cho order >= này |

---

## 4. Sync flow — Classify & Create Trello card

### 4.1 Khi nào chạy

Integrate vào `POST /api/shopify/orders/sync` hiện có. Sau khi upsert order vào DB:
- Nếu `order.orderType === "UNKNOWN"` → classify
- Nếu là Custom HOẶC Non-Custom chưa có design → check xem có cần tạo Trello card không

### 4.2 Classify logic

```
function classifyOrder(shopifyOrder):
  for each lineItem in shopifyOrder.lines:
    if lineItem.customAttributes has key "_print_files":
      return "CUSTOM"
    if lineItem.productTags includes "Custom Name":
      return "CUSTOM"
  return "NON_CUSTOM"
```

### 4.3 Trello card creation gate

```
function shouldCreateTrelloCard(order, skuDesignMap):
  // Chỉ tạo từ syncFromOrderName trở đi
  if order.shopifyOrderNumber < config.syncFromOrderName:
    return false

  if order.trelloCardId is not null:
    return false  // đã tạo rồi

  if order.orderType === "CUSTOM":
    return true

  if order.orderType === "NON_CUSTOM":
    // Kiểm tra từng SKU — nếu có SKU nào chưa có design → tạo card
    for each line in order.lines:
      if line.sku is not null:
        skuDesign = skuDesignMap[line.sku]
        if skuDesign is null OR skuDesign.designReady === false:
          return true
    return false
```

### 4.4 Card content

**Custom order:**
```
Card Name: {order.shopifyOrderNumber} - {sku1} [{variantTitle}]
           (nếu multi-line: ghép tất cả SKU: "SKU1 / SKU2")

Description:
  🛒 Order: {shopifyOrderNumber}
  👤 Customer: {customerName}
  📦 Product: {productTitle} — {variantTitle}
  🖼 Preview: {_customall_preview URL}
  🖨 Print file: {_customall_print_file URL}
  🎨 Print areas: (parse _print_files JSON)
    - Area: Zip Hoodie
      URL: https://...
  🔗 Customized at: {_customized_url}
```

**Non-Custom order:**
```
Card Name: {order.shopifyOrderNumber} - {sku} [{variantTitle}]

Description:
  🛒 Order: {shopifyOrderNumber}
  👤 Customer: {customerName}
  📦 Product: {productTitle} — {variantTitle}
  ⚠️ Design chưa có — cần tạo design cho SKU: {sku}
```

---

## 5. Trello → App sync (Polling)

### 5.1 Trigger

Nút **"Sync Trello"** trên trang Orders → gọi `POST /api/trello/sync`.

### 5.2 Flow

```
1. Lấy config: doneListId từ AppSetting
2. Gọi Trello API: GET /lists/{doneListId}/cards?attachments=true
3. For each card in DONE list:
   a. Tìm attachment là Google Drive link (url chứa "drive.google.com")
   b. Lookup Order WHERE trelloCardId = card.id
      → Nếu tìm thấy: KHÔNG cần làm gì thêm (order đã có design ready)
   c. Lookup SkuDesign WHERE trelloCardId = card.id
      → Nếu tìm thấy + designReady = false:
         UPDATE SkuDesign SET designReady=true, driveLink=<drive url>
         (Tất cả Non-Custom order có SKU này sẽ hiện "Đã có" tự động)
4. Return { updated: N }
```

---

## 6. UI Changes trên trang `/orders`

### 6.1 Columns mới trong bảng

| Column | Custom | Non-Custom |
|---|---|---|
| **Type** | Badge "Custom" (tím) | Badge "Non-Custom" (xám) |
| **Design** | "—" (không áp dụng) | "Đã có" (xanh) / "—" |
| **Trạng thái Trello** | "Đã tạo Trello" / "Chưa tạo" | "Đã tạo Trello" / "Chưa có design" |
| **Trello** | Link "Xem card" | Link "Xem card" |

### 6.2 Buttons thêm vào header

- **Sync Trello** — gọi `/api/trello/sync`
- **Sync Design Order** — gọi `/api/shopify/orders/sync` với classify + card creation

### 6.3 Filter thêm

- **Type filter**: All / Custom / Non-Custom
- **Design filter**: All / Đã có / Chưa có (chỉ áp dụng cho Non-Custom)
- **Trello filter**: All / Đã tạo / Chưa tạo

### 6.4 Setup page (`/setup`)

Thêm section **Trello** với 5 fields:
- API Key (`trello.apiKey`)
- Token (`trello.token`)
- Board ID (`trello.boardId`)
- List ID — nơi tạo card (`trello.listId`)
- Done List ID — cột DONE để sync (`trello.doneListId`)
- Sync từ order (`trello.syncFromOrderName`) — default `"LIT2341"`

---

## 7. API Routes mới

```
POST /api/trello/sync    Polling DONE cards → update SkuDesign.designReady
GET  /api/trello/config  Đọc Trello config từ AppSetting
POST /api/trello/config  Lưu Trello config vào AppSetting
```

Trello card creation được gọi inline trong sync flow hiện có:
```
POST /api/shopify/orders/sync  (đã có) — extend thêm classify + create card logic
```

---

## 8. Lib modules

```
src/lib/trello.ts         Trello API client: createCard(), getCardsByList(), getCardAttachments()
src/lib/order-classify.ts Pure function: classifyOrder(shopifyLines) → "CUSTOM" | "NON_CUSTOM"
```

---

## 9. Migration

```prisma
// prisma/schema.prisma additions:
// 1. Add orderType, trelloCardId, trelloCardUrl to Order model
// 2. Add SkuDesign model
```

```bash
npx prisma migrate dev --name add_order_type_trello_skudesign
npx prisma generate
# Bump SCHEMA_VERSION in src/lib/db.ts
```

---

## 10. Implementation Phases

### Phase 14.1 — Schema + Classify logic
- [ ] Prisma migration: `Order.orderType`, `Order.trelloCardId`, `Order.trelloCardUrl`, `SkuDesign`
- [ ] `src/lib/order-classify.ts` pure function + unit tests
- [ ] Integrate classify vào sync flow (upsert order → set `orderType`)
- [ ] Backfill `orderType` cho orders đã có trong DB (chạy 1 lần)

### Phase 14.2 — Trello Setup UI
- [ ] Section Trello trong `/setup` page
- [ ] `GET/POST /api/trello/config` routes
- [ ] Validate config (test create card giả) khi save

### Phase 14.3 — Trello card creation
- [ ] `src/lib/trello.ts` client
- [ ] Logic tạo card trong sync flow (gate by syncFromOrderName)
- [ ] Lưu `trelloCardId` + `trelloCardUrl` vào Order sau khi tạo

### Phase 14.4 — Trello Sync (Polling)
- [ ] `POST /api/trello/sync` — poll DONE list, update `SkuDesign`

### Phase 14.5 — UI Orders page
- [ ] Columns: Type badge, Design badge, Trello status, Xem card link
- [ ] Buttons: Sync Trello, Cập nhật Trello, Sync Design Order
- [ ] Filters: Type, Design, Trello status
- [ ] `OrderRow` type update

---

## 11. Các quyết định đã chốt

| # | Hạng mục | Quyết định |
|---|---|---|
| 1 | Custom detect | `_print_files` customAttribute OR product tag "Custom Name" |
| 2 | Non-Custom design track | Per-SKU trong `SkuDesign` table |
| 3 | Card creation trigger | Auto trong sync, chỉ từ order >= `syncFromOrderName` |
| 4 | Trello → App | Polling thủ công (nút Sync Trello) |
| 5 | Drive link detect | attachment URL chứa `drive.google.com` |
| 6 | Non-Custom + design ready | Một SKU "Đã có" → TẤT CẢ order có SKU đó hiện "Đã có" |
