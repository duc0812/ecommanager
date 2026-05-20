# Order Custom Classification & Trello Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phân loại orders thành Custom/Non-Custom, tự động tạo Trello card cho Design team, và sync ngược trạng thái "Đã có design" khi card DONE + có Drive link.

**Architecture:** Custom được detect từ Shopify line item `customAttributes` (`_print_files` key) hoặc product tag "Custom Name". Trello card được tạo inline trong sync flow, gated by `syncFromOrderName`. Non-Custom design tracking qua bảng `SkuDesign` per-SKU. Polling DONE list qua nút "Sync Trello".

**Tech Stack:** Next.js App Router, Prisma + SQLite (libsql), Trello REST API v1, TypeScript strict-off (any allowed).

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | Modify | Add `orderType`, `trelloCardId`, `trelloCardUrl` to `Order`; add `SkuDesign` model |
| `src/lib/db.ts` | Modify | Bump `SCHEMA_VERSION` v11 → v12 |
| `src/lib/order-classify.ts` | **Create** | Pure function: classify order lines → CUSTOM / NON_CUSTOM |
| `src/lib/trello.ts` | **Create** | Trello REST API client: createCard, getCardsByList |
| `src/lib/shopify-orders.ts` | Modify | Add `customAttributes { key value }` to GraphQL query + type |
| `src/lib/repos/orders.ts` | Modify | Add `orderType`, `trelloCardId`, `trelloCardUrl` to `UpsertOrderInput` + upsert |
| `src/lib/repos/reports.ts` | Modify | Join `SkuDesign` per-SKU in `ordersWithComputedPL`; expose `designReady` |
| `src/app/api/trello/config/route.ts` | **Create** | GET/POST Trello config từ/vào `AppSetting` |
| `src/app/api/trello/sync/route.ts` | **Create** | POST: poll Trello DONE list → update `SkuDesign.designReady` |
| `src/app/api/shopify/orders/sync/route.ts` | Modify | Sau upsert: classify → store `orderType` → create Trello card nếu cần |
| `src/app/setup/page.tsx` | Modify | Thêm section Trello config (6 fields) |
| `src/app/orders/page.tsx` | Modify | Thêm columns Type/Design/Trello, buttons Sync Trello, filters |
| `tests/order-classify.test.ts` | **Create** | Unit tests cho classify function |

---

## Task 1: Schema Migration

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/lib/db.ts`

- [ ] **Step 1: Thêm fields vào `Order` model và `SkuDesign` model mới**

Mở `prisma/schema.prisma`. Trong `model Order { ... }`, thêm 3 dòng sau `shippingZone String?`:

```prisma
  orderType       String   @default("UNKNOWN")   // "CUSTOM" | "NON_CUSTOM" | "UNKNOWN"
  trelloCardId    String?
  trelloCardUrl   String?
```

Thêm model mới ở cuối file (sau `SupplierZoneOverride`):

```prisma
model SkuDesign {
  id           String   @id @default(cuid())
  sku          String   @unique
  designReady  Boolean  @default(false)
  driveLink    String?
  trelloCardId String?
  updatedAt    DateTime @updatedAt
  createdAt    DateTime @default(now())
}
```

- [ ] **Step 2: Chạy migration**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx prisma migrate dev --name add_order_type_trello_skudesign
```

Expected output: `Your database is now in sync with your schema.`

- [ ] **Step 3: Generate Prisma client**

```bash
npx prisma generate
```

- [ ] **Step 4: Bump SCHEMA_VERSION trong `src/lib/db.ts`**

Tìm dòng:
```typescript
const SCHEMA_VERSION = 'v11'
```
Đổi thành:
```typescript
const SCHEMA_VERSION = 'v12'
```

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma src/lib/db.ts
git commit -m "feat: add orderType/trelloCardId to Order and SkuDesign model"
```

---

## Task 2: order-classify.ts (TDD)

**Files:**
- Create: `src/lib/order-classify.ts`
- Create: `tests/order-classify.test.ts`

- [ ] **Step 1: Tạo file test trước (TDD)**

Tạo `tests/order-classify.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { classifyOrderLines } from '@/lib/order-classify'

type Line = Parameters<typeof classifyOrderLines>[0][number]

const makeLine = (overrides: Partial<Line> = {}): Line => ({
  sku: 'SKU-001',
  productTitle: 'Test Product',
  customAttributes: [],
  productTags: [],
  ...overrides,
})

