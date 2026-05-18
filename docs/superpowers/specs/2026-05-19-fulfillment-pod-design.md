# Fulfillment & Supplier POD Module — Design Spec

**Status:** 🟢 Brainstorming complete — all 9 sections drafted + implementation phases broken down. Awaiting user final review.
**Created:** 2026-05-19
**Owner:** duc0812@gmail.com
**Target phase in PLAN.md:** Phase 13
**Chosen track:** Hướng B (Recommended — 3-4 tuần)

---

## 1. Mục tiêu

Thêm module **Fulfillment & POD Supplier Management** vào Ecom Manager để:

1. Quản lý order từ Shopify ở mức **per-order** (hiện app chỉ có Payout aggregate).
2. Quản lý nhiều **supplier POD** + bảng giá `(SKU → baseCost)` per supplier.
3. **Auto-detect** default supplier cho mỗi SKU → tính `Per-order Profit = Expected Payout − Base Cost − Supplier Shipping` **realtime**.
4. **CSV Export Center** với template builder per-supplier (mỗi sup có format CSV riêng), filter theo date range + US timezone.
5. Order **pipeline status** (Pending → Exported → Fulfilled → Shipped) + alert SKU thiếu mapping.
6. Tích hợp với Project/Meta hiện có để ra **P&L tổng hợp per project** (orders profit − ad spend − staff cost).

---

## 2. Quyết định đã chốt (từ brainstorming)

| # | Hạng mục | Quyết định |
|---|---|---|
| 1 | **Order data source** | Polling Shopify Orders API (cron 15-30 phút) + nút "Sync Now" thủ công. KHÔNG dùng webhook (đơn giản, không cần public URL). |
| 2 | **Số lượng supplier** | Nhiều sup, mỗi product map tới 1 **default supplier**. Cho phép **override per-order** nếu cần. |
| 3 | **Mapping level** | **Variant/SKU level** — mỗi SKU có cost riêng (vì POD khác giá theo size/color). |
| 4 | **Nguồn cost data** | **Hybrid**: API cho sup lớn (Printful, Printify) + manual/CSV import cho sup nhỏ. |
| 5 | **Expected payout per order** | Lấy từ **Shopify GraphQL** `order.transactions[].amount − order.transactions[].fees[].amount`. Đây chính là con số "$X will be added to your <date> payout" Shopify hiển thị sẵn. **Realtime** ngay khi capture. |
| 6 | **Cost items trừ vào P/L** | (a) Base cost SKU × qty, (b) Supplier shipping (first item + additional item). KHÔNG bao gồm transaction fee (đã trừ trong Expected Payout) và KHÔNG include ad cost per-order (allocate ở aggregate level). |
| 7 | **Supplier shipping formula** | Per-item: `firstItemFee + additionalItemFee × (qty − 1)` per supplier. |
| 8 | **Fulfillment workflow** | **CSV template export** — mỗi sup có template cột riêng, user filter date range → app render CSV theo template. KHÔNG auto-push qua sup API. |
| 9 | **Timezone** | App default **Vietnam (ICT)**, hiển thị **US time song song** trong order timeline, và CSV export filter cho chọn **US date range** (cutoff US 23:59). |

---

## 3. Công thức P/L (chi tiết)

### Per-order
```
Expected Payout (per order)
  = Σ(transaction.amount − transaction.fees) for transactions WHERE kind ≠ REFUND
  − Σ(refund.amount)                          for refunds linked to this order

Base Cost (per order)
  = Σ(line.qty × SupplierProduct.baseCost)   với supplier = order.assignedSupplier (default hoặc override)

Supplier Shipping (per order)
  = supplier.firstItemFee + supplier.additionalItemFee × (totalQty − 1)
  (totalQty = sum của line.qty trong order)

Profit (per order)
  = Expected Payout − Base Cost − Supplier Shipping

Margin %
  = Profit / Expected Payout × 100
```

### Aggregate (dashboard)
```
Total Revenue     = Σ Expected Payout per order trong filter range
Total COGS        = Σ Base Cost per order
Total Shipping    = Σ Supplier Shipping per order
Total Profit      = Total Revenue − Total COGS − Total Shipping
Avg Margin %      = Total Profit / Total Revenue × 100
Orders count, Avg profit/order, ...
```

