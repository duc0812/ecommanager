# Design Library (Non-Custom SKU × Supplier) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho phép đơn non-custom "đẩy thẳng" (skip design team) khi cặp (SKU × Supplier được gán) đã có design ready trong thư viện; nếu chưa → fallback tạo Trello card rồi tự populate thư viện để tái dùng.

**Architecture:** Thêm model `SkuSupplierDesign` (per SKU × Supplier). Một pure function `resolveOrderDesign` quyết định order design-ready dựa trên `SupplierProduct.requiresDesign` + tra thư viện theo supplier đã resolve của từng line. Sync route dùng kết quả này để (a) set pipeline status qua `autoDetectStatus`, (b) điền `OrderLine.designDriveLink`, (c) chỉ tạo Trello card cho các line còn thiếu và upsert `SkuSupplierDesign(trelloCardId)`. `trello/sync` populate ngược `ready=true` theo `trelloCardId`. Trang `/fulfillment/design-library` quản lý thủ công.

**Tech Stack:** Next.js App Router (`'use client'` pages), Prisma (SQLite), Vitest, Tailwind design tokens, material-symbols icons.

**Spec:** `docs/superpowers/specs/2026-08-28-design-library-design.md`

## Global Constraints

- **KHÔNG thêm `url` vào `datasource db {}`** trong `prisma/schema.prisma` (breaks Prisma v7).
- Sau schema change: `npx prisma migrate dev --name <...>` → `npx prisma generate` → bump `SCHEMA_VERSION` trong `src/lib/db.ts` (hiện `'v37'` → `'v38'`) → restart dev server.
- Import Prisma qua `import { prisma } from '@/lib/db'`; **route handler KHÔNG import prisma trực tiếp** — đi qua repo `src/lib/repos/<domain>.ts`.
- Import client type qua `@/generated/prisma/client` (không phải `@/generated/prisma`).
- Pages: `'use client'` + render `<Sidebar />`, wrap `<div className="flex min-h-screen bg-surface"><Sidebar /><main className="ml-[280px] flex-1 p-xl">...</main></div>`.
- Card pattern: `bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20`.
- Icons: `<span className="material-symbols-outlined">icon_name</span>`.
- API: export named `GET/POST/DELETE/PATCH`, trả `NextResponse.json(...)` hoặc `NextResponse.json({ error }, { status })`.
- Test runner: `npm test` (= `vitest run`). Unit tests colocated: `src/lib/<name>.test.ts`.
- `SkuSupplierDesign` là **shared/global** (không `projectId`).
- Dates hiển thị US MM/DD/YYYY (`en-US`) — không dùng `vi-VN`.

---

## File Structure

| File | Trách nhiệm |
|---|---|
| `prisma/schema.prisma` | + model `SkuSupplierDesign`, + relation `Supplier.skuDesigns` |
| `src/lib/db.ts` | bump `SCHEMA_VERSION` → `'v38'` |
| `src/lib/design-library.ts` | **mới** — pure: `resolveOrderDesign`, `parseDesignLibraryCsv`, key helper |
| `src/lib/design-library.test.ts` | **mới** — unit tests pure functions |
| `src/lib/order-classify.ts` | mở rộng nhánh NON_CUSTOM của `buildTrelloCardContent` (supplier + template + master artwork) |
| `src/lib/order-classify.test.ts` | + test cho NON_CUSTOM card mới |
| `src/lib/repos/design-library.ts` | **mới** — CRUD + `loadReadyDesignLookup` + import + `markLibraryReadyByCard` |
| `src/lib/repos/orders.ts` | + field `designReady?: boolean` vào `UpsertOrderInput` + ghi vào create/update |
| `src/app/api/shopify/orders/sync/route.ts` | tích hợp gate mới: preload lookup, resolve design, điền line link, set designReady, card gate per-supplier, upsert `SkuSupplierDesign` |
| `src/app/api/trello/sync/route.ts` | populate `SkuSupplierDesign` theo `trelloCardId`; update master artwork `SkuDesign.driveLink` |
| `src/lib/repos/design-library.ts` (consumed by) `src/app/api/fulfillment/design-library/route.ts` | **mới** — GET/POST |
| `src/app/api/fulfillment/design-library/[id]/route.ts` | **mới** — DELETE |
| `src/app/api/fulfillment/design-library/import/route.ts` | **mới** — POST bulk CSV |
| `src/app/fulfillment/design-library/page.tsx` | **mới** — UI |
| `src/components/Sidebar.tsx` | + nav "Design Library" |

**Đã có sẵn — không cần đụng:** `src/lib/csv-template.ts` (source `line.designDriveLink` đã hỗ trợ qua generic `line.` resolver) và `src/app/api/fulfillment/export/route.ts` (đã map `line.designDriveLink`). Bonus CSV coi như hoàn tất.

---

### Task 1: Prisma model `SkuSupplierDesign` + migration + schema version

**Files:**
- Modify: `prisma/schema.prisma` (model `Supplier` ~line 266–285; thêm model mới sau `SkuDesign` ~line 472)
- Modify: `src/lib/db.ts:6`

**Interfaces:**
- Produces: Prisma model `SkuSupplierDesign` với `@@unique([sku, supplierId])` (compound key name Prisma: `sku_supplierId`), relation `Supplier.skuDesigns`.

- [ ] **Step 1: Thêm relation ngược vào `Supplier`**

Trong `model Supplier { ... }`, thêm dòng cạnh các relation khác (sau `shipments Shipment[]`):

```prisma
  skuDesigns            SkuSupplierDesign[]
```

- [ ] **Step 2: Thêm model mới** (đặt ngay sau `model SkuDesign { ... }`)

```prisma
model SkuSupplierDesign {
  id           String   @id @default(cuid())
  sku          String
  supplierId   String
  supplier     Supplier @relation(fields: [supplierId], references: [id], onDelete: Cascade)
  designLink   String?
  ready        Boolean  @default(false)
  source       String   @default("MANUAL")   // "MANUAL" | "TRELLO"
  trelloCardId String?
  note         String?
  updatedAt    DateTime @updatedAt
  createdAt    DateTime @default(now())
  @@unique([sku, supplierId])
  @@index([sku])
  @@index([supplierId])
  @@index([trelloCardId])
}
```