describe('classifyOrderLines', () => {
  it('returns CUSTOM when any line has _print_files customAttribute', () => {
    const lines = [
      makeLine({
        customAttributes: [
          { key: '_print_files', value: '[{"print_area":"Front","url":"https://cdn.example.com/file.png"}]' },
        ],
      }),
    ]
    expect(classifyOrderLines(lines)).toBe('CUSTOM')
  })

  it('returns CUSTOM when any line product tag includes "Custom Name"', () => {
    const lines = [makeLine({ productTags: ['apparel', 'Custom Name', 'summer'] })]
    expect(classifyOrderLines(lines)).toBe('CUSTOM')
  })

  it('returns NON_CUSTOM when no line has _print_files or Custom Name tag', () => {
    const lines = [
      makeLine({ productTags: ['ceramic', 'handmade'] }),
      makeLine({ sku: 'SKU-002', productTags: ['mug'] }),
    ]
    expect(classifyOrderLines(lines)).toBe('NON_CUSTOM')
  })

  it('returns CUSTOM if at least one line is custom even if others are not', () => {
    const lines = [
      makeLine({ productTags: ['ceramic'] }),
      makeLine({ customAttributes: [{ key: '_print_files', value: '[]' }] }),
    ]
    expect(classifyOrderLines(lines)).toBe('CUSTOM')
  })

  it('returns NON_CUSTOM for empty lines array', () => {
    expect(classifyOrderLines([])).toBe('NON_CUSTOM')
  })

  it('ignores other customAttribute keys that are not _print_files', () => {
    const lines = [
      makeLine({ customAttributes: [{ key: '_kaching_cart', value: '{}' }] }),
    ]
    expect(classifyOrderLines(lines)).toBe('NON_CUSTOM')
  })
})
```

- [ ] **Step 2: Chạy test để confirm fail**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx vitest run tests/order-classify.test.ts
```

Expected: FAIL — `classifyOrderLines` not found

- [ ] **Step 3: Tạo `src/lib/order-classify.ts`**

```typescript
export type ClassifyLine = {
  sku: string | null
  productTitle: string
  customAttributes: Array<{ key: string; value: string }>
  productTags: string[]
}

export type OrderType = 'CUSTOM' | 'NON_CUSTOM'

export function classifyOrderLines(lines: ClassifyLine[]): OrderType {
  for (const line of lines) {
    if (line.customAttributes.some(a => a.key === '_print_files')) return 'CUSTOM'
    if (line.productTags.includes('Custom Name')) return 'CUSTOM'
  }
  return 'NON_CUSTOM'
}

export function buildTrelloCardContent(
  orderName: string,
  lines: Array<ClassifyLine & { variantTitle: string | null; qty: number }>,
  orderType: OrderType,
): { name: string; desc: string } {
  const skuParts = lines
    .filter(l => l.sku)
    .map(l => `${l.sku}${l.variantTitle ? ` [${l.variantTitle}]` : ''}`)
    .join(' / ')
  const name = `${orderName} - ${skuParts || 'N/A'}`

  if (orderType === 'CUSTOM') {
    const sections: string[] = []
    for (const line of lines) {
      if (!line.sku) continue
      const preview = line.customAttributes.find(a => a.key === '_customall_preview')?.value ?? ''
      const printFile = line.customAttributes.find(a => a.key === '_customall_print_file')?.value ?? ''
      const customUrl = line.customAttributes.find(a => a.key === '_customized_url')?.value ?? ''
      let printAreas = ''
      try {
        const pf = line.customAttributes.find(a => a.key === '_print_files')?.value
        if (pf) {
          const parsed = JSON.parse(pf) as Array<{ print_area: string; url: string }>
          printAreas = parsed.map(p => `  - ${p.print_area}: ${p.url}`).join('\n')
        }
      } catch {}
      sections.push(
        `**${line.productTitle}** (${line.sku}${line.variantTitle ? ` / ${line.variantTitle}` : ''}, qty: ${line.qty})` +
        (preview ? `\n🖼 Preview: ${preview}` : '') +
        (printFile ? `\n🖨 Print file: ${printFile}` : '') +
        (printAreas ? `\n🎨 Print areas:\n${printAreas}` : '') +
        (customUrl ? `\n🔗 Customized URL: ${customUrl}` : ''),
      )
    }
    return { name, desc: sections.join('\n\n---\n\n') }
  }

  // NON_CUSTOM
  const skuList = lines.filter(l => l.sku).map(l => l.sku).join(', ')
  return {
    name,
    desc: `⚠️ Design chưa có — cần tạo design cho SKU: ${skuList}\n\nSản phẩm: ${lines.map(l => l.productTitle).join(', ')}`,
  }
}
```

- [ ] **Step 4: Chạy test để confirm pass**