### P&L per Project (kết hợp với module hiện có — Phase 8)
```
Project Net Profit
  = Σ Fulfillment Profit (orders thuộc project, theo date range của project/staff)
  − Σ Meta Ad Spend (project)
  − Σ Staff Cost (StaffAssignment × monthlyCost × months_active)
```

---

## 4. Module Architecture (Section 1 — APPROVED)

### Sidebar layout
```
─ Overview                       /
─ FINANCE
   • Shopify                     /shopify
   • Meta Billing                /finance/meta
─ FULFILLMENT  ← NEW
   • Orders & P/L Dashboard      /fulfillment
   • CSV Export Center           /fulfillment/export
   • Pipeline (Kanban)           /fulfillment/pipeline
─ PROJECT MANAGEMENT
   • Dashboard                   /projects
─ SETUP
   • Store / Meta / Projects / HR
   • Suppliers       ← NEW       /setup/suppliers
   • Product Mapping ← NEW       /setup/products
```

### API routes (theo convention hiện tại)
```
src/app/api/shopify/orders/sync/route.ts        POST – pull orders + transactions từ Shopify
src/app/api/shopify/orders/route.ts             GET  – read orders từ DB
src/app/api/fulfillment/orders/route.ts         GET  – orders w/ P/L computed (joined w/ supplier costs)
src/app/api/fulfillment/pl-summary/route.ts     GET  – aggregate dashboard stats
src/app/api/fulfillment/export/route.ts         POST – generate CSV per template
src/app/api/fulfillment/pipeline/route.ts       PATCH – bulk update order status
src/app/api/suppliers/route.ts                  CRUD suppliers
src/app/api/suppliers/products/route.ts         CRUD SupplierProduct mapping + CSV import
src/app/api/suppliers/templates/route.ts        CRUD CSV templates
src/app/api/suppliers/[id]/sync-cost/route.ts   POST – pull cost từ Printful/Printify API
```

### Lib modules
```
src/lib/shopify-orders.ts        GraphQL client cho Order + transactions + fees
src/lib/pl-calculator.ts         Pure function: order + price map → P/L breakdown (testable)
src/lib/csv-template.ts          Template engine: order line → CSV row theo column mapping
src/lib/suppliers/printful.ts    Connector implementing SupplierConnector interface
src/lib/suppliers/printify.ts    Connector implementing SupplierConnector interface
src/lib/timezone.ts              Helper VN/US conversion + day boundary
```

**Design principles:**
- `pl-calculator.ts` là pure function — dễ unit test, dễ tái dùng cả ở server và (sau này) ở client.
- Mỗi supplier connector implement interface `SupplierConnector` chung → thêm sup mới = tạo file mới.
- Tách CSV template engine khỏi route handler → có thể test rendering riêng.

---

## 5. Data Model (Section 2 — DRAFT, awaiting approval)

### Prisma schema bổ sung (paste vào `prisma/schema.prisma`)