- [ ] **Step 3: Chạy migration + generate**

Run:
```bash
cd "d:/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx prisma migrate dev --name add_sku_supplier_design
npx prisma generate
```
Expected: migration mới trong `prisma/migrations/`, client generate thành công, không lỗi.

- [ ] **Step 4: Bump SCHEMA_VERSION**

Trong `src/lib/db.ts:6` đổi:
```ts
const SCHEMA_VERSION = 'v37'
```
thành:
```ts
const SCHEMA_VERSION = 'v38'
```

- [ ] **Step 5: Verify build/generate**

Run: `npx tsc --noEmit`
Expected: PASS (không lỗi type từ Prisma client mới).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/db.ts
git commit -m "feat(design-library): add SkuSupplierDesign model + migration"
```

---

### Task 2: Pure gate function `resolveOrderDesign` + CSV parse

**Files:**
- Create: `src/lib/design-library.ts`
- Test: `src/lib/design-library.test.ts`

**Interfaces:**
- Produces:
  - `designKey(sku: string, supplierId: string): string` → `` `${sku}::${supplierId}` ``
  - `type DesignLineInput = { index: number; sku: string | null; isNonProduct: boolean; requiresDesign: boolean; resolvedSupplierId: string | null; existingDesignLink: string | null }`
  - `type LibraryEntry = { ready: boolean; designLink: string | null }`
  - `type LibraryLookup = (sku: string, supplierId: string) => LibraryEntry | null`
  - `type DesignResolution = { orderDesignReady: boolean; lineLinks: Array<{ index: number; designLink: string }>; missing: Array<{ index: number; sku: string | null; supplierId: string | null }> }`
  - `resolveOrderDesign(lines: DesignLineInput[], lookup: LibraryLookup): DesignResolution`
  - `type DesignImportRow = { sku: string; supplierCode: string; designLink: string }`
  - `parseDesignLibraryCsv(text: string): { rows: DesignImportRow[]; errors: string[] }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/design-library.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { resolveOrderDesign, parseDesignLibraryCsv, designKey, type DesignLineInput, type LibraryLookup } from './design-library'

const lookupFrom = (map: Record<string, { ready: boolean; designLink: string | null }>): LibraryLookup =>
  (sku, sup) => map[designKey(sku, sup)] ?? null

const baseLine = (over: Partial<DesignLineInput>): DesignLineInput => ({
  index: 0, sku: 'SKU1', isNonProduct: false, requiresDesign: true,
  resolvedSupplierId: 'supA', existingDesignLink: null, ...over,
})

describe('resolveOrderDesign', () => {
  it('order with no design-requiring lines is ready', () => {
    const r = resolveOrderDesign([baseLine({ requiresDesign: false })], lookupFrom({}))
    expect(r.orderDesignReady).toBe(true)
    expect(r.missing).toEqual([])
  })

  it('ready when library has ready entry for resolved supplier, and returns its link', () => {
    const r = resolveOrderDesign(
      [baseLine({ sku: 'SKU1', resolvedSupplierId: 'supA' })],
      lookupFrom({ [designKey('SKU1', 'supA')]: { ready: true, designLink: 'http://d/1' } }),
    )
    expect(r.orderDesignReady).toBe(true)
    expect(r.lineLinks).toEqual([{ index: 0, designLink: 'http://d/1' }])
  })

  it('missing when same SKU assigned to a different supplier without entry', () => {
    const r = resolveOrderDesign(
      [baseLine({ sku: 'SKU1', resolvedSupplierId: 'supB' })],
      lookupFrom({ [designKey('SKU1', 'supA')]: { ready: true, designLink: 'http://d/1' } }),
    )
    expect(r.orderDesignReady).toBe(false)
    expect(r.missing).toEqual([{ index: 0, sku: 'SKU1', supplierId: 'supB' }])
  })

  it('existing design link (e.g. from Trello) counts as ready', () => {
    const r = resolveOrderDesign(
      [baseLine({ existingDesignLink: 'http://trello/link' })],
      lookupFrom({}),
    )
    expect(r.orderDesignReady).toBe(true)
    expect(r.lineLinks).toEqual([])
  })

  it('non-product lines are ignored', () => {
    const r = resolveOrderDesign(
      [baseLine({ isNonProduct: true, requiresDesign: true, resolvedSupplierId: null })],
      lookupFrom({}),
    )
    expect(r.orderDesignReady).toBe(true)
  })

  it('multi-line ready only when all design lines ready', () => {
    const r = resolveOrderDesign([
      baseLine({ index: 0, sku: 'A', resolvedSupplierId: 'supA' }),
      baseLine({ index: 1, sku: 'B', resolvedSupplierId: 'supA' }),
    ], lookupFrom({ [designKey('A', 'supA')]: { ready: true, designLink: 'x' } }))
    expect(r.orderDesignReady).toBe(false)
    expect(r.missing).toEqual([{ index: 1, sku: 'B', supplierId: 'supA' }])
  })

  it('unresolved supplier is missing (not ready)', () => {
    const r = resolveOrderDesign([baseLine({ resolvedSupplierId: null })], lookupFrom({}))
    expect(r.orderDesignReady).toBe(false)
    expect(r.missing[0].supplierId).toBeNull()
  })
})

