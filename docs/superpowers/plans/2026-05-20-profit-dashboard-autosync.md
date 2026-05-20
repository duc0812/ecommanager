# Profit Dashboard + Auto-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm auto-sync mỗi giờ (Shopify orders + Meta Insights), profit chart theo ngày vào Projects page, và redesign Overview page với period metrics (Hôm nay / Tuần / Tháng).

**Architecture:** Node-cron singleton khởi động qua Next.js `instrumentation.ts` hook; sync logic tách thành lib functions độc lập; DailyAdSpend model mới lưu ad spend theo ngày từ Meta Insights API; profit tính từ các trường đã lưu sẵn trên OrderLine (resolvedBaseCost, resolvedShipFirst…).

**Tech Stack:** Next.js 14.2, Prisma 7 / LibSQL, node-cron, TypeScript, Tailwind CSS, SVG charts (thuần, không lib ngoài)

---

## File Structure

### Tạo mới
| File | Trách nhiệm |
|------|-------------|
| `src/lib/order-profit.ts` | `computeOrderProfitFromDb()` — tính profit từ DB order lines |
| `src/lib/sync-shopify-orders.ts` | `syncShopifyOrders()` — kéo orders mới từ Shopify API |
| `src/lib/sync-meta-insights.ts` | `syncMetaInsights()` — kéo daily ad spend từ Meta Insights |
| `src/lib/auto-sync.ts` | `initAutoSync()` — node-cron singleton, gọi cả hai sync trên |
| `instrumentation.ts` | Next.js server hook, gọi `initAutoSync()` khi process start |
| `src/app/api/shopify/sync-orders/route.ts` | POST → gọi `syncShopifyOrders()` |
| `src/app/api/meta/sync-insights/route.ts` | POST → gọi `syncMetaInsights()` |
| `src/app/api/auto-sync/route.ts` | GET status + POST manual trigger |
| `src/app/api/projects/profit-chart/route.ts` | GET profit chart data theo project + period |

### Chỉnh sửa
| File | Thay đổi |
|------|----------|
| `next.config.mjs` | Bật `experimental.instrumentationHook` |
| `prisma/schema.prisma` | Thêm model `DailyAdSpend` + relation vào `MetaAdAccount` |
| `src/lib/db.ts` | Bump `SCHEMA_VERSION` v16 → v17 |
| `src/app/api/overview/route.ts` | Thêm `?period=` param + `periodMetrics` + `chartData` trong response |
| `src/app/page.tsx` | Redesign: period tabs + hero profit card + chart |
| `src/app/projects/page.tsx` | Thêm `ProfitChart` section + auto-sync status bar |

---

## Task 1: Schema Migration + Install node-cron

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/lib/db.ts`
- Modify: `next.config.mjs`

- [ ] **Bước 1: Cài node-cron**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npm install node-cron
npm install --save-dev @types/node-cron
```

Expected: `added 2 packages`

- [ ] **Bước 2: Thêm DailyAdSpend vào schema**

Mở `prisma/schema.prisma`, thêm model sau vào cuối file (sau `VariantManualMapping`):

```prisma
model DailyAdSpend {
  id          String        @id @default(cuid())
  adAccountId String
  adAccount   MetaAdAccount @relation(fields: [adAccountId], references: [id])
  date        String        // "YYYY-MM-DD"
  spend       Float         @default(0)
  impressions Int           @default(0)
  clicks      Int           @default(0)
  currency    String        @default("USD")
  fetchedAt   DateTime      @default(now())

  @@unique([adAccountId, date])
  @@index([date])
  @@index([adAccountId])
}
```

Và thêm relation vào model `MetaAdAccount` (sau dòng `lastSyncAt`):

```prisma
  dailySpends DailyAdSpend[]
```

- [ ] **Bước 3: Chạy migration**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx prisma migrate dev --name add_daily_ad_spend
npx prisma generate
```

Expected output kết thúc bằng: `Generated Prisma Client`

- [ ] **Bước 4: Bump schema version**

Trong `src/lib/db.ts`, đổi:
```typescript
const SCHEMA_VERSION = 'v16'
```
thành:
```typescript
const SCHEMA_VERSION = 'v17'
```

- [ ] **Bước 5: Bật instrumentation hook trong next.config.mjs**

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    instrumentationHook: true,
  },
};

export default nextConfig;
```

- [ ] **Bước 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/db.ts next.config.mjs package.json package-lock.json
git commit -m "feat: add DailyAdSpend schema + node-cron dependency"
```

---

## Task 2: Order Profit Helper + Unit Test

**Files:**
- Create: `src/lib/order-profit.ts`
- Create: `src/lib/order-profit.test.ts`

- [ ] **Bước 1: Viết test trước (TDD)**

Tạo `src/lib/order-profit.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { computeOrderProfitFromDb } from './order-profit'

describe('computeOrderProfitFromDb', () => {
  it('returns null if any line has no resolvedBaseCost', () => {
    const result = computeOrderProfitFromDb(100, [
      { qty: 1, resolvedBaseCost: null, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 0 },
    ])
    expect(result).toBeNull()
  })

  it('calculates profit for single-item order', () => {
    // expectedPayout=50, baseCost=20*1=20, shipping=5+0=5, import=0 → profit=25
    const result = computeOrderProfitFromDb(50, [
      { qty: 1, resolvedBaseCost: 20, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 0 },
    ])
    expect(result).toBe(25)
  })

  it('calculates profit for multi-item order', () => {
    // expectedPayout=100, baseCost=20*3=60, shipping=5+2*(3-1)=9, import=1*3=3 → profit=28
    const result = computeOrderProfitFromDb(100, [
      { qty: 3, resolvedBaseCost: 20, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 1 },
    ])
    expect(result).toBe(28)
  })

  it('uses first line with shipping for dominant supplier', () => {
    // 2 lines, first has shipping, second does not
    // qty=1+2=3, baseCost=10+15*2=40, shipping from line0: 5+2*(3-1)=9, import=0 → profit=100-40-9=51
    const result = computeOrderProfitFromDb(100, [
      { qty: 1, resolvedBaseCost: 10, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 0 },
      { qty: 2, resolvedBaseCost: 15, resolvedShipFirst: null, resolvedShipAdditional: null, resolvedImportTax: 0 },
    ])
    expect(result).toBe(51)
  })

  it('returns profit=expectedPayout if no costs at all (zero cost order)', () => {
    const result = computeOrderProfitFromDb(50, [
      { qty: 1, resolvedBaseCost: 0, resolvedShipFirst: 0, resolvedShipAdditional: 0, resolvedImportTax: 0 },
    ])
    expect(result).toBe(50)
  })
})
```

- [ ] **Bước 2: Chạy test để xác nhận nó fail**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx vitest run src/lib/order-profit.test.ts
```

Expected: `FAIL` với lỗi `Cannot find module './order-profit'`

- [ ] **Bước 3: Tạo `src/lib/order-profit.ts`**

```typescript
export type OrderLineForProfit = {
  qty: number
  resolvedBaseCost: number | null
  resolvedShipFirst: number | null
  resolvedShipAdditional: number | null
  resolvedImportTax: number | null
}

export function computeOrderProfitFromDb(
  expectedPayout: number,
  lines: OrderLineForProfit[]
): number | null {
  if (lines.length === 0) return null
  if (lines.some(l => l.resolvedBaseCost === null)) return null

  const totalQty = lines.reduce((s, l) => s + l.qty, 0)
  const totalBaseCost = lines.reduce((s, l) => s + l.resolvedBaseCost! * l.qty, 0)

  const dominantLine = lines.find(l => l.resolvedShipFirst !== null) ?? null
  const shipFirst = dominantLine?.resolvedShipFirst ?? 0
  const shipAdditional = dominantLine?.resolvedShipAdditional ?? 0
  const shipping = shipFirst + shipAdditional * Math.max(0, totalQty - 1)

  const importTax = lines.reduce((s, l) => s + (l.resolvedImportTax ?? 0) * l.qty, 0)

  return expectedPayout - totalBaseCost - shipping - importTax
}
```

- [ ] **Bước 4: Chạy lại test để pass**

