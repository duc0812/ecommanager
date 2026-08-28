# Design Library (Non-Custom SKU × Supplier) — Design Spec

**Status:** 🟢 Brainstorming complete — approved by user, ready for implementation plan
**Created:** 2026-08-28
**Owner:** duc0812@gmail.com
**Module:** Fulfillment
**Depends on:** Fulfillment & POD module (Phase 13), Order Custom Classification & Trello (Phase 14)

---

## 1. Mục tiêu

Thêm **thư viện lưu trữ DESIGN cho đơn non-custom** vào module Fulfillment, để những SKU đã có sẵn design (không cần khách customize) có thể **đẩy thẳng đơn đi mà không cần design team xử lý per-order** — khác với đơn custom.

Điểm cốt lõi (yêu cầu nghiệp vụ):
- Xác nhận design **theo SKU** là đủ (không cần soi nội dung artwork từng đơn).
- **1 SKU có thể gửi cho nhiều supplier khác nhau tùy thời điểm**, và **mỗi supplier yêu cầu template/file design khác nhau** → design phải lưu **per cặp (SKU × Supplier)**.
- Đơn chỉ "đẩy thẳng" khi **đúng supplier được gán** đã có bản design ready trong thư viện.

---

## 2. Trạng thái hiện tại (baseline)

Luồng non-custom hiện tại (đã implement, Phase 14):

- `POST /api/shopify/orders/sync` classify mỗi order = `CUSTOM | NON_CUSTOM` (`src/lib/order-classify.ts`).
- Với `NON_CUSTOM`: gate tạo Trello card dựa trên **`SkuDesign` per-SKU global** (`SkuDesign.sku @unique`, `designReady`). Nếu **bất kỳ** SKU chưa `designReady` → tạo Trello card cho design team.
- `SkuDesign.designReady` được set `true` qua `POST /api/trello/sync` khi card ở list DONE có Drive attachment.
- Supplier được resolve sẵn khi sync: `Order.defaultSupplierId`, `OrderLine.resolvedSupplierId`.
- `SupplierProduct.requiresDesign: Boolean` — đã tồn tại; cho biết cặp (supplier, product) đó **có cần design hay không**.
- `SupplierProduct.designTemplateUrl: String?` — ref template design của supplier cho product đó.
- `OrderLine.designDriveLink: String?` — đã tồn tại, sẵn sàng chứa link design cho từng line.

**Hạn chế cần khắc phục:** `SkuDesign` chỉ 1 chiều (per SKU). Không phản ánh được việc cùng 1 SKU nhưng gửi supplier khác nhau cần design khác nhau.

---

## 3. Quyết định đã chốt (từ brainstorming)

| # | Hạng mục | Quyết định |
|---|---|---|
| 1 | Mô hình design | **2 lớp**: 1 artwork master/SKU (`SkuDesign`) + biến thể per supplier (`SkuSupplierDesign`). Xác nhận tồn tại ở mức SKU, nhưng "đẩy thẳng" cần biến thể của supplier được gán. |
| 2 | Nhập design | **Upload/dán link thủ công 1 lần per (SKU × Supplier)**; tái dùng cho mọi đơn sau. |
| 3 | "Đẩy thẳng đơn đi" | **Tự chuyển pipeline (skip bước design)** — không tạo Trello card cho design team. |
| 4 | Fallback khi thiếu | Cặp (SKU × Supplier) chưa có trong thư viện → **vẫn tạo Trello card** cho design team (coexist luồng cũ); khi design team xong (Trello DONE + Drive link) → **tự populate** vào thư viện để lần sau tái dùng. |
| 5 | Gate không cần design | Nếu `SupplierProduct.requiresDesign = false` cho line → auto-ready, không cần bản ghi thư viện. |
| 6 | Vị trí UI | Trang riêng **`/fulfillment/design-library`** trong nhóm FULFILLMENT. |
| 7 | Phạm vi dữ liệu | **Shared/global** (không `projectId`) giống `SupplierProduct` — tái dùng across store/order. |

---

## 4. Data model

### 4.1 Model mới `SkuSupplierDesign`