```prisma
model Supplier {
  id                   String              @id @default(cuid())
  name                 String                                  // "Printful", "CustomCat-US"
  code                 String              @unique             // "printful", "customcat_us" – dùng cho mapping rule
  apiType              String?                                 // "printful" | "printify" | null (manual)
  apiKey               String?                                 // encrypt khi deploy
  firstItemShipFee     Float               @default(0)
  additionalItemShipFee Float              @default(0)
  currency             String              @default("USD")
  note                 String?
  isActive             Boolean             @default(true)
  createdAt            DateTime            @default(now())
  products             SupplierProduct[]
  templates            CsvTemplate[]
  orders               Order[]                                 // orders default-assigned to this supplier
  costHistory          SupplierCostHistory[]
}

model SupplierProduct {
  id          String   @id @default(cuid())
  supplierId  String
  supplier    Supplier @relation(fields: [supplierId], references: [id], onDelete: Cascade)
  sku         String                                           // Shopify variant SKU
  productName String?                                          // human-readable
  baseCost    Float
  currency    String   @default("USD")
  updatedAt   DateTime @updatedAt
  createdAt   DateTime @default(now())
  @@unique([supplierId, sku])
  @@index([sku])                                               // fast lookup khi resolve supplier cho order line
}

model SupplierCostHistory {
  id         String   @id @default(cuid())
  supplierId String
  supplier   Supplier @relation(fields: [supplierId], references: [id])
  sku        String
  oldCost    Float
  newCost    Float
  changedAt  DateTime @default(now())
  @@index([supplierId, sku])
}

model Order {
  id                  String         @id                       // Shopify Order ID (graphql gid hoặc REST id)
  storeId             String
  shopifyOrderNumber  String                                   // "#1023"
  customerEmail       String?
  customerName        String?
  shippingCountry     String?
  shippingState       String?
  financialStatus     String                                   // paid | pending | refunded | partially_refunded | voided
  fulfillmentStatus   String?                                  // unfulfilled | fulfilled | partial | restocked
  pipelineStatus      String         @default("PENDING")       // PENDING | EXPORTED | FULFILLED | SHIPPED | DELIVERED | CANCELLED
  currency            String
  grossAmount         Float                                    // subtotal + shipping + tax (customer paid)
  expectedPayout      Float                                    // sum(transaction.amount − fee) − refunds
  totalFees           Float          @default(0)               // Σ transaction fees
  refundedAmount      Float          @default(0)
  defaultSupplierId   String?                                  // resolved from majority of line items
  defaultSupplier     Supplier?      @relation(fields: [defaultSupplierId], references: [id])
  exportedAt          DateTime?                                // khi đã export CSV
  exportedToSupplierId String?
  placedAt            DateTime                                 // order.created_at từ Shopify
  fetchedAt           DateTime       @default(now())
  updatedAt           DateTime       @updatedAt
  lines               OrderLine[]
  @@index([placedAt])
  @@index([pipelineStatus])
  @@index([defaultSupplierId])
}

model OrderLine {
  id                String   @id @default(cuid())
  orderId           String
  order             Order    @relation(fields: [orderId], references: [id], onDelete: Cascade)
  shopifyLineId     String                                     // ID của line item từ Shopify
  sku               String?
  variantTitle      String?
  productTitle      String
  qty               Int
  unitPrice         Float                                      // giá customer trả per unit
  resolvedSupplierId String?                                   // supplier dùng để tính COGS (default hoặc override)
  resolvedBaseCost   Float?                                    // SupplierProduct.baseCost tại thời điểm sync
  costSnapshotAt     DateTime?                                 // khi nào snapshot — phòng giá đổi sau
  @@index([sku])
}

model CsvTemplate {
  id          String   @id @default(cuid())
  supplierId  String
  supplier    Supplier @relation(fields: [supplierId], references: [id], onDelete: Cascade)
  name        String                                           // "Printful Default", "CustomCat Bulk Upload"
  columns     String                                           // JSON string: [{header, source, transform?}, ...]
  rowMode     String   @default("PER_LINE")                    // PER_LINE | PER_ORDER (grouped)
  isDefault   Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

### Lưu ý migration
- Schema thêm 6 model mới, 0 thay đổi model cũ → migration đơn giản, không touch data hiện có.
- Sau khi chạy `prisma migrate dev --name add_fulfillment_module` → bump `SCHEMA_VERSION` trong `src/lib/db.ts` (current là vN → vN+1).
- `Order.expectedPayout` được tính & lưu tại thời điểm sync (không tính lại on-the-fly) → fast read cho dashboard. Recalculate khi sync lại.
- `OrderLine.resolvedBaseCost` là **snapshot** — nếu supplier đổi giá, order cũ vẫn giữ giá tại thời điểm fulfill. Cost history lưu ở `SupplierCostHistory` để audit.

### CsvTemplate.columns format (ví dụ)
```json
[
  { "header": "Order ID", "source": "order.shopifyOrderNumber" },
  { "header": "SKU", "source": "line.sku" },
  { "header": "Qty", "source": "line.qty" },
  { "header": "Recipient Name", "source": "order.customerName" },
  { "header": "Country", "source": "order.shippingCountry" },
  { "header": "Notes", "source": "literal:Rush order" }
]
```
Engine resolve `source` theo dot-path, hoặc literal value, hoặc transform function (`uppercase`, `dateFormat:US`, v.v.).

---

## 6. Section 3 — Order Sync Logic

### 6.1 Shopify GraphQL Admin API
- **Version**: 2024-10 (or latest available — confirm at impl time)
- **Endpoint**: `https://{shop}.myshopify.com/admin/api/2024-10/graphql.json`
- **Auth**: existing `ShopifyStore` access token (đã có từ Phase 2 OAuth + manual fallback)
- **Scopes cần thêm**: `read_orders`, `read_all_orders` (đối với order > 60 days), `read_fulfillments` — user cần re-auth nếu chưa có