```bash
npx vitest run tests/order-classify.test.ts
```

Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/order-classify.ts tests/order-classify.test.ts
git commit -m "feat: add order-classify pure function with tests"
```

---

## Task 3: Cập nhật shopify-orders.ts

**Files:**
- Modify: `src/lib/shopify-orders.ts`

- [ ] **Step 1: Thêm `customAttributes` vào type `ShopifyOrderLine`**

Trong `src/lib/shopify-orders.ts`, tìm:
```typescript
export type ShopifyOrderLine = {
  id: string
  sku: string | null
  title: string
  variantTitle: string | null
  quantity: number
  unitPrice: number
  productTags: string[]
  productType: string | null
}
```

Thêm field `customAttributes`:
```typescript
export type ShopifyOrderLine = {
  id: string
  sku: string | null
  title: string
  variantTitle: string | null
  quantity: number
  unitPrice: number
  productTags: string[]
  productType: string | null
  customAttributes: Array<{ key: string; value: string }>
}
```

- [ ] **Step 2: Thêm `customAttributes { key value }` vào GraphQL query**

Trong cùng file, tìm block `lineItems(first: 50)` trong `const QUERY`:
```graphql
      lineItems(first: 50) {
        nodes {
          id sku title variantTitle quantity
          originalUnitPriceSet { shopMoney { amount } }
          product { tags productType }
        }
      }
```

Thêm `customAttributes { key value }`:
```graphql
      lineItems(first: 50) {
        nodes {
          id sku title variantTitle quantity
          originalUnitPriceSet { shopMoney { amount } }
          customAttributes { key value }
          product { tags productType }
        }
      }