```bash
npx vitest run src/lib/order-profit.test.ts
```

Expected: `✓ 5 tests passed`

- [ ] **Bước 5: Commit**

```bash
git add src/lib/order-profit.ts src/lib/order-profit.test.ts
git commit -m "feat: add computeOrderProfitFromDb helper with tests"
```

---

## Task 3: Shopify Orders Sync Lib + Route

**Files:**
- Create: `src/lib/sync-shopify-orders.ts`
- Create: `src/app/api/shopify/sync-orders/route.ts`

- [ ] **Bước 1: Tạo `src/lib/sync-shopify-orders.ts`**

```typescript
import { prisma } from '@/lib/db'
import { getShopifyConnection } from '@/lib/token-store'
import { fetchOrdersPage } from '@/lib/shopify-orders'

function computeTotalFees(transactions: Array<{ kind: string; status: string; fees: number }>): number {
  return transactions
    .filter(tx => ['CAPTURE', 'SALE'].includes(tx.kind) && tx.status === 'SUCCESS')
    .reduce((s, tx) => s + tx.fees, 0)
}

export async function syncShopifyOrders(): Promise<{ synced: number; skipped: number; error?: string }> {
  const conn = await getShopifyConnection()
  if (!conn) return { synced: 0, skipped: 0, error: 'No Shopify connection' }

  const store = await prisma.shopifyStore.findUnique({ where: { shop: conn.shop } })
  if (!store) return { synced: 0, skipped: 0, error: 'Store not found in DB' }
  if (!store.projectId) return { synced: 0, skipped: 0, error: 'Store has no projectId assigned' }

  const sinceDate = store.syncSinceDate
    ? store.syncSinceDate.toISOString().split('T')[0]
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  let cursor: string | null = null
  let synced = 0
  let skipped = 0
  let hasMore = true

  while (hasMore) {
    const page = await fetchOrdersPage(conn.shop, conn.token, cursor, sinceDate)

    for (const order of page.orders) {
      if (!['paid', 'partially_paid', 'partially_refunded'].includes(order.financialStatus.toLowerCase())) {
        skipped++
        continue
      }

      const totalFees = computeTotalFees(order.transactions)
      const expectedPayout = order.grossAmount - totalFees - order.refundedAmount

      await prisma.order.upsert({
        where: { id: order.id },
        create: {
          id: order.id,
          storeId: store.id,
          projectId: store.projectId!,
          shopifyOrderNumber: order.name,
          customerEmail: order.customerEmail,
          customerName: order.customerName,
          shippingCountry: order.shippingCountry,
          shippingState: order.shippingState,
          shippingName: order.shippingName,
          shippingAddress1: order.shippingAddress1,
          shippingAddress2: order.shippingAddress2,
          shippingCity: order.shippingCity,
          shippingZip: order.shippingZip,
          shippingPhone: order.shippingPhone,
          financialStatus: order.financialStatus.toLowerCase(),
          fulfillmentStatus: order.fulfillmentStatus?.toLowerCase() ?? null,
          currency: order.currency,
          grossAmount: order.grossAmount,
          subtotalAmount: order.subtotal,
          shippingAmount: order.shipping,
          taxAmount: order.tax,
          expectedPayout,
          totalFees,
          refundedAmount: order.refundedAmount,
          placedAt: new Date(order.processedAt ?? order.createdAt),
          shopTimezone: store.ianaTimezone ?? null,
          lines: {
            create: order.lines.map(l => ({
              shopifyLineId: l.id,
              shopifyVariantId: l.variantId,
              variantOptions: l.selectedOptions && Object.keys(l.selectedOptions).length > 0
                ? JSON.stringify(l.selectedOptions)
                : null,
              sku: l.sku,
              variantTitle: l.variantTitle,
              productTitle: l.title,
              qty: l.quantity,
              unitPrice: l.unitPrice,
            })),
          },
        },
        update: {
          financialStatus: order.financialStatus.toLowerCase(),
          fulfillmentStatus: order.fulfillmentStatus?.toLowerCase() ?? null,
          grossAmount: order.grossAmount,
          expectedPayout,
          totalFees,
          refundedAmount: order.refundedAmount,
          updatedAt: new Date(),
        },
      })
      synced++
    }

    hasMore = page.hasNextPage
    cursor = page.endCursor
  }

  await prisma.shopifyStore.update({
    where: { id: store.id },
    data: { syncSinceDate: new Date() },
  })

  return { synced, skipped }
}
```

- [ ] **Bước 2: Tạo `src/app/api/shopify/sync-orders/route.ts`**

```typescript
import { NextResponse } from 'next/server'
import { syncShopifyOrders } from '@/lib/sync-shopify-orders'

export async function POST() {
  try {
    const result = await syncShopifyOrders()
    return NextResponse.json({ success: true, ...result })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
```

- [ ] **Bước 3: Khởi động dev server và test**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npm run dev -- --port 3002
```

Trong terminal khác:

```bash
curl -X POST http://localhost:3002/api/shopify/sync-orders
```

Expected (nếu store đã connected):
```json
{"success":true,"synced":5,"skipped":2}
```

Expected (nếu chưa connect Shopify):
```json
{"success":true,"synced":0,"skipped":0,"error":"No Shopify connection"}
```

Cả hai đều là response hợp lệ (không phải 500).

- [ ] **Bước 4: Commit**

```bash
git add src/lib/sync-shopify-orders.ts src/app/api/shopify/sync-orders/route.ts
git commit -m "feat: add Shopify orders sync lib and route"
```

---

## Task 4: Meta Insights Sync Lib + Route

**Files:**
- Create: `src/lib/sync-meta-insights.ts`
- Create: `src/app/api/meta/sync-insights/route.ts`

- [ ] **Bước 1: Tạo `src/lib/sync-meta-insights.ts`**

```typescript
import { prisma } from '@/lib/db'

const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION ?? 'v19.0'

function dateOnly(d: Date) {
  return d.toISOString().split('T')[0]
}

function daysAgo(n: number) {
  return dateOnly(new Date(Date.now() - n * 24 * 60 * 60 * 1000))
}

