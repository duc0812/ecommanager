# Profit Dashboard + Auto-sync Design
**Date:** 2026-05-20  
**Status:** Approved by user

---

## 1. Tổng quan

Ba tính năng độc lập nhưng liên quan chặt chẽ:

| # | Tính năng | Trang/File chính |
|---|-----------|-----------------|
| 1 | Auto-sync mỗi giờ (orders + Meta Insights) | `lib/auto-sync.ts` + `app/api/auto-sync/route.ts` |
| 2 | Profit Chart trong Projects page | `app/projects/page.tsx` + `app/api/projects/profit-chart/route.ts` |
| 3 | Overview metrics theo Ngày/Tuần/Tháng | `app/page.tsx` + `app/api/overview/route.ts` |

---

## 2. Auto-sync (Feature 1)

### Mục tiêu
Tự động chạy mỗi 1 tiếng để sync dữ liệu mới nhất, không cần tương tác thủ công.

### Scope sync
- ✅ Shopify **orders** (orders mới từ Shopify API, dùng `syncSinceDate` làm checkpoint)
- ✅ Meta **Insights** (ad spend theo ngày từ `/{account_id}/insights`)
- ❌ Shopify **payouts** (loại trừ — chỉ payout 1 lần/ngày, sync thủ công)
- ❌ Meta **billing transactions** (không cần — billing đã có route riêng, 1 lần/ngày)

### Cơ chế scheduler
Dùng **`node-cron`** chạy trong Next.js process (không cần Task Scheduler bên ngoài):
- Singleton trong `lib/auto-sync.ts` — `initAutoSync()` chỉ register cron 1 lần
- Khởi động qua **`instrumentation.ts`** (Next.js 14 server hook, chạy khi process start):
  ```ts
  // instrumentation.ts (root của project)
  export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
      const { initAutoSync } = await import('./src/lib/auto-sync')
      initAutoSync()
    }
  }
  ```
- `app/api/auto-sync/route.ts` chỉ expose `POST` để trigger thủ công + `GET` để lấy status
- Cron expression: `0 * * * *` (đầu mỗi giờ)
- Log kết quả vào `AppSetting` key `last_auto_sync_result` (JSON string)

### Shopify Orders Sync (mới)
**Route:** `POST /api/shopify/sync-orders`

Logic:
1. Lấy store từ DB (`prisma.shopifyStore.findFirst()`)
2. Query Shopify GraphQL: orders từ `syncSinceDate` hoặc 30 ngày nếu chưa có
3. Upsert orders + orderLines vào DB
4. Map supplier tự động (gọi `auto-mapping.ts` nếu có)
5. Cập nhật `store.syncSinceDate = now()`

Fields cần từ Shopify: `id`, `name`, `processedAt`, `financialStatus`, `fulfillmentStatus`, `currency`, `currentTotalPriceSet`, `currentSubtotalPriceSet`, `currentShippingPriceSet`, `currentTotalTaxSet`, lines, transactions (fees), customer, shippingAddress

### Meta Insights Sync (mới — cần model mới)
**Route:** `POST /api/meta/sync-insights`

Gọi Meta Insights API: `GET /{account_id}/insights?fields=spend&time_increment=1&date_preset=last_30_days`

**Model mới: `DailyAdSpend`**
```prisma
model DailyAdSpend {
  id          String        @id @default(cuid())
  adAccountId String
  adAccount   MetaAdAccount @relation(fields: [adAccountId], references: [id])
  date        String        // "YYYY-MM-DD"
  spend       Float
  impressions Int           @default(0)
  clicks      Int           @default(0)
  currency    String        @default("USD")
  fetchedAt   DateTime      @default(now())

  @@unique([adAccountId, date])
  @@index([date])
  @@index([adAccountId])
}
```

Migration name: `add_daily_ad_spend`  
Schema version bump: `v16` → `v17`

### Auto-sync Status UI
Hiển thị ở dưới cùng của Projects page và Overview page:
- Dot xanh/đỏ: running/error
- Text: "Lần cuối: HH:MM · Orders: N · Spend: $X"
- Button "⟳ Sync ngay" → `POST /api/auto-sync` (trigger thủ công)
- Button "Cấu hình" → link `/setup`

---

## 3. Profit Chart — Projects Page (Feature 2)

### Vị trí
Section mới được thêm vào đầu phần analytics trong `app/projects/page.tsx`, trước các section "Actual Cashflow" và "Gross Profit" hiện tại.

### API mới: `GET /api/projects/profit-chart`

**Params:**
- `projectId` (required)
- `period`: `this-month` (default) | `this-week` | `today` | `custom`
- `from`, `to`: dùng khi `period=custom` (YYYY-MM-DD)