```

- [ ] **Step 3: Map `customAttributes` trong parser**

Tìm block `.map((l: any) => ({` cho lines:
```typescript
      lines: (n.lineItems?.nodes || []).map((l: any) => ({
        id: l.id,
        sku: l.sku || null,
        title: l.title,
        variantTitle: l.variantTitle,
        quantity: l.quantity,
        unitPrice: num(l.originalUnitPriceSet),
        productTags: l.product?.tags ?? [],
        productType: l.product?.productType ?? null,
      })),
```

Thêm `customAttributes`:
```typescript
      lines: (n.lineItems?.nodes || []).map((l: any) => ({
        id: l.id,
        sku: l.sku || null,
        title: l.title,
        variantTitle: l.variantTitle,
        quantity: l.quantity,
        unitPrice: num(l.originalUnitPriceSet),
        productTags: l.product?.tags ?? [],
        productType: l.product?.productType ?? null,
        customAttributes: l.customAttributes ?? [],
      })),
```

- [ ] **Step 4: Verify TypeScript compile không lỗi**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors (hoặc chỉ lỗi không liên quan đến file này)

- [ ] **Step 5: Commit**

```bash
git add src/lib/shopify-orders.ts
git commit -m "feat: fetch line item customAttributes from Shopify GraphQL"
```

---

## Task 4: Cập nhật repos/orders.ts

**Files:**
- Modify: `src/lib/repos/orders.ts`

- [ ] **Step 1: Thêm `orderType`, `trelloCardId`, `trelloCardUrl` vào `UpsertOrderInput`**

Tìm `export type UpsertOrderInput = {` và thêm 3 fields:
```typescript
export type UpsertOrderInput = {
  // ... existing fields ...
  orderType?: string          // "CUSTOM" | "NON_CUSTOM" | "UNKNOWN"
  trelloCardId?: string | null
  trelloCardUrl?: string | null
}
```

- [ ] **Step 2: Thêm vào `create` block trong `upsertOrderWithLines`**

Tìm `create: {` block, thêm sau `shippingZone: input.shippingZone ?? null,`:
```typescript
        orderType: input.orderType ?? 'UNKNOWN',
        trelloCardId: input.trelloCardId ?? null,
        trelloCardUrl: input.trelloCardUrl ?? null,
```

- [ ] **Step 3: Thêm vào `update` block**

Tìm `update: {` block, thêm sau `...(input.pipelineStatus !== undefined ? { pipelineStatus: input.pipelineStatus } : {}),`:
```typescript
        ...(input.orderType !== undefined ? { orderType: input.orderType } : {}),
        ...(input.trelloCardId !== undefined ? { trelloCardId: input.trelloCardId } : {}),
        ...(input.trelloCardUrl !== undefined ? { trelloCardUrl: input.trelloCardUrl } : {}),
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/repos/orders.ts
git commit -m "feat: add orderType and trelloCard fields to order upsert"
```

---

## Task 5: Tạo trello.ts client

**Files:**
- Create: `src/lib/trello.ts`

- [ ] **Step 1: Tạo `src/lib/trello.ts`**

```typescript
export type TrelloConfig = {
  apiKey: string
  token: string
  listId: string          // list để tạo card vào
  doneListId: string      // list DONE để poll
  syncFromOrderName: string  // e.g. "LIT2341"
}

export type TrelloCard = {
  id: string
  name: string
  url: string
  attachments?: Array<{ url: string; name: string }>
}

const BASE = 'https://api.trello.com/1'

function auth(cfg: TrelloConfig) {
  return `key=${cfg.apiKey}&token=${cfg.token}`
}

export async function createTrelloCard(
  cfg: TrelloConfig,
  name: string,
  desc: string,
): Promise<TrelloCard> {
  const res = await fetch(
    `${BASE}/cards?${auth(cfg)}&idList=${cfg.listId}&name=${encodeURIComponent(name)}&desc=${encodeURIComponent(desc)}`,
    { method: 'POST' },
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Trello createCard failed ${res.status}: ${text}`)
  }
  const data = await res.json()
  return { id: data.id, name: data.name, url: data.shortUrl ?? data.url }
}

export async function getCardsByList(cfg: TrelloConfig, listId: string): Promise<TrelloCard[]> {
  const res = await fetch(
    `${BASE}/lists/${listId}/cards?${auth(cfg)}&attachments=true&fields=id,name,shortUrl`,
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Trello getCardsByList failed ${res.status}: ${text}`)
  }
  const data = await res.json()
  return data.map((c: any) => ({
    id: c.id,
    name: c.name,
    url: c.shortUrl ?? c.url,
    attachments: (c.attachments ?? []).map((a: any) => ({ url: a.url, name: a.name })),
  }))
}

export function shouldCreateCard(
  orderName: string,
  syncFromOrderName: string,
): boolean {
  const extractNum = (s: string) => parseInt(s.replace(/\D/g, ''), 10) || 0
  return extractNum(orderName) >= extractNum(syncFromOrderName)
}

export async function getTrelloConfig(): Promise<TrelloConfig | null> {
  const { prisma } = await import('@/lib/db')
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: ['trello.apiKey', 'trello.token', 'trello.listId', 'trello.doneListId', 'trello.syncFromOrderName'] } },
  })
  const m = Object.fromEntries(rows.map(r => [r.key, r.value]))
  if (!m['trello.apiKey'] || !m['trello.token'] || !m['trello.listId'] || !m['trello.doneListId']) return null
  return {
    apiKey: m['trello.apiKey'],
    token: m['trello.token'],
    listId: m['trello.listId'],
    doneListId: m['trello.doneListId'],
    syncFromOrderName: m['trello.syncFromOrderName'] ?? 'LIT2341',
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/trello.ts
git commit -m "feat: add Trello API client with createCard and getCardsByList"
```

---

## Task 6: Trello config API routes

**Files:**
- Create: `src/app/api/trello/config/route.ts`

- [ ] **Step 1: Tạo `src/app/api/trello/config/route.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

const TRELLO_KEYS = [
  'trello.apiKey',
  'trello.token',
  'trello.listId',
  'trello.doneListId',
  'trello.syncFromOrderName',
]

export async function GET() {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: TRELLO_KEYS } } })
  const config = Object.fromEntries(rows.map(r => [r.key.replace('trello.', ''), r.value]))
  return NextResponse.json(config)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const updates: Array<{ key: string; value: string }> = []
  for (const field of ['apiKey', 'token', 'listId', 'doneListId', 'syncFromOrderName']) {
    if (body[field] !== undefined) {
      updates.push({ key: `trello.${field}`, value: String(body[field]) })
    }
  }
  await Promise.all(
    updates.map(u =>
      prisma.appSetting.upsert({
        where: { key: u.key },
        create: { key: u.key, value: u.value },
        update: { value: u.value },
      }),
    ),
  )
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/trello/config/route.ts
git commit -m "feat: add GET/POST /api/trello/config for Trello setup"
```

---

## Task 7: Trello Setup UI

**Files:**
- Modify: `src/app/setup/page.tsx`

- [ ] **Step 1: Thêm Trello state vào SetupPage**

Đọc file `src/app/setup/page.tsx`. Sau các `useState` hiện có, thêm:

```typescript
  const [trelloApiKey, setTrelloApiKey] = useState('')
  const [trelloToken, setTrelloToken] = useState('')
  const [trelloListId, setTrelloListId] = useState('')
  const [trelloDoneListId, setTrelloDoneListId] = useState('')
  const [trelloSyncFrom, setTrelloSyncFrom] = useState('LIT2341')
  const [trelloSaving, setTrelloSaving] = useState(false)
  const [trelloMsg, setTrelloMsg] = useState('')
```

- [ ] **Step 2: Fetch Trello config khi mount**

Trong `useEffect` ban đầu, sau dòng `fetch('/api/auth/status')...`, thêm:

```typescript
    fetch('/api/trello/config').then(r => r.json()).then(d => {
      if (d.apiKey) setTrelloApiKey(d.apiKey)
      if (d.token) setTrelloToken(d.token)
      if (d.listId) setTrelloListId(d.listId)
      if (d.doneListId) setTrelloDoneListId(d.doneListId)
      if (d.syncFromOrderName) setTrelloSyncFrom(d.syncFromOrderName)
    }).catch(() => {})