```prisma
model SkuSupplierDesign {
  id           String   @id @default(cuid())
  sku          String
  supplierId   String
  supplier     Supplier @relation(fields: [supplierId], references: [id], onDelete: Cascade)
  designLink   String?          // link file đã format theo template của supplier này (Drive/CDN)
  ready        Boolean  @default(false)
  source       String   @default("MANUAL")   // "MANUAL" | "TRELLO"
  trelloCardId String?          // set khi bản ghi được sinh/populate từ fallback Trello
  note         String?
  updatedAt    DateTime @updatedAt
  createdAt    DateTime @default(now())
  @@unique([sku, supplierId])
  @@index([sku])
  @@index([supplierId])
}
```

### 4.2 `SkuDesign` (đã có) — đổi vai trò

`SkuDesign` giữ nguyên schema, **đổi ngữ nghĩa** thành **master artwork per SKU**:
- `driveLink` = artwork gốc (master), `note` = ghi chú chung.
- `designReady` **không còn dùng để gate** đẩy đơn (gate chuyển xuống mức supplier ở `SkuSupplierDesign`). Field được giữ lại (không xóa) để tránh phá dữ liệu cũ; có thể hiểu là "đã có master artwork".
- `trelloCardId` trên `SkuDesign` **không còn** là nơi map ngược từ Trello cho non-custom design (chuyển sang `SkuSupplierDesign.trelloCardId`).

**Bắt buộc khai báo relation ngược** — Prisma yêu cầu phía `Supplier` khai báo relation ngược. Thêm vào `Supplier`:
```prisma
model Supplier {
  // ... existing ...
  skuDesigns  SkuSupplierDesign[]
}
```

### 4.3 Migration

```bash
npx prisma migrate dev --name add_sku_supplier_design
npx prisma generate
# Bump SCHEMA_VERSION trong src/lib/db.ts
```

- Chỉ thêm 1 model + 1 relation field ngược trên `Supplier` → không đụng dữ liệu cũ.
- **Backfill:** Không auto-migrate được `SkuDesign` (per-SKU) sang `SkuSupplierDesign` (per SKU×Supplier) vì thiếu thông tin supplier. Dữ liệu `SkuDesign.driveLink` cũ giữ nguyên làm master artwork. Các cặp (SKU × Supplier) được điền dần qua manual add hoặc Trello fallback. (Không cần script backfill bắt buộc.)

---

## 5. Gate logic (sửa trong `POST /api/shopify/orders/sync`)

Thay check per-SKU global hiện tại (`SkuDesign.designReady`) bằng **check per-line theo supplier được gán**.

### 5.1 Pseudocode

```
function computeLineDesign(line):
  # line: product line (bỏ qua digital/add-on qua isNonProductLine)
  supplierId = line.resolvedSupplierId
  if supplierId == null:
    return { ready: false, needsDesign: true, link: null }   # unmapped — sẽ không tạo card vì gate allProductLinesMapped

  requiresDesign = SupplierProduct(supplierId, line.sku).requiresDesign
  if requiresDesign == false:
    return { ready: true, needsDesign: false, link: null }   # supplier không cần design → auto đẩy

  entry = SkuSupplierDesign(sku=line.sku, supplierId=supplierId)
  if entry != null AND entry.ready == true:
    return { ready: true, needsDesign: true, link: entry.designLink }
  return { ready: false, needsDesign: true, link: null }

function computeOrderDesign(order):
  productLines = order.lines.filter(not isNonProductLine)
  results = productLines.map(computeLineDesign)
  # điền link cho từng line
  for (line, r) in zip(productLines, results):
    line.designDriveLink = r.link
  orderDesignReady = results.all(r => r.ready == true)
  missing = productLines where result.ready == false   # cần Trello card
  return { orderDesignReady, missing }
```

- `Order.designReady = orderDesignReady` (recompute mỗi lần sync).
- Nếu `orderDesignReady == true` → **skip tạo Trello card**, đơn đẩy thẳng pipeline (giữ/nâng `pipelineStatus` như luồng non-custom sẵn có; không chặn chờ design).
- Nếu có `missing` → tạo Trello card fallback (Section 6). Gate tạo card vẫn tuân theo điều kiện hiện có: `allProductLinesMapped`, `trelloCardId == null`, `shouldCreateCard(orderName, syncFromOrderName)`.