### 6.2 GraphQL Query chính
```graphql
query SyncOrders($cursor: String, $query: String) {
  orders(first: 50, after: $cursor, query: $query, sortKey: PROCESSED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name                              # "#1023"
      createdAt
      processedAt
      displayFinancialStatus            # PAID | PENDING | REFUNDED | ...
      displayFulfillmentStatus
      currencyCode
      currentTotalPriceSet { shopMoney { amount } }
      currentSubtotalPriceSet { shopMoney { amount } }
      currentTotalTaxSet { shopMoney { amount } }
      currentShippingPriceSet { shopMoney { amount } }
      customer { email displayName }
      shippingAddress { country countryCode province city zip }
      taxLines { source rate priceSet { shopMoney { amount } } }
      lineItems(first: 50) {
        nodes {
          id sku title variantTitle quantity
          originalUnitPriceSet { shopMoney { amount } }
          discountedUnitPriceSet { shopMoney { amount } }
        }
      }
      transactions(first: 20) {
        id kind status processedAt
        amountSet { shopMoney { amount } }
        fees { amount { amount } flatFee { amount } rate type }
      }
      refunds(first: 10) {
        id createdAt
        totalRefundedSet { shopMoney { amount } }
      }
    }
  }
}
```

### 6.3 Sync flow (`POST /api/shopify/orders/sync`)
```
1. Read ShopifyStore.syncSinceDate (default: today − 60 days; user-configurable)
2. Build query: "processed_at:>=YYYY-MM-DD"  (Shopify search syntax)
3. Paginate cursor-based until hasNextPage = false (50 orders / page)
4. For each order:
   a. Compute totalFees = Σ transactions[].fees[].amount.amount (USD)
   b. Compute expectedPayout =
        Σ tx.amountSet for tx.kind ∈ {SALE, CAPTURE} − totalFees
        − Σ refund.totalRefundedSet
   c. Resolve defaultSupplierId:
        - For each line, lookup SupplierProduct WHERE sku = line.sku ORDER BY supplier.preferenceRank
        - Group by supplierId, sum line.quantity
        - Pick supplier with majority qty; if tie/mixed → null + log alert
   d. For each line: resolve resolvedSupplierId + resolvedBaseCost (snapshot)
   e. UPSERT Order by id (idempotent)
   f. DELETE OrderLine WHERE orderId = X, then INSERT new lines (clean re-sync)
5. Update ShopifyStore.lastOrdersSyncAt = now()
6. Return { totalSynced, withMappedCost, withUnmappedSku, errors[] }
```

### 6.4 Cron / Schedule
- **Dev/local**: nút "Sync Now" trên `/fulfillment` UI là đủ.
- **Prod**: dùng Vercel Cron (`vercel.json` schedule) hoặc external uptime cron call `POST /api/shopify/orders/sync?automated=1` mỗi 15-30 phút. Implement trong Phase 13.2 — không bắt buộc cho v1.

### 6.5 Idempotency & race condition
- `Order.id` là Shopify GID → primary key → upsert tự nhiên idempotent
- Cost snapshot tại sync time → reflect cost LATEST khi sync. Nếu user đổi cost rồi muốn re-snapshot order cũ → add nút "Re-snapshot cost" trong order drill-down (Phase 13.2)
- Concurrency: trong Next.js route, dùng `prisma.$transaction` cho UPSERT order + bulk INSERT lines

---

## 7. Section 4 — Supplier Cost Management UI

### 7.1 `/setup/suppliers` — Suppliers list
- Table: name, code, apiType, ship fees (first/additional), currency, isActive, # products mapped, # orders
- Actions: Add, Edit, Deactivate (soft — không xóa để giữ history)
- Form fields:
  - `name`, `code`, `apiType` (dropdown: None / Printful / Printify), `apiKey` (password input)
  - `firstItemShipFee`, `additionalItemShipFee`, `currency`, `note`
  - `preferenceRank` (number — dùng cho tie-breaking khi nhiều sup có cùng SKU)