```

- [ ] **Step 3: Thêm hàm saveTrello**

Sau hàm `disconnect()`, thêm:

```typescript
  async function saveTrello() {
    setTrelloSaving(true); setTrelloMsg('')
    try {
      await fetch('/api/trello/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: trelloApiKey.trim(),
          token: trelloToken.trim(),
          listId: trelloListId.trim(),
          doneListId: trelloDoneListId.trim(),
          syncFromOrderName: trelloSyncFrom.trim(),
        }),
      })
      setTrelloMsg('Đã lưu cấu hình Trello.')
    } catch {
      setTrelloMsg('Lỗi khi lưu.')
    } finally {
      setTrelloSaving(false)
    }
  }
```

- [ ] **Step 4: Thêm Trello section vào JSX**

Tìm tag `</main>` cuối của return block. Thêm section Trello trước `</main>`:

```tsx
        {/* Trello Config */}
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 mb-lg">
          <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
            <span className="material-symbols-outlined text-on-surface-variant">view_kanban</span>
            <h2 className="text-title-md">Trello Integration</h2>
          </div>
          <div className="p-lg grid grid-cols-1 md:grid-cols-2 gap-md">
            <div>
              <label className="text-label-sm block mb-xs">API Key</label>
              <input
                type="password"
                value={trelloApiKey}
                onChange={e => setTrelloApiKey(e.target.value)}
                placeholder="Trello API Key"
                className="w-full border rounded-lg px-md py-sm text-body-sm"
              />
            </div>
            <div>
              <label className="text-label-sm block mb-xs">Token</label>
              <input
                type="password"
                value={trelloToken}
                onChange={e => setTrelloToken(e.target.value)}
                placeholder="Trello Token"
                className="w-full border rounded-lg px-md py-sm text-body-sm"
              />
            </div>
            <div>
              <label className="text-label-sm block mb-xs">List ID (tạo card vào)</label>
              <input
                value={trelloListId}
                onChange={e => setTrelloListId(e.target.value)}
                placeholder="e.g. 64abc123def456"
                className="w-full border rounded-lg px-md py-sm text-body-sm"
              />
            </div>
            <div>
              <label className="text-label-sm block mb-xs">Done List ID (cột DONE để sync)</label>
              <input
                value={trelloDoneListId}
                onChange={e => setTrelloDoneListId(e.target.value)}
                placeholder="e.g. 64abc789xyz012"
                className="w-full border rounded-lg px-md py-sm text-body-sm"
              />
            </div>
            <div>
              <label className="text-label-sm block mb-xs">Sync từ order (không kèm #)</label>
              <input
                value={trelloSyncFrom}
                onChange={e => setTrelloSyncFrom(e.target.value)}
                placeholder="LIT2341"
                className="w-full border rounded-lg px-md py-sm text-body-sm"
              />
            </div>
          </div>
          <div className="px-lg pb-lg flex items-center gap-sm">
            <button
              onClick={saveTrello}
              disabled={trelloSaving}
              className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50"
            >
              {trelloSaving ? 'Đang lưu…' : 'Lưu Trello Config'}
            </button>
            {trelloMsg && <span className="text-body-sm text-on-surface-variant">{trelloMsg}</span>}
          </div>
        </div>
```

- [ ] **Step 5: Verify app compile**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 6: Commit**

```bash
git add src/app/setup/page.tsx
git commit -m "feat: add Trello config section to Setup page"
```

---

## Task 8: Integrate classify + Trello card creation vào sync route

**Files:**
- Modify: `src/app/api/shopify/orders/sync/route.ts`

- [ ] **Step 1: Import các module mới vào đầu file**

Tìm các import hiện có, thêm vào:

```typescript
import { classifyOrderLines, buildTrelloCardContent } from '@/lib/order-classify'
import { createTrelloCard, getTrelloConfig, shouldCreateCard } from '@/lib/trello'
import { prisma } from '@/lib/db'
```

(Lưu ý: `prisma` đã được import rồi, không cần thêm lại nếu đã có)

- [ ] **Step 2: Load Trello config một lần trước loop**

Sau dòng `const allOverrides = await prisma.supplierZoneOverride.findMany()` và khởi tạo `overridesBySupplier`, thêm:

```typescript
  const trelloConfig = await getTrelloConfig()
```

- [ ] **Step 3: Thêm classify + Trello logic sau `await upsertOrderWithLines(...)`**

Tìm dòng:
```typescript
      totalSynced++
```

Thêm logic classify và Trello ngay trước dòng đó:

```typescript
      // Classify order type
      const classifyLines = o.lines.map(l => ({
        sku: l.sku,
        productTitle: l.title,
        customAttributes: l.customAttributes,
        productTags: l.productTags,
      }))
      const orderType = classifyOrderLines(classifyLines)

      // Update orderType in DB (separate update to avoid touching upsert logic)
      const existingOrder = await prisma.order.findUnique({
        where: { id: o.id },
        select: { orderType: true, trelloCardId: true },
      })
      if (existingOrder && existingOrder.orderType === 'UNKNOWN') {
        await prisma.order.update({ where: { id: o.id }, data: { orderType } })
      }

      // Create Trello card if needed
      if (
        trelloConfig &&
        existingOrder?.trelloCardId == null &&
        shouldCreateCard(o.name, trelloConfig.syncFromOrderName)
      ) {
        let needsCard = false

        if (orderType === 'CUSTOM') {
          needsCard = true
        } else if (orderType === 'NON_CUSTOM') {
          // Check if any SKU lacks a design
          const skus = o.lines.map(l => l.sku).filter(Boolean) as string[]
          if (skus.length > 0) {
            const skuDesigns = await prisma.skuDesign.findMany({
              where: { sku: { in: skus } },
              select: { sku: true, designReady: true },
            })
            const readySkus = new Set(skuDesigns.filter(s => s.designReady).map(s => s.sku))
            needsCard = skus.some(s => !readySkus.has(s))
          }
        }

        if (needsCard) {
          try {
            const cardLines = o.lines.map(l => ({
              sku: l.sku,
              productTitle: l.title,
              customAttributes: l.customAttributes,
              productTags: l.productTags,
              variantTitle: l.variantTitle,
              qty: l.quantity,
            }))
            const { name: cardName, desc } = buildTrelloCardContent(o.name, cardLines, orderType)
            const card = await createTrelloCard(trelloConfig, cardName, desc)
            await prisma.order.update({
              where: { id: o.id },
              data: { trelloCardId: card.id, trelloCardUrl: card.url },
            })

            // For NON_CUSTOM: upsert SkuDesign records with trelloCardId
            if (orderType === 'NON_CUSTOM') {
              const skus = o.lines.map(l => l.sku).filter(Boolean) as string[]
              for (const sku of skus) {
                await prisma.skuDesign.upsert({
                  where: { sku },
                  create: { sku, trelloCardId: card.id },
                  update: { trelloCardId: card.id },
                })
              }
            }
          } catch (e: any) {
            errors.push(`Trello card creation failed for ${o.name}: ${e.message}`)
          }
        }
      }

```

- [ ] **Step 4: Verify TypeScript compile**

```bash
npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/shopify/orders/sync/route.ts
git commit -m "feat: classify orders and create Trello cards during sync"
```

---

## Task 9: Trello Sync route (Poll DONE list)

**Files:**
- Create: `src/app/api/trello/sync/route.ts`

- [ ] **Step 1: Tạo `src/app/api/trello/sync/route.ts`**

```typescript
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getTrelloConfig, getCardsByList } from '@/lib/trello'