export async function syncMetaInsights(
  days = 30
): Promise<{ synced: number; accounts: number; error?: string }> {
  const accounts = await prisma.metaAdAccount.findMany()
  if (accounts.length === 0) return { synced: 0, accounts: 0, error: 'No Meta accounts configured' }

  const since = daysAgo(days)
  const until = dateOnly(new Date())
  let totalSynced = 0

  for (const account of accounts) {
    const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${account.accountId}/insights`)
    url.searchParams.set('fields', 'spend,impressions,clicks')
    url.searchParams.set('time_increment', '1')
    url.searchParams.set('time_range', JSON.stringify({ since, until }))
    url.searchParams.set('level', 'account')
    url.searchParams.set('access_token', account.accessToken)

    const res = await fetch(url.toString())
    const json = await res.json()

    if (json.error) {
      console.error(`[sync-meta-insights] Account ${account.accountId}: ${json.error.message}`)
      continue
    }

    const rows: Array<{ spend: string; impressions: string; clicks: string; date_start: string }> =
      json.data ?? []

    for (const row of rows) {
      await prisma.dailyAdSpend.upsert({
        where: { adAccountId_date: { adAccountId: account.id, date: row.date_start } },
        create: {
          adAccountId: account.id,
          date: row.date_start,
          spend: parseFloat(row.spend ?? '0'),
          impressions: parseInt(row.impressions ?? '0', 10),
          clicks: parseInt(row.clicks ?? '0', 10),
          currency: account.currency ?? 'USD',
        },
        update: {
          spend: parseFloat(row.spend ?? '0'),
          impressions: parseInt(row.impressions ?? '0', 10),
          clicks: parseInt(row.clicks ?? '0', 10),
          fetchedAt: new Date(),
        },
      })
      totalSynced++
    }

    await prisma.metaAdAccount.update({
      where: { id: account.id },
      data: { lastSyncAt: new Date() },
    })
  }

  return { synced: totalSynced, accounts: accounts.length }
}
```

- [ ] **Bước 2: Tạo `src/app/api/meta/sync-insights/route.ts`**

```typescript
import { NextResponse } from 'next/server'
import { syncMetaInsights } from '@/lib/sync-meta-insights'

export async function POST() {
  try {
    const result = await syncMetaInsights()
    return NextResponse.json({ success: true, ...result })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
```

- [ ] **Bước 3: Test route**

```bash
curl -X POST http://localhost:3002/api/meta/sync-insights
```

Expected (nếu có Meta account):
```json
{"success":true,"synced":20,"accounts":1}
```

Expected (nếu chưa có account):
```json
{"success":true,"synced":0,"accounts":0,"error":"No Meta accounts configured"}
```

- [ ] **Bước 4: Commit**

```bash
git add src/lib/sync-meta-insights.ts src/app/api/meta/sync-insights/route.ts
git commit -m "feat: add Meta Insights daily spend sync lib and route"
```

---

## Task 5: Auto-sync Infrastructure

**Files:**
- Create: `src/lib/auto-sync.ts`
- Create: `instrumentation.ts`
- Create: `src/app/api/auto-sync/route.ts`

- [ ] **Bước 1: Tạo `src/lib/auto-sync.ts`**

```typescript
import cron from 'node-cron'
import { prisma } from '@/lib/db'
import { syncShopifyOrders } from '@/lib/sync-shopify-orders'
import { syncMetaInsights } from '@/lib/sync-meta-insights'

let initialized = false

export async function runAutoSync(): Promise<Record<string, any>> {
  const result: Record<string, any> = { startedAt: new Date().toISOString() }

  try {
    result.orders = await syncShopifyOrders()
  } catch (e: any) {
    result.orders = { error: e.message }
  }

  try {
    result.insights = await syncMetaInsights()
  } catch (e: any) {
    result.insights = { error: e.message }
  }

  result.finishedAt = new Date().toISOString()

  await prisma.appSetting.upsert({
    where: { key: 'last_auto_sync_result' },
    create: { key: 'last_auto_sync_result', value: JSON.stringify(result) },
    update: { value: JSON.stringify(result) },
  })

  return result
}

export function initAutoSync() {
  if (initialized) return
  initialized = true
  cron.schedule('0 * * * *', () => {
    runAutoSync().catch(err => console.error('[auto-sync] Error:', err))
  })
  console.log('[auto-sync] Initialized — runs every hour on the hour')
}
```

- [ ] **Bước 2: Tạo `instrumentation.ts` ở root project**

Tạo file tại `C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh/instrumentation.ts`:

```typescript
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initAutoSync } = await import('./src/lib/auto-sync')
    initAutoSync()
  }
}
```

- [ ] **Bước 3: Tạo `src/app/api/auto-sync/route.ts`**

```typescript
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { runAutoSync } from '@/lib/auto-sync'

export async function GET() {
  try {
    const setting = await prisma.appSetting.findUnique({
      where: { key: 'last_auto_sync_result' },
    })
    const lastResult = setting?.value ? JSON.parse(setting.value) : null
    return NextResponse.json({ status: 'running', lastResult })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function POST() {
  try {
    const result = await runAutoSync()
    return NextResponse.json({ success: true, result })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
```

- [ ] **Bước 4: Restart dev server và xác nhận instrumentation log**

Dừng server (Ctrl+C), khởi động lại:
```bash
npm run dev -- --port 3002
```

Expected trong console: `[auto-sync] Initialized — runs every hour on the hour`

- [ ] **Bước 5: Test manual trigger**

```bash
curl -X POST http://localhost:3002/api/auto-sync
```

Expected:
```json
{"success":true,"result":{"startedAt":"...","orders":{...},"insights":{...},"finishedAt":"..."}}
```

- [ ] **Bước 6: Test status endpoint**

```bash
curl http://localhost:3002/api/auto-sync
```

Expected:
```json
{"status":"running","lastResult":{"startedAt":"...","orders":{"synced":5,"skipped":2},...}}
```

- [ ] **Bước 7: Commit**

```bash
git add src/lib/auto-sync.ts instrumentation.ts src/app/api/auto-sync/route.ts
git commit -m "feat: auto-sync cron (orders + Meta Insights) via instrumentation hook"
```

---

## Task 6: Profit Chart API

**Files:**
- Create: `src/app/api/projects/profit-chart/route.ts`

- [ ] **Bước 1: Tạo `src/app/api/projects/profit-chart/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { computeOrderProfitFromDb } from '@/lib/order-profit'

function getPeriodRange(period: string, from?: string | null, to?: string | null) {
  const now = new Date()
  const todayStr = now.toISOString().split('T')[0]

  if (period === 'custom' && from && to) {
    return { from: new Date(`${from}T00:00:00.000Z`), to: new Date(`${to}T23:59:59.999Z`) }
  }
  if (period === 'today') {
    return { from: new Date(`${todayStr}T00:00:00.000Z`), to: new Date(`${todayStr}T23:59:59.999Z`) }
  }
  if (period === 'this-week') {
    const dow = now.getUTCDay()
    const monday = new Date(now)
    monday.setUTCDate(now.getUTCDate() - ((dow + 6) % 7))
    const mondayStr = monday.toISOString().split('T')[0]
    return { from: new Date(`${mondayStr}T00:00:00.000Z`), to: new Date(`${todayStr}T23:59:59.999Z`) }
  }
  // default: this-month
  const monthStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  return {
    from: new Date(`${monthStr}-01T00:00:00.000Z`),
    to: new Date(`${todayStr}T23:59:59.999Z`),
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get('projectId')
  if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 })

  const period = searchParams.get('period') ?? 'this-month'
  const { from, to } = getPeriodRange(period, searchParams.get('from'), searchParams.get('to'))

  // Lấy orders của project trong khoảng thời gian
  const orders = await prisma.order.findMany({
    where: { projectId, placedAt: { gte: from, lte: to } },
    include: {
      lines: {
        select: {
          qty: true,
          resolvedBaseCost: true,
          resolvedShipFirst: true,
          resolvedShipAdditional: true,
          resolvedImportTax: true,
        },
      },
    },
    orderBy: { placedAt: 'asc' },
  })

  // Lấy MetaAdAccount của project để query DailyAdSpend
  const metaAccounts = await prisma.metaAdAccount.findMany({
    where: { projectId },
    select: { id: true },
  })
  const accountIds = metaAccounts.map(a => a.id)

  const fromDate = from.toISOString().split('T')[0]
  const toDate = to.toISOString().split('T')[0]

  const dailySpends = accountIds.length > 0
    ? await prisma.dailyAdSpend.findMany({
        where: { adAccountId: { in: accountIds }, date: { gte: fromDate, lte: toDate } },
      })
    : []

  // Tổng spend theo ngày
  const spendByDate: Record<string, number> = {}
  for (const ds of dailySpends) {
    spendByDate[ds.date] = (spendByDate[ds.date] ?? 0) + ds.spend
  }

  // Group orders theo ngày
  const dayMap: Record<string, { orders: number; ordersUnmapped: number; revenue: number; profit: number }> = {}

  for (const order of orders) {
    const dateKey = order.placedAt.toISOString().split('T')[0]
    if (!dayMap[dateKey]) dayMap[dateKey] = { orders: 0, ordersUnmapped: 0, revenue: 0, profit: 0 }

    const profit = computeOrderProfitFromDb(order.expectedPayout, order.lines)

    if (profit === null) {
      dayMap[dateKey].ordersUnmapped++
    } else {
      dayMap[dateKey].orders++
      dayMap[dateKey].revenue += order.grossAmount
      dayMap[dateKey].profit += profit
    }
  }

  // Build daily series — fill in missing days with zeros
  const dailyData = []
  const cursor = new Date(from)
  while (cursor <= to) {
    const dateStr = cursor.toISOString().split('T')[0]
    const day = dayMap[dateStr] ?? { orders: 0, ordersUnmapped: 0, revenue: 0, profit: 0 }
    dailyData.push({
      date: dateStr,
      orders: day.orders,
      ordersUnmapped: day.ordersUnmapped,
      revenue: Math.round(day.revenue * 100) / 100,
      profit: Math.round(day.profit * 100) / 100,
      adSpend: Math.round((spendByDate[dateStr] ?? 0) * 100) / 100,
    })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  const totalOrders = dailyData.reduce((s, d) => s + d.orders, 0)
  const totalOrdersUnmapped = dailyData.reduce((s, d) => s + d.ordersUnmapped, 0)
  const totalRevenue = Math.round(dailyData.reduce((s, d) => s + d.revenue, 0) * 100) / 100
  const totalProfit = Math.round(dailyData.reduce((s, d) => s + d.profit, 0) * 100) / 100
  const totalAdSpend = Math.round(dailyData.reduce((s, d) => s + d.adSpend, 0) * 100) / 100
  const avgMargin = totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 10000) / 100 : 0
  const avgOrderProfit = totalOrders > 0 ? Math.round((totalProfit / totalOrders) * 100) / 100 : 0

  return NextResponse.json({
    dailyData,
    summary: {
      totalOrders,
      totalOrdersUnmapped,
      totalRevenue,
      totalProfit,
      totalAdSpend,
      netProfit: Math.round((totalProfit - totalAdSpend) * 100) / 100,
      avgMargin,
      avgOrderProfit,
    },
  })
}
```

- [ ] **Bước 2: Test API**

```bash
# Lấy projectId từ DB trước
curl http://localhost:3002/api/projects

# Thay <PROJECT_ID> bằng id thực
curl "http://localhost:3002/api/projects/profit-chart?projectId=<PROJECT_ID>&period=this-month"
```

Expected:
```json
{
  "dailyData": [
    {"date":"2026-05-01","orders":3,"ordersUnmapped":0,"revenue":120.00,"profit":38.40,"adSpend":25.00},
    ...
  ],
  "summary": {
    "totalOrders": 94,
    "totalOrdersUnmapped": 5,
    "totalRevenue": 4317.74,
    "totalProfit": 1382.47,
    "totalAdSpend": 892.00,
    "netProfit": 490.47,
    "avgMargin": 32.04,
    "avgOrderProfit": 14.71
  }
}
```

- [ ] **Bước 3: Commit**

```bash
git add src/app/api/projects/profit-chart/route.ts
git commit -m "feat: profit chart API with daily order profit + ad spend"
```

---

## Task 7: Projects Page — ProfitChart Section

**Files:**
- Modify: `src/app/projects/page.tsx`

- [ ] **Bước 1: Thêm types và helper functions vào đầu file (sau các type declarations hiện có)**

Mở `src/app/projects/page.tsx`, thêm sau `type Analytics = { ... }`:

```typescript
type DailyProfitPoint = {
  date: string
  orders: number
  ordersUnmapped: number
  revenue: number
  profit: number
  adSpend: number
}

type ProfitChartData = {
  dailyData: DailyProfitPoint[]
  summary: {
    totalOrders: number
    totalOrdersUnmapped: number
    totalRevenue: number
    totalProfit: number
    totalAdSpend: number
    netProfit: number
    avgMargin: number
    avgOrderProfit: number
  }
}

type AutoSyncStatus = {
  status: string
  lastResult: {
    startedAt: string
    finishedAt?: string
    orders?: { synced?: number; skipped?: number; error?: string }
    insights?: { synced?: number; accounts?: number; error?: string }
  } | null
}
```

- [ ] **Bước 2: Thêm state variables cho ProfitChart trong `ProjectDashboard` component**

Trong function `ProjectDashboard`, sau `const [costs, setCosts] = useState(...)`, thêm:

```typescript
  const [chartPeriod, setChartPeriod] = useState<string>('this-month')
  const [syncStatus, setSyncStatus] = useState<AutoSyncStatus | null>(null)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    fetch('/api/auto-sync').then(r => r.json()).then(setSyncStatus).catch(() => {})
  }, [])

  function handleManualSync() {
    setSyncing(true)
    fetch('/api/auto-sync', { method: 'POST' })
      .then(r => r.json())
      .then(() => fetch('/api/auto-sync').then(r => r.json()).then(setSyncStatus))
      .finally(() => setSyncing(false))
  }
```

- [ ] **Bước 3: Thêm `ProfitChart` component vào cuối file (sau `ProjectPLCard`)**

Thêm vào cuối file `src/app/projects/page.tsx`:

```typescript
function ProfitChart({ projectId, period, onPeriodChange }: { projectId: string; period: string; onPeriodChange: (p: string) => void }) {
  const [data, setData] = useState<ProfitChartData | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/projects/profit-chart?projectId=${projectId}&period=${period}`)
      .then(r => r.json())
      .then(setData)
      .finally(() => setLoading(false))
  }, [projectId, period])

  const periods = [
    { key: 'today', label: 'Hôm nay' },
    { key: 'this-week', label: 'Tuần này' },
    { key: 'this-month', label: 'Tháng này' },
  ]

  return (
    <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
      <div className="flex items-center justify-between px-lg py-md border-b border-outline-variant/20 flex-wrap gap-sm">
        <div className="flex items-center gap-sm">
          <span className="material-symbols-outlined text-secondary">show_chart</span>
          <h3 className="text-headline-sm text-primary">Profit Chart</h3>
          <span className="text-label-sm text-on-surface-variant">profit từng đơn hàng</span>
        </div>
        <div className="flex gap-xs">
          {periods.map(p => (
            <button
              key={p.key}
              onClick={() => onPeriodChange(p.key)}
              className={`px-md py-xs rounded-lg text-label-sm font-semibold transition-all ${
                period === p.key
                  ? 'bg-secondary text-on-secondary'
                  : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-xl">
          <span className="material-symbols-outlined animate-spin text-secondary">sync</span>
        </div>
      )}

      {data && !loading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-md p-lg border-b border-outline-variant/10">
            <div className="bg-surface-container rounded-xl p-md">
              <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Net Profit</p>
              <p className={`text-stats-lg font-bold ${data.summary.netProfit >= 0 ? 'text-on-tertiary-container' : 'text-error'}`}>
                {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(data.summary.netProfit)}
              </p>
            </div>
            <div className="bg-surface-container rounded-xl p-md">
              <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Orders</p>
              <p className="text-stats-lg font-bold text-primary">{data.summary.totalOrders}</p>
              {data.summary.totalOrdersUnmapped > 0 && (
                <p className="text-label-sm text-amber-500">{data.summary.totalOrdersUnmapped} chưa map</p>
              )}
            </div>
            <div className="bg-surface-container rounded-xl p-md">
              <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Avg Margin</p>
              <p className="text-stats-lg font-bold text-secondary">{data.summary.avgMargin.toFixed(1)}%</p>
            </div>
            <div className="bg-surface-container rounded-xl p-md">
              <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Ad Spend</p>
              <p className="text-stats-lg font-bold text-error">
                {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(data.summary.totalAdSpend)}
              </p>
            </div>
          </div>

          <ProfitChartSVG data={data.dailyData} />
        </>
      )}

      {data && data.dailyData.length === 0 && !loading && (
        <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">
          Không có dữ liệu cho khoảng thời gian này.
        </div>
      )}
    </div>
  )
}

function ProfitChartSVG({ data }: { data: DailyProfitPoint[] }) {
  if (data.length === 0) return null

  const W = 600
  const H = 150
  const PAD = { top: 12, right: 12, bottom: 28, left: 8 }
  const chartW = W - PAD.left - PAD.right
  const chartH = H - PAD.top - PAD.bottom

  const maxOrders = Math.max(...data.map(d => d.orders), 1)
  const maxProfit = Math.max(...data.map(d => d.profit), 1)
  const minProfit = Math.min(...data.map(d => d.profit), 0)
  const profitRange = maxProfit - minProfit || 1

  const barW = Math.max(2, (chartW / data.length) * 0.6)
  const step = chartW / Math.max(data.length - 1, 1)

  const toX = (i: number) => PAD.left + i * step
  const toYProfit = (v: number) => PAD.top + chartH - ((v - minProfit) / profitRange) * chartH
  const toYOrders = (v: number) => PAD.top + chartH - (v / maxOrders) * chartH

  const profitPoints = data.map((d, i) => `${toX(i)},${toYProfit(d.profit)}`).join(' ')

  const fmtDate = (s: string) => {
    const d = new Date(s + 'T00:00:00Z')
    return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`
  }

  const labelEvery = Math.ceil(data.length / 6)

  return (
    <div className="px-lg pb-lg">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0.25, 0.5, 0.75, 1].map(f => (
          <line key={f}
            x1={PAD.left} y1={PAD.top + chartH * (1 - f)}
            x2={PAD.left + chartW} y2={PAD.top + chartH * (1 - f)}
            stroke="currentColor" strokeOpacity="0.06" strokeWidth="1"
            className="text-on-surface-variant"
          />
        ))}

        {data.map((d, i) => {
          const x = toX(i)
          const barH = (d.orders / maxOrders) * chartH
          return (
            <rect key={d.date}
              x={x - barW / 2}
              y={PAD.top + chartH - barH}
              width={barW}
              height={barH}
              fill="#6366f1"
              fillOpacity="0.35"
              rx="1"
            />
          )
        })}

        <path
          d={`M${data.map((d, i) => `${toX(i)},${toYProfit(d.profit)}`).join(' L')} L${toX(data.length - 1)},${PAD.top + chartH} L${toX(0)},${PAD.top + chartH} Z`}
          fill="url(#profitGrad)"
        />
        <polyline
          points={profitPoints}
          fill="none"
          stroke="#22c55e"
          strokeWidth="2"
          strokeLinejoin="round"
        />

        {data.map((d, i) => {
          if (i !== data.length - 1 && i % labelEvery !== 0) return null
          return (
            <text key={d.date}
              x={toX(i)}
              y={H - 4}
              textAnchor="middle"
              fontSize="9"
              fill="currentColor"
              fillOpacity="0.4"
              className="text-on-surface-variant"
            >
              {fmtDate(d.date)}
            </text>
          )
        })}

        <circle cx={toX(data.length - 1)} cy={toYProfit(data[data.length - 1].profit)} r="4"
          fill="#22c55e" stroke="currentColor" strokeWidth="2" className="text-surface-container-lowest" />
      </svg>

      <div className="flex gap-lg mt-xs">
        <div className="flex items-center gap-xs">
          <div className="w-3 h-2 rounded-sm" style={{ background: '#6366f1', opacity: 0.5 }} />
          <span className="text-label-sm text-on-surface-variant">Orders/ngày</span>
        </div>
        <div className="flex items-center gap-xs">
          <div className="w-4 h-0.5 bg-green-500" />
          <span className="text-label-sm text-on-surface-variant">Profit ($)</span>
        </div>
      </div>
    </div>
  )
}

function AutoSyncStatusBar({ status, syncing, onSync }: { status: AutoSyncStatus | null; syncing: boolean; onSync: () => void }) {
  const lastOrders = status?.lastResult?.orders
  const lastInsights = status?.lastResult?.insights
  const lastTime = status?.lastResult?.finishedAt
    ? new Date(status.lastResult.finishedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-md flex items-center justify-between gap-md flex-wrap">
      <div className="flex items-center gap-sm">
        <div className="w-2 h-2 rounded-full bg-on-tertiary-container" style={{ boxShadow: '0 0 6px #4ade80' }} />
        <div>
          <p className="text-label-md text-primary">Auto-sync</p>
          <p className="text-label-sm text-on-surface-variant">
            {lastTime ? `Lần cuối: ${lastTime}` : 'Chưa sync'}
            {lastOrders && !lastOrders.error ? ` · Orders: ${lastOrders.synced ?? 0}` : ''}
            {lastInsights && !lastInsights.error ? ` · Insights: ${lastInsights.synced ?? 0} ngày` : ''}
          </p>
        </div>
      </div>
      <button
        onClick={onSync}
        disabled={syncing}
        className="bg-surface-container text-secondary hover:bg-surface-container-high rounded-lg px-md py-xs text-label-sm font-semibold flex items-center gap-xs disabled:opacity-50"
      >
        <span className={`material-symbols-outlined text-[14px] ${syncing ? 'animate-spin' : ''}`}>sync</span>
        {syncing ? 'Đang sync...' : 'Sync ngay'}
      </button>
    </div>
  )
}
```

- [ ] **Bước 4: Chèn `ProfitChart` và `AutoSyncStatusBar` vào render trong `ProjectDashboard`**

Trong phần `{analytics ? (` của `ProjectDashboard`, thêm `ProfitChart` section TRƯỚC section "Actual Cashflow" hiện có:

Tìm đoạn:
```typescript
            ) : analytics ? (
              <div className="space-y-xl">
                <section>
                  <div className="flex items-center gap-sm mb-lg">
                    <span className="material-symbols-outlined text-secondary">account_balance_wallet</span>
                    <h3 className="text-headline-sm text-primary">Actual Cashflow</h3>
```

Thêm section mới VÀO NGAY sau `<div className="space-y-xl">`:

```typescript
                {selectedProject && (
                  <ProfitChart
                    projectId={selectedProject}
                    period={chartPeriod}
                    onPeriodChange={setChartPeriod}
                  />
                )}
```

Và thêm `AutoSyncStatusBar` ở cuối `<div className="space-y-xl">` (trước `</div>` đóng cuối cùng của space-y-xl):

```typescript
                <AutoSyncStatusBar status={syncStatus} syncing={syncing} onSync={handleManualSync} />
```

- [ ] **Bước 5: Mở http://localhost:3002/projects và kiểm tra**

- Profit Chart section xuất hiện ở đầu trang
- Period selector hoạt động (Hôm nay / Tuần / Tháng)
- Chart hiển thị bars tím (orders) và đường xanh (profit)
- Summary cards hiển thị đúng
- Auto-sync status bar ở dưới
- Nút "Sync ngay" trigger sync và cập nhật status

- [ ] **Bước 6: Commit**

```bash
git add src/app/projects/page.tsx
git commit -m "feat: add ProfitChart + auto-sync status bar to Projects page"
```

---

## Task 8: Overview API — Period Metrics + Chart Data

**Files:**
- Modify: `src/app/api/overview/route.ts`

- [ ] **Bước 1: Thay thế `src/app/api/overview/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { computeOrderProfitFromDb } from '@/lib/order-profit'

function getPeriodRange(period: string) {
  const now = new Date()
  const todayStr = now.toISOString().split('T')[0]

  if (period === 'today') {
    return { from: new Date(`${todayStr}T00:00:00.000Z`), to: new Date(`${todayStr}T23:59:59.999Z`), label: 'Hôm nay' }
  }
  if (period === 'this-week') {
    const dow = now.getUTCDay()
    const monday = new Date(now)
    monday.setUTCDate(now.getUTCDate() - ((dow + 6) % 7))
    const mondayStr = monday.toISOString().split('T')[0]
    return { from: new Date(`${mondayStr}T00:00:00.000Z`), to: new Date(`${todayStr}T23:59:59.999Z`), label: 'Tuần này' }
  }
  if (period === 'this-month') {
    const monthStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    return { from: new Date(`${monthStr}-01T00:00:00.000Z`), to: new Date(`${todayStr}T23:59:59.999Z`), label: 'Tháng này' }
  }
  return null // all-time
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const period = searchParams.get('period') ?? 'all'
    const periodRange = getPeriodRange(period)

    const paidMetaStatuses = ['PAID', 'SETTLED', 'COMPLETED']

    const [payouts, metaBillings, projects, staff] = await Promise.all([
      prisma.payout.findMany({ where: { status: 'paid' } }),
      prisma.metaBilling.findMany({ where: { status: { in: paidMetaStatuses } } }),
      prisma.project.findMany({
        include: { assignments: { include: { staff: true } } },
        orderBy: { startDate: 'desc' },
      }),
      prisma.staff.findMany(),
    ])

    const totalRevenue = payouts.reduce((s, p) => s + p.amount, 0)
    const payoutCount = payouts.length
    const recentPayouts = await prisma.payout.findMany({
      where: { status: 'paid' }, orderBy: { date: 'desc' }, take: 5,
    })

    const totalSpend = metaBillings.reduce((s, b) => s + b.amount, 0)
    const billingCount = metaBillings.length
    const recentBillings = await prisma.metaBilling.findMany({
      where: { status: { in: paidMetaStatuses } }, orderBy: { billingDate: 'desc' }, take: 5,
    })

    const projectList = projects.map(p => ({
      id: p.id,
      name: p.name,
      startDate: p.startDate,
      staffCount: p.assignments.length,
      monthlyCost: p.assignments.reduce((s, a) => s + (a.staff?.monthlyCost ?? 0), 0),
    }))

    // Period metrics
    let periodMetrics = null
    if (periodRange) {
      const [periodOrders, periodAdSpends] = await Promise.all([
        prisma.order.findMany({
          where: { placedAt: { gte: periodRange.from, lte: periodRange.to } },
          include: {
            lines: {
              select: { qty: true, resolvedBaseCost: true, resolvedShipFirst: true, resolvedShipAdditional: true, resolvedImportTax: true },
            },
          },
        }),
        prisma.dailyAdSpend.findMany({
          where: {
            date: {
              gte: periodRange.from.toISOString().split('T')[0],
              lte: periodRange.to.toISOString().split('T')[0],
            },
          },
        }),
      ])

      let totalOrderProfit = 0
      let mappedOrders = 0
      let totalOrderRevenue = 0

      for (const order of periodOrders) {
        const profit = computeOrderProfitFromDb(order.expectedPayout, order.lines)
        if (profit !== null) {
          totalOrderProfit += profit
          mappedOrders++
          totalOrderRevenue += order.grossAmount
        }
      }

      const adSpend = periodAdSpends.reduce((s, d) => s + d.spend, 0)
      const roas = adSpend > 0 ? totalOrderRevenue / adSpend : 0
      const avgMargin = totalOrderRevenue > 0 ? (totalOrderProfit / totalOrderRevenue) * 100 : 0
      const aov = mappedOrders > 0 ? totalOrderRevenue / mappedOrders : 0

      const unfulfilledOrders = await prisma.order.count({
        where: {
          placedAt: { gte: periodRange.from, lte: periodRange.to },
          fulfillmentStatus: { in: ['unfulfilled', null] },
        },
      })

      periodMetrics = {
        period,
        label: periodRange.label,
        from: periodRange.from.toISOString().split('T')[0],
        to: periodRange.to.toISOString().split('T')[0],
        orders: periodOrders.length,
        revenue: Math.round(totalOrderRevenue * 100) / 100,
        adSpend: Math.round(adSpend * 100) / 100,
        orderProfit: Math.round(totalOrderProfit * 100) / 100,
        netProfit: Math.round((totalOrderProfit - adSpend) * 100) / 100,
        roas: Math.round(roas * 100) / 100,
        avgMargin: Math.round(avgMargin * 100) / 100,
        avgOrderValue: Math.round(aov * 100) / 100,
        unfulfilledOrders,
      }
    }

    // Chart data: last 30 days revenue + ad spend grouped by day
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const [chartOrders, chartSpends] = await Promise.all([
      prisma.order.findMany({
        where: { placedAt: { gte: thirtyDaysAgo } },
        select: { placedAt: true, grossAmount: true },
      }),
      prisma.dailyAdSpend.findMany({
        where: { date: { gte: thirtyDaysAgo.toISOString().split('T')[0] } },
      }),
    ])

    const revenueByDate: Record<string, number> = {}
    for (const o of chartOrders) {
      const d = o.placedAt.toISOString().split('T')[0]
      revenueByDate[d] = (revenueByDate[d] ?? 0) + o.grossAmount
    }
    const spendByDate: Record<string, number> = {}
    for (const s of chartSpends) {
      spendByDate[s.date] = (spendByDate[s.date] ?? 0) + s.spend
    }

    const chartData: Array<{ date: string; revenue: number; adSpend: number }> = []
    const cursor = new Date(thirtyDaysAgo)
    const today = new Date()
    while (cursor <= today) {
      const d = cursor.toISOString().split('T')[0]
      chartData.push({
        date: d,
        revenue: Math.round((revenueByDate[d] ?? 0) * 100) / 100,
        adSpend: Math.round((spendByDate[d] ?? 0) * 100) / 100,
      })
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }

    return NextResponse.json({
      shopify: { totalRevenue, payoutCount, recentPayouts },
      meta: { totalSpend, billingCount, recentBillings },
      projects: { count: projects.length, list: projectList },
      staff: { count: staff.length, totalMonthlyCost: staff.reduce((s, st) => s + st.monthlyCost, 0) },
      netCashflow: totalRevenue - totalSpend,
      periodMetrics,
      chartData,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Unknown error' }, { status: 500 })
  }
}
```

- [ ] **Bước 2: Test endpoint**

```bash
curl "http://localhost:3002/api/overview?period=today"
```

Expected response có thêm `periodMetrics` và `chartData` arrays.

```bash
curl "http://localhost:3002/api/overview?period=this-month"
```

Expected: `periodMetrics.label === "Tháng này"`, `chartData` có 30 entries.

- [ ] **Bước 3: Commit**

```bash
git add src/app/api/overview/route.ts
git commit -m "feat: overview API period filtering + periodMetrics + chartData"
```

---

## Task 9: Overview Page Redesign

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Bước 1: Thay thế toàn bộ `src/app/page.tsx`**

```typescript
'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'

type PeriodMetrics = {
  period: string
  label: string
  from: string
  to: string
  orders: number
  revenue: number
  adSpend: number
  orderProfit: number
  netProfit: number
  roas: number
  avgMargin: number
  avgOrderValue: number
  unfulfilledOrders: number
}

type ChartPoint = { date: string; revenue: number; adSpend: number }

type RecentPayout = { id: number; date: string; amount: number; currency: string; status: string }
type RecentBilling = { id: string; billingDate: string; amount: number; currency: string; chargeType: string | null }
type ProjectSummary = { id: string; name: string; startDate: string; staffCount: number; monthlyCost: number }

type OverviewData = {
  shopify: { totalRevenue: number; payoutCount: number; recentPayouts: RecentPayout[] }
  meta: { totalSpend: number; billingCount: number; recentBillings: RecentBilling[] }
  projects: { count: number; list: ProjectSummary[] }
  staff: { count: number; totalMonthlyCost: number }
  netCashflow: number
  periodMetrics: PeriodMetrics | null
  chartData: ChartPoint[]
  error?: string
}

const PERIODS = [
  { key: 'today', label: 'Hôm nay' },
  { key: 'this-week', label: 'Tuần này' },
  { key: 'this-month', label: 'Tháng này' },
  { key: 'all', label: 'All time' },
]

function fmtUSD(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n || 0)
}

function fmtNum(n: number) {
  return new Intl.NumberFormat('en-US').format(n || 0)
}

export default function OverviewPage() {
  const [period, setPeriod] = useState<string>('today')
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/overview?period=${period}`)
      .then(r => r.json())
      .then((d: OverviewData) => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [period])

  const pm = data?.periodMetrics
  const isAllTime = period === 'all'

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <div className="flex items-center justify-between mb-lg flex-wrap gap-sm">
          <div>
            <h2 className="text-display-md font-bold text-primary">Tổng quan</h2>
            <p className="text-on-surface-variant text-body-md mt-xs">Lợi nhuận & Hiệu quả kinh doanh</p>
          </div>
        </div>

        {/* Period tabs */}
        <div className="flex gap-xs mb-xl flex-wrap">
          {PERIODS.map(p => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`px-lg py-sm rounded-lg text-label-md font-semibold transition-all ${
                period === p.key
                  ? 'bg-secondary text-on-secondary shadow-sm'
                  : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high border border-outline-variant/20'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {loading && (
          <div className="flex items-center justify-center py-3xl text-on-surface-variant gap-sm">
            <span className="material-symbols-outlined animate-spin text-[24px]">sync</span>
            <span className="text-body-md">Đang tải...</span>
          </div>
        )}

        {data && !data.error && !loading && (
          <>
            {/* Row 1: Hero + 3 stat cards */}
            {!isAllTime && pm ? (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-lg mb-lg">
                <HeroCard
                  label={`Lợi nhuận ròng · ${pm.label}`}
                  value={fmtUSD(pm.netProfit)}
                  negative={pm.netProfit < 0}
                />
                <StatCard label="Đơn hàng" value={fmtNum(pm.orders)} sub={`AOV: ${fmtUSD(pm.avgOrderValue)}`} icon="shopping_bag" />
                <StatCard label="Doanh thu" value={fmtUSD(pm.revenue)} sub={`Margin ${pm.avgMargin.toFixed(1)}%`} icon="storefront" positive />
                <StatCard label="Ad Spend" value={fmtUSD(pm.adSpend)} sub={`ROAS ${pm.roas.toFixed(2)}x`} icon="campaign" negative />
              </div>
            ) : (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-lg mb-lg">
                <StatCard label="Total Revenue" value={fmtUSD(data.shopify.totalRevenue)} icon="account_balance_wallet" positive />
                <StatCard label="Total Ad Spend" value={fmtUSD(data.meta.totalSpend)} icon="campaign" negative />
                <HeroCard label="Net Cashflow" value={fmtUSD(data.netCashflow)} negative={data.netCashflow < 0} />
                <StatCard label="Active Projects" value={fmtNum(data.projects.count)} icon="folder_open" />
              </div>
            )}

            {/* Row 2: Secondary metrics */}
            {!isAllTime && pm ? (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-lg mb-xl">
                <MiniCard label="Order Profit" value={fmtUSD(pm.orderProfit)} color="positive" />
                <MiniCard label="ROAS" value={`${pm.roas.toFixed(2)}x`} color={pm.roas >= 3 ? 'positive' : 'warn'} />
                <MiniCard label="Avg Margin" value={`${pm.avgMargin.toFixed(1)}%`} color={pm.avgMargin >= 25 ? 'positive' : 'warn'} />
                <MiniCard label="Unfulfilled" value={fmtNum(pm.unfulfilledOrders)} color={pm.unfulfilledOrders > 0 ? 'warn' : 'neutral'} />
              </div>
            ) : (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-lg mb-xl">
                <StatCard label="Total Payouts" value={fmtNum(data.shopify.payoutCount)} icon="receipt_long" />
                <StatCard label="Meta Billings" value={fmtNum(data.meta.billingCount)} icon="receipt" />
                <StatCard label="Staff Count" value={fmtNum(data.staff.count)} icon="group" />
                <StatCard label="Monthly Staff Cost" value={fmtUSD(data.staff.totalMonthlyCost)} icon="payments" />
              </div>
            )}

            {/* Revenue + Ad Spend Chart */}
            {data.chartData.length > 0 && (
              <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden mb-xl">
                <div className="flex items-center justify-between px-lg py-md border-b border-outline-variant/20">
                  <div className="flex items-center gap-sm">
                    <span className="material-symbols-outlined text-secondary">bar_chart</span>
                    <h3 className="text-headline-sm text-primary">Revenue vs Ad Spend (30 ngày)</h3>
                  </div>
                </div>
                <div className="p-lg">
                  <OverviewChart data={data.chartData} />
                </div>
              </div>
            )}

            {/* Recent Payouts + Billings */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-xl mb-xl">
              <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
                <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                  <span className="material-symbols-outlined text-secondary">payments</span>
                  <h3 className="text-headline-sm text-primary">Recent Payouts</h3>
                  <a href="/shopify" className="ml-auto text-secondary text-label-sm hover:underline flex items-center gap-xs">
                    Xem tất cả <span className="material-symbols-outlined text-[14px]">chevron_right</span>
                  </a>
                </div>
                {data.shopify.recentPayouts.length === 0 ? (
                  <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">Chưa có dữ liệu</div>
                ) : (
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-outline-variant/10 bg-surface-container-low">
                        <th className="text-left px-lg py-sm text-label-sm text-on-surface-variant">Date</th>
                        <th className="text-left px-lg py-sm text-label-sm text-on-surface-variant">Amount</th>
                        <th className="text-left px-lg py-sm text-label-sm text-on-surface-variant">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.shopify.recentPayouts.map(p => (
                        <tr key={p.id} className="border-b border-outline-variant/10 hover:bg-surface-container-low/50">
                          <td className="px-lg py-sm text-body-sm text-on-surface-variant">{p.date}</td>
                          <td className="px-lg py-sm text-label-md font-bold text-on-tertiary-container">{fmtUSD(p.amount)}</td>
                          <td className="px-lg py-sm">
                            <span className="bg-on-tertiary-container/15 text-on-tertiary-container px-sm py-xs rounded-full text-label-sm">{p.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
                <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                  <span className="material-symbols-outlined text-secondary">campaign</span>
                  <h3 className="text-headline-sm text-primary">Recent Meta Billings</h3>
                  <a href="/finance/meta" className="ml-auto text-secondary text-label-sm hover:underline flex items-center gap-xs">
                    Xem tất cả <span className="material-symbols-outlined text-[14px]">chevron_right</span>
                  </a>
                </div>
                {data.meta.recentBillings.length === 0 ? (
                  <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">Chưa có dữ liệu</div>
                ) : (
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-outline-variant/10 bg-surface-container-low">
                        <th className="text-left px-lg py-sm text-label-sm text-on-surface-variant">Date</th>
                        <th className="text-left px-lg py-sm text-label-sm text-on-surface-variant">Amount</th>
                        <th className="text-left px-lg py-sm text-label-sm text-on-surface-variant">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.meta.recentBillings.map(b => (
                        <tr key={b.id} className="border-b border-outline-variant/10 hover:bg-surface-container-low/50">
                          <td className="px-lg py-sm text-body-sm text-on-surface-variant">{b.billingDate}</td>
                          <td className="px-lg py-sm text-label-md font-bold text-error">-{fmtUSD(b.amount)}</td>
                          <td className="px-lg py-sm text-body-sm text-on-surface-variant">{b.chargeType ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Projects */}
            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
              <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                <span className="material-symbols-outlined text-secondary">folder_open</span>
                <h3 className="text-headline-sm text-primary">Projects</h3>
                <a href="/projects" className="ml-auto text-secondary text-label-sm hover:underline flex items-center gap-xs">
                  Dashboard <span className="material-symbols-outlined text-[14px]">chevron_right</span>
                </a>
              </div>
              {data.projects.list.length === 0 ? (
                <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">
                  Chưa có project. <a href="/setup/projects" className="text-secondary hover:underline">Tạo project</a>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-lg p-lg">
                  {data.projects.list.map(p => (
                    <a key={p.id} href="/projects"
                      className="block bg-surface-container rounded-xl p-lg border border-outline-variant/20 hover:border-secondary/40 hover:shadow-card transition-all">
                      <div className="flex items-start justify-between mb-sm">
                        <h4 className="text-headline-sm text-primary">{p.name}</h4>
                        <span className="material-symbols-outlined text-[18px] text-secondary">analytics</span>
                      </div>
                      <p className="text-label-sm text-on-surface-variant mb-md">
                        Start: {new Date(p.startDate).toLocaleDateString('vi-VN')}
                      </p>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-xs text-body-sm text-on-surface-variant">
                          <span className="material-symbols-outlined text-[14px]">group</span>
                          {p.staffCount} staff
                        </span>
                        <span className="text-label-md font-bold text-primary">
                          {fmtUSD(p.monthlyCost)}<span className="text-label-sm font-normal text-on-surface-variant">/mo</span>
                        </span>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {!loading && !data && (
          <div className="flex flex-col items-center justify-center py-3xl text-center">
            <span className="material-symbols-outlined text-[48px] text-on-surface-variant/30">dashboard</span>
            <h3 className="text-headline-sm text-primary mb-sm mt-lg">Không tải được dữ liệu</h3>
            <p className="text-body-md text-on-surface-variant">Kiểm tra server và thử lại.</p>
          </div>
        )}
      </main>
    </div>
  )
}

function HeroCard({ label, value, negative }: { label: string; value: string; negative?: boolean }) {
  return (
    <div className="col-span-1 bg-primary rounded-xl p-lg shadow-card border border-outline-variant/20">
      <div className="flex items-center justify-between mb-sm">
        <span className="text-label-sm uppercase tracking-wider text-on-primary/60">{label}</span>
        <span className="material-symbols-outlined text-[18px] text-on-primary/40">trending_up</span>
      </div>
      <div className={`text-stats-lg font-bold ${negative ? 'text-error' : 'text-on-primary'}`}>{value}</div>
    </div>
  )
}

function StatCard({ label, value, icon, positive, negative, sub }: { label: string; value: string; icon: string; positive?: boolean; negative?: boolean; sub?: string }) {
  const valueColor = positive ? 'text-on-tertiary-container' : negative ? 'text-error' : 'text-primary'
  return (
    <div className="rounded-xl p-lg shadow-card border border-outline-variant/20 bg-surface-container-lowest">
      <div className="flex items-center justify-between mb-sm">
        <span className="text-label-sm uppercase tracking-wider text-on-surface-variant">{label}</span>
        <span className={`material-symbols-outlined text-[18px] text-secondary`}>{icon}</span>
      </div>
      <div className={`text-stats-lg font-bold ${valueColor}`}>{value}</div>
      {sub && <p className="text-label-sm text-on-surface-variant mt-xs">{sub}</p>}
    </div>
  )
}

function MiniCard({ label, value, color }: { label: string; value: string; color: 'positive' | 'negative' | 'warn' | 'neutral' }) {
  const colorMap = { positive: 'text-on-tertiary-container', negative: 'text-error', warn: 'text-amber-500', neutral: 'text-primary' }
  return (
    <div className="bg-surface-container-lowest rounded-xl p-md border border-outline-variant/20">
      <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">{label}</p>
      <p className={`text-headline-sm font-bold ${colorMap[color]}`}>{value}</p>
    </div>
  )
}

function OverviewChart({ data }: { data: ChartPoint[] }) {
  if (data.length === 0) return null

  const W = 600
  const H = 130
  const PAD = { top: 8, right: 8, bottom: 24, left: 8 }
  const chartW = W - PAD.left - PAD.right
  const chartH = H - PAD.top - PAD.bottom

  const maxRevenue = Math.max(...data.map(d => d.revenue), 1)
  const maxSpend = Math.max(...data.map(d => d.adSpend), 1)
  const maxVal = Math.max(maxRevenue, maxSpend, 1)

  const barW = Math.max(2, (chartW / data.length) * 0.45)
  const step = chartW / Math.max(data.length - 1, 1)
  const toX = (i: number) => PAD.left + i * (chartW / data.length) + (chartW / data.length) / 2
  const toH = (v: number) => (v / maxVal) * chartH

  const profitPoints = data
    .map((d, i) => `${toX(i)},${PAD.top + chartH - ((d.revenue - d.adSpend) / maxVal) * chartH}`)
    .join(' ')

  const labelEvery = Math.ceil(data.length / 6)
  const fmtDate = (s: string) => {
    const d = new Date(s + 'T00:00:00Z')
    return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`
  }

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <defs>
          <linearGradient id="overviewGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
          </linearGradient>
        </defs>

        {data.map((d, i) => {
          const x = toX(i)
          const rH = toH(d.revenue)
          const sH = toH(d.adSpend)
          return (
            <g key={d.date}>
              <rect x={x - barW} y={PAD.top + chartH - rH} width={barW} height={rH} fill="#3b82f6" fillOpacity="0.35" rx="1" />
              <rect x={x} y={PAD.top + chartH - sH} width={barW} height={sH} fill="#ef4444" fillOpacity="0.5" rx="1" />
            </g>
          )
        })}

        <path
          d={`M${profitPoints.replace(/,/g, ' L').replace(/ L/g, ',')} L${toX(data.length - 1)},${PAD.top + chartH} L${toX(0)},${PAD.top + chartH} Z`}
          fill="url(#overviewGrad)"
        />
        <polyline points={profitPoints} fill="none" stroke="#22c55e" strokeWidth="2" strokeLinejoin="round" />

        {data.map((d, i) => {
          if (i % labelEvery !== 0 && i !== data.length - 1) return null
          return (
            <text key={d.date} x={toX(i)} y={H - 4} textAnchor="middle" fontSize="8" fill="currentColor" fillOpacity="0.4" className="text-on-surface-variant">
              {fmtDate(d.date)}
            </text>
          )
        })}
      </svg>

      <div className="flex gap-lg mt-xs">
        <div className="flex items-center gap-xs">
          <div className="w-3 h-2 rounded-sm bg-blue-500" style={{ opacity: 0.5 }} />
          <span className="text-label-sm text-on-surface-variant">Revenue</span>
        </div>
        <div className="flex items-center gap-xs">
          <div className="w-3 h-2 rounded-sm bg-red-500" style={{ opacity: 0.6 }} />
          <span className="text-label-sm text-on-surface-variant">Ad Spend</span>
        </div>
        <div className="flex items-center gap-xs">
          <div className="w-4 h-0.5 bg-green-500" />
          <span className="text-label-sm text-on-surface-variant">Profit</span>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Bước 2: Mở http://localhost:3002 và kiểm tra**

Checklist visual:
- [ ] Period tabs (Hôm nay / Tuần này / Tháng này / All time) hiển thị ở đầu trang
- [ ] Khi chọn "Hôm nay": Row 1 có Hero profit + Orders + Revenue + Ad Spend; Row 2 có Order Profit / ROAS / Avg Margin / Unfulfilled
- [ ] Khi chọn "All time": hiện về layout cũ (Revenue / Ad Spend / Net Cashflow / Active Projects)
- [ ] Chart "Revenue vs Ad Spend" hiển thị với 3 series (bars xanh dương / đỏ + đường xanh lá)
- [ ] Các section bên dưới (Recent Payouts, Recent Billings, Projects) vẫn hiển thị bình thường

- [ ] **Bước 3: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: overview page redesign with period tabs, hero metrics, and chart"
```

---

## Self-Review Checklist

### Spec coverage

| Spec requirement | Task |
|-----------------|------|
| Auto-sync mỗi 1 tiếng | Task 5 (`auto-sync.ts` + `instrumentation.ts`) |
| Sync Shopify orders | Task 3 |
| Sync Meta Insights (ad spend theo ngày) | Task 4 |
| KHÔNG sync Shopify payout | Task 3 (không import `fetchAllPayouts`) |
| Model `DailyAdSpend` mới | Task 1 |
| Schema v16 → v17 | Task 1 |
| `node-cron` package | Task 1 |
| `instrumentation.ts` hook | Task 5 |
| Manual trigger `/api/auto-sync POST` | Task 5 |
| Profit Chart trong Projects page | Task 7 |
| Chart kiểu D (profit line + order bars) | Task 7 (`ProfitChartSVG`) |
| Period selector (Hôm nay / Tuần / Tháng) | Task 7 |
| Summary cards: Total Profit, Orders, Margin, Ad Spend | Task 7 |
| Công thức profit = expectedPayout − costs từ lines | Task 2 (`computeOrderProfitFromDb`) |
| Overview period tabs | Task 9 |
| Hero card Net Profit | Task 9 |
| Orders count + AOV | Task 9 |
| ROAS, Avg Margin, Unfulfilled | Task 9 |
| Chart Revenue + Ad Spend + Profit | Task 9 (`OverviewChart`) |
| Auto-sync status bar trong Projects | Task 7 (`AutoSyncStatusBar`) |

Tất cả requirements được cover. ✓

### Type consistency

- `computeOrderProfitFromDb(expectedPayout, lines: OrderLineForProfit[])` — dùng nhất quán ở Task 6 (profit-chart API) và Task 8 (overview API)
- `DailyAdSpend` compound unique `adAccountId_date` — nhất quán ở Task 4 (upsert) và Task 6/8 (query)
- `runAutoSync()` export — dùng ở Task 5 route và Task 5 cron
- `ProfitChartData` type — dùng ở Task 7 state

### Potential issues

1. **`instrumentation.ts` location**: phải ở root project (cùng cấp với `package.json`), không phải trong `src/`. Đã ghi rõ trong Task 5.
2. **Prisma compound unique accessor**: `adAccountId_date` — tên tự động từ Prisma, cần verify sau migration.
3. **Orders upsert không update lines**: Task 3 upsert chỉ update header fields, không xóa/thêm lại lines (tránh mất mapping data đã có). Đây là behavior đúng.