### 5.2 Ảnh hưởng tương thích

- `OrderLine.designDriveLink` được điền từ `SkuSupplierDesign.designLink` khi ready.
- `Order.designReady` vẫn là cờ aggregate như hiện tại (các nơi đọc `designReady` — orders page, reports — không đổi interface).
- Bỏ dependency vào `SkuDesign.designReady` trong gate non-custom (đoạn `readySkus` trong sync route).

---

## 6. Trello fallback + tự populate thư viện

### 6.1 Tạo card (khi có line thiếu design)

Với các product line `missing` (cần design cho 1 supplier cụ thể):
- **Card content** mô tả rõ **SKU cần design cho supplier nào**, kèm:
  - Master artwork link (`SkuDesign.driveLink`) nếu có — để designer dùng làm gốc.
  - Template ref của supplier (`SupplierProduct.designTemplateUrl`) — để format đúng chuẩn supplier.
- Sau khi tạo card: với **mỗi** cặp (sku, supplierId) đang thiếu → **upsert `SkuSupplierDesign`** với `trelloCardId = card.id`, `source = "TRELLO"`, `ready = false`.
  - (Thay cho logic cũ upsert `SkuDesign` theo `sku`.)

Mở rộng `buildTrelloCardContent` trong `src/lib/order-classify.ts` (nhánh `NON_CUSTOM`) để nhận thông tin supplier + template ref per line thiếu.

### 6.2 Populate ngược (`POST /api/trello/sync`)

Khi card ở list DONE có Drive attachment:
- Tìm **`SkuSupplierDesign` theo `trelloCardId`** (thay cho `SkuDesign` theo `trelloCardId`).
- Set `ready = true`, `designLink = <drive url>`.
- Kết quả: mọi đơn tương lai của cặp (SKU × Supplier) này **auto đẩy thẳng** (cache tái dùng).

> Lưu ý migration hành vi: các card non-custom cũ đang map qua `SkuDesign.trelloCardId` sẽ không còn được `trello/sync` cập nhật theo model mới. Chấp nhận được vì luồng chuyển sang per-supplier; card cũ có thể tạo lại hoặc điền thủ công qua Design Library.

---

## 7. Trang `/fulfillment/design-library` + API

### 7.1 UI

- Nav mới **"Design Library"** trong nhóm FULFILLMENT (`src/components/Sidebar.tsx`).
- Trang `'use client'`, theo pattern chuẩn (`<Sidebar />` + `<main className="ml-[280px] ...">`).
- **Bảng** cột: `SKU | Supplier | Design Link | Ready | Source | Updated | (edit/delete)`.
  - Có thể nhóm/hiển thị **master artwork** (`SkuDesign.driveLink`) ở cấp SKU (cột phụ hoặc header nhóm).
- **Filter bar**: supplier dropdown, search SKU, trạng thái `ready`, `source`.
- **Actions:**
  - **Add entry** (xác nhận bằng SKU): nhập SKU → chọn Supplier → dán `designLink` → lưu (`ready=true`, `source=MANUAL`).
  - **Inline edit** `designLink`, **toggle `ready`**, **delete**.
  - **Import CSV**: cột `sku, supplierCode, designLink` (UPSERT theo `(sku, supplierId)`; resolve supplier qua `Supplier.code`). Preview diff trước khi commit.

### 7.2 API routes

```
GET    /api/fulfillment/design-library          # list + filter (supplier, sku, ready, source)
POST   /api/fulfillment/design-library          # create/update 1 entry (sku, supplierId, designLink, ready)
DELETE /api/fulfillment/design-library/[id]     # xóa entry
POST   /api/fulfillment/design-library/import   # bulk CSV upsert
```

- Route handler **không import `prisma` trực tiếp** — đi qua repo mới `src/lib/repos/design-library.ts`.
- Trả `NextResponse.json(...)` theo convention.

### 7.3 Bonus — CSV export nhận link design