export async function POST() {
  const cfg = await getTrelloConfig()
  if (!cfg) {
    return NextResponse.json({ error: 'Trello chưa được cấu hình. Vào Setup để nhập API key.' }, { status: 400 })
  }

  let cards
  try {
    cards = await getCardsByList(cfg, cfg.doneListId)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 })
  }

  let updated = 0

  for (const card of cards) {
    const driveAttachment = card.attachments?.find(a => a.url.includes('drive.google.com'))
    if (!driveAttachment) continue

    // Update SkuDesign records linked to this card
    const skuDesign = await prisma.skuDesign.findFirst({ where: { trelloCardId: card.id } })
    if (skuDesign && !skuDesign.designReady) {
      await prisma.skuDesign.update({
        where: { id: skuDesign.id },
        data: { designReady: true, driveLink: driveAttachment.url },
      })
      updated++
    }
  }

  return NextResponse.json({ updated, cardsChecked: cards.length })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/trello/sync/route.ts
git commit -m "feat: add POST /api/trello/sync to poll Trello DONE list"
```

---

## Task 10: Extend reports.ts để trả về orderType + designReady

**Files:**
- Modify: `src/lib/repos/reports.ts`

- [ ] **Step 1: Cập nhật `ordersWithComputedPL` để join SkuDesign**

Trong `src/lib/repos/reports.ts`, tìm function `ordersWithComputedPL`. Sau `const orders = await listOrdersWithLines(filter)`, thêm:

```typescript
  // Build SkuDesign lookup for Non-Custom design status
  const allSkus = [...new Set(orders.flatMap(o => o.lines.map(l => l.sku).filter(Boolean) as string[]))]
  const skuDesigns = allSkus.length > 0
    ? await prisma.skuDesign.findMany({ where: { sku: { in: allSkus } } })
    : []
  const skuDesignMap = new Map(skuDesigns.map(s => [s.sku, s]))
