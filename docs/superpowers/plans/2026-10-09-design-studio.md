# Design Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/design-studio` page listing orders that need a print file, and a per-order workspace where a designer sees the customer's input, supplier, template, master artwork and preview, uploads artwork per print area, and marks lines done so the order leaves `PENDING_DESIGN`.

**Architecture:** Line-item properties get persisted on `OrderLine.customAttributesJson` at sync time (today they are thrown away after the Trello card is built). A new `DesignArtwork` table tracks uploaded files, stored on local disk under `storage/design/` and streamed back through an API route. `src/lib/design-studio.ts` joins everything a workspace needs; thin route handlers under `/api/design-studio` wrap it; two `'use client'` pages render it. Marking a line done writes the same columns `/api/trello/sync` writes, so the existing pipeline logic moves the order.

**Tech Stack:** Next.js 15 app router, Prisma v7 (SQLite via libsql adapter), Vitest on `test.db`, Tailwind with the project's tokens, Material Symbols icons.

**Spec:** `docs/superpowers/specs/2026-10-09-design-studio-design.md`

## Global Constraints

- Never add `url` to `datasource db {}` in `prisma/schema.prisma`; the URL lives in `prisma.config.ts`.
- After the schema change: `npx prisma migrate dev --name <name>`, then `npx prisma generate`, then bump `SCHEMA_VERSION` in `src/lib/db.ts` from `'v54'` to `'v55'`.
- Import Prisma types from `@/generated/prisma/client`, never `@/generated/prisma`. Use `import { prisma } from '@/lib/db'`.
- Tests run on `test.db` (vitest sets `DATABASE_URL`); every integration test creates and deletes its own rows.
- Every new `/api/*` prefix needs a rule in `API_ACCESS_RULES` (`src/lib/api-access.ts`) or the middleware denies it.
- Pages are `'use client'`, render `<Sidebar />`, and use the layout `<div className="flex min-h-screen bg-surface"><Sidebar /><main className="ml-[280px] flex-1 p-xl">…</main></div>`.
- Tailwind tokens only (`bg-surface-container-lowest`, `text-on-surface-variant`, `rounded-xl shadow-card border border-outline-variant/20`, buttons `bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md`). Icons: `<span className="material-symbols-outlined">name</span>`.
- Dates display as US `MM/DD/YYYY` (`toLocaleDateString('en-US')`).
- No comments in code unless explaining a non-obvious constraint.
- Files are served only by `DesignArtwork.id`; a client never supplies a path.
- Commit after every task; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A re-sync of an order that already has `customAttributesJson` must keep it when Shopify returns the same attributes, and must not blank it when the sync passes `undefined` — pinned by the "preserves existing JSON" test in Task 1.
2. `_print_files` can be malformed JSON or an array without `print_area`; `printAreasForLine` must fall back to `['Artwork']`, not throw — pinned in Task 2.
3. An order with a non-product line (Tip, Shipping protection, digital add-on) must count as done when every *product* line is done — pinned in Task 3.
4. A file name like `../../etc/passwd` or one with spaces/unicode must land inside the storage root with a safe name — pinned in Task 4.
5. Two uploads to the same slot must become version 1 and 2, never collide on the unique index — pinned in Task 4.

---

### Task 1: Persist line-item properties and add the artwork table

**Files:**
- Modify: `prisma/schema.prisma` (OrderLine ~line 405-434; add model after `OrderLine`)
- Modify: `src/lib/db.ts:7`
- Modify: `src/lib/repos/orders.ts` (UpsertOrderInput lines ~125-147; createMany ~237-262)
- Modify: `src/app/api/shopify/orders/sync/route.ts` (line map ~351-377)
- Modify: `.gitignore`
- Test: `tests/design-studio-attrs.integration.test.ts`

**Interfaces:**
- Produces: `OrderLine.customAttributesJson: string | null`, `OrderLine.designNote: string | null`, model `DesignArtwork`, and `UpsertOrderInput.lines[].customAttributesJson?: string | null`.

- [ ] **Step 1: Edit the schema**

In `prisma/schema.prisma`, inside `model OrderLine` after `customized Boolean @default(false)` add:

```prisma
  customAttributesJson    String?
  designNote              String?
  artworks                DesignArtwork[]
```

After the `OrderLine` model add:

```prisma
model DesignArtwork {
  id           String    @id @default(cuid())
  orderLineId  String
  orderLine    OrderLine @relation(fields: [orderLineId], references: [id], onDelete: Cascade)
  printArea    String
  version      Int
  fileName     String
  storagePath  String
  size         Int
  mimeType     String
  uploadedById String?
  createdAt    DateTime  @default(now())
  @@unique([orderLineId, printArea, version])
  @@index([orderLineId])
}
```

- [ ] **Step 2: Migrate and generate**

```bash
cd "D:/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx prisma migrate dev --name design_studio_attrs_artwork
npx prisma generate
```

Expected: a new folder under `prisma/migrations/` and no errors. Then in `src/lib/db.ts` change `const SCHEMA_VERSION = 'v54'` to `'v55'`.

- [ ] **Step 3: Gitignore the storage root**

Append to `.gitignore`:

```
# design studio uploads
/storage/
```

- [ ] **Step 4: Write the failing test**

`tests/design-studio-attrs.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { upsertOrderWithLines } from '@/lib/repos/orders'

const ORDER_ID = 'gid://test/Order/ds-attrs-1'
const SHOP = 'ds-attrs.myshopify.com'
const ATTRS = JSON.stringify([{ key: 'Custom Name', value: 'Ashley' }, { key: '_design', value: '{"v":3}' }])

function orderInput(storeId: string, attrs: string | null | undefined) {
  return {
    id: ORDER_ID, projectId: 'proj_ds_attrs', storeId, shopifyOrderNumber: '#DSA1',
    customerEmail: null, customerName: null, shippingCountry: null, shippingState: null,
    financialStatus: 'PAID', fulfillmentStatus: null, currency: 'USD',
    grossAmount: 50, expectedPayout: 48, totalFees: 2, refundedAmount: 0,
    defaultSupplierId: null, placedAt: new Date('2026-10-01T00:00:00Z'),
    lines: [{
      shopifyLineId: 'dsa-line-1', sku: 'DSA-SKU', variantTitle: null, productTitle: 'Socks',
      qty: 1, linePosition: 1, unitPrice: 50, resolvedSupplierId: null, resolvedBaseCost: null,
      customAttributesJson: attrs,
    }],
  }
}

let storeId = ''
beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_ds_attrs' }, create: { id: 'proj_ds_attrs', name: 'DS attrs', startDate: new Date('2026-06-01') }, update: {} })
  const store = await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_ds_attrs' }, update: {} })
  storeId = store.id
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
})

describe('OrderLine.customAttributesJson', () => {
  it('stores the attributes passed at upsert', async () => {
    await upsertOrderWithLines(orderInput(storeId, ATTRS))
    const line = await prisma.orderLine.findFirst({ where: { orderId: ORDER_ID } })
    expect(line?.customAttributesJson).toBe(ATTRS)
  })
  it('preserves existing JSON when the next sync passes undefined', async () => {
    await upsertOrderWithLines(orderInput(storeId, undefined))
    const line = await prisma.orderLine.findFirst({ where: { orderId: ORDER_ID } })
    expect(line?.customAttributesJson).toBe(ATTRS)
  })
})
```

- [ ] **Step 5: Run it to see it fail**

Run: `npx vitest run tests/design-studio-attrs.integration.test.ts`
Expected: FAIL — `customAttributesJson` is undefined/null (the repo does not write it yet).

- [ ] **Step 6: Thread the column through the repo**

In `src/lib/repos/orders.ts`:
- In `UpsertOrderInput.lines` type add `customAttributesJson?: string | null` after `customized?: boolean`.
- In the `existingLines` `select` (around line 155) add `customAttributesJson: true` and `designNote: true`.
- In the `createMany` data object add, after `designDriveLink`:

```ts
          customAttributesJson: l.customAttributesJson !== undefined ? l.customAttributesJson : (snap?.customAttributesJson ?? null),
          designNote: snap?.designNote ?? null,
```

(`snap` is the entry from the `snapshots` map keyed by `shopifyLineId`; `designNote` must survive a re-sync for the same reason cost snapshots do.)

- [ ] **Step 7: Write it from the sync route**

In `src/app/api/shopify/orders/sync/route.ts`, in the `lines: o.lines.map((l, idx) => { … })` object, after `customized: …` add:

```ts
            customAttributesJson: l.customAttributes.length > 0 ? JSON.stringify(l.customAttributes) : null,
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/design-studio-attrs.integration.test.ts tests/shopify-orders-sync.integration.test.ts tests/manual-base-cost.integration.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/db.ts src/lib/repos/orders.ts src/app/api/shopify/orders/sync/route.ts .gitignore tests/design-studio-attrs.integration.test.ts
git commit -m "feat(design-studio): persist line-item properties, add DesignArtwork

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Workspace loader

**Files:**
- Create: `src/lib/design-studio.ts`
- Test: `tests/design-studio.test.ts` (pure helpers), `tests/design-studio-workspace.integration.test.ts`

**Interfaces:**
- Consumes: `visibleCustomAttributes`, `customerDesignLink` from `@/lib/order-classify`; `extractPreviewCdnUrl` from `@/lib/order-line-assets`; `isNonProductLine` from `@/lib/order-lines`; `lineDesignStatus` from `@/lib/design-status`; `loadReadyDesignEntries` from `@/lib/repos/design-library`; `matchDesignEntry` from `@/lib/design-parent`.
- Produces:

```ts
export type CustomAttribute = { key: string; value: string }
export type SourcePrintFile = { printArea: string; url: string }
export type ArtworkRow = { id: string; printArea: string; version: number; fileName: string; size: number; mimeType: string; uploadedById: string | null; createdAt: string; url: string }
export type WorkspaceLine = {
  id: string; linePosition: number; sku: string | null; productTitle: string; variantTitle: string | null
  qty: number; isNonProduct: boolean; customized: boolean
  variantOptions: Record<string, string>
  attributesLoaded: boolean
  personalization: CustomAttribute[]
  customerDesignLink: string | null
  customizedUrl: string | null
  previewUrl: string | null
  sourcePrintFiles: SourcePrintFile[]
  supplier: { id: string; name: string; code: string } | null
  supplierSku: string | null
  templateUrl: string | null
  masterArtworkUrl: string | null
  libraryDesignLink: string | null
  designStatus: 'DONE' | 'PENDING' | 'LIBRARY' | 'NONE'
  designDriveLink: string | null
  designNote: string | null
  printAreas: string[]
  artworks: ArtworkRow[]
}
export type Workspace = {
  order: { id: string; shopifyOrderNumber: string; placedAt: string; pipelineStatus: string; orderType: string; designReady: boolean; trelloCardUrl: string | null; store: { shop: string; projectId: string; projectName: string } }
  lines: WorkspaceLine[]
}
export function parseAttributes(json: string | null): CustomAttribute[]
export function sourcePrintFiles(attrs: CustomAttribute[]): SourcePrintFile[]
export function printAreasForLine(attrs: CustomAttribute[]): string[]
export function artworkUrl(id: string): string            // `/api/design-studio/file/${id}`
export async function loadWorkspace(orderId: string): Promise<Workspace | null>
```

- [ ] **Step 1: Write the failing unit tests**

`tests/design-studio.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseAttributes, printAreasForLine, sourcePrintFiles } from '@/lib/design-studio'

const PF = JSON.stringify([
  { print_area: 'Front', url: 'https://cdn.example/front.png' },
  { print_area: 'Back', url: 'https://cdn.example/back.png' },
])

describe('parseAttributes', () => {
  it('returns [] for null or broken JSON', () => {
    expect(parseAttributes(null)).toEqual([])
    expect(parseAttributes('{nope')).toEqual([])
  })
  it('keeps only {key, value} string pairs', () => {
    expect(parseAttributes(JSON.stringify([{ key: 'A', value: 'x' }, { key: 1 }, 'junk']))).toEqual([{ key: 'A', value: 'x' }])
  })
})

describe('sourcePrintFiles', () => {
  it('reads _print_files entries', () => {
    expect(sourcePrintFiles([{ key: '_print_files', value: PF }])).toEqual([
      { printArea: 'Front', url: 'https://cdn.example/front.png' },
      { printArea: 'Back', url: 'https://cdn.example/back.png' },
    ])
  })
  it('falls back to _customall_print_file as "Print"', () => {
    expect(sourcePrintFiles([{ key: '_customall_print_file', value: 'https://cdn.example/p.png' }]))
      .toEqual([{ printArea: 'Print', url: 'https://cdn.example/p.png' }])
  })
  it('ignores malformed JSON', () => {
    expect(sourcePrintFiles([{ key: '_print_files', value: '[{"url":' }])).toEqual([])
  })
})

describe('printAreasForLine', () => {
  it('names slots after _print_files areas', () => {
    expect(printAreasForLine([{ key: '_print_files', value: PF }])).toEqual(['Front', 'Back'])
  })
  it('falls back to Artwork when there are no areas or no names', () => {
    expect(printAreasForLine([])).toEqual(['Artwork'])
    expect(printAreasForLine([{ key: '_print_files', value: JSON.stringify([{ url: 'x' }]) }])).toEqual(['Artwork'])
    expect(printAreasForLine([{ key: '_print_files', value: 'not json' }])).toEqual(['Artwork'])
  })
  it('dedupes repeated area names', () => {
    const dup = JSON.stringify([{ print_area: 'print', url: 'a' }, { print_area: 'print', url: 'b' }])
    expect(printAreasForLine([{ key: '_print_files', value: dup }])).toEqual(['print'])
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/design-studio.test.ts`
Expected: FAIL — module `@/lib/design-studio` not found.

- [ ] **Step 3: Write the helpers and the loader**

`src/lib/design-studio.ts`:

```ts
import { prisma } from '@/lib/db'
import { visibleCustomAttributes, customerDesignLink } from '@/lib/order-classify'
import { extractPreviewCdnUrl } from '@/lib/order-line-assets'
import { isNonProductLine } from '@/lib/order-lines'
import { lineDesignStatus, type LineDesignStatus } from '@/lib/design-status'
import { loadReadyDesignEntries } from '@/lib/repos/design-library'
import { matchDesignEntry } from '@/lib/design-parent'

export type CustomAttribute = { key: string; value: string }
export type SourcePrintFile = { printArea: string; url: string }
export type ArtworkRow = {
  id: string; printArea: string; version: number; fileName: string; size: number
  mimeType: string; uploadedById: string | null; createdAt: string; url: string
}
export type WorkspaceLine = {
  id: string; linePosition: number; sku: string | null; productTitle: string; variantTitle: string | null
  qty: number; isNonProduct: boolean; customized: boolean
  variantOptions: Record<string, string>
  attributesLoaded: boolean
  personalization: CustomAttribute[]
  customerDesignLink: string | null
  customizedUrl: string | null
  previewUrl: string | null
  sourcePrintFiles: SourcePrintFile[]
  supplier: { id: string; name: string; code: string } | null
  supplierSku: string | null
  templateUrl: string | null
  masterArtworkUrl: string | null
  libraryDesignLink: string | null
  designStatus: LineDesignStatus
  designDriveLink: string | null
  designNote: string | null
  printAreas: string[]
  artworks: ArtworkRow[]
}
export type Workspace = {
  order: {
    id: string; shopifyOrderNumber: string; placedAt: string; pipelineStatus: string; orderType: string
    designReady: boolean; trelloCardUrl: string | null
    store: { shop: string; projectId: string; projectName: string }
  }
  lines: WorkspaceLine[]
}

export const DEFAULT_PRINT_AREA = 'Artwork'

export function parseAttributes(json: string | null): CustomAttribute[] {
  if (!json) return []
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return [] }
  if (!Array.isArray(raw)) return []
  return raw.filter((a): a is CustomAttribute =>
    !!a && typeof a === 'object' && typeof (a as any).key === 'string' && typeof (a as any).value === 'string')
}

export function sourcePrintFiles(attrs: CustomAttribute[]): SourcePrintFile[] {
  const pf = attrs.find(a => a.key === '_print_files')?.value
  if (pf) {
    try {
      const parsed = JSON.parse(pf)
      if (Array.isArray(parsed)) {
        const out = parsed
          .filter(p => p && typeof p.url === 'string')
          .map(p => ({ printArea: typeof p.print_area === 'string' && p.print_area.trim() ? p.print_area.trim() : 'Print', url: p.url as string }))
        if (out.length > 0) return out
      }
    } catch {}
  }
  const single = attrs.find(a => a.key === '_customall_print_file')?.value
  return single ? [{ printArea: 'Print', url: single }] : []
}

export function printAreasForLine(attrs: CustomAttribute[]): string[] {
  const pf = attrs.find(a => a.key === '_print_files')?.value
  if (!pf) return [DEFAULT_PRINT_AREA]
  let parsed: unknown
  try { parsed = JSON.parse(pf) } catch { return [DEFAULT_PRINT_AREA] }
  if (!Array.isArray(parsed)) return [DEFAULT_PRINT_AREA]
  const names = Array.from(new Set(
    parsed.map(p => (p && typeof p.print_area === 'string') ? p.print_area.trim() : '').filter(Boolean),
  ))
  return names.length > 0 ? names : [DEFAULT_PRINT_AREA]
}

export function artworkUrl(id: string): string {
  return `/api/design-studio/file/${id}`
}

function parseVariantOptions(json: string | null): Record<string, string> {
  if (!json) return {}
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}

export async function loadWorkspace(orderId: string): Promise<Workspace | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      store: { include: { project: { select: { id: true, name: true } } } },
      lines: {
        orderBy: { linePosition: 'asc' },
        include: { artworks: { orderBy: [{ printArea: 'asc' }, { version: 'desc' }] } },
      },
    },
  })
  if (!order) return null

  const supplierIds = Array.from(new Set(order.lines.map(l => l.resolvedSupplierId).filter(Boolean) as string[]))
  const skus = Array.from(new Set(order.lines.map(l => l.sku).filter(Boolean) as string[]))
  const [suppliers, supplierProducts, skuDesigns, designEntries] = await Promise.all([
    supplierIds.length ? prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true, code: true } }) : [],
    supplierIds.length
      ? prisma.supplierProduct.findMany({
          where: { supplierId: { in: supplierIds }, sku: { in: order.lines.map(l => l.resolvedSupplierSku).filter(Boolean) as string[] } },
          select: { supplierId: true, sku: true, designTemplateUrl: true },
        })
      : [],
    skus.length ? prisma.skuDesign.findMany({ where: { sku: { in: skus } }, select: { sku: true, driveLink: true } }) : [],
    loadReadyDesignEntries(),
  ])
  const supplierById = new Map(suppliers.map(s => [s.id, s]))
  const templateByKey = new Map(supplierProducts.map(p => [`${p.supplierId}::${p.sku}`, p.designTemplateUrl]))
  const masterBySku = new Map(skuDesigns.map(d => [d.sku, d.driveLink]))

  const lines: WorkspaceLine[] = order.lines.map(l => {
    const attrs = parseAttributes(l.customAttributesJson)
    const isNonProduct = isNonProductLine(l)
    const entry = matchDesignEntry(l.sku, l.resolvedSupplierId, designEntries)
    const preview = l.previewCdnUrl ?? extractPreviewCdnUrl(attrs)
    return {
      id: l.id,
      linePosition: l.linePosition,
      sku: l.sku,
      productTitle: l.productTitle,
      variantTitle: l.variantTitle,
      qty: l.qty,
      isNonProduct,
      customized: l.customized,
      variantOptions: parseVariantOptions(l.variantOptions),
      attributesLoaded: l.customAttributesJson != null,
      personalization: visibleCustomAttributes(attrs).filter(a => a.value !== preview),
      customerDesignLink: customerDesignLink({ customAttributes: attrs, productUrl: null, variantId: l.shopifyVariantId }),
      customizedUrl: attrs.find(a => a.key === '_customized_url')?.value ?? null,
      previewUrl: preview,
      sourcePrintFiles: sourcePrintFiles(attrs),
      supplier: l.resolvedSupplierId ? (supplierById.get(l.resolvedSupplierId) ?? null) : null,
      supplierSku: l.resolvedSupplierSku,
      templateUrl: l.resolvedSupplierId && l.resolvedSupplierSku ? (templateByKey.get(`${l.resolvedSupplierId}::${l.resolvedSupplierSku}`) ?? null) : null,
      masterArtworkUrl: l.sku ? (masterBySku.get(l.sku) ?? null) : null,
      libraryDesignLink: entry?.designLink ?? null,
      designStatus: lineDesignStatus({
        isNonProduct, previewCdnUrl: l.previewCdnUrl, designDriveLink: l.designDriveLink,
        hasLibraryDesign: !!entry, customized: l.customized,
      }),
      designDriveLink: l.designDriveLink,
      designNote: l.designNote,
      printAreas: printAreasForLine(attrs),
      artworks: l.artworks.map(a => ({
        id: a.id, printArea: a.printArea, version: a.version, fileName: a.fileName, size: a.size,
        mimeType: a.mimeType, uploadedById: a.uploadedById, createdAt: a.createdAt.toISOString(), url: artworkUrl(a.id),
      })),
    }
  })

  return {
    order: {
      id: order.id, shopifyOrderNumber: order.shopifyOrderNumber, placedAt: order.placedAt.toISOString(),
      pipelineStatus: order.pipelineStatus, orderType: order.orderType, designReady: order.designReady,
      trelloCardUrl: order.trelloCardUrl,
      store: { shop: order.store.shop, projectId: order.store.project.id, projectName: order.store.project.name },
    },
    lines,
  }
}
```

Note on `customerDesignLink`: it needs `productUrl`, which is not stored on the line. Pass `null` for now — the link is produced only when the refresh route (Task 5) has stored `_product_url` in the attributes; add this line before the `return` inside the map so the stored value is used:

```ts
    const productUrl = attrs.find(a => a.key === '_product_url')?.value ?? null