### 7.2 `/setup/products` — SKU mapping table
- Filter bar: supplier dropdown, search SKU/name, "show unmapped" toggle
- Table: SKU, productName, supplier, baseCost, currency, updatedAt
- Inline edit baseCost (click → input → blur saves)
- Bulk actions:
  - **Add mapping** — form: sku, supplierId, baseCost, productName
  - **Import CSV** — upload `.csv` với columns `sku,baseCost,productName` (optional `currency`). UPSERT theo `(supplierId, sku)`. Preview diff trước khi commit.
  - **Sync from supplier API** — chỉ available nếu supplier.apiType ≠ null. Gọi `POST /api/suppliers/[id]/sync-cost` → connector → diff preview → commit.

### 7.3 Connector interface (`src/lib/suppliers/index.ts`)
```typescript
export interface SupplierConnector {
  type: 'printful' | 'printify';
  /** Fetch toàn bộ catalog cost từ supplier API */
  fetchCosts(apiKey: string): Promise<Array<{ sku: string; productName: string; baseCost: number; currency: string }>>;
}
```
- `src/lib/suppliers/printful.ts` — implement Printful API v1 (`/products` + `/variants`)
- `src/lib/suppliers/printify.ts` — implement Printify API (`/v1/catalog/blueprints`)
- Thêm sup mới chỉ cần tạo file mới + register vào dispatcher

### 7.4 Cost history
- Mỗi khi `SupplierProduct.baseCost` thay đổi (manual hoặc qua sync), trigger Prisma middleware tạo `SupplierCostHistory` row.
- View history per SKU: drill-down trong `/setup/products` modal.

---

## 8. Section 5 — CSV Template Builder

### 8.1 `/setup/suppliers/[id]/templates`
- List templates của supplier + nút "New template"
- Mark 1 template là `isDefault` → tự chọn khi export

### 8.2 Template editor UI
```
┌────────────────────────────────────────────────────────────────┐
│  Template Name: [Printful Bulk Upload]    isDefault [✓]        │
│  Row mode: ( ) PER_LINE  (•) PER_ORDER                         │
│                                                                │
│  Columns (drag to reorder):                                    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ ☰  Header: [Order ID]      Source: [order.shopifyNumber▼]│  │
│  │ ☰  Header: [SKU]           Source: [line.sku           ▼]│  │
│  │ ☰  Header: [Quantity]      Source: [line.qty           ▼]│  │
│  │ ☰  Header: [Recipient]     Source: [order.customerName ▼]│  │
│  │ ☰  Header: [Country]       Source: [order.shipCountry  ▼]│  │
│  │ ☰  Header: [Note]          Source: [literal:Rush       ▼]│  │
│  └──────────────────────────────────────────────────────────┘  │
│  [+ Add column]                                                │
│                                                                │
│  Live preview (3 sample orders):                               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Order ID, SKU,         Quantity, Recipient,  Country     │  │
│  │ #1023,    TSHIRT-RED-M, 2,        David Olsen, US        │  │
│  │ #1024,    HOODIE-BLK-L, 1,        Jane Doe,    CA        │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                          [Cancel]  [Save]      │
└────────────────────────────────────────────────────────────────┘
```

### 8.3 Source field options (dropdown)
| Source key | Resolves to |
|---|---|
| `order.shopifyOrderNumber` | "#1023" |
| `order.placedAt` | ISO date |
| `order.customerName` / `customerEmail` | |
| `order.shippingCountry` / `shippingState` / `shippingAddress.*` | |
| `line.sku` / `line.productTitle` / `line.variantTitle` / `line.qty` | |
| `literal:<text>` | static value |
| `transform:uppercase:<source>` | helper transforms |

### 8.4 Engine (`src/lib/csv-template.ts`)
```typescript
export function renderCsv(template: CsvTemplate, orders: OrderWithLines[]): string {
  const cols = JSON.parse(template.columns) as Column[];
  const rows: string[][] = [];
  rows.push(cols.map(c => c.header));
  for (const order of orders) {
    if (template.rowMode === 'PER_ORDER') {
      rows.push(cols.map(c => resolveSource(c.source, { order, line: null })));
    } else {
      for (const line of order.lines) {
        rows.push(cols.map(c => resolveSource(c.source, { order, line })));
      }
    }
  }
  return rows.map(r => r.map(csvEscape).join(',')).join('\n');
}
```

### 8.5 Seed templates (ship sẵn 3)
- `Printful Default` — columns theo format Printful CSV import
- `Printify Default` — columns theo format Printify
- `CustomCat Generic` — columns phổ biến của CustomCat
- Seed bằng Prisma seed script chạy 1 lần khi user enable Phase 13