```

Thêm `import { prisma } from '@/lib/db'` nếu chưa có ở đầu file.

- [ ] **Step 2: Cập nhật kiểu trả về của `ordersWithComputedPL`**

Tìm dòng `return { ...o, computed: { totalQty, baseCost, shipping, profit, margin, hasUnmappedSku } }`.

Thay bằng:

```typescript
    // Design ready = all non-null SKUs in order have designReady = true
    const orderSkus = o.lines.map(l => l.sku).filter(Boolean) as string[]
    const designReady = orderSkus.length > 0 && orderSkus.every(sku => skuDesignMap.get(sku)?.designReady === true)
    const driveLink = orderSkus.length > 0 ? (skuDesignMap.get(orderSkus[0])?.driveLink ?? null) : null

    return {
      ...o,
      computed: { totalQty, baseCost, shipping, profit, margin, hasUnmappedSku },
      designReady,
      driveLink,
    }
```

- [ ] **Step 3: Verify compile**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/repos/reports.ts
git commit -m "feat: join SkuDesign in ordersWithComputedPL for designReady status"
```

---

## Task 11: Orders page UI

**Files:**
- Modify: `src/app/orders/page.tsx`

- [ ] **Step 1: Cập nhật `OrderRow` type**

Tìm `type OrderRow = {` trong `src/app/orders/page.tsx`. Thêm 4 fields:

```typescript
type OrderRow = {
  // ... existing fields ...
  orderType: string           // "CUSTOM" | "NON_CUSTOM" | "UNKNOWN"
  trelloCardId: string | null
  trelloCardUrl: string | null
  designReady: boolean
}
```

- [ ] **Step 2: Thêm state và handler cho Sync Trello**

Sau `const [syncResult, setSyncResult] = useState('')`, thêm:

```typescript
  const [syncingTrello, setSyncingTrello] = useState(false)
  const [trelloResult, setTrelloResult] = useState('')
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'CUSTOM' | 'NON_CUSTOM'>('ALL')
  const [designFilter, setDesignFilter] = useState<'ALL' | 'HAS' | 'MISSING'>('ALL')
  const [trelloFilter, setTrelloFilter] = useState<'ALL' | 'CREATED' | 'NOT_CREATED'>('ALL')
```

- [ ] **Step 3: Thêm hàm `syncTrello`**

Sau hàm `sync()`, thêm:

```typescript
  const syncTrello = async () => {
    setSyncingTrello(true); setTrelloResult('Đang sync Trello...')
    try {
      const res = await fetch('/api/trello/sync', { method: 'POST' })
      const body = await res.json()
      if (!res.ok) setTrelloResult(`Lỗi: ${body.error ?? res.statusText}`)
      else setTrelloResult(`Đã cập nhật ${body.updated} design(s) từ ${body.cardsChecked} card DONE.`)
      await load()
    } catch (e: any) { setTrelloResult(`Lỗi: ${e.message}`) }
    finally { setSyncingTrello(false) }
  }
```

- [ ] **Step 4: Apply client-side filters**

Trong hàm `load`, sau `let list: OrderRow[] = oRes.orders ?? []`:

```typescript
    if (showUnmappedOnly) list = list.filter(o => o.computed.hasUnmappedSku)
    if (typeFilter !== 'ALL') list = list.filter(o => o.orderType === typeFilter)
    if (designFilter === 'HAS') list = list.filter(o => o.orderType === 'NON_CUSTOM' && o.designReady)
    if (designFilter === 'MISSING') list = list.filter(o => o.orderType === 'NON_CUSTOM' && !o.designReady)
    if (trelloFilter === 'CREATED') list = list.filter(o => o.trelloCardId != null)
    if (trelloFilter === 'NOT_CREATED') list = list.filter(o => o.trelloCardId == null)
```

Đồng thời thêm các filter dependencies vào useMemo `queryString` và useCallback `load`.

- [ ] **Step 5: Thêm buttons Sync Trello + Sync Design Order vào header**

Tìm button "Sync Now", thêm 2 button trước nó:

```tsx
            <button
              onClick={syncTrello}
              disabled={syncingTrello}
              className="border border-outline-variant/40 px-lg py-sm rounded-lg text-label-md disabled:opacity-50"
            >
              {syncingTrello ? 'Syncing…' : 'Sync Trello'}
            </button>
```

Và thêm thông báo kết quả Trello sau `syncResult`:

```tsx
        {trelloResult && <p className="mb-md text-body-sm text-on-surface-variant">{trelloResult}</p>}
```

- [ ] **Step 6: Thêm filter row (Type / Design / Trello)**

Trong section `{showFilters && ...}`, thêm vào grid:

```tsx
              <div>
                <label className="text-label-sm block mb-xs">Loại đơn</label>
                <select
                  value={typeFilter}
                  onChange={e => setTypeFilter(e.target.value as any)}
                  className="w-full border rounded-lg px-sm py-xs text-body-sm"
                >
                  <option value="ALL">Tất cả</option>
                  <option value="CUSTOM">Custom</option>
                  <option value="NON_CUSTOM">Non-Custom</option>
                </select>
              </div>
              <div>
                <label className="text-label-sm block mb-xs">Design</label>
                <select
                  value={designFilter}
                  onChange={e => setDesignFilter(e.target.value as any)}
                  className="w-full border rounded-lg px-sm py-xs text-body-sm"
                >
                  <option value="ALL">Tất cả</option>
                  <option value="HAS">Đã có</option>
                  <option value="MISSING">Chưa có</option>
                </select>
              </div>
              <div>
                <label className="text-label-sm block mb-xs">Trello</label>
                <select
                  value={trelloFilter}
                  onChange={e => setTrelloFilter(e.target.value as any)}
                  className="w-full border rounded-lg px-sm py-xs text-body-sm"
                >
                  <option value="ALL">Tất cả</option>
                  <option value="CREATED">Đã tạo card</option>
                  <option value="NOT_CREATED">Chưa tạo</option>
                </select>
              </div>
```

- [ ] **Step 7: Thêm columns vào table header**

Tìm `<tr className="text-left">` trong `<thead>`. Thêm sau `<th className="px-md py-sm">Order #</th>`:

```tsx
                <th className="px-md py-sm">Loại</th>
                <th className="px-md py-sm">Design</th>
                <th className="px-md py-sm">Trello</th>
```

Cập nhật `colSpan` của "No orders" row từ `11` thành `14`.

- [ ] **Step 8: Thêm cells vào table body**

Trong row `<tr key={o.id} ...>`, thêm sau cell Order #:

```tsx
                  <td className="px-md py-sm">
                    {o.orderType === 'CUSTOM' && (
                      <span className="bg-tertiary/15 text-tertiary text-label-sm px-xs py-[2px] rounded">Custom</span>
                    )}
                    {o.orderType === 'NON_CUSTOM' && (
                      <span className="bg-surface-container text-on-surface-variant text-label-sm px-xs py-[2px] rounded">Non-Custom</span>
                    )}
                    {o.orderType === 'UNKNOWN' && (
                      <span className="text-label-sm text-on-surface-variant">—</span>
                    )}
                  </td>
                  <td className="px-md py-sm">
                    {o.orderType === 'NON_CUSTOM' ? (
                      o.designReady
                        ? <span className="text-label-sm text-tertiary font-medium">Đã có</span>
                        : <span className="text-label-sm text-on-surface-variant">—</span>
                    ) : (
                      <span className="text-label-sm text-on-surface-variant">—</span>
                    )}
                  </td>
                  <td className="px-md py-sm">
                    {o.trelloCardUrl ? (
                      <a
                        href={o.trelloCardUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-label-sm text-secondary underline"
                      >
                        Xem card
                      </a>
                    ) : (
                      <span className="text-label-sm text-on-surface-variant">—</span>
                    )}
                  </td>
```

- [ ] **Step 9: Verify compile và chạy dev server để test UI**

```bash
npx tsc --noEmit 2>&1 | head -20
npm run dev -- --port 3002
```

Mở http://localhost:3002/orders và kiểm tra:
- Columns Type / Design / Trello hiển thị đúng
- Nút "Sync Trello" hoạt động
- Filters lọc đúng

- [ ] **Step 10: Commit**

```bash
git add src/app/orders/page.tsx
git commit -m "feat: add Custom/NonCustom type, Design, Trello columns and filters to Orders page"
```

---

## Self-Review checklist

- [x] Schema migration: `orderType`, `trelloCardId`, `trelloCardUrl` trên Order + `SkuDesign` model
- [x] `classifyOrderLines()` detect `_print_files` customAttribute và "Custom Name" product tag
- [x] `buildTrelloCardContent()` format đúng cho cả Custom lẫn Non-Custom
- [x] `shopify-orders.ts` fetch `customAttributes` từ Shopify GraphQL
- [x] Sync route classify sau upsert, gate by `syncFromOrderName`, tạo Trello card nếu cần
- [x] Non-Custom: upsert `SkuDesign` records với `trelloCardId` khi tạo card
- [x] `POST /api/trello/sync` poll DONE list, tìm Drive attachment, update `SkuDesign.designReady`
- [x] `reports.ts` join `SkuDesign`, compute `designReady` per order
- [x] Orders page: columns Type/Design/Trello, filters, nút Sync Trello
- [x] Setup page: Trello config section với 5 fields