```

and use `customerDesignLink({ customAttributes: attrs, productUrl, variantId: l.shopifyVariantId })`. Task 5 writes `_product_url` into the stored JSON; Task 1's sync path adds it too (see Step 5 below).

- [ ] **Step 4: Run the unit tests**

Run: `npx vitest run tests/design-studio.test.ts`
Expected: PASS.

- [ ] **Step 5: Store the product URL at sync**

In `src/app/api/shopify/orders/sync/route.ts`, replace the `customAttributesJson:` line from Task 1 with:

```ts
            customAttributesJson: (l.customAttributes.length > 0 || l.productUrl)
              ? JSON.stringify(l.productUrl ? [...l.customAttributes, { key: '_product_url', value: l.productUrl }] : l.customAttributes)
              : null,
```

Check `l.productUrl` exists on the synced line type (`src/lib/shopify-orders.ts` ~line 200 maps `product.onlineStoreUrl`); if the field is named differently there, use that name.

- [ ] **Step 6: Write the integration test for the loader**

`tests/design-studio-workspace.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { loadWorkspace } from '@/lib/design-studio'

const ORDER_ID = 'gid://test/Order/ds-ws-1'
const SHOP = 'ds-ws.myshopify.com'
const SUP = 'sup_ds_ws'
let storeId = ''

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_ds_ws' }, create: { id: 'proj_ds_ws', name: 'DS ws', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_ds_ws' }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'DSWS' }, create: { id: SUP, name: 'DS WS Supplier', code: 'DSWS' }, update: {} })
  await prisma.supplierProduct.upsert({
    where: { supplierId_sku: { supplierId: SUP, sku: 'SUP-SOCK' } },
    create: { supplierId: SUP, sku: 'SUP-SOCK', baseCost: 5, designTemplateUrl: 'https://drive.example/template' },
    update: { designTemplateUrl: 'https://drive.example/template' },
  })
  await prisma.skuDesign.upsert({ where: { sku: 'DSWS-SKU' }, create: { sku: 'DSWS-SKU', driveLink: 'https://drive.example/master' }, update: { driveLink: 'https://drive.example/master' } })
  await prisma.order.create({
    data: {
      id: ORDER_ID, projectId: 'proj_ds_ws', storeId, shopifyOrderNumber: '#DSW1', financialStatus: 'PAID',
      currency: 'USD', grossAmount: 50, expectedPayout: 48, totalFees: 2, refundedAmount: 0, placedAt: new Date('2026-10-01'),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
      lines: { create: [
        {
          shopifyLineId: 'dsw-1', sku: 'DSWS-SKU', productTitle: 'Socks', qty: 1, linePosition: 1, unitPrice: 50,
          resolvedSupplierId: SUP, resolvedSupplierSku: 'SUP-SOCK', customized: true,
          customAttributesJson: JSON.stringify([
            { key: 'Custom Name', value: 'Ashley' },
            { key: '_print_files', value: JSON.stringify([{ print_area: 'Front', url: 'https://cdn.example/f.png' }]) },
          ]),
        },
        { shopifyLineId: 'dsw-2', sku: 'OTHER', productTitle: 'Mug', qty: 1, linePosition: 2, unitPrice: 20, customAttributesJson: null },
      ] },
    },
  })
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.skuDesign.deleteMany({ where: { sku: 'DSWS-SKU' } })
})

describe('loadWorkspace', () => {
  it('returns null for an unknown order', async () => {
    expect(await loadWorkspace('nope')).toBeNull()
  })
  it('joins supplier, template, master artwork and print areas per line', async () => {
    const ws = await loadWorkspace(ORDER_ID)
    expect(ws?.order.shopifyOrderNumber).toBe('#DSW1')
    const [l1, l2] = ws!.lines
    expect(l1.supplier?.code).toBe('DSWS')
    expect(l1.templateUrl).toBe('https://drive.example/template')
    expect(l1.masterArtworkUrl).toBe('https://drive.example/master')
    expect(l1.personalization).toEqual([{ key: 'Custom Name', value: 'Ashley' }])
    expect(l1.printAreas).toEqual(['Front'])
    expect(l1.sourcePrintFiles[0].url).toBe('https://cdn.example/f.png')
    expect(l1.attributesLoaded).toBe(true)
    expect(l2.attributesLoaded).toBe(false)
    expect(l2.templateUrl).toBeNull()
    expect(l2.printAreas).toEqual(['Artwork'])
  })
})
```

- [ ] **Step 7: Run both test files**

Run: `npx vitest run tests/design-studio.test.ts tests/design-studio-workspace.integration.test.ts`
Expected: PASS. If `supplierId_sku` is not the generated compound key name, read `prisma/schema.prisma` `SupplierProduct` `@@unique` and use that name.

- [ ] **Step 8: Commit**

```bash
git add src/lib/design-studio.ts src/app/api/shopify/orders/sync/route.ts tests/design-studio.test.ts tests/design-studio-workspace.integration.test.ts
git commit -m "feat(design-studio): workspace loader with print areas and source print files

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Mark a line done, order GET/PATCH routes, access rule

**Files:**
- Modify: `src/lib/design-studio.ts`
- Create: `src/app/api/design-studio/orders/[id]/route.ts`
- Create: `src/app/api/design-studio/lines/[lineId]/route.ts`
- Modify: `src/lib/api-access.ts:29` (add rule next to the design- rule)
- Test: `tests/design-studio-done.integration.test.ts`

**Interfaces:**
- Produces:

```ts
export async function updateLine(lineId: string, patch: { note?: string | null; done?: boolean }): Promise<{ line: { id: string; designDriveLink: string | null; designNote: string | null }; order: { id: string; designReady: boolean; pipelineStatus: string } } | null>
```
- `GET /api/design-studio/orders/[id]` → `Workspace` JSON or `{error}` 404.
- `PATCH /api/design-studio/lines/[lineId]` body `{ note?: string | null, done?: boolean }` → `updateLine` result.

- [ ] **Step 1: Write the failing test**