describe('parseDesignLibraryCsv', () => {
  it('parses valid rows and reports malformed lines', () => {
    const csv = 'sku,supplierCode,designLink\nSKU1,printful,http://d/1\nSKU2,,http://d/2\n,customcat,http://d/3'
    const { rows, errors } = parseDesignLibraryCsv(csv)
    expect(rows).toEqual([{ sku: 'SKU1', supplierCode: 'printful', designLink: 'http://d/1' }])
    expect(errors.length).toBe(2)
  })

  it('tolerates header column reordering', () => {
    const csv = 'designLink,sku,supplierCode\nhttp://d/1,SKU1,printful'
    const { rows } = parseDesignLibraryCsv(csv)
    expect(rows).toEqual([{ sku: 'SKU1', supplierCode: 'printful', designLink: 'http://d/1' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/design-library.test.ts`
Expected: FAIL (module không tồn tại).

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/design-library.ts`:
```ts
export function designKey(sku: string, supplierId: string): string {
  return `${sku}::${supplierId}`
}

export type DesignLineInput = {
  index: number
  sku: string | null
  isNonProduct: boolean
  requiresDesign: boolean
  resolvedSupplierId: string | null
  existingDesignLink: string | null
}

export type LibraryEntry = { ready: boolean; designLink: string | null }
export type LibraryLookup = (sku: string, supplierId: string) => LibraryEntry | null

export type DesignResolution = {
  orderDesignReady: boolean
  lineLinks: Array<{ index: number; designLink: string }>
  missing: Array<{ index: number; sku: string | null; supplierId: string | null }>
}

export function resolveOrderDesign(lines: DesignLineInput[], lookup: LibraryLookup): DesignResolution {
  const designLines = lines.filter(l => !l.isNonProduct && l.requiresDesign)
  const lineLinks: DesignResolution['lineLinks'] = []
  const missing: DesignResolution['missing'] = []
  let orderDesignReady = true

  for (const line of designLines) {
    if (line.existingDesignLink) continue
    const entry = line.sku && line.resolvedSupplierId ? lookup(line.sku, line.resolvedSupplierId) : null
    if (entry && entry.ready) {
      if (entry.designLink) lineLinks.push({ index: line.index, designLink: entry.designLink })
      continue
    }
    orderDesignReady = false
    missing.push({ index: line.index, sku: line.sku, supplierId: line.resolvedSupplierId })
  }

  return { orderDesignReady, lineLinks, missing }
}

export type DesignImportRow = { sku: string; supplierCode: string; designLink: string }

export function parseDesignLibraryCsv(text: string): { rows: DesignImportRow[]; errors: string[] } {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const rows: DesignImportRow[] = []
  const errors: string[] = []
  if (lines.length === 0) return { rows, errors }

  const header = lines[0].split(',').map(h => h.trim())
  const iSku = header.indexOf('sku')
  const iSup = header.indexOf('supplierCode')
  const iLink = header.indexOf('designLink')
  if (iSku < 0 || iSup < 0 || iLink < 0) {
    return { rows, errors: ['Header must contain: sku, supplierCode, designLink'] }
  }

  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i].split(',').map(c => c.trim())
    const sku = cells[iSku] ?? ''
    const supplierCode = cells[iSup] ?? ''
    const designLink = cells[iLink] ?? ''
    if (!sku || !supplierCode || !designLink) {
      errors.push(`Line ${i + 1}: missing sku/supplierCode/designLink`)
      continue
    }
    rows.push({ sku, supplierCode, designLink })
  }
  return { rows, errors }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/design-library.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/design-library.ts src/lib/design-library.test.ts
git commit -m "feat(design-library): resolveOrderDesign gate + CSV parse (pure)"
```

---

### Task 3: NON_CUSTOM Trello card content — supplier + template + master artwork

**Files:**
- Modify: `src/lib/order-classify.ts:21-78` (`buildTrelloCardContent`, nhánh NON_CUSTOM ~line 71-77)
- Test: `src/lib/order-classify.test.ts` (thêm test)

**Interfaces:**
- Consumes: `ClassifyLine` (Task uses existing type).
- Produces: `buildTrelloCardContent` chấp nhận line có thêm optional fields `supplierName?: string | null`, `designTemplateUrl?: string | null`, và optional param thứ 4 `masterArtworkBySku?: Map<string, string | null>`. Chữ ký mới:
  `buildTrelloCardContent(orderName, lines: Array<ClassifyLine & { variantTitle: string | null; qty: number; supplierName?: string | null; designTemplateUrl?: string | null }>, orderType, masterArtworkBySku?: Map<string, string | null>)`

- [ ] **Step 1: Write the failing test**

Thêm vào `src/lib/order-classify.test.ts`:
```ts
import { buildTrelloCardContent } from './order-classify'

describe('buildTrelloCardContent NON_CUSTOM with supplier hints', () => {
  it('lists supplier + template ref + master artwork per SKU', () => {
    const lines = [{
      sku: 'SKU1', productTitle: 'Tee', customAttributes: [], productTags: [],
      variantTitle: 'M', qty: 1, supplierName: 'Printful', designTemplateUrl: 'http://tpl/pf',
    }]
    const master = new Map<string, string | null>([['SKU1', 'http://master/1']])
    const { desc } = buildTrelloCardContent('#1023', lines, 'NON_CUSTOM', master)
    expect(desc).toContain('SKU1')
    expect(desc).toContain('Printful')
    expect(desc).toContain('http://tpl/pf')
    expect(desc).toContain('http://master/1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/order-classify.test.ts`
Expected: FAIL (desc thiếu supplier/template/master).

- [ ] **Step 3: Implement**

Trong `src/lib/order-classify.ts`:

1. Đổi chữ ký hàm:
```ts
export function buildTrelloCardContent(
  orderName: string,
  lines: Array<ClassifyLine & { variantTitle: string | null; qty: number; supplierName?: string | null; designTemplateUrl?: string | null }>,
  orderType: OrderType,
  masterArtworkBySku?: Map<string, string | null>,
): { name: string; desc: string } {
```

2. Thay nhánh NON_CUSTOM (đoạn `const skuList = ...; return { name, desc: 'Design missing ...' }`) bằng:
```ts
  const nonCustomSections = productLines.map((l, idx) => {
    const master = l.sku ? masterArtworkBySku?.get(l.sku) ?? null : null
    return [
      `**${idx + 1}. ${l.sku} (${orderToken}_${idx + 1})** — ${l.productTitle}${l.variantTitle ? ` / ${l.variantTitle}` : ''}`,
      l.supplierName ? `Supplier: ${l.supplierName}` : null,
      l.designTemplateUrl ? `Template: ${l.designTemplateUrl}` : null,
      master ? `Master artwork: ${master}` : null,
    ].filter(Boolean).join('\n')
  })
  return {
    name,
    desc: `Design missing — prepare per-supplier design:\n\n${nonCustomSections.join('\n\n---\n\n')}${digitalNote}`,
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/order-classify.test.ts`
Expected: PASS (bao gồm cả các test cũ vẫn xanh).

- [ ] **Step 5: Commit**

```bash
git add src/lib/order-classify.ts src/lib/order-classify.test.ts
git commit -m "feat(design-library): NON_CUSTOM Trello card shows supplier/template/master"
```

---

### Task 4: Repo `design-library.ts` + `UpsertOrderInput.designReady`

**Files:**
- Create: `src/lib/repos/design-library.ts`
- Modify: `src/lib/repos/orders.ts` (`UpsertOrderInput` ~line 90-143; create ~line 202; update ~line 226-229)

**Interfaces:**
- Produces:
  - `type DesignLibraryFilter = { supplierId?: string; sku?: string; ready?: boolean; source?: string }`
  - `listDesignEntries(filter: DesignLibraryFilter): Promise<Array<SkuSupplierDesign & { supplier: { id: string; name: string; code: string } }>>`
  - `upsertDesignEntry(input: { sku: string; supplierId: string; designLink?: string | null; ready?: boolean; note?: string | null; source?: string; trelloCardId?: string | null }): Promise<SkuSupplierDesign>`
  - `deleteDesignEntry(id: string): Promise<void>`
  - `loadReadyDesignLookup(): Promise<Map<string, string | null>>` — key `designKey(sku, supplierId)` → designLink, chỉ entries `ready=true`.
  - `importDesignEntries(rows: DesignImportRow[]): Promise<{ upserted: number; errors: string[] }>`
  - `markLibraryReadyByCard(cardId: string, designLink: string): Promise<number>`
  - `loadMasterArtworkBySku(): Promise<Map<string, string | null>>` — từ `SkuDesign.driveLink`.
- Consumes: `designKey`, `DesignImportRow` từ `@/lib/design-library`.

- [ ] **Step 1: Implement repo**

Create `src/lib/repos/design-library.ts`:
```ts
import { prisma } from '@/lib/db'
import { designKey, type DesignImportRow } from '@/lib/design-library'

export type DesignLibraryFilter = { supplierId?: string; sku?: string; ready?: boolean; source?: string }

export async function listDesignEntries(filter: DesignLibraryFilter) {
  const where: any = {}
  if (filter.supplierId) where.supplierId = filter.supplierId
  if (filter.sku) where.sku = { contains: filter.sku }
  if (typeof filter.ready === 'boolean') where.ready = filter.ready
  if (filter.source) where.source = filter.source
  return prisma.skuSupplierDesign.findMany({
    where,
    orderBy: [{ sku: 'asc' }, { supplierId: 'asc' }],
    include: { supplier: { select: { id: true, name: true, code: true } } },
  })
}

export async function upsertDesignEntry(input: {
  sku: string; supplierId: string; designLink?: string | null;
  ready?: boolean; note?: string | null; source?: string; trelloCardId?: string | null
}) {
  const ready = input.ready ?? (input.designLink ? true : false)
  return prisma.skuSupplierDesign.upsert({
    where: { sku_supplierId: { sku: input.sku, supplierId: input.supplierId } },
    create: {
      sku: input.sku, supplierId: input.supplierId,
      designLink: input.designLink ?? null, ready,
      note: input.note ?? null, source: input.source ?? 'MANUAL',
      trelloCardId: input.trelloCardId ?? null,
    },
    update: {
      ...(input.designLink !== undefined ? { designLink: input.designLink } : {}),
      ...(input.ready !== undefined ? { ready: input.ready } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.trelloCardId !== undefined ? { trelloCardId: input.trelloCardId } : {}),
    },
  })
}

export async function deleteDesignEntry(id: string) {
  await prisma.skuSupplierDesign.delete({ where: { id } })
}

export async function loadReadyDesignLookup(): Promise<Map<string, string | null>> {
  const rows = await prisma.skuSupplierDesign.findMany({
    where: { ready: true },
    select: { sku: true, supplierId: true, designLink: true },
  })
  return new Map(rows.map(r => [designKey(r.sku, r.supplierId), r.designLink]))
}

export async function loadMasterArtworkBySku(): Promise<Map<string, string | null>> {
  const rows = await prisma.skuDesign.findMany({ select: { sku: true, driveLink: true } })
  return new Map(rows.map(r => [r.sku, r.driveLink]))
}

export async function importDesignEntries(rows: DesignImportRow[]): Promise<{ upserted: number; errors: string[] }> {
  const errors: string[] = []
  let upserted = 0
  const suppliers = await prisma.supplier.findMany({ select: { id: true, code: true } })
  const supplierIdByCode = new Map(suppliers.map(s => [s.code, s.id]))
  for (const row of rows) {
    const supplierId = supplierIdByCode.get(row.supplierCode)
    if (!supplierId) { errors.push(`Unknown supplierCode: ${row.supplierCode} (sku ${row.sku})`); continue }
    await upsertDesignEntry({ sku: row.sku, supplierId, designLink: row.designLink, ready: true, source: 'MANUAL' })
    upserted += 1
  }
  return { upserted, errors }
}

export async function markLibraryReadyByCard(cardId: string, designLink: string): Promise<number> {
  const res = await prisma.skuSupplierDesign.updateMany({
    where: { trelloCardId: cardId, ready: false },
    data: { ready: true, designLink },
  })
  return res.count
}
```

- [ ] **Step 2: Thêm `designReady` vào `UpsertOrderInput`**

Trong `src/lib/repos/orders.ts`, thêm vào type `UpsertOrderInput` (cạnh `trelloCardUrl?`):
```ts
  designReady?: boolean
```
Trong nhánh `create` của `prisma.order.upsert` (sau `trelloCardUrl: input.trelloCardUrl ?? null,`):
```ts
        designReady: input.designReady ?? false,
```
Trong nhánh `update` (sau dòng spread `trelloCardUrl`):
```ts
        ...(input.designReady !== undefined ? { designReady: input.designReady } : {}),
```

- [ ] **Step 3: Verify types**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/repos/design-library.ts src/lib/repos/orders.ts
git commit -m "feat(design-library): repo (CRUD/lookup/import) + designReady in order upsert"
```

---

### Task 5: Sync route integration — gate per-supplier, line links, card fallback

**Files:**
- Modify: `src/app/api/shopify/orders/sync/route.ts` (imports ~line 1-14; preload ~line 101-160; per-order gate ~line 254-273; upsert lines ~line 305-333; card block ~line 364-437)

**Interfaces:**
- Consumes: `resolveOrderDesign`, `designKey` (`@/lib/design-library`); `loadReadyDesignLookup`, `loadMasterArtworkBySku` (`@/lib/repos/design-library`); `buildTrelloCardContent` (Task 3 signature).
- Produces: `Order.designReady` computed from library; `OrderLine.designDriveLink` filled; `SkuSupplierDesign` rows created on card creation.

- [ ] **Step 1: Add imports** (top of file)
```ts
import { resolveOrderDesign, designKey, type DesignLineInput } from '@/lib/design-library'
import { loadReadyDesignLookup, loadMasterArtworkBySku } from '@/lib/repos/design-library'
```

- [ ] **Step 2: Preload lookups** (after `const trelloConfig = await getTrelloConfig()`, ~line 160)
```ts
  const designLookup = await loadReadyDesignLookup()
  const masterArtworkBySku = await loadMasterArtworkBySku()
```

- [ ] **Step 3: Resolve design per order** (insert right BEFORE the `autoDetectStatus` call, after `hasCustomDesignLine` block ~line 264)
```ts
      const designInputs: DesignLineInput[] = resolvedLines.map((r, idx) => {
        const sp = r.pbResolve.supplierProductId ? supplierProductById.get(r.pbResolve.supplierProductId) : null
        return {
          index: idx,
          sku: r.line.sku,
          isNonProduct: isNonProductLine({ sku: r.line.sku, productTitle: r.line.title, shopifyProductType: r.line.productType }),
          requiresDesign: !!sp?.requiresDesign,
          resolvedSupplierId: sp?.supplierId ?? null,
          existingDesignLink: null,
        }
      })
      const designResolution = resolveOrderDesign(designInputs, (sku, supId) => {
        const key = designKey(sku, supId)
        return designLookup.has(key) ? { ready: true, designLink: designLookup.get(key) ?? null } : null
      })
      const libraryDesignLinkByIndex = new Map(designResolution.lineLinks.map(l => [l.index, l.designLink]))
      const effectiveDesignReady = designResolution.orderDesignReady || (existing?.designReady ?? false)
```
> Lưu ý: `existing` được đọc ngay phía trên (`select: { pipelineStatus, designReady }`) — dùng lại được.

- [ ] **Step 4: Feed design-ready into status detection**

Đổi `hasDesignReady: existing?.designReady ?? false,` trong `autoDetectStatus({...})` thành:
```ts
        hasDesignReady: effectiveDesignReady,
```

- [ ] **Step 5: Persist designReady + per-line library link in upsert**

Trong `upsertOrderWithLines({...})`, thêm field cấp order (cạnh `pipelineStatus: detected,`):
```ts
        designReady: effectiveDesignReady,
```
Trong `lines: o.lines.map((l, idx) => { ... return { ... } })`, thêm vào object trả về:
```ts
            designDriveLink: libraryDesignLinkByIndex.get(idx) ?? null,
```
> `upsertOrderWithLines` bảo toàn `designDriveLink` cũ khi nhận `null` (dòng `l.designDriveLink ?? snap?.designDriveLink ?? null`), nên link do Trello set không bị mất; link thư viện được ưu tiên khi có.

- [ ] **Step 6: Replace NON_CUSTOM card gate**

Thay khối:
```ts
        } else if (orderType === 'NON_CUSTOM') {
          const skus = o.lines
            .filter(l => !isNonProductLine({ sku: l.sku, productTitle: l.title, shopifyProductType: l.productType }))
            .map(l => l.sku).filter(Boolean) as string[]
          if (skus.length > 0) {
            const skuDesigns = await prisma.skuDesign.findMany({
              where: { sku: { in: skus } },
              select: { sku: true, designReady: true },
            })
            const readySkus = new Set(skuDesigns.filter(s => s.designReady).map(s => s.sku))
            needsCard = skus.some(s => !readySkus.has(s))
          }
        }
```
bằng:
```ts
        } else if (orderType === 'NON_CUSTOM') {
          needsCard = designResolution.missing.length > 0
        }
```

- [ ] **Step 7: Enrich card lines + replace SkuDesign upsert with SkuSupplierDesign**

7a. Trong khối `if (needsCard) { ... }`, đổi phần build `cardLines` để thêm supplier name + template (dùng maps sẵn có `supplierProductById`, `rawSupplierProductById`, và một map tên supplier). Trước vòng lặp orders (~line 117), thêm:
```ts
  const supplierNameById = new Map(supplierProducts.map(p => [p.supplierId, p.supplier.name]))
```
Đổi `const cardLines = o.lines.map(l => ({ ... }))` thành (map theo index để lấy resolved supplier/template):
```ts
            const cardLines = o.lines.map((l, idx) => {
              const spId = resolvedLines[idx]?.pbResolve.supplierProductId ?? null
              const sp = spId ? supplierProductById.get(spId) : null
              const raw = spId ? rawSupplierProductById.get(spId) : null
              return {
                sku: l.sku,
                productTitle: l.title,
                shopifyProductType: l.productType,
                customAttributes: l.customAttributes,
                productTags: l.productTags,
                variantTitle: l.variantTitle,
                qty: l.quantity,
                supplierName: sp ? supplierNameById.get(sp.supplierId) ?? null : null,
                designTemplateUrl: raw?.designTemplateUrl ?? null,
              }
            })
            const { name: cardName, desc } = buildTrelloCardContent(o.name, cardLines, orderType, masterArtworkBySku)
```

7b. Thay khối:
```ts
            // For NON_CUSTOM: upsert SkuDesign records with trelloCardId
            if (orderType === 'NON_CUSTOM') {
              const skus = o.lines
                .filter(l => !isNonProductLine({ sku: l.sku, productTitle: l.title, shopifyProductType: l.productType }))
                .map(l => l.sku).filter(Boolean) as string[]
              for (const sku of skus) {
                await prisma.skuDesign.upsert({
                  where: { sku },
                  create: { sku, trelloCardId: card.id },
                  update: { trelloCardId: card.id },
                })
              }
            }
```
bằng:
```ts
            // For NON_CUSTOM: link each missing (SKU × Supplier) to this card for reuse
            if (orderType === 'NON_CUSTOM') {
              for (const m of designResolution.missing) {
                if (!m.sku || !m.supplierId) continue
                await prisma.skuSupplierDesign.upsert({
                  where: { sku_supplierId: { sku: m.sku, supplierId: m.supplierId } },
                  create: { sku: m.sku, supplierId: m.supplierId, trelloCardId: card.id, source: 'TRELLO', ready: false },
                  update: { trelloCardId: card.id, source: 'TRELLO' },
                })
              }
            }
```

- [ ] **Step 8: Verify types + full test suite**

Run: `npx tsc --noEmit && npm test`
Expected: PASS (không lỗi type; test cũ vẫn xanh).

- [ ] **Step 9: Commit**

```bash
git add src/app/api/shopify/orders/sync/route.ts
git commit -m "feat(design-library): sync gate uses per-supplier library; card fallback per missing pair"
```

---

### Task 6: Trello sync — populate `SkuSupplierDesign` by card

**Files:**
- Modify: `src/app/api/trello/sync/route.ts` (imports ~line 1-5; updateMany ~line 34-38; bottom SkuDesign loop ~line 154-177)

**Interfaces:**
- Consumes: `markLibraryReadyByCard` (`@/lib/repos/design-library`).

- [ ] **Step 1: Add import**
```ts
import { markLibraryReadyByCard } from '@/lib/repos/design-library'
```

- [ ] **Step 2: Populate library from card**

Thay khối (~line 34-38):
```ts
    const linkedResult = await prisma.skuDesign.updateMany({
      where: { trelloCardId: card.id, designReady: false },
      data: { designReady: true, driveLink: driveAttachment.url },
    })
    updated += linkedResult.count
```
bằng:
```ts
    updated += await markLibraryReadyByCard(card.id, driveAttachment.url)
```

- [ ] **Step 3: Repurpose bottom loop to store master artwork**

Thay khối (~line 154-177) — trước đây upsert `SkuDesign` với `designReady/driveLink` per-SKU — bằng bản chỉ lưu master artwork (không dùng để gate):
```ts
    const skus = Array.from(new Set(
      linkedOrders
        .filter(o => o.orderType !== 'CUSTOM')
        .flatMap(o => o.lines.map(l => l.sku).filter(Boolean) as string[]),
    ))

    for (const sku of skus) {
      await prisma.skuDesign.upsert({
        where: { sku },
        create: { sku, driveLink: driveAttachment.url },
        update: { driveLink: driveAttachment.url },
      })
    }
```

- [ ] **Step 4: Verify types + tests**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/trello/sync/route.ts
git commit -m "feat(design-library): Trello sync populates SkuSupplierDesign by card"
```

---

### Task 7: API routes for Design Library

**Files:**
- Create: `src/app/api/fulfillment/design-library/route.ts`
- Create: `src/app/api/fulfillment/design-library/[id]/route.ts`
- Create: `src/app/api/fulfillment/design-library/import/route.ts`

**Interfaces:**
- Consumes: repo functions from Task 4; `parseDesignLibraryCsv` (`@/lib/design-library`).
- Produces (HTTP):
  - `GET /api/fulfillment/design-library?supplierId&sku&ready&source` → `{ entries }`
  - `POST /api/fulfillment/design-library` body `{ sku, supplierId, designLink?, ready?, note? }` → `{ entry }`
  - `DELETE /api/fulfillment/design-library/[id]` → `{ ok: true }`
  - `POST /api/fulfillment/design-library/import` body `{ csv }` → `{ upserted, errors }`

- [ ] **Step 1: GET + POST route**

Create `src/app/api/fulfillment/design-library/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server'
import { listDesignEntries, upsertDesignEntry } from '@/lib/repos/design-library'

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const readyParam = sp.get('ready')
  const entries = await listDesignEntries({
    supplierId: sp.get('supplierId') ?? undefined,
    sku: sp.get('sku') ?? undefined,
    ready: readyParam == null ? undefined : readyParam === 'true',
    source: sp.get('source') ?? undefined,
  })
  return NextResponse.json({ entries })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  if (!body.sku || !body.supplierId) {
    return NextResponse.json({ error: 'sku and supplierId are required' }, { status: 400 })
  }
  const entry = await upsertDesignEntry({
    sku: String(body.sku).trim(),
    supplierId: String(body.supplierId),
    designLink: body.designLink ?? null,
    ready: typeof body.ready === 'boolean' ? body.ready : undefined,
    note: body.note ?? null,
    source: 'MANUAL',
  })
  return NextResponse.json({ entry })
}
```

- [ ] **Step 2: DELETE route**

Create `src/app/api/fulfillment/design-library/[id]/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server'
import { deleteDesignEntry } from '@/lib/repos/design-library'

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await deleteDesignEntry(id)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Import route**

Create `src/app/api/fulfillment/design-library/import/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server'
import { parseDesignLibraryCsv } from '@/lib/design-library'
import { importDesignEntries } from '@/lib/repos/design-library'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  if (typeof body.csv !== 'string' || !body.csv.trim()) {
    return NextResponse.json({ error: 'csv text is required' }, { status: 400 })
  }
  const { rows, errors: parseErrors } = parseDesignLibraryCsv(body.csv)
  const { upserted, errors: importErrors } = await importDesignEntries(rows)
  return NextResponse.json({ upserted, errors: [...parseErrors, ...importErrors] })
}
```

- [ ] **Step 4: Verify types**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/fulfillment/design-library
git commit -m "feat(design-library): API routes (list/upsert/delete/import)"
```

---

### Task 8: UI page `/fulfillment/design-library` + Sidebar nav

**Files:**
- Create: `src/app/fulfillment/design-library/page.tsx`
- Modify: `src/components/Sidebar.tsx:32` (thêm nav item sau Product Mapping)

**Interfaces:**
- Consumes: API routes from Task 7; `GET /api/fulfillment/mapping/supplier-products` or existing suppliers endpoint for the supplier dropdown (use `GET /api/fulfillment/suppliers` if present; otherwise fetch suppliers list).

- [ ] **Step 1: Add Sidebar nav item**

Trong `src/components/Sidebar.tsx`, sau dòng Product Mapping (`{ type: 'child', href: '/fulfillment/mapping', ... }`), thêm:
```ts
  { type: 'child', href: '/fulfillment/design-library', icon: 'palette', label: 'Design Library' },
```

- [ ] **Step 2: Confirm supplier list endpoint**

Run: `npx ls-files-or-grep` không cần — kiểm tra nhanh:
Run: `git grep -l "api/fulfillment/suppliers" src`
Nếu tồn tại route GET suppliers → dùng nó cho dropdown. Nếu không, dùng `GET /api/fulfillment/mapping/supplier-products` và rút danh sách supplier distinct trên client, hoặc thêm nhanh `GET /api/fulfillment/suppliers`. (Chọn endpoint có sẵn để tránh tạo thừa.)

- [ ] **Step 3: Implement page**

Create `src/app/fulfillment/design-library/page.tsx`:
```tsx
'use client'
import { useEffect, useState, useCallback } from 'react'
import { Sidebar } from '@/components/Sidebar'

type Entry = {
  id: string; sku: string; supplierId: string; designLink: string | null
  ready: boolean; source: string; note: string | null; updatedAt: string
  supplier: { id: string; name: string; code: string }
}
type Supplier = { id: string; name: string; code: string }

export default function DesignLibraryPage() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [filterSupplier, setFilterSupplier] = useState('')
  const [filterSku, setFilterSku] = useState('')
  const [filterReady, setFilterReady] = useState('')
  const [form, setForm] = useState({ sku: '', supplierId: '', designLink: '' })
  const [csv, setCsv] = useState('')
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    const qs = new URLSearchParams()
    if (filterSupplier) qs.set('supplierId', filterSupplier)
    if (filterSku) qs.set('sku', filterSku)
    if (filterReady) qs.set('ready', filterReady)
    const res = await fetch(`/api/fulfillment/design-library?${qs.toString()}`)
    const data = await res.json()
    setEntries(data.entries ?? [])
  }, [filterSupplier, filterSku, filterReady])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    fetch('/api/fulfillment/suppliers').then(r => r.ok ? r.json() : { suppliers: [] })
      .then(d => setSuppliers(d.suppliers ?? d ?? []))
      .catch(() => setSuppliers([]))
  }, [])

  async function addEntry() {
    if (!form.sku || !form.supplierId) { setMsg('Nhập SKU và chọn Supplier'); return }
    const res = await fetch('/api/fulfillment/design-library', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, ready: true }),
    })
    if (res.ok) { setForm({ sku: '', supplierId: '', designLink: '' }); setMsg('Đã lưu'); load() }
    else setMsg((await res.json()).error ?? 'Lỗi')
  }

  async function toggleReady(e: Entry) {
    await fetch('/api/fulfillment/design-library', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: e.sku, supplierId: e.supplierId, ready: !e.ready }),
    })
    load()
  }

  async function remove(id: string) {
    await fetch(`/api/fulfillment/design-library/${id}`, { method: 'DELETE' })
    load()
  }

  async function runImport() {
    const res = await fetch('/api/fulfillment/design-library/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv }),
    })
    const data = await res.json()
    setMsg(`Imported ${data.upserted ?? 0}. ${data.errors?.length ? 'Errors: ' + data.errors.join('; ') : ''}`)
    setCsv(''); load()
  }

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <h1 className="text-headline-md font-semibold mb-lg">Design Library</h1>

        <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-lg mb-lg">
          <div className="flex items-center gap-sm mb-md">
            <span className="material-symbols-outlined">add_circle</span>
            <h2 className="text-title-md font-medium">Thêm design (xác nhận theo SKU)</h2>
          </div>
          <div className="flex flex-wrap gap-sm items-end">
            <input className="border border-outline-variant/40 rounded-lg px-md py-sm" placeholder="SKU"
              value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })} />
            <select className="border border-outline-variant/40 rounded-lg px-md py-sm"
              value={form.supplierId} onChange={e => setForm({ ...form, supplierId: e.target.value })}>
              <option value="">— Supplier —</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <input className="border border-outline-variant/40 rounded-lg px-md py-sm flex-1 min-w-[280px]" placeholder="Design link (Drive/CDN)"
              value={form.designLink} onChange={e => setForm({ ...form, designLink: e.target.value })} />
            <button className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md" onClick={addEntry}>Lưu</button>
          </div>
          {msg && <p className="text-body-sm text-on-surface-variant mt-sm">{msg}</p>}
        </div>

        <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-lg mb-lg">
          <div className="flex items-center gap-sm mb-md">
            <span className="material-symbols-outlined">upload_file</span>
            <h2 className="text-title-md font-medium">Import CSV (sku,supplierCode,designLink)</h2>
          </div>
          <textarea className="border border-outline-variant/40 rounded-lg px-md py-sm w-full h-24 font-mono text-body-sm"
            placeholder={'sku,supplierCode,designLink\nSKU1,printful,https://drive...'}
            value={csv} onChange={e => setCsv(e.target.value)} />
          <button className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md mt-sm" onClick={runImport}>Import</button>
        </div>

        <div className="flex flex-wrap gap-sm mb-md">
          <select className="border border-outline-variant/40 rounded-lg px-md py-sm" value={filterSupplier} onChange={e => setFilterSupplier(e.target.value)}>
            <option value="">All suppliers</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input className="border border-outline-variant/40 rounded-lg px-md py-sm" placeholder="Search SKU" value={filterSku} onChange={e => setFilterSku(e.target.value)} />
          <select className="border border-outline-variant/40 rounded-lg px-md py-sm" value={filterReady} onChange={e => setFilterReady(e.target.value)}>
            <option value="">Ready: all</option>
            <option value="true">Ready</option>
            <option value="false">Not ready</option>
          </select>
        </div>

        <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
          <table className="w-full text-body-sm">
            <thead className="bg-surface-container-low">
              <tr className="text-left">
                <th className="px-md py-sm">SKU</th><th className="px-md py-sm">Supplier</th>
                <th className="px-md py-sm">Design Link</th><th className="px-md py-sm">Ready</th>
                <th className="px-md py-sm">Source</th><th className="px-md py-sm">Updated</th><th className="px-md py-sm"></th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id} className="border-t border-outline-variant/20">
                  <td className="px-md py-sm font-medium">{e.sku}</td>
                  <td className="px-md py-sm">{e.supplier.name}</td>
                  <td className="px-md py-sm max-w-[320px] truncate">
                    {e.designLink ? <a className="text-primary underline" href={e.designLink} target="_blank" rel="noreferrer">{e.designLink}</a> : '—'}
                  </td>
                  <td className="px-md py-sm">
                    <button onClick={() => toggleReady(e)} className={`px-sm py-xs rounded-lg text-label-sm ${e.ready ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}`}>
                      {e.ready ? 'Ready' : 'Not ready'}
                    </button>
                  </td>
                  <td className="px-md py-sm">{e.source}</td>
                  <td className="px-md py-sm">{new Date(e.updatedAt).toLocaleDateString('en-US')}</td>
                  <td className="px-md py-sm">
                    <button onClick={() => remove(e.id)} className="material-symbols-outlined text-error">delete</button>
                  </td>
                </tr>
              ))}
              {entries.length === 0 && <tr><td className="px-md py-lg text-on-surface-variant" colSpan={7}>Chưa có design nào.</td></tr>}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
```
> Nếu Step 2 xác định không có `GET /api/fulfillment/suppliers`, đổi endpoint fetch supplier sang endpoint có sẵn và map `{ id, name, code }` cho đúng.

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS (page compiles, không lỗi import `Sidebar`).

- [ ] **Step 5: Commit**

```bash
git add src/app/fulfillment/design-library/page.tsx src/components/Sidebar.tsx
git commit -m "feat(design-library): management page + sidebar nav"
```

---

### Task 9: Manual QA + docs

**Files:**
- Modify: `NOTES.md`, `PLAN.md` (ghi trạng thái feature)

- [ ] **Step 1: Manual QA** (dev server chạy `npm run dev`)
  - [ ] Add entry (SKU + Supplier + link) trong `/fulfillment/design-library` → xuất hiện dòng "Ready".
  - [ ] Đảm bảo SupplierProduct của SKU đó có `requiresDesign=true`. Sync order chứa SKU đó gán đúng supplier → order `designReady=true`, status `READY_TO_PRODUCTION`, **không** tạo Trello card.
  - [ ] Cùng SKU nhưng order gán supplier khác (chưa có entry) → tạo Trello card mô tả supplier + template; entry `SkuSupplierDesign(source=TRELLO, ready=false)` được tạo.
  - [ ] Move card sang DONE + đính Drive link → `POST /api/trello/sync` → entry chuyển `ready=true`, `designLink` set → order sau của cặp đó auto ready.
  - [ ] SupplierProduct `requiresDesign=false` → order auto ready dù không có entry, không card.
  - [ ] Import CSV `sku,supplierCode,designLink` → entries upsert; supplierCode sai → nằm trong `errors`.

- [ ] **Step 2: Update docs**

Thêm mục ngắn vào `NOTES.md` (feature Design Library đã ship: model `SkuSupplierDesign`, gate per-supplier trong sync, trang `/fulfillment/design-library`). Cập nhật `PLAN.md` đánh dấu hoàn thành.

- [ ] **Step 3: Commit**

```bash
git add NOTES.md PLAN.md
git commit -m "docs(design-library): note feature completion + QA"
```

---

## Self-Review

**1. Spec coverage:**
- §4.1 model `SkuSupplierDesign` → Task 1. ✅
- §4.2 `SkuDesign` master + relation ngược → Task 1 (relation), Task 6 (master artwork update). ✅
- §5 gate per-line theo supplier + `requiresDesign` + điền `OrderLine.designDriveLink` + recompute `Order.designReady` → Task 2 (pure) + Task 5 (integration). ✅
- §6.1 card content supplier/template/master + upsert `SkuSupplierDesign(trelloCardId)` → Task 3 + Task 5 Step 7. ✅
- §6.2 populate ngược theo `trelloCardId` → Task 6. ✅
- §7 page + API CRUD + import CSV → Task 7 + Task 8. ✅
- §7.3 CSV export source `line.designDriveLink` → đã có sẵn (documented in File Structure). ✅
- §9 testing → Task 2/3 unit tests + Task 9 manual QA. ✅

**2. Placeholder scan:** Không có TBD/TODO. Mọi code step có nội dung thật. Task 8 Step 2 là một verification step có điều kiện (endpoint supplier) — nêu rõ nhánh xử lý, không phải placeholder.

**3. Type consistency:**
- `resolveOrderDesign` / `DesignResolution.missing` (`{index, sku, supplierId}`) dùng nhất quán ở Task 2 & Task 5.
- `designKey(sku, supplierId)` dùng ở lib + repo `loadReadyDesignLookup` + sync lookup — nhất quán.
- Compound unique `sku_supplierId` dùng nhất quán ở repo `upsertDesignEntry` (Task 4) và sync `skuSupplierDesign.upsert` (Task 5).
- `buildTrelloCardContent` chữ ký mới (param 4 `masterArtworkBySku`) khớp giữa Task 3 (định nghĩa) và Task 5 (gọi).
- `UpsertOrderInput.designReady` thêm ở Task 4, dùng ở Task 5.