Thêm source `line.designDriveLink` vào CSV template engine (`src/lib/csv-template.ts`) → supplier nhận luôn link file design khi export từ `/fulfillment/export`. (Chỉ cần đăng ký source key mới; `OrderLine.designDriveLink` đã được điền ở Section 5.)

---

## 8. Lib modules & files chạm tới

| File | Thay đổi |
|---|---|
| `prisma/schema.prisma` | + model `SkuSupplierDesign`, + relation `Supplier.skuDesigns` |
| `src/lib/db.ts` | bump `SCHEMA_VERSION` |
| `src/lib/repos/design-library.ts` | **mới** — CRUD + import + query cho gate |
| `src/app/api/shopify/orders/sync/route.ts` | thay gate per-SKU → per-line theo supplier; điền `OrderLine.designDriveLink`; upsert `SkuSupplierDesign` khi tạo card |
| `src/lib/order-classify.ts` | mở rộng `buildTrelloCardContent` (NON_CUSTOM) với supplier + template ref |
| `src/app/api/trello/sync/route.ts` | populate ngược `SkuSupplierDesign` theo `trelloCardId` |
| `src/lib/csv-template.ts` | + source key `line.designDriveLink` |
| `src/app/fulfillment/design-library/page.tsx` | **mới** — UI |
| `src/app/api/fulfillment/design-library/route.ts` (+ `[id]`, `import`) | **mới** — API |
| `src/components/Sidebar.tsx` | + nav "Design Library" |

---

## 9. Testing strategy

### 9.1 Unit tests (gate logic — tách thành pure function để test)
- `requiresDesign = false` → line ready, không cần thư viện.
- Supplier X có `SkuSupplierDesign.ready=true` → line ready + `designLink` được gán.
- Supplier X chưa có / `ready=false` → line thiếu, order.designReady=false.
- Multi-line multi-supplier: order ready chỉ khi **tất cả** line ready.
- Line unmapped (`resolvedSupplierId=null`) → không ready, không tạo card (gate `allProductLinesMapped`).

### 9.2 Integration tests
- Trello populate: card DONE + Drive link → `SkuSupplierDesign(trelloCardId).ready=true`, `designLink` set.
- Import CSV: resolve `supplierCode` → upsert đúng theo `(sku, supplierId)`.
- CSV export: source `line.designDriveLink` render đúng cột.

### 9.3 Manual QA
- [ ] Add entry thủ công (SKU + Supplier + link) → đơn mới của cặp đó khi sync có `designReady=true`, không tạo Trello card.
- [ ] SKU gửi Supplier A (đã có design) → đẩy thẳng; cùng SKU gửi Supplier B (chưa có) → tạo Trello card cho B.
- [ ] Trello DONE cho B → `trello/sync` → cặp (SKU, B) ready → đơn sau của B đẩy thẳng.
- [ ] `requiresDesign=false` cho 1 supplier → đơn auto đẩy dù không có entry.

---

## 10. Implementation phases (đề xuất — chi tiết hóa ở writing-plans)

1. **Schema + repo**: model `SkuSupplierDesign`, migration, bump SCHEMA_VERSION, `repos/design-library.ts` + unit test query.
2. **Gate logic**: refactor gate non-custom trong sync route thành pure function per-line + tests; điền `OrderLine.designDriveLink`; recompute `Order.designReady`.
3. **Trello fallback + populate**: mở rộng card content với supplier/template; upsert `SkuSupplierDesign` khi tạo card; sửa `trello/sync` populate ngược.
4. **UI + API Design Library**: page `/fulfillment/design-library`, routes CRUD + import CSV, nav.
5. **CSV export bonus**: source `line.designDriveLink` trong template engine.
6. **QA + docs**: manual QA checklist; cập nhật SPEC.md / NOTES.md / PLAN.md.

---

## 11. Open questions (none blocking)

- Có cần hiển thị/quản lý master artwork (`SkuDesign`) ngay trong trang Design Library ở v1, hay chỉ per-supplier entries? → Đề xuất v1: hiển thị master ở cột phụ, quản lý per-supplier là chính.
- Có cần backfill script cho `SkuDesign` cũ không? → Đề xuất không bắt buộc; điền dần qua manual/Trello.