`tests/design-studio-done.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { updateLine } from '@/lib/design-studio'

const ORDER_ID = 'gid://test/Order/ds-done-1'
const SHOP = 'ds-done.myshopify.com'
let storeId = ''
let l1 = '', l2 = '', tip = ''

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_ds_done' }, create: { id: 'proj_ds_done', name: 'DS done', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_ds_done' }, update: {} })).id
  const o = await prisma.order.create({
    data: {
      id: ORDER_ID, projectId: 'proj_ds_done', storeId, shopifyOrderNumber: '#DSD1', financialStatus: 'PAID',
      currency: 'USD', grossAmount: 50, expectedPayout: 48, totalFees: 2, refundedAmount: 0, placedAt: new Date('2026-10-01'),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM', designReady: false,
      lines: { create: [
        { shopifyLineId: 'd1', sku: 'A', productTitle: 'Socks', qty: 1, linePosition: 1, unitPrice: 20, customized: true, resolvedSupplierId: null },
        { shopifyLineId: 'd2', sku: 'B', productTitle: 'Mug', qty: 1, linePosition: 2, unitPrice: 20, customized: true },
        { shopifyLineId: 'd3', sku: null, productTitle: 'Tip', qty: 1, linePosition: 3, unitPrice: 5 },
      ] },
    },
    include: { lines: { orderBy: { linePosition: 'asc' } } },
  })
  ;[l1, l2, tip] = o.lines.map(l => l.id)
  await prisma.designArtwork.create({ data: { orderLineId: l1, printArea: 'Artwork', version: 1, fileName: 'a.png', storagePath: 'x/a.png', size: 1, mimeType: 'image/png' } })
  await prisma.designArtwork.create({ data: { orderLineId: l2, printArea: 'Artwork', version: 1, fileName: 'b.png', storagePath: 'x/b.png', size: 1, mimeType: 'image/png' } })
})
afterAll(async () => { await prisma.order.deleteMany({ where: { id: ORDER_ID } }) })

describe('updateLine', () => {
  it('saves a note without touching done state', async () => {
    const r = await updateLine(l1, { note: 'kéo tên vào 60px' })
    expect(r?.line.designNote).toBe('kéo tên vào 60px')
    expect(r?.order.designReady).toBe(false)
  })
  it('marks the first line done but the order stays pending', async () => {
    const r = await updateLine(l1, { done: true })
    expect(r?.line.designDriveLink).toMatch(/^\/api\/design-studio\/file\//)
    expect(r?.order.designReady).toBe(false)
    expect(r?.order.pipelineStatus).toBe('PENDING_DESIGN')
  })
  it('ignores the Tip line and flips the order when the last product line is done', async () => {
    const r = await updateLine(l2, { done: true })
    expect(r?.order.designReady).toBe(true)
    expect(r?.order.pipelineStatus).toBe('READY_TO_PRODUCTION')
    const tipLine = await prisma.orderLine.findUnique({ where: { id: tip } })
    expect(tipLine?.designDriveLink).toBeNull()
  })
  it('refuses done when the slot has no artwork', async () => {
    await prisma.designArtwork.deleteMany({ where: { orderLineId: l2 } })
    await prisma.orderLine.update({ where: { id: l2 }, data: { designDriveLink: null } })
    await expect(updateLine(l2, { done: true })).rejects.toThrow(/no artwork/i)
  })
  it('reopening clears the flags', async () => {
    const r = await updateLine(l1, { done: false })
    expect(r?.line.designDriveLink).toBeNull()
    expect(r?.order.designReady).toBe(false)
    expect(r?.order.pipelineStatus).toBe('PENDING_DESIGN')
  })
  it('returns null for an unknown line', async () => {
    expect(await updateLine('nope', { note: 'x' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/design-studio-done.integration.test.ts`
Expected: FAIL — `updateLine` is not exported.

- [ ] **Step 3: Implement `updateLine`**

Append to `src/lib/design-studio.ts`:

```ts
import { autoDetectStatus, type PipelineStatus } from '@/lib/pipeline-status'

export async function updateLine(lineId: string, patch: { note?: string | null; done?: boolean }) {
  const line = await prisma.orderLine.findUnique({
    where: { id: lineId },
    include: { artworks: { orderBy: { version: 'desc' } } },
  })
  if (!line) return null

  const data: { designNote?: string | null; designDriveLink?: string | null } = {}
  if (patch.note !== undefined) data.designNote = patch.note === null ? null : patch.note.trim() || null
  if (patch.done === true) {
    const attrs = parseAttributes(line.customAttributesJson)
    const slots = printAreasForLine(attrs)
    const missing = slots.filter(s => !line.artworks.some(a => a.printArea === s))
    if (missing.length > 0) throw new Error(`No artwork uploaded for: ${missing.join(', ')}`)
    const first = line.artworks.filter(a => a.printArea === slots[0]).sort((a, b) => b.version - a.version)[0]
    data.designDriveLink = artworkUrl(first.id)
  }
  if (patch.done === false) data.designDriveLink = null

  const updated = await prisma.orderLine.update({ where: { id: lineId }, data })
  const order = await recomputeOrderDesign(line.orderId)
  return {
    line: { id: updated.id, designDriveLink: updated.designDriveLink, designNote: updated.designNote },
    order,
  }
}

async function recomputeOrderDesign(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { lines: true } })
  if (!order) throw new Error('order vanished')
  const productLines = order.lines.filter(l => !isNonProductLine(l))
  const designLines = productLines.filter(l => l.customized || l.designDriveLink)
  const designReady = designLines.length > 0 && designLines.every(l => !!l.designDriveLink)
  const pipelineStatus = autoDetectStatus({
    financialStatus: order.financialStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    cancelled: order.pipelineStatus === 'CANCELLED',
    hasUnmappedSku: productLines.some(l => !l.resolvedSupplierId),
    hasPendingMapping: false,
    hasCustomDesignLine: designLines.length > 0,
    hasDesignLine: designLines.length > 0,
    hasDesignReady: designReady,
    currentStatus: order.pipelineStatus as PipelineStatus,
  })
  const saved = await prisma.order.update({
    where: { id: orderId },
    data: { designReady, pipelineStatus, designDriveLink: designReady ? (designLines[0]?.designDriveLink ?? null) : order.designDriveLink },
    select: { id: true, designReady: true, pipelineStatus: true },
  })
  return saved
}
```

Read `src/lib/pipeline-status.ts:83` for the exact `AutoDetectInput` field names and the `PipelineStatus` export before writing this; adjust names to match. The test expects `READY_TO_PRODUCTION` for a paid, mapped, design-ready order — if `hasUnmappedSku: true` (the fixture has no supplier) makes `autoDetectStatus` return `PENDING_MAPPING`, set `resolvedSupplierId` in the fixture to a created supplier instead of changing the logic.

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/design-studio-done.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the routes and the access rule**

`src/app/api/design-studio/orders/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { loadWorkspace } from '@/lib/design-studio'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const ws = await loadWorkspace(id)
  if (!ws) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  return NextResponse.json(ws)
}
```

`src/app/api/design-studio/lines/[lineId]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { updateLine } from '@/lib/design-studio'

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ lineId: string }> }) {
  const { lineId } = await ctx.params
  const body = await req.json().catch(() => ({} as any))
  const patch: { note?: string | null; done?: boolean } = {}
  if (body.note !== undefined) patch.note = body.note === null ? null : String(body.note)
  if (typeof body.done === 'boolean') patch.done = body.done
  if (patch.note === undefined && patch.done === undefined) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }
  try {
    const r = await updateLine(lineId, patch)
    if (!r) return NextResponse.json({ error: 'Line not found' }, { status: 404 })
    return NextResponse.json(r)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }
}
```

Check how other dynamic routes in this repo type `params` (e.g. `src/app/api/fulfillment/design-library/[id]/route.ts`) and copy that form — Next 15 uses a Promise.

In `src/lib/api-access.ts`, after the `/api/fulfillment/design-` rule add:

```ts
  { prefix: '/api/design-studio', access: ['fulfillment_design_library', 'fulfillment_orders'] },
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors in the new files.

- [ ] **Step 7: Commit**

```bash
git add src/lib/design-studio.ts src/app/api/design-studio src/lib/api-access.ts tests/design-studio-done.integration.test.ts
git commit -m "feat(design-studio): mark lines done, order and line routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Local artwork storage, upload and file routes

**Files:**
- Create: `src/lib/design-storage.ts`
- Create: `src/app/api/design-studio/lines/[lineId]/artwork/route.ts`
- Create: `src/app/api/design-studio/file/[artworkId]/route.ts`
- Test: `tests/design-storage.integration.test.ts`

**Interfaces:**
- Produces:

```ts
export const ALLOWED_MIME: Record<string, string>   // mime → extension
export function safeFileName(name: string): string
export function storageRoot(): string                // DESIGN_STORAGE_DIR ?? path.resolve(process.cwd(), 'storage')
export async function saveArtwork(input: { lineId: string; printArea: string; fileName: string; mimeType: string; bytes: Buffer; uploadedById: string | null }): Promise<ArtworkRow>
export async function readArtwork(id: string): Promise<{ absPath: string; fileName: string; mimeType: string } | null>
```
- `POST /api/design-studio/lines/[lineId]/artwork` multipart `printArea`, `file` → `{ artwork: ArtworkRow }`.
- `GET /api/design-studio/file/[artworkId]` → file bytes with `Content-Type` and `Content-Disposition: inline; filename="…"`.

- [ ] **Step 1: Write the failing test**

`tests/design-storage.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { prisma } from '@/lib/db'
import { safeFileName, saveArtwork, readArtwork, storageRoot } from '@/lib/design-storage'

const ORDER_ID = 'gid://test/Order/ds-store-1'
const SHOP = 'ds-store.myshopify.com'
let lineId = ''
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-storage-'))

beforeAll(async () => {
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.project.upsert({ where: { id: 'proj_ds_store' }, create: { id: 'proj_ds_store', name: 'DS store', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_ds_store' }, update: {} })).id
  const o = await prisma.order.create({
    data: {
      id: ORDER_ID, projectId: 'proj_ds_store', storeId, shopifyOrderNumber: '#DSS1', financialStatus: 'PAID',
      currency: 'USD', grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
      lines: { create: [{ shopifyLineId: 's1', sku: 'S', productTitle: 'Socks', qty: 1, linePosition: 1, unitPrice: 1 }] },
    },
    include: { lines: true },
  })
  lineId = o.lines[0].id
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
})

describe('safeFileName', () => {
  it('strips path parts and odd characters', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('Tên áo (final) v2.PNG')).toBe('Ten_ao_final_v2.PNG')
    expect(safeFileName('')).toBe('file')
  })
})

describe('saveArtwork / readArtwork', () => {
  it('writes v1 then v2 into the storage root and records both', async () => {
    const a1 = await saveArtwork({ lineId, printArea: 'Front', fileName: 'front.png', mimeType: 'image/png', bytes: Buffer.from('one'), uploadedById: null })
    const a2 = await saveArtwork({ lineId, printArea: 'Front', fileName: 'front.png', mimeType: 'image/png', bytes: Buffer.from('two'), uploadedById: 'u1' })
    expect(a1.version).toBe(1)
    expect(a2.version).toBe(2)
    const r2 = await readArtwork(a2.id)
    expect(r2?.absPath.startsWith(storageRoot())).toBe(true)
    expect(fs.readFileSync(r2!.absPath, 'utf8')).toBe('two')
    expect(r2?.mimeType).toBe('image/png')
  })
  it('rejects a disallowed type', async () => {
    await expect(saveArtwork({ lineId, printArea: 'Front', fileName: 'x.exe', mimeType: 'application/x-msdownload', bytes: Buffer.from('x'), uploadedById: null }))
      .rejects.toThrow(/not allowed/i)
  })
  it('returns null for an unknown id', async () => {
    expect(await readArtwork('nope')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/design-storage.integration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement storage**

`src/lib/design-storage.ts`:

```ts
import fs from 'fs/promises'
import path from 'path'
import { prisma } from '@/lib/db'
import { artworkUrl, type ArtworkRow } from '@/lib/design-studio'