**Response:**
```typescript
{
  dailyData: Array<{
    date: string          // "YYYY-MM-DD"
    orders: number        // số đơn có profit tính được
    ordersUnmapped: number // số đơn chưa map supplier
    revenue: number       // tổng expectedPayout
    profit: number        // tổng profit tính được
    adSpend: number       // từ DailyAdSpend cho ngày đó
  }>
  summary: {
    totalOrders: number
    totalOrdersUnmapped: number
    totalRevenue: number
    totalProfit: number
    totalAdSpend: number
    netProfit: number     // totalProfit - totalAdSpend
    avgMargin: number     // %
    avgOrderProfit: number
  }
}
```

### Công thức Profit per order
```
profit = order.expectedPayout
       − Σ(line.resolvedBaseCost × line.qty)
       − resolvedShipFirst
       − resolvedShipAdditional × max(0, totalQty − 1)
       − resolvedImportTaxPerUnit × totalQty
```

Nếu bất kỳ line nào `resolvedBaseCost = null` → đơn đó thuộc `ordersUnmapped`, không tính vào profit.

Group theo `order.placedAt` (date part, dùng timezone của store `ianaTimezone`).

### Chart UI
**Kiểu D**: Profit line (xanh) + Order count bars (tím nhạt, background)

- Period selector: `Hôm nay` | `Tuần này` | `Tháng này` | `Tùy chọn` (date range)
- Summary cards: Total Profit · Orders · Avg Margin · Avg Order Profit
- SVG chart thuần (không dùng thư viện ngoài)
- Tooltip khi hover ngày: date, orders count, profit, ad spend

---

## 4. Overview Metrics theo Period (Feature 3)

### Thay đổi API: `GET /api/overview`

Thêm query param `?period=today|this-week|this-month` (default: all-time).

**Metrics mới trả về trong `periodMetrics`:**
```typescript
periodMetrics: {
  period: string
  from: string   // ISO date
  to: string     // ISO date
  orders: number
  revenue: number        // tổng order.grossAmount
  adSpend: number        // từ DailyAdSpend
  orderProfit: number    // tổng profit từ orders
  netProfit: number      // orderProfit - adSpend
  roas: number           // revenue / adSpend
  avgMargin: number      // %
  avgOrderValue: number  // AOV
  unfulfilledOrders: number
}
```

### Overview Page UI
Layout mới theo thiết kế đã duyệt:

**Period tabs** ở đầu trang: Hôm nay · Tuần này · Tháng này · All time

**Row 1 (4 cards):**
- Hero: Net Profit (highlight tím/xanh) + % vs period trước
- Orders count + AOV
- Revenue + % vs period trước
- Ad Spend + ROAS

**Row 2 (4 cards nhỏ):**
- Fulfillment Cost (từ order lines)
- ROAS
- Avg Order Profit
- Unfulfilled Orders

**Chart:** Revenue bars (từ `Order.grossAmount` grouped by `placedAt`) + Ad Spend bars (từ `DailyAdSpend`) + Profit line — toggle Tuần/Tháng

**Các section cũ giữ nguyên** bên dưới (Recent Payouts, Recent Billings, Projects summary).

---

## 5. Database Changes

| Thay đổi | Chi tiết |
|----------|----------|
| Thêm model `DailyAdSpend` | Lưu ad spend theo ngày từ Meta Insights |
| Thêm relation `MetaAdAccount.dailySpends` | `DailyAdSpend[]` |
| Schema version | `v16` → `v17` |
| Migration | `npx prisma migrate dev --name add_daily_ad_spend` |

---

## 6. Packages mới

| Package | Mục đích |
|---------|----------|
| `node-cron` | Scheduler chạy trong Next.js process |

Cài: `npm install node-cron @types/node-cron`

---

## 7. File Changes Summary

### Mới tạo
- `instrumentation.ts` — Next.js server hook, gọi `initAutoSync()` khi process start
- `src/lib/auto-sync.ts` — singleton scheduler + sync orchestration
- `src/app/api/auto-sync/route.ts` — GET (status) + POST (manual trigger)
- `src/app/api/shopify/sync-orders/route.ts` — sync orders từ Shopify API
- `src/app/api/meta/sync-insights/route.ts` — sync daily spend từ Meta Insights
- `src/app/api/projects/profit-chart/route.ts` — profit chart data

### Chỉnh sửa
- `prisma/schema.prisma` — thêm `DailyAdSpend` model
- `src/lib/db.ts` — bump schema version v16→v17
- `src/app/api/overview/route.ts` — thêm period filtering + periodMetrics
- `src/app/page.tsx` — redesign với period tabs + new metric cards + chart
- `src/app/projects/page.tsx` — thêm ProfitChart section + auto-sync status bar

---

## 8. Constraints & Edge Cases

- Đơn chưa map supplier → hiện trong chart với `profit = null`, không tính vào tổng
- Meta Insights API delay ~15 phút so với thực tế (Meta limitation)
- Auto-sync chỉ chạy khi Next.js server đang chạy — không phải background service persistent
- Nếu store chưa kết nối Shopify, orders sync bỏ qua silently
- Nếu không có Meta account, insights sync bỏ qua silently
- `DailyAdSpend` upsert theo `(adAccountId, date)` unique → chạy nhiều lần an toàn