---

## 9. Section 6 — Dashboard P/L UI

### 9.1 `/fulfillment` — Main dashboard

**Layout:**
```
┌────────────────────────────────────────────────────────────────┐
│  Header: "Fulfillment & P/L"                                   │
│  [Last synced: 14:23 ICT (2 min ago)]  [⟳ Sync Now]            │
│  [Filter: Date 2026-05-12 → 2026-05-19 (VN) | US: ...|         │
│           Supplier: All ▼  Project: All ▼  Status: All ▼ ]     │
├────────────────────────────────────────────────────────────────┤
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │Revenue  │ │COGS     │ │Profit   │ │Margin   │ │Orders   │   │
│  │$12,453  │ │$5,210   │ │$7,243   │ │58.2%    │ │ 87      │   │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘   │
│                                                                │
│  ⚠ Alerts: 3 orders có SKU thiếu mapping → [View]              │
├────────────────────────────────────────────────────────────────┤
│  Orders Table                                                  │
│  ┌──────┬───────────┬──────┬────────┬──────┬───────┬─────────┐ │
│  │ #    │ Customer  │ Sup  │ Payout │ COGS │Profit │ Status  │ │
│  ├──────┼───────────┼──────┼────────┼──────┼───────┼─────────┤ │
│  │#1023 │ D. Olsen  │ PF   │$145.34 │$48.20│$97.14 │Pending  │ │
│  │#1024 │ J. Doe    │ PRT  │$ 89.10 │$32.50│$56.60 │Exported │ │
│  │ ...                                                        │ │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

### 9.2 Stats cards
- Revenue, COGS (Base + Shipping), Profit, Margin %, Orders, Avg/Order, Unmapped count
- Click stat → filter dashboard to relevant subset

### 9.3 Filter bar
- Date range picker với **toggle VN ⇄ US time**: hiển thị cả 2 múi giờ, range được convert tự động
- Supplier multi-select
- Project multi-select (sử dụng `Project.metaAccounts` + future `Project.orders`)
- Pipeline status multi-select

### 9.4 Order drill-down (click row)
- Modal hiển thị:
  - Order timeline (giống screenshot Shopify: created, captured, payout-scheduled)
  - Line items với resolved supplier + baseCost
  - P/L breakdown: gross / fees / net payout / COGS / shipping / profit
  - Action: change supplier override, mark pipeline status

---

## 10. Section 7 — Pipeline Kanban

### 10.1 `/fulfillment/pipeline`
- 5 columns: **PENDING** → **EXPORTED** → **FULFILLED** → **SHIPPED** → **DELIVERED**
- Bonus column: **CANCELLED** (collapsed)
- Drag drop card giữa columns → `PATCH /api/fulfillment/pipeline` với `{ orderIds: [], newStatus }`

### 10.2 Card design
```
┌────────────────────────────┐
│ #1023 · 2 days ago         │
│ David Olsen                │
│ $145.34 · Profit $97.14    │
│ Sup: Printful · 1 line     │
└────────────────────────────┘
```

### 10.3 Bulk actions
- Checkbox select multiple cards → bulk move
- Filter bar (giống dashboard) áp dụng vào Kanban
- "Select all in column" cho mass operations (vd: export hết PENDING → mark EXPORTED)

### 10.4 Status transitions (rules)
| From | Allowed To |
|---|---|
| PENDING | EXPORTED, CANCELLED |
| EXPORTED | FULFILLED, CANCELLED |
| FULFILLED | SHIPPED, CANCELLED |
| SHIPPED | DELIVERED |
| DELIVERED | (terminal) |
| CANCELLED | (terminal, but allow undo to PENDING) |

---

## 11. Section 8 — Alerts

### 11.1 Alert types
| Type | Trigger | Severity | Action suggested |
|---|---|---|---|
| `UNMAPPED_SKU` | Order line có sku không tìm thấy trong SupplierProduct | High (profit sai) | Link tới `/setup/products?sku=X` |
| `MIXED_SUPPLIER` | Order có lines thuộc nhiều sup → defaultSupplierId = null | Medium | Force manual assign |
| `STALE_ORDER` | Order placedAt > 3 ngày + status = PENDING | Medium | Reminder export CSV |
| `COST_SPIKE` | SupplierProduct.baseCost thay đổi > 10% so với last sync | Low | Review pricing |
| `PAYOUT_UNRESOLVED` | Order placedAt > 7 ngày nhưng `expectedPayout = 0` | High | Check Shopify transactions |

### 11.2 UI placement
- Alert summary card ở top of `/fulfillment` dashboard (như mockup Section 6)
- Click → modal liệt kê tất cả alerts với link action
- Dismiss alert (soft — không xóa data, chỉ hide cho user)
- Schema thêm sau (Phase 13.2): `Alert` model nếu muốn persist; v1 compute on-the-fly

---

## 12. Section 9 — Testing Strategy

### 12.1 Unit tests (Vitest hoặc Jest — chọn theo project hiện tại)
- `pl-calculator.test.ts`
  - Order 1 line, 1 supplier, no refund → profit đúng
  - Order multi-line, 1 supplier → profit cộng dồn đúng
  - Order multi-line, multi-supplier → defaultSupplierId resolve majority đúng
  - Order có refund → expectedPayout trừ đúng
  - Order có SKU unmapped → resolvedBaseCost = null, alert flag = true
  - Shipping calc: 1 item → first only; 3 items → first + 2×additional
- `csv-template.test.ts`
  - PER_LINE mode render đúng số rows = Σ line.qty count
  - PER_ORDER mode render đúng số rows = order count
  - Transform `literal:` và `transform:uppercase:` work
  - CSV escape khi field chứa dấu phẩy hoặc quote
- `timezone.test.ts`
  - VN → US Eastern conversion (DST aware)
  - Day boundary 23:59:59 US ET sang VN time tương ứng

### 12.2 Integration tests
- `/api/shopify/orders/sync` với mocked GraphQL response → DB state đúng
- `/api/fulfillment/export` với template → CSV output đúng
- `/api/fulfillment/pl-summary` filter date range → aggregate đúng

### 12.3 Manual QA checklist
- [ ] Sync orders thật từ Shopify store của user → dashboard hiển thị order mới nhất
- [ ] Mock case: order có SKU không tồn tại trong SupplierProduct → alert hiện, profit row đánh dấu màu đỏ
- [ ] Export CSV cho Printful → mở file trong Excel → format đúng cột
- [ ] Drag drop order trong Kanban → status update + persist sau refresh
- [ ] Filter date range US-time → verify boundary 23:59 ET map đúng VN 10:59 sáng hôm sau

---

## 13. Implementation Phases (Phase 13 broken down)

### Phase 13.1 — Foundation (Week 1)
- [ ] Prisma schema migration cho 6 models
- [ ] `src/lib/db.ts` SCHEMA_VERSION bump
- [ ] `src/lib/pl-calculator.ts` pure function + unit tests (TDD)
- [ ] `src/lib/csv-template.ts` engine + unit tests (TDD)
- [ ] `src/lib/timezone.ts` helper + unit tests
- [ ] Sidebar update với FULFILLMENT group

### Phase 13.2 — Backend sync (Week 1-2)
- [ ] `src/lib/shopify-orders.ts` GraphQL client
- [ ] `POST /api/shopify/orders/sync` route + idempotency
- [ ] `GET /api/shopify/orders` route
- [ ] `GET /api/fulfillment/orders` (join + P/L compute)
- [ ] `GET /api/fulfillment/pl-summary` (aggregate)
- [ ] Integration test sync flow với mocked Shopify response

### Phase 13.3 — Supplier setup UI (Week 2)
- [ ] `/setup/suppliers` page (CRUD)
- [ ] `/setup/products` page (CRUD + CSV import)
- [ ] `/api/suppliers/*` routes
- [ ] `src/lib/suppliers/printful.ts` + `/api/suppliers/[id]/sync-cost` route
- [ ] `src/lib/suppliers/printify.ts`
- [ ] Cost history trigger via Prisma middleware

### Phase 13.4 — Dashboard + Filters (Week 2-3)
- [ ] `/fulfillment` page với stats card, filter bar, orders table
- [ ] Order drill-down modal
- [ ] Date range picker với VN/US toggle
- [ ] Sync Now button

### Phase 13.5 — CSV Export Center (Week 3)
- [ ] `/setup/suppliers/[id]/templates` template builder UI
- [ ] `/fulfillment/export` page (chọn supplier + template + date range)
- [ ] `POST /api/fulfillment/export` returns CSV blob
- [ ] Seed 3 default templates (Printful, Printify, CustomCat)

### Phase 13.6 — Pipeline & Alerts (Week 3-4)
- [ ] `/fulfillment/pipeline` Kanban
- [ ] Drag-drop library (dnd-kit hoặc react-beautiful-dnd)
- [ ] `PATCH /api/fulfillment/pipeline` bulk status update
- [ ] Alert panel computed on dashboard
- [ ] Bulk action UI in Kanban

### Phase 13.7 — Project integration & polish (Week 4)
- [ ] Update `/projects/page.tsx` + `/api/projects/analytics`: combine fulfillment profit + ad spend + staff cost
- [ ] Overview dashboard: thêm Fulfillment stats card
- [ ] Manual QA checklist (Section 12.3)
- [ ] Documentation update (SPEC.md + NOTES.md + PLAN.md)

---

## 14. Resolved Open Questions (từ Section 8 cũ)

| # | Question | Resolution |
|---|---|---|
| 1 | Schema approval | Pending user final review of this spec |
| 2 | `defaultSupplierId` khi mixed | Majority qty; tie → null + alert MIXED_SUPPLIER |
| 3 | Tax handling | Exclude tax từ `grossAmount` nếu `tax_lines[].source === "marketplace"`; else include |
| 4 | Initial sync window | Default 60 ngày; configurable via `ShopifyStore.syncSinceDate` (new field — added in migration) |
| 5 | Seed templates | Ship 3 (Printful, Printify, CustomCat) via Prisma seed |

**Additional schema field added** (cập nhật Section 2):
```prisma
model ShopifyStore {
  ...
  syncSinceDate  DateTime?    // nullable; if null → default to (now − 60 days)
}
```


---

## 7. Market research takeaways (đã review)

Tham khảo từ Order Desk (CSV template per sup), TrueProfit/BeProfit/Lifetimely (COGS rules + P&L realtime), DSers/AutoDS (supplier mapping với fallback), Triple Whale (per-product profit ranking).

**Features mượn từ market sẽ làm:**
- Cost history versioning (BeProfit)
- CSV template builder (Order Desk)
- Pipeline Kanban (DSers)
- Alert SKU thiếu mapping (TrueProfit)
- Per-SKU profit ranking (Triple Whale)
- Daily digest report (Lifetimely)

**KHÔNG làm v1 (defer cho Phase 14+):**
- Auto-push order qua sup API
- Multi-currency với FX
- Webhook (vẫn dùng polling)
- QuickBooks/Sheets export
- Email alert

---

## 8. Open questions (cần user confirm khi continue)

1. **Schema approval** — bạn approve schema model ở Section 5 chứ? (đặc biệt: tên field, có thiếu field nào không?)
2. **Resolve `defaultSupplierId` per order** — nếu order có nhiều SKU thuộc nhiều sup khác nhau, default supplier của order là gì? (đề xuất: sup chiếm majority qty; OR null + force user assign)
3. **Tax handling** — nếu Shopify marketplace facilitator collect tax (như US sales tax marketplace), `grossAmount` có nên trừ tax không? Hiện tại đang include.
4. **Order pagination khi sync** — Shopify limit 250/page. Sync từ lúc nào lần đầu? (đề xuất: cho user chọn `since` date, default 30 ngày trước)
5. **CSV template seed data** — có cần ship sẵn template cho Printful / Printify / CustomCat phổ biến không?

---

## 9. Tiếp tục từ đâu (cho session sau / codex)

**Next action khi resume:**
1. Đọc file này + `CLAUDE.md` + `PLAN.md` + `NOTES.md` của project.
2. Xác nhận với user các open questions ở Section 8.
3. Hoàn thiện Section 3-9 trên (draft → user approve từng section).
4. Sau khi tất cả section approved → re-write thành spec final (single doc), commit, request user review.
5. Sau khi user approve final spec → invoke `superpowers:writing-plans` skill để tạo implementation plan ở `docs/superpowers/plans/`.
6. Implementation theo plan, có thể dùng `superpowers:executing-plans` skill.

**Tránh đi tắt:** Không bắt đầu code (Prisma migration, route, UI) trước khi user approve final spec — đây là yêu cầu của brainstorming workflow.