export const ALLOWED_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
  'image/vnd.adobe.photoshop': 'psd',
  'application/x-photoshop': 'psd',
  'application/octet-stream': 'bin',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
}
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'pdf', 'psd', 'zip'])

export function storageRoot(): string {
  return process.env.DESIGN_STORAGE_DIR || path.resolve(process.cwd(), 'storage')
}

export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const ascii = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
  const cleaned = ascii.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+\./g, '.')
  return cleaned || 'file'
}

function extOf(fileName: string, mimeType: string): string {
  const fromName = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
  if (ALLOWED_EXT.has(fromName)) return fromName
  return ALLOWED_MIME[mimeType] ?? ''
}

export async function saveArtwork(input: {
  lineId: string; printArea: string; fileName: string; mimeType: string; bytes: Buffer; uploadedById: string | null
}): Promise<ArtworkRow> {
  const ext = extOf(input.fileName, input.mimeType)
  if (!ext || !ALLOWED_EXT.has(ext)) throw new Error(`File type not allowed: ${input.fileName} (${input.mimeType})`)
  const line = await prisma.orderLine.findUnique({
    where: { id: input.lineId },
    select: { id: true, linePosition: true, order: { select: { shopifyOrderNumber: true } } },
  })
  if (!line) throw new Error('Line not found')

  const printArea = input.printArea.trim() || 'Artwork'
  const last = await prisma.designArtwork.findFirst({
    where: { orderLineId: line.id, printArea }, orderBy: { version: 'desc' }, select: { version: true },
  })
  const version = (last?.version ?? 0) + 1
  const fileName = safeFileName(input.fileName)
  const rel = path.join(
    'design',
    line.order.shopifyOrderNumber.replace(/^#/, ''),
    String(line.linePosition),
    safeFileName(printArea),
    `v${version}-${fileName}`,
  )
  const abs = path.join(storageRoot(), rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, input.bytes)

  const row = await prisma.designArtwork.create({
    data: {
      orderLineId: line.id, printArea, version, fileName, storagePath: rel.split(path.sep).join('/'),
      size: input.bytes.length, mimeType: input.mimeType, uploadedById: input.uploadedById,
    },
  })
  return {
    id: row.id, printArea: row.printArea, version: row.version, fileName: row.fileName, size: row.size,
    mimeType: row.mimeType, uploadedById: row.uploadedById, createdAt: row.createdAt.toISOString(), url: artworkUrl(row.id),
  }
}

export async function readArtwork(id: string) {
  const row = await prisma.designArtwork.findUnique({ where: { id } })
  if (!row) return null
  const root = storageRoot()
  const absPath = path.resolve(root, row.storagePath)
  if (!absPath.startsWith(path.resolve(root) + path.sep)) return null
  return { absPath, fileName: row.fileName, mimeType: row.mimeType }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/design-storage.integration.test.ts`
Expected: PASS. If `'Tên áo (final) v2.PNG'` does not map exactly to `Ten_ao_final_v2.PNG`, adjust the expectation to the real output as long as it contains no spaces, slashes or parentheses — the invariant is safety, not the exact spelling.

- [ ] **Step 5: Upload and file routes**

`src/app/api/design-studio/lines/[lineId]/artwork/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/api-auth'
import { saveArtwork } from '@/lib/design-storage'

const MAX_BYTES = 200 * 1024 * 1024

export async function POST(req: NextRequest, ctx: { params: Promise<{ lineId: string }> }) {
  const { lineId } = await ctx.params
  const user = await getAuthUser(req)
  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  const printArea = String(form?.get('printArea') ?? '')
  if (!(file instanceof File)) return NextResponse.json({ error: 'file is required' }, { status: 400 })
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'File lớn hơn 200 MB' }, { status: 400 })
  try {
    const artwork = await saveArtwork({
      lineId, printArea, fileName: file.name, mimeType: file.type || 'application/octet-stream',
      bytes: Buffer.from(await file.arrayBuffer()), uploadedById: user?.id ?? null,
    })
    return NextResponse.json({ artwork })
  } catch (e: any) {
    const status = /not found/i.test(e.message) ? 404 : 400
    return NextResponse.json({ error: e.message }, { status })
  }
}
```

`src/app/api/design-studio/file/[artworkId]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs/promises'
import { readArtwork } from '@/lib/design-storage'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ artworkId: string }> }) {
  const { artworkId } = await ctx.params
  const art = await readArtwork(artworkId)
  if (!art) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  let bytes: Buffer
  try { bytes = await fs.readFile(art.absPath) } catch { return NextResponse.json({ error: 'File missing on disk' }, { status: 404 }) }
  return new NextResponse(bytes, {
    headers: {
      'Content-Type': art.mimeType,
      'Content-Length': String(bytes.length),
      'Content-Disposition': `inline; filename="${art.fileName}"`,
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
```

- [ ] **Step 6: Type-check and run the whole suite**

Run: `npx tsc --noEmit -p . && npx vitest run`
Expected: PASS everywhere.

- [ ] **Step 7: Commit**

```bash
git add src/lib/design-storage.ts src/app/api/design-studio tests/design-storage.integration.test.ts
git commit -m "feat(design-studio): local artwork storage with upload and file routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Refresh line properties from Shopify

**Files:**
- Create: `src/app/api/design-studio/orders/[id]/refresh/route.ts`
- Modify: `src/lib/design-studio.ts`
- Test: `tests/design-studio-refresh.integration.test.ts`

**Interfaces:**
- Consumes: `getShopifyConnection()` from `@/lib/token-store`; `fetchOrderLinePropsByNames(shop, token, names)` from `@/lib/shopify-orders` returning `Map<orderName, ShopifyOrderLineProps[]>` where each prop has `{ sku, title, variantTitle, quantity, productType, customAttributes, productUrl, variantId }`.
- Produces: `export async function applyLineProps(orderId: string, props: ShopifyOrderLineProps[]): Promise<{ updated: number; unmatched: number }>` — matches props to `OrderLine`s by position (both are in Shopify line order), falling back to `sku + title` when counts differ, and writes `customAttributesJson` (with `_product_url` appended when `productUrl` is present).
- `POST /api/design-studio/orders/[id]/refresh` → `{ updated, unmatched }`.

- [ ] **Step 1: Write the failing test**

`tests/design-studio-refresh.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { applyLineProps } from '@/lib/design-studio'

const ORDER_ID = 'gid://test/Order/ds-ref-1'
const SHOP = 'ds-ref.myshopify.com'

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_ds_ref' }, create: { id: 'proj_ds_ref', name: 'DS ref', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_ds_ref' }, update: {} })).id
  await prisma.order.create({
    data: {
      id: ORDER_ID, projectId: 'proj_ds_ref', storeId, shopifyOrderNumber: '#DSR1', financialStatus: 'PAID',
      currency: 'USD', grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
      lines: { create: [
        { shopifyLineId: 'r1', sku: 'A', productTitle: 'Socks', qty: 1, linePosition: 1, unitPrice: 1 },
        { shopifyLineId: 'r2', sku: 'B', productTitle: 'Mug', qty: 1, linePosition: 2, unitPrice: 1 },
      ] },
    },
  })
})
afterAll(async () => { await prisma.order.deleteMany({ where: { id: ORDER_ID } }) })

describe('applyLineProps', () => {
  it('writes attributes by position and appends _product_url', async () => {
    const r = await applyLineProps(ORDER_ID, [
      { sku: 'A', title: 'Socks', variantTitle: null, quantity: 1, productType: null, customAttributes: [{ key: 'Custom Name', value: 'Ashley' }], productUrl: 'https://shop.example/products/socks', variantId: null },
      { sku: 'B', title: 'Mug', variantTitle: null, quantity: 1, productType: null, customAttributes: [], productUrl: null, variantId: null },
    ])
    expect(r).toEqual({ updated: 2, unmatched: 0 })
    const lines = await prisma.orderLine.findMany({ where: { orderId: ORDER_ID }, orderBy: { linePosition: 'asc' } })
    expect(JSON.parse(lines[0].customAttributesJson!)).toEqual([
      { key: 'Custom Name', value: 'Ashley' }, { key: '_product_url', value: 'https://shop.example/products/socks' },
    ])
    expect(lines[1].customAttributesJson).toBe('[]')
  })
  it('falls back to sku+title when counts differ', async () => {
    const r = await applyLineProps(ORDER_ID, [
      { sku: 'B', title: 'Mug', variantTitle: null, quantity: 1, productType: null, customAttributes: [{ key: 'Text', value: 'Hi' }], productUrl: null, variantId: null },
    ])
    expect(r).toEqual({ updated: 1, unmatched: 0 })
    const b = await prisma.orderLine.findFirst({ where: { orderId: ORDER_ID, sku: 'B' } })
    expect(JSON.parse(b!.customAttributesJson!)).toEqual([{ key: 'Text', value: 'Hi' }])
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/design-studio-refresh.integration.test.ts`
Expected: FAIL — `applyLineProps` not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/design-studio.ts`:

```ts
import type { ShopifyOrderLineProps } from '@/lib/shopify-orders'

export async function applyLineProps(orderId: string, props: ShopifyOrderLineProps[]) {
  const lines = await prisma.orderLine.findMany({ where: { orderId }, orderBy: { linePosition: 'asc' }, select: { id: true, sku: true, productTitle: true } })
  const byPosition = lines.length === props.length
  let updated = 0, unmatched = 0
  const used = new Set<string>()
  for (let i = 0; i < props.length; i++) {
    const p = props[i]
    const line = byPosition
      ? lines[i]
      : lines.find(l => !used.has(l.id) && (l.sku ?? '') === (p.sku ?? '') && l.productTitle === p.title)
    if (!line) { unmatched++; continue }
    used.add(line.id)
    const attrs = p.productUrl ? [...p.customAttributes, { key: '_product_url', value: p.productUrl }] : p.customAttributes
    await prisma.orderLine.update({ where: { id: line.id }, data: { customAttributesJson: JSON.stringify(attrs) } })
    updated++
  }
  return { updated, unmatched }
}
```

Check `ShopifyOrderLineProps` is exported from `src/lib/shopify-orders.ts` (the backfill route imports it as a type, so it is).

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/design-studio-refresh.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: The route**

`src/app/api/design-studio/orders/[id]/refresh/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getShopifyConnection } from '@/lib/token-store'
import { fetchOrderLinePropsByNames } from '@/lib/shopify-orders'
import { applyLineProps } from '@/lib/design-studio'

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const order = await prisma.order.findUnique({ where: { id }, select: { shopifyOrderNumber: true, store: { select: { shop: true } } } })
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  const conn = await getShopifyConnection()
  if (!conn) return NextResponse.json({ error: 'Chưa kết nối Shopify. Vào /setup để connect trước.' }, { status: 401 })
  if (conn.shop !== order.store.shop) {
    return NextResponse.json({ error: `Token Shopify đang nối ${conn.shop}, đơn này thuộc ${order.store.shop}` }, { status: 400 })
  }
  let props
  try {
    props = (await fetchOrderLinePropsByNames(conn.shop, conn.token, [order.shopifyOrderNumber])).get(order.shopifyOrderNumber)
  } catch (e: any) {
    return NextResponse.json({ error: `Shopify: ${e.message}` }, { status: 502 })
  }
  if (!props) return NextResponse.json({ error: 'Shopify không trả về đơn này (quá 60 ngày hoặc sai store)' }, { status: 404 })
  const r = await applyLineProps(id, props)
  return NextResponse.json(r)
}
```

- [ ] **Step 6: Type-check and commit**

Run: `npx tsc --noEmit -p .`
Expected: clean.

```bash
git add src/lib/design-studio.ts src/app/api/design-studio/orders tests/design-studio-refresh.integration.test.ts
git commit -m "feat(design-studio): refresh line properties from Shopify

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Orders list page and sidebar entry

**Files:**
- Create: `src/app/design-studio/page.tsx`
- Modify: `src/components/Sidebar.tsx` (nav array ~line 13-51)

**Interfaces:**
- Consumes: `GET /api/fulfillment/orders?pipelineStatus=…&projectId=…&supplierId=…&search=…&page=1&pageSize=100` → `{ orders: EnrichedOrder[], total, totalPages }` where each order has `id, shopifyOrderNumber, placedAt, pipelineStatus, orderType, designReady, updatedAt, lines[{ id, sku, productTitle, previewCdnUrl, resolvedSupplierId, designStatus, customized }]`, `store?`/`projectId`. `GET /api/suppliers` → `{ suppliers: [{id,name,code}] }`. `GET /api/projects` → check the response shape in `src/app/orders/page.tsx` (it loads a project selector) and reuse it. `STATUS_COLORS`/`STATUS_LABELS` from `@/lib/pipeline-status`.

- [ ] **Step 1: Sidebar entry**

In `src/components/Sidebar.tsx` nav array, before the Design Library child add:

```ts
  { type: 'child', href: '/design-studio', icon: 'brush', label: 'Design Studio' },
```

- [ ] **Step 2: The page**

`src/app/design-studio/page.tsx`:

```tsx
'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'
import { STATUS_COLORS, STATUS_LABELS, type PipelineStatus } from '@/lib/pipeline-status'

type Line = { id: string; sku: string | null; productTitle: string; previewCdnUrl: string | null; resolvedSupplierId: string | null; designStatus: string; customized: boolean }
type OrderRow = {
  id: string; shopifyOrderNumber: string; placedAt: string; updatedAt: string; pipelineStatus: PipelineStatus
  orderType: string; designReady: boolean; projectId: string; lines: Line[]
}
type Supplier = { id: string; name: string; code: string }
type Tab = 'TODO' | 'DONE'

const TYPE_LABEL: Record<string, string> = { CUSTOM: 'Custom', NON_CUSTOM: 'Non-custom', DUAL: 'Dual', MIXED: 'Mixed', UNKNOWN: '—' }

function hoursSince(iso: string) { return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 36e5)) }

export default function DesignStudioPage() {
  const [tab, setTab] = useState<Tab>('TODO')
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [type, setType] = useState('ALL')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    fetch('/api/suppliers').then(r => r.json()).then(d => setSuppliers(d.suppliers ?? [])).catch(() => setSuppliers([]))
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const statuses: PipelineStatus[] = tab === 'TODO' ? ['PENDING_DESIGN', 'DESIGN_REJECTED'] : ['READY_TO_PRODUCTION', 'EXPORTED', 'FULFILLED']
      const pages = await Promise.all(statuses.map(async s => {
        const qs = new URLSearchParams({ pipelineStatus: s, page: '1', pageSize: '200' })
        if (supplierId) qs.set('supplierId', supplierId)
        if (search.trim()) qs.set('search', search.trim())
        if (tab === 'DONE') qs.set('dateFrom', new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10))
        const res = await fetch(`/api/fulfillment/orders?${qs}`)
        if (!res.ok) throw new Error(`${s}: HTTP ${res.status}`)
        return (await res.json()).orders as OrderRow[]
      }))
      let list = pages.flat()
      if (tab === 'DONE') list = list.filter(o => o.designReady && o.lines.some(l => l.customized))
      if (type !== 'ALL') list = list.filter(o => o.orderType === type)
      list.sort((a, b) => new Date(a.placedAt).getTime() - new Date(b.placedAt).getTime())
      setOrders(list)
    } catch (e: any) { setErr(e.message) } finally { setLoading(false) }
  }, [tab, supplierId, type, search])
  useEffect(() => { load() }, [load])

  const supplierName = useMemo(() => new Map(suppliers.map(s => [s.id, s.code || s.name])), [suppliers])

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <div className="flex items-end gap-md mb-lg">
          <div>
            <h1 className="text-headline-lg text-on-surface">Design Studio</h1>
            <p className="text-body-sm text-on-surface-variant">Mỗi đơn là một workspace: thông tin custom, supplier, template, artwork.</p>
          </div>
          <div className="ml-auto flex gap-xs bg-surface-container rounded-lg p-xs">
            {(['TODO', 'DONE'] as Tab[]).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-md py-xs rounded-md text-label-sm ${tab === t ? 'bg-surface-container-lowest shadow-card text-on-surface' : 'text-on-surface-variant'}`}>
                {t === 'TODO' ? 'Cần design' : 'Đã xong 7 ngày'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-sm mb-md">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Tìm số đơn / SKU"
            className="px-md py-sm rounded-lg border border-outline-variant/40 bg-surface-container-lowest text-body-sm" />
          <select value={supplierId} onChange={e => setSupplierId(e.target.value)} className="px-md py-sm rounded-lg border border-outline-variant/40 bg-surface-container-lowest text-body-sm">
            <option value="">Mọi supplier</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={type} onChange={e => setType(e.target.value)} className="px-md py-sm rounded-lg border border-outline-variant/40 bg-surface-container-lowest text-body-sm">
            <option value="ALL">Mọi loại</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <span className="self-center text-body-sm text-on-surface-variant">{loading ? 'Đang tải…' : `${orders.length} đơn`}</span>
        </div>
        {err && <div className="mb-md px-md py-sm rounded-lg bg-error-container text-on-error-container text-body-sm">{err}</div>}

        <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
          <table className="w-full text-body-sm">
            <thead className="bg-surface-container-low text-label-sm text-on-surface-variant">
              <tr>
                <th className="text-left px-lg py-sm">Đơn</th>
                <th className="text-left px-md py-sm">Ngày</th>
                <th className="text-left px-md py-sm">Loại</th>
                <th className="text-left px-md py-sm">Dòng</th>
                <th className="text-left px-md py-sm">Supplier</th>
                <th className="text-left px-md py-sm">Preview</th>
                <th className="text-right px-md py-sm">Chờ</th>
                <th className="text-left px-md py-sm">Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(o => {
                const sups = Array.from(new Set(o.lines.map(l => l.resolvedSupplierId).filter(Boolean) as string[])).map(id => supplierName.get(id) ?? '?')
                const preview = o.lines.find(l => l.previewCdnUrl)?.previewCdnUrl
                const h = hoursSince(o.placedAt)
                return (
                  <tr key={o.id} className="border-t border-outline-variant/20 hover:bg-surface-container-low">
                    <td className="px-lg py-sm">
                      <Link href={`/design-studio/${encodeURIComponent(o.id)}`} className="text-secondary font-semibold hover:underline">{o.shopifyOrderNumber}</Link>
                    </td>
                    <td className="px-md py-sm">{new Date(o.placedAt).toLocaleDateString('en-US')}</td>
                    <td className="px-md py-sm">{TYPE_LABEL[o.orderType] ?? o.orderType}</td>
                    <td className="px-md py-sm">{o.lines.filter(l => l.sku).length}</td>
                    <td className="px-md py-sm">{sups.join(', ') || <span className="text-on-surface-variant">chưa map</span>}</td>
                    <td className="px-md py-sm">{preview ? <img src={preview} alt="" className="w-10 h-10 rounded-md object-cover border border-outline-variant/30" /> : '—'}</td>
                    <td className={`px-md py-sm text-right ${h > 24 ? 'text-error font-semibold' : ''}`}>{h}h</td>
                    <td className="px-md py-sm"><span className={`px-sm py-xs rounded-md text-label-sm ${STATUS_COLORS[o.pipelineStatus]}`}>{STATUS_LABELS[o.pipelineStatus]}</span></td>
                  </tr>
                )
              })}
              {!loading && orders.length === 0 && (
                <tr><td colSpan={8} className="px-lg py-xl text-center text-on-surface-variant">Không có đơn nào.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
```

Before writing, open `src/app/api/fulfillment/orders/route.ts` and confirm `pipelineStatus` accepts one value and `dateFrom` is `YYYY-MM-DD`; if the response omits `updatedAt`, drop it from the type.

- [ ] **Step 3: Type-check, then run the dev server and open the page**

Run: `npx tsc --noEmit -p .` — clean.
Start the dev server with the project's preview tool (`.claude/launch.json` entry on port 3002; create one with `npm run dev -- --port 3002` if missing) and open `http://localhost:3002/design-studio`. Expected: the table lists PENDING_DESIGN orders from `dev.db` (dev.db may be weeks stale — the memory note says so; an empty list with no error is acceptable, a red error is not).

- [ ] **Step 4: Commit**

```bash
git add src/app/design-studio/page.tsx src/components/Sidebar.tsx
git commit -m "feat(design-studio): orders list page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Order workspace page

**Files:**
- Create: `src/app/design-studio/[orderId]/page.tsx`
- Create: `src/app/design-studio/[orderId]/LineBlock.tsx`

**Interfaces:**
- Consumes: `GET /api/design-studio/orders/[id]` → `Workspace` (Task 2 type, copy the type into the page); `PATCH /api/design-studio/lines/[lineId]` `{note?, done?}`; `POST /api/design-studio/lines/[lineId]/artwork` multipart; `POST /api/design-studio/orders/[id]/refresh`.

- [ ] **Step 1: The line block component**

`src/app/design-studio/[orderId]/LineBlock.tsx`:

```tsx
'use client'
import { useRef, useState } from 'react'

export type ArtworkRow = { id: string; printArea: string; version: number; fileName: string; size: number; mimeType: string; uploadedById: string | null; createdAt: string; url: string }
export type WorkspaceLine = {
  id: string; linePosition: number; sku: string | null; productTitle: string; variantTitle: string | null; qty: number
  isNonProduct: boolean; customized: boolean; variantOptions: Record<string, string>; attributesLoaded: boolean
  personalization: { key: string; value: string }[]; customerDesignLink: string | null; customizedUrl: string | null
  previewUrl: string | null; sourcePrintFiles: { printArea: string; url: string }[]
  supplier: { id: string; name: string; code: string } | null; supplierSku: string | null; templateUrl: string | null
  masterArtworkUrl: string | null; libraryDesignLink: string | null; designStatus: string
  designDriveLink: string | null; designNote: string | null; printAreas: string[]; artworks: ArtworkRow[]
}

const card = 'bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20'
const head = 'flex items-center gap-sm px-lg py-md border-b border-outline-variant/20 text-label-md text-on-surface-variant'

function fmtSize(n: number) { return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB` }
function hasNonAscii(s: string) { return /[^\x00-\x7F]/.test(s) }

export default function LineBlock({ line, onChanged }: { line: WorkspaceLine; onChanged: () => void }) {
  const [note, setNote] = useState(line.designNote ?? '')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({})
  const done = !!line.designDriveLink
  const slotsFilled = line.printAreas.every(a => line.artworks.some(x => x.printArea === a))

  async function patch(body: { note?: string | null; done?: boolean }) {
    setBusy('patch'); setMsg('')
    const res = await fetch(`/api/design-studio/lines/${line.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const d = await res.json().catch(() => ({}))
    setBusy('')
    if (!res.ok) { setMsg(d.error ?? 'Lỗi'); return }
    onChanged()
  }

  async function upload(printArea: string, file: File) {
    setBusy(printArea); setMsg('')
    const fd = new FormData(); fd.set('printArea', printArea); fd.set('file', file)
    const res = await fetch(`/api/design-studio/lines/${line.id}/artwork`, { method: 'POST', body: fd })
    const d = await res.json().catch(() => ({}))
    setBusy('')
    if (!res.ok) { setMsg(d.error ?? 'Upload lỗi'); return }
    onChanged()
  }

  async function copy(v: string) { try { await navigator.clipboard.writeText(v); setMsg(`Đã chép “${v}”`) } catch { setMsg('Không chép được') } }

  if (line.isNonProduct) {
    return <div className={`${card} px-lg py-md text-body-sm text-on-surface-variant`}>Dòng {line.linePosition}: {line.productTitle} — không cần design</div>
  }

  return (
    <div className={`${card} ${done ? 'border-tertiary/40' : ''}`}>
      <div className={head}>
        <span className="material-symbols-outlined">{done ? 'task_alt' : 'brush'}</span>
        <span>Dòng {line.linePosition}</span>
        <span className="text-on-surface font-semibold truncate">{line.productTitle}</span>
        {line.variantTitle && <span className="text-on-surface-variant">· {line.variantTitle}</span>}
        <span className="ml-auto">SKU <b className="text-on-surface">{line.sku ?? '—'}</b> · x{line.qty}</span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-lg p-lg">
        <section className="flex flex-col gap-md">
          <h3 className="text-label-md text-on-surface-variant">Thông tin custom</h3>
          {!line.attributesLoaded && (
            <div className="px-md py-sm rounded-lg bg-surface-container text-body-sm text-on-surface-variant">Chưa có dữ liệu custom cho dòng này — bấm “Nạp lại từ Shopify” ở đầu trang.</div>
          )}
          {line.personalization.length === 0 && line.attributesLoaded && (
            <div className="text-body-sm text-on-surface-variant">Khách không nhập gì.{Object.keys(line.variantOptions).length > 0 && ' Biến thể: ' + Object.entries(line.variantOptions).map(([k, v]) => `${k}: ${v}`).join(', ')}</div>
          )}
          {line.personalization.length > 0 && (
            <table className="w-full text-body-sm">
              <tbody>
                {line.personalization.map(a => (
                  <tr key={a.key} className="border-b border-dashed border-outline-variant/30">
                    <td className="py-xs pr-md text-on-surface-variant w-2/5 align-top">{a.key}</td>
                    <td className="py-xs">
                      <code className="px-sm py-xs rounded-md bg-surface-container border border-outline-variant/30">{a.value}</code>
                      <button onClick={() => copy(a.value)} className="ml-xs text-on-surface-variant hover:text-secondary align-middle" title="Chép"><span className="material-symbols-outlined text-[16px]">content_copy</span></button>
                      {hasNonAscii(a.value) && <span className="ml-xs px-sm rounded-md bg-error-container text-on-error-container text-label-sm">ký tự đặc biệt</span>}
                      {a.value.length > 14 && <span className="ml-xs px-sm rounded-md bg-amber-100 text-amber-900 text-label-sm">{a.value.length} ký tự</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="flex flex-wrap gap-sm text-body-sm">
            {line.customerDesignLink && <a className="text-secondary hover:underline" href={line.customerDesignLink} target="_blank" rel="noreferrer">Mở lại thiết kế của khách ↗</a>}
            {line.customizedUrl && <a className="text-secondary hover:underline" href={line.customizedUrl} target="_blank" rel="noreferrer">Customized URL ↗</a>}
          </div>

          <h3 className="text-label-md text-on-surface-variant mt-sm">Supplier & template</h3>
          <dl className="grid grid-cols-[140px_1fr] gap-y-xs text-body-sm">
            <dt className="text-on-surface-variant">Supplier</dt><dd>{line.supplier ? `${line.supplier.name} (${line.supplier.code})` : <span className="text-error">chưa map</span>}</dd>
            <dt className="text-on-surface-variant">SKU xưởng</dt><dd>{line.supplierSku ?? '—'}</dd>
            <dt className="text-on-surface-variant">Template</dt><dd>{line.templateUrl ? <a className="text-secondary hover:underline" href={line.templateUrl} target="_blank" rel="noreferrer">Mở template ↗</a> : <span className="text-amber-900">chưa có template cho SKU này</span>}</dd>
            <dt className="text-on-surface-variant">Master artwork</dt><dd>{line.masterArtworkUrl ? <a className="text-secondary hover:underline" href={line.masterArtworkUrl} target="_blank" rel="noreferrer">Mở master ↗</a> : '—'}</dd>
            <dt className="text-on-surface-variant">Design Library</dt><dd>{line.libraryDesignLink ? <a className="text-secondary hover:underline" href={line.libraryDesignLink} target="_blank" rel="noreferrer">Có design sẵn ↗</a> : line.designStatus}</dd>
          </dl>
        </section>

        <section className="flex flex-col gap-md">
          <h3 className="text-label-md text-on-surface-variant">Mockup / preview</h3>
          {line.previewUrl
            ? <a href={line.previewUrl} target="_blank" rel="noreferrer"><img src={line.previewUrl} alt="Preview" className="max-h-64 rounded-lg border border-outline-variant/30 object-contain bg-surface-container" /></a>
            : <div className="text-body-sm text-on-surface-variant">Không có preview.</div>}
          {line.sourcePrintFiles.length > 0 && (
            <div className="flex flex-wrap gap-sm">
              {line.sourcePrintFiles.map(f => (
                <a key={f.url} href={f.url} target="_blank" rel="noreferrer" className="px-md py-xs rounded-lg border border-outline-variant/40 text-body-sm hover:bg-surface-container">File in từ app · {f.printArea} ↗</a>
              ))}
            </div>
          )}

          <h3 className="text-label-md text-on-surface-variant mt-sm">Artwork theo template</h3>
          {line.printAreas.map(area => {
            const versions = line.artworks.filter(a => a.printArea === area)
            return (
              <div key={area} className="rounded-lg border border-outline-variant/30 p-md flex flex-col gap-sm">
                <div className="flex items-center gap-sm">
                  <span className="font-semibold text-body-sm">{area}</span>
                  <span className="text-label-sm text-on-surface-variant">{versions.length ? `${versions.length} phiên bản` : 'chưa có file'}</span>
                  <input ref={el => { fileInputs.current[area] = el }} type="file" accept=".png,.jpg,.jpeg,.pdf,.psd,.zip" hidden
                    onChange={e => { const f = e.target.files?.[0]; if (f) upload(area, f); e.target.value = '' }} />
                  <button disabled={busy === area} onClick={() => fileInputs.current[area]?.click()}
                    className="ml-auto bg-secondary text-on-secondary px-md py-xs rounded-lg text-label-sm disabled:opacity-50">
                    {busy === area ? 'Đang tải…' : 'Upload'}
                  </button>
                </div>
                <div onDragOver={e => { e.preventDefault() }} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) upload(area, f) }}
                  className="rounded-md border border-dashed border-outline-variant/50 px-md py-sm text-label-sm text-on-surface-variant text-center">
                  Kéo thả file vào đây (png, jpg, pdf, psd, zip)
                </div>
                {versions.map(v => (
                  <div key={v.id} className="flex items-center gap-sm text-body-sm">
                    <span className="material-symbols-outlined text-on-surface-variant">{v.mimeType.startsWith('image/') ? 'image' : 'description'}</span>
                    <a href={v.url} target="_blank" rel="noreferrer" className="text-secondary hover:underline truncate">v{v.version} · {v.fileName}</a>
                    <span className="ml-auto text-on-surface-variant whitespace-nowrap">{fmtSize(v.size)} · {new Date(v.createdAt).toLocaleString('en-US')}</span>
                  </div>
                ))}
              </div>
            )
          })}

          <h3 className="text-label-md text-on-surface-variant mt-sm">Ghi chú</h3>
          <textarea value={note} onChange={e => setNote(e.target.value)} onBlur={() => note !== (line.designNote ?? '') && patch({ note })}
            rows={2} placeholder="Ghi chú cho người duyệt hoặc CS…" className="w-full px-md py-sm rounded-lg border border-outline-variant/40 bg-surface-container-lowest text-body-sm" />

          <div className="flex items-center gap-sm mt-xs">
            {msg && <span className="text-body-sm text-on-surface-variant">{msg}</span>}
            <div className="ml-auto flex gap-sm">
              {done
                ? <button disabled={busy === 'patch'} onClick={() => patch({ done: false })} className="px-md py-sm rounded-lg border border-outline-variant/40 text-label-md">Mở lại</button>
                : <button disabled={busy === 'patch' || !slotsFilled} title={slotsFilled ? '' : 'Upload đủ mọi vùng in trước'} onClick={() => patch({ done: true })}
                    className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-40">Đánh dấu xong</button>}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: The page**

`src/app/design-studio/[orderId]/page.tsx`:

```tsx
'use client'
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'
import { STATUS_COLORS, STATUS_LABELS, type PipelineStatus } from '@/lib/pipeline-status'
import LineBlock, { type WorkspaceLine } from './LineBlock'

type Workspace = {
  order: { id: string; shopifyOrderNumber: string; placedAt: string; pipelineStatus: PipelineStatus; orderType: string; designReady: boolean; trelloCardUrl: string | null; store: { shop: string; projectId: string; projectName: string } }
  lines: WorkspaceLine[]
}

export default function DesignWorkspacePage() {
  const params = useParams<{ orderId: string }>()
  const orderId = decodeURIComponent(params.orderId)
  const [ws, setWs] = useState<Workspace | null>(null)
  const [err, setErr] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    const res = await fetch(`/api/design-studio/orders/${encodeURIComponent(orderId)}`)
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`); return }
    setWs(await res.json())
  }, [orderId])
  useEffect(() => { load() }, [load])

  async function refresh() {
    setRefreshing(true); setMsg('')
    const res = await fetch(`/api/design-studio/orders/${encodeURIComponent(orderId)}/refresh`, { method: 'POST' })
    const d = await res.json().catch(() => ({}))
    setRefreshing(false)
    setMsg(res.ok ? `Đã nạp ${d.updated} dòng từ Shopify` : (d.error ?? 'Lỗi'))
    if (res.ok) load()
  }

  const productLines = ws?.lines.filter(l => !l.isNonProduct) ?? []
  const doneCount = productLines.filter(l => l.designDriveLink).length

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <Link href="/design-studio" className="text-body-sm text-secondary hover:underline">← Design Studio</Link>
        {err && <div className="mt-md px-md py-sm rounded-lg bg-error-container text-on-error-container text-body-sm">{err}</div>}
        {ws && (
          <>
            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 px-lg py-md mt-md mb-lg flex flex-wrap items-center gap-md">
              <h1 className="text-headline-lg text-on-surface">{ws.order.shopifyOrderNumber}</h1>
              <span className={`px-sm py-xs rounded-md text-label-sm ${STATUS_COLORS[ws.order.pipelineStatus]}`}>{STATUS_LABELS[ws.order.pipelineStatus]}</span>
              <span className="text-body-sm text-on-surface-variant">{ws.order.store.projectName} · {new Date(ws.order.placedAt).toLocaleDateString('en-US')} · {ws.order.orderType}</span>
              <span className="text-body-sm">{doneCount}/{productLines.length} dòng xong{ws.order.designReady && ' · đơn đã đủ design'}</span>
              <div className="ml-auto flex gap-sm items-center">
                {msg && <span className="text-body-sm text-on-surface-variant">{msg}</span>}
                <a className="px-md py-sm rounded-lg border border-outline-variant/40 text-label-md" href={`https://${ws.order.store.shop}/admin/orders?query=${encodeURIComponent(ws.order.shopifyOrderNumber)}`} target="_blank" rel="noreferrer">Shopify ↗</a>
                {ws.order.trelloCardUrl && <a className="px-md py-sm rounded-lg border border-outline-variant/40 text-label-md" href={ws.order.trelloCardUrl} target="_blank" rel="noreferrer">Trello ↗</a>}
                <button onClick={refresh} disabled={refreshing} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">{refreshing ? 'Đang nạp…' : 'Nạp lại từ Shopify'}</button>
              </div>
            </div>
            <div className="flex flex-col gap-lg">
              {ws.lines.map(l => <LineBlock key={l.id} line={l} onChanged={load} />)}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
```

- [ ] **Step 3: Type-check and verify in the browser**

Run: `npx tsc --noEmit -p .` — clean.
With the dev server running, open `/design-studio`, click an order, then: upload a PNG into a slot (expect a `v1` row and a file under `storage/design/<order>/…`), click "Đánh dấu xong" (expect the header count to rise, and when all product lines are done the status badge to change), click "Mở lại" (expect it to revert). Read the browser console for errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/design-studio
git commit -m "feat(design-studio): order workspace page with per-area artwork upload

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Docs and launch config

**Files:**
- Modify: `PLAN.md` (add Design Studio under what's done / next)
- Modify: `NOTES.md` (new section "Design Studio")
- Create or modify: `.claude/launch.json`

- [ ] **Step 1: NOTES.md**

Append:

```markdown
## Design Studio (2026-10-09, local only)

- `/design-studio` lists PENDING_DESIGN + DESIGN_REJECTED orders; `/design-studio/[orderId]` is the per-order workspace.
- Line-item properties are now persisted on `OrderLine.customAttributesJson` at sync (with `_product_url` appended). Orders synced before this have `null` there — the "Nạp lại từ Shopify" button fills them via `fetchOrderLinePropsByNames` (60-day window, single-store token).
- Uploaded artwork lives under `storage/design/<order>/<line>/<area>/v<n>-<name>` (`DESIGN_STORAGE_DIR` overrides the root), tracked in `DesignArtwork`, served only via `/api/design-studio/file/<id>`.
- "Đánh dấu xong" writes `OrderLine.designDriveLink` = the app file URL and recomputes `Order.designReady` + `pipelineStatus` with `autoDetectStatus`. The supplier CSV therefore carries an app URL until Drive storage replaces local storage.
- Next phase: the auto-design agent (see the spec's "Next phase").
```

- [ ] **Step 2: PLAN.md**

Under the done/next sections add one line each: "Design Studio v1 (local): order list + workspace + per-area upload — 2026-10-09" and "Next: printcheck on the clone tools, PrintTemplate model, auto-design agent".

- [ ] **Step 3: launch.json**

If `.claude/launch.json` lacks a dev entry, create:

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "dev", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev", "--", "--port", "3002"], "port": 3002 }
  ]
}
```

- [ ] **Step 4: Full suite and commit**

Run: `npx vitest run && npx tsc --noEmit -p .`
Expected: PASS, clean.

```bash
git add NOTES.md PLAN.md .claude/launch.json
git commit -m "docs(design-studio): notes, plan entry, dev launch config

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
