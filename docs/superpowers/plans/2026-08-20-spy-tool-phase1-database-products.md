# Spy Tool — Phase 1: Database Foundation + Persistent Store Products + IDEA Vault — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the existing on-demand Shopify product spy into a scheduled, DB-backed tool with a store list, product history, and an IDEA vault — laying the full Spy database (all 10 models) that later phases (Ad Library, keyword trending) build on.

**Architecture:** Evolve the existing `/tools/spy-idea` feature. Extract the reusable pure helpers from `src/app/api/tools/spy-idea/route.ts` into `src/lib/spy/shopify.ts`. Add all 10 `Spy*` Prisma models in one migration. Build a scan runner that fetches `{domain}/products.json`, maps products, upserts entities + observations under a `SpyScan`, driven both by manual API triggers and a `node-cron` schedule (2×/day, VN time). Add a persistent store list and IDEA vault UI in the same `/tools/spy-idea` namespace.

**Tech Stack:** Next.js (App Router, `'use client'` pages), Prisma + SQLite, Vitest (`vi.mock('@/lib/db')`, `vi.spyOn(globalThis,'fetch')`), node-cron, Tailwind design tokens.

**Spec:** `docs/superpowers/specs/2026-08-20-spy-tool-design.md` (see §4 schema, §10 phasing, §11 reconciliation with existing `/tools/spy-idea`).

## Global Constraints

- **Never add `url` to the `datasource db {}` block** in `prisma/schema.prisma` (breaks Prisma v7). URL lives only in `prisma.config.ts`.
- After schema change run in order: `npx prisma migrate dev --name <change>` → `npx prisma generate` → bump `SCHEMA_VERSION` in `src/lib/db.ts` → restart dev server.
- Import Prisma only via `import { prisma } from '@/lib/db'`. Never import from `@/generated/prisma` (use `@/generated/prisma/client` if ever needed directly).
- SQLite has no enum/JSON types: model enums as `String` (allowed values in a comment), JSON as `String` default `"[]"`.
- All pages `'use client'`, render `<Sidebar />`, wrap in `<div className="flex min-h-screen bg-surface"><Sidebar /><main className="ml-[280px] flex-1 p-xl">…</main></div>`.
- Icons: `<span className="material-symbols-outlined">icon_name</span>`. Card pattern: `bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20`.
- API routes: `src/app/api/<feature>/<action>/route.ts`, export named `GET/POST/PATCH/DELETE`, return `NextResponse.json(...)`.
- Dates display US format `en-US` (MM/DD/YYYY) — never `vi-VN`.
- Tests: `npm test` (vitest run). Test files: `src/**/*.test.ts`.
- Routing stays under `/tools/spy-idea` (nav + roles `tools_spy_idea` already cover children via `startsWith`).

---

### Task 1: Add all Spy Prisma models + migration

**Files:**
- Modify: `prisma/schema.prisma` (append models)
- Modify: `src/lib/db.ts:6` (bump `SCHEMA_VERSION`)

**Interfaces:**
- Produces: Prisma delegates `prisma.spyStore`, `prisma.spyProduct`, `prisma.spyProductSnapshot`, `prisma.spyAdvertiser`, `prisma.spyAd`, `prisma.spyAdObservation`, `prisma.spyKeyword`, `prisma.spyKeywordHit`, `prisma.spyScan`, `prisma.spyIdea`.

- [ ] **Step 1: Append the 10 models to `prisma/schema.prisma`**

Paste the schema block from spec §4 verbatim, with the `SpyProduct` field additions from spec §11 (`variantCount`, `availableVariantCount`, `dateSource`, `publishedAt = published_at ?? created_at`). The full `SpyProduct` model is:

```prisma
model SpyProduct {
  id                    String    @id @default(cuid())
  storeId               String
  store                 SpyStore  @relation(fields: [storeId], references: [id], onDelete: Cascade)
  externalProductId     String
  handle                String?
  title                 String?
  productType           String?
  vendor                String?
  tags                  String    @default("[]")
  imageUrl              String?
  priceMin              Float?
  priceMax              Float?
  variantCount          Int       @default(0)
  availableVariantCount Int       @default(0)
  niche                 String?
  publishedAt           DateTime?
  dateSource            String?
  status                String    @default("active")
  firstSeenAt           DateTime  @default(now())
  lastSeenAt            DateTime  @default(now())
  snapshots             SpyProductSnapshot[]

  @@unique([storeId, externalProductId])
  @@index([firstSeenAt])
  @@index([productType])
  @@index([storeId])
}
```

Add the other 9 models (`SpyStore`, `SpyProductSnapshot`, `SpyAdvertiser`, `SpyAd`, `SpyAdObservation`, `SpyKeyword`, `SpyKeywordHit`, `SpyScan`, `SpyIdea`) exactly as in spec §4.

- [ ] **Step 2: Validate schema**

Run: `npx prisma validate`
Expected: "The schema at prisma/schema.prisma is valid 🚀"

- [ ] **Step 3: Create migration**

Run: `npx prisma migrate dev --name add_spy_tool`
Expected: migration applied, no errors.

- [ ] **Step 4: Regenerate client**

Run: `npx prisma generate`
Expected: "Generated Prisma Client".

- [ ] **Step 5: Bump SCHEMA_VERSION**

In `src/lib/db.ts:6` change `const SCHEMA_VERSION = 'v23'` → `'v24'`.

- [ ] **Step 6: Smoke-test the client**

Create `src/lib/spy/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/db'

describe('spy schema', () => {
  it('exposes all spy model delegates', () => {
    for (const m of ['spyStore','spyProduct','spyProductSnapshot','spyAdvertiser','spyAd','spyAdObservation','spyKeyword','spyKeywordHit','spyScan','spyIdea'] as const) {
      expect((prisma as any)[m]).toBeDefined()
    }
  })
})
```

Run: `npm test -- src/lib/spy/schema.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add prisma/ src/lib/db.ts src/lib/spy/schema.test.ts
git commit -m "feat(spy): add Spy tool database models"
```

---

### Task 2: Extract reusable Shopify spy helpers into a lib

**Files:**
- Create: `src/lib/spy/shopify.ts`
- Create: `src/lib/spy/shopify.test.ts`
- Modify: `src/app/api/tools/spy-idea/route.ts` (import from lib instead of local copies)

**Interfaces:**
- Produces:
  - `normalizeStoreUrl(value: string): string` — throws on empty/private; returns `protocol//host`.
  - `normalizeDomain(value: string): string` — bare host (no protocol, no trailing slash), lowercased. `normalizeDomain('https://Foo.com/') === 'foo.com'`.
  - `parseDate(value?: string | null): Date | null`
  - `stripHtml(value?: string): string`
  - `tagsToArray(value?: string | string[]): string[]`
  - `priceSummary(variants): { min: number, max: number } | null`
  - `productUrl(origin: string, handle?: string): string`
  - `externalProductId(raw: ShopifyRawProduct): string` — `String(id)` if present else `handle:<handle>`.
  - `type ShopifyRawProduct` — the `/products.json` product shape.
  - `type ParsedSpyProduct` — mapped shape (see Task 3).
  - `mapShopifyProduct(raw: ShopifyRawProduct, origin: string): ParsedSpyProduct` (added in Task 3).

- [ ] **Step 1: Write failing tests for the helpers**

Create `src/lib/spy/shopify.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { normalizeStoreUrl, normalizeDomain, tagsToArray, priceSummary, externalProductId } from './shopify'

describe('spy shopify helpers', () => {
  it('normalizeStoreUrl adds protocol and strips path', () => {
    expect(normalizeStoreUrl('foo.com/collections/all')).toBe('https://foo.com')
  })
  it('normalizeStoreUrl rejects private hosts', () => {
    expect(() => normalizeStoreUrl('192.168.0.1')).toThrow()
    expect(() => normalizeStoreUrl('localhost')).toThrow()
  })
  it('normalizeDomain returns bare lowercased host', () => {
    expect(normalizeDomain('https://Foo.com/')).toBe('foo.com')
    expect(normalizeDomain('foo.com')).toBe('foo.com')
  })
  it('tagsToArray splits strings and passes arrays', () => {
    expect(tagsToArray('a, b ,c')).toEqual(['a','b','c'])
    expect(tagsToArray(['x','y'])).toEqual(['x','y'])
  })
  it('priceSummary returns min/max', () => {
    expect(priceSummary([{ price: '10' }, { price: '25' }])).toEqual({ min: 10, max: 25 })
    expect(priceSummary([])).toBeNull()
  })
  it('externalProductId prefers numeric id, falls back to handle', () => {
    expect(externalProductId({ id: 123, handle: 'h' } as any)).toBe('123')
    expect(externalProductId({ handle: 'h' } as any)).toBe('handle:h')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/spy/shopify.test.ts`
Expected: FAIL — cannot find module `./shopify`.

- [ ] **Step 3: Implement `src/lib/spy/shopify.ts`**

Move the pure helpers out of `src/app/api/tools/spy-idea/route.ts` (`normalizeStoreUrl`, `parseDate`, `stripHtml`, `tagsToArray`, `productUrl`) verbatim, change `priceSummary` to return `{min,max}` numbers instead of a formatted string, and add `normalizeDomain` + `externalProductId`:

```ts
export type ShopifyVariant = { id?: number; price?: string; available?: boolean }
export type ShopifyImage = { src?: string }
export type ShopifyRawProduct = {
  id?: number; title?: string; handle?: string; body_html?: string
  vendor?: string; product_type?: string; tags?: string | string[]
  created_at?: string; published_at?: string | null; updated_at?: string
  variants?: ShopifyVariant[]; images?: ShopifyImage[]
}

export function normalizeStoreUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('Domain is required')
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const parsed = new URL(withProtocol)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https domains are supported')
  const hostname = parsed.hostname.toLowerCase()
  if (
    hostname === 'localhost' || hostname.endsWith('.local') || hostname === '0.0.0.0' ||
    hostname.startsWith('127.') || hostname.startsWith('10.') || hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  ) throw new Error('Local or private network domains are not allowed')
  return `${parsed.protocol}//${parsed.host}`
}

export function normalizeDomain(value: string): string {
  return new URL(normalizeStoreUrl(value)).host.toLowerCase()
}

export function parseDate(value?: string | null): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function stripHtml(value?: string): string {
  return String(value ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

export function tagsToArray(value?: string | string[]): string[] {
  if (Array.isArray(value)) return value.map(t => String(t).trim()).filter(Boolean)
  return String(value ?? '').split(',').map(t => t.trim()).filter(Boolean)
}

export function priceSummary(variants: ShopifyVariant[] = []): { min: number; max: number } | null {
  const prices = variants.map(v => Number(v.price)).filter(p => Number.isFinite(p))
  if (prices.length === 0) return null
  return { min: Math.min(...prices), max: Math.max(...prices) }
}

export function productUrl(origin: string, handle?: string): string {
  return handle ? `${origin}/products/${handle}` : origin
}

export function externalProductId(raw: ShopifyRawProduct): string {
  if (raw.id) return String(raw.id)
  if (raw.handle) return `handle:${raw.handle}`
  throw new Error('Product has neither id nor handle')
}
```

- [ ] **Step 4: Refactor the existing route to import from lib**

In `src/app/api/tools/spy-idea/route.ts`, delete the local `normalizeStoreUrl`, `parseDate`, `stripHtml`, `tagsToArray`, `productUrl` and the local `priceSummary`; import the shared ones:

```ts
import { normalizeStoreUrl, parseDate, stripHtml, tagsToArray, productUrl, priceSummary } from '@/lib/spy/shopify'
```

Because the shared `priceSummary` now returns `{min,max}`, update the one call site to keep the route's existing string output:

```ts
// was: price: priceSummary(variants),
const ps = priceSummary(variants)
// price string preserves prior behavior:
const price = ps ? (ps.min === ps.max ? ps.min.toFixed(2) : `${ps.min.toFixed(2)} - ${ps.max.toFixed(2)}`) : null
// ...then use `price` in the returned object
```

- [ ] **Step 5: Run helper tests + full suite**

Run: `npm test -- src/lib/spy/shopify.test.ts`
Expected: PASS.
Run: `npm test`
Expected: all pass (route still compiles; no behavior change).

- [ ] **Step 6: Commit**

```bash
git add src/lib/spy/shopify.ts src/lib/spy/shopify.test.ts src/app/api/tools/spy-idea/route.ts
git commit -m "refactor(spy): extract shared Shopify helpers to lib"
```

---

### Task 3: `mapShopifyProduct` — raw product → persistable shape

**Files:**
- Modify: `src/lib/spy/shopify.ts`
- Modify: `src/lib/spy/shopify.test.ts`

**Interfaces:**
- Produces:
```ts
export type ParsedSpyProduct = {
  externalProductId: string
  handle: string | null
  title: string | null
  productType: string | null
  vendor: string | null
  tags: string[]
  imageUrl: string | null
  priceMin: number | null
  priceMax: number | null
  variantCount: number
  availableVariantCount: number
  publishedAt: Date | null
  dateSource: 'published_at' | 'created_at' | null
  url: string
}
export function mapShopifyProduct(raw: ShopifyRawProduct, origin: string): ParsedSpyProduct
```

- [ ] **Step 1: Write failing test**

Append to `src/lib/spy/shopify.test.ts`:

```ts
import { mapShopifyProduct } from './shopify'

describe('mapShopifyProduct', () => {
  it('maps fields and derives publishedAt/dateSource', () => {
    const raw = {
      id: 42, title: 'Tee', handle: 'tee', vendor: 'V', product_type: 'Shirt',
      tags: 'a,b', created_at: '2026-08-01T00:00:00Z', published_at: '2026-08-10T00:00:00Z',
      variants: [{ price: '19.99', available: true }, { price: '24.99', available: false }],
      images: [{ src: 'http://img/1.jpg' }],
    }
    const p = mapShopifyProduct(raw as any, 'https://foo.com')
    expect(p.externalProductId).toBe('42')
    expect(p.url).toBe('https://foo.com/products/tee')
    expect(p.priceMin).toBe(19.99)
    expect(p.priceMax).toBe(24.99)
    expect(p.variantCount).toBe(2)
    expect(p.availableVariantCount).toBe(1)
    expect(p.dateSource).toBe('published_at')
    expect(p.publishedAt?.toISOString()).toBe('2026-08-10T00:00:00.000Z')
  })
  it('falls back to created_at when published_at missing', () => {
    const p = mapShopifyProduct({ id: 1, created_at: '2026-08-01T00:00:00Z' } as any, 'https://foo.com')
    expect(p.dateSource).toBe('created_at')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/spy/shopify.test.ts`
Expected: FAIL — `mapShopifyProduct` is not a function.

- [ ] **Step 3: Implement `mapShopifyProduct`**

Append to `src/lib/spy/shopify.ts`:

```ts
export type ParsedSpyProduct = {
  externalProductId: string; handle: string | null; title: string | null
  productType: string | null; vendor: string | null; tags: string[]
  imageUrl: string | null; priceMin: number | null; priceMax: number | null
  variantCount: number; availableVariantCount: number
  publishedAt: Date | null; dateSource: 'published_at' | 'created_at' | null; url: string
}

export function mapShopifyProduct(raw: ShopifyRawProduct, origin: string): ParsedSpyProduct {
  const published = parseDate(raw.published_at)
  const created = parseDate(raw.created_at)
  const publishedAt = published ?? created
  const dateSource = published ? 'published_at' : created ? 'created_at' : null
  const variants = raw.variants ?? []
  const ps = priceSummary(variants)
  const handle = raw.handle || null
  return {
    externalProductId: externalProductId(raw),
    handle,
    title: raw.title || null,
    productType: raw.product_type || null,
    vendor: raw.vendor || null,
    tags: tagsToArray(raw.tags),
    imageUrl: raw.images?.[0]?.src || null,
    priceMin: ps?.min ?? null,
    priceMax: ps?.max ?? null,
    variantCount: variants.length,
    availableVariantCount: variants.filter(v => v.available !== false).length,
    publishedAt,
    dateSource,
    url: productUrl(origin, handle ?? undefined),
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- src/lib/spy/shopify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/spy/shopify.ts src/lib/spy/shopify.test.ts
git commit -m "feat(spy): add mapShopifyProduct"
```

---

### Task 4: `fetchStoreProducts` — fetch + parse products.json

**Files:**
- Create: `src/lib/spy/scan-products.ts`
- Create: `src/lib/spy/scan-products.test.ts`

**Interfaces:**
- Consumes: `normalizeStoreUrl`, `mapShopifyProduct`, `ParsedSpyProduct` from `@/lib/spy/shopify`.
- Produces: `fetchStoreProducts(domain: string): Promise<{ products: ParsedSpyProduct[]; totalScanned: number }>` — throws on non-OK HTTP.

- [ ] **Step 1: Write failing test**

Create `src/lib/spy/scan-products.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchStoreProducts } from './scan-products'

afterEach(() => vi.restoreAllMocks())

describe('fetchStoreProducts', () => {
  it('fetches products.json and maps items', async () => {
    const payload = { products: [
      { id: 1, title: 'A', handle: 'a', variants: [{ price: '9.99', available: true }] },
      { id: 2, title: 'B', handle: 'b', variants: [] },
    ] }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: true, json: async () => payload } as Response)
    const { products, totalScanned } = await fetchStoreProducts('foo.com')
    expect(totalScanned).toBe(2)
    expect(products[0].externalProductId).toBe('1')
    expect(products[0].url).toBe('https://foo.com/products/a')
  })
  it('throws on non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' } as Response)
    await expect(fetchStoreProducts('foo.com')).rejects.toThrow('404')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/spy/scan-products.test.ts`
Expected: FAIL — cannot find module `./scan-products`.

- [ ] **Step 3: Implement**

Create `src/lib/spy/scan-products.ts`:

```ts
import { normalizeStoreUrl, mapShopifyProduct, type ParsedSpyProduct, type ShopifyRawProduct } from '@/lib/spy/shopify'

export async function fetchStoreProducts(domain: string): Promise<{ products: ParsedSpyProduct[]; totalScanned: number }> {
  const origin = normalizeStoreUrl(domain)
  const endpoint = `${origin}/products.json?limit=250&page=1`
  const res = await fetch(endpoint, {
    cache: 'no-store',
    headers: { accept: 'application/json', 'user-agent': 'EcomManagerSpy/1.0' },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`Store returned ${res.status} ${res.statusText ?? ''}`.trim())
  const payload = await res.json()
  const raw: ShopifyRawProduct[] = Array.isArray(payload?.products) ? payload.products : Array.isArray(payload) ? payload : []
  return { products: raw.map(p => mapShopifyProduct(p, origin)), totalScanned: raw.length }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- src/lib/spy/scan-products.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/spy/scan-products.ts src/lib/spy/scan-products.test.ts
git commit -m "feat(spy): add fetchStoreProducts"
```

---

### Task 5: `ingestStoreProducts` — upsert entities under a scan

**Files:**
- Create: `src/lib/spy/ingest-products.ts`
- Create: `src/lib/spy/ingest-products.test.ts`

**Interfaces:**
- Consumes: `ParsedSpyProduct` from `@/lib/spy/shopify`; `prisma` from `@/lib/db`.
- Produces: `ingestStoreProducts(storeId: string, scanId: string, products: ParsedSpyProduct[]): Promise<{ found: number; created: number; updated: number }>`.

- [ ] **Step 1: Write failing test (mock prisma)**

Create `src/lib/spy/ingest-products.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: any = { upsert: [], snapshotCreate: [] }
vi.mock('@/lib/db', () => ({
  prisma: {
    spyProduct: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async (args: any) => { calls.upsert.push(args); return { id: 'p1', ...args.create } }),
    },
    spyProductSnapshot: { create: vi.fn(async (a: any) => { calls.snapshotCreate.push(a); return {} }) },
  },
}))

import { ingestStoreProducts } from './ingest-products'
import type { ParsedSpyProduct } from '@/lib/spy/shopify'

const parsed = (id: string): ParsedSpyProduct => ({
  externalProductId: id, handle: 'h'+id, title: 'T'+id, productType: 'Shirt', vendor: 'V',
  tags: ['a'], imageUrl: null, priceMin: 10, priceMax: 20, variantCount: 1,
  availableVariantCount: 1, publishedAt: new Date('2026-08-10'), dateSource: 'published_at',
  url: 'https://foo.com/products/h'+id,
})

beforeEach(() => { calls.upsert.length = 0; calls.snapshotCreate.length = 0; vi.clearAllMocks() })

describe('ingestStoreProducts', () => {
  it('upserts each product scoped by store + externalProductId', async () => {
    const res = await ingestStoreProducts('store1', 'scan1', [parsed('1'), parsed('2')])
    expect(res.found).toBe(2)
    expect(calls.upsert).toHaveLength(2)
    expect(calls.upsert[0].where).toEqual({ storeId_externalProductId: { storeId: 'store1', externalProductId: '1' } })
    expect(calls.upsert[0].create.tags).toBe('["a"]')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/spy/ingest-products.test.ts`
Expected: FAIL — cannot find module `./ingest-products`.

- [ ] **Step 3: Implement**

Create `src/lib/spy/ingest-products.ts`:

```ts
import { prisma } from '@/lib/db'
import type { ParsedSpyProduct } from '@/lib/spy/shopify'

export async function ingestStoreProducts(
  storeId: string, scanId: string, products: ParsedSpyProduct[],
): Promise<{ found: number; created: number; updated: number }> {
  let created = 0, updated = 0
  const now = new Date()
  for (const p of products) {
    const existing = await prisma.spyProduct.findUnique({
      where: { storeId_externalProductId: { storeId, externalProductId: p.externalProductId } },
      select: { id: true, priceMin: true, priceMax: true, title: true },
    })
    const data = {
      handle: p.handle, title: p.title, productType: p.productType, vendor: p.vendor,
      tags: JSON.stringify(p.tags), imageUrl: p.imageUrl, priceMin: p.priceMin, priceMax: p.priceMax,
      variantCount: p.variantCount, availableVariantCount: p.availableVariantCount,
      publishedAt: p.publishedAt, dateSource: p.dateSource, status: 'active',
    }
    const row = await prisma.spyProduct.upsert({
      where: { storeId_externalProductId: { storeId, externalProductId: p.externalProductId } },
      create: { storeId, externalProductId: p.externalProductId, firstSeenAt: now, lastSeenAt: now, ...data },
      update: { lastSeenAt: now, ...data },
    })
    if (existing) {
      updated++
      const changed = existing.priceMin !== p.priceMin || existing.priceMax !== p.priceMax || existing.title !== p.title
      if (changed) {
        await prisma.spyProductSnapshot.create({
          data: { productId: row.id, scanId, title: p.title, priceMin: p.priceMin, priceMax: p.priceMax, available: p.availableVariantCount > 0 },
        })
      }
    } else {
      created++
    }
  }
  return { found: products.length, created, updated }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- src/lib/spy/ingest-products.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/spy/ingest-products.ts src/lib/spy/ingest-products.test.ts
git commit -m "feat(spy): add ingestStoreProducts"
```

---

### Task 6: `runStoreProductScan` — scan lifecycle orchestrator

**Files:**
- Create: `src/lib/spy/scan-runner.ts`
- Create: `src/lib/spy/scan-runner.test.ts`

**Interfaces:**
- Consumes: `fetchStoreProducts` (Task 4), `ingestStoreProducts` (Task 5), `prisma`.
- Produces: `runStoreProductScan(store: { id: string; domain: string }): Promise<{ scanId: string; status: 'success' | 'failed'; stats?: object; error?: string }>` — creates a `SpyScan` (type `STORE_PRODUCTS`), runs fetch+ingest, marks success/failed, records `stats`.

- [ ] **Step 1: Write failing test**

Create `src/lib/spy/scan-runner.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db: any = { scans: [] }
vi.mock('@/lib/db', () => ({
  prisma: {
    spyScan: {
      create: vi.fn(async ({ data }: any) => { const s = { id: 'scan1', ...data }; db.scans.push(s); return s }),
      update: vi.fn(async ({ data }: any) => { Object.assign(db.scans[0], data); return db.scans[0] }),
    },
  },
}))
vi.mock('./scan-products', () => ({ fetchStoreProducts: vi.fn() }))
vi.mock('./ingest-products', () => ({ ingestStoreProducts: vi.fn() }))

import { runStoreProductScan } from './scan-runner'
import { fetchStoreProducts } from './scan-products'
import { ingestStoreProducts } from './ingest-products'

beforeEach(() => { db.scans.length = 0; vi.clearAllMocks() })

describe('runStoreProductScan', () => {
  it('marks scan success and records stats', async () => {
    ;(fetchStoreProducts as any).mockResolvedValue({ products: [{}, {}], totalScanned: 2 })
    ;(ingestStoreProducts as any).mockResolvedValue({ found: 2, created: 1, updated: 1 })
    const r = await runStoreProductScan({ id: 'store1', domain: 'foo.com' })
    expect(r.status).toBe('success')
    expect(db.scans[0].status).toBe('success')
    expect(JSON.parse(db.scans[0].stats)).toMatchObject({ found: 2, created: 1 })
  })
  it('marks scan failed on fetch error', async () => {
    ;(fetchStoreProducts as any).mockRejectedValue(new Error('boom'))
    const r = await runStoreProductScan({ id: 'store1', domain: 'foo.com' })
    expect(r.status).toBe('failed')
    expect(db.scans[0].status).toBe('failed')
    expect(db.scans[0].error).toBe('boom')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/spy/scan-runner.test.ts`
Expected: FAIL — cannot find module `./scan-runner`.

- [ ] **Step 3: Implement**

Create `src/lib/spy/scan-runner.ts`:

```ts
import { prisma } from '@/lib/db'
import { fetchStoreProducts } from './scan-products'
import { ingestStoreProducts } from './ingest-products'

export async function runStoreProductScan(store: { id: string; domain: string }) {
  const scan = await prisma.spyScan.create({
    data: { type: 'STORE_PRODUCTS', targetType: 'STORE', targetId: store.id, status: 'running' },
  })
  try {
    const { products, totalScanned } = await fetchStoreProducts(store.domain)
    const ingest = await ingestStoreProducts(store.id, scan.id, products)
    const stats = { totalScanned, ...ingest }
    await prisma.spyScan.update({ where: { id: scan.id }, data: { status: 'success', stats: JSON.stringify(stats), finishedAt: new Date() } })
    return { scanId: scan.id, status: 'success' as const, stats }
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : 'Unknown error'
    await prisma.spyScan.update({ where: { id: scan.id }, data: { status: 'failed', error, finishedAt: new Date() } })
    return { scanId: scan.id, status: 'failed' as const, error }
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- src/lib/spy/scan-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/spy/scan-runner.ts src/lib/spy/scan-runner.test.ts
git commit -m "feat(spy): add runStoreProductScan orchestrator"
```

---

### Task 7: Spy store CRUD API

**Files:**
- Create: `src/app/api/spy/stores/route.ts`

**Interfaces:**
- Consumes: `normalizeDomain` from `@/lib/spy/shopify`, `prisma`.
- Produces HTTP: `GET` (list stores), `POST {domain,name?}` (create, dedup by normalized domain), `PATCH {id,...}` (update status/name/tags), `DELETE {id}` (cascade products).

- [ ] **Step 1: Implement the route**

Create `src/app/api/spy/stores/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { normalizeDomain } from '@/lib/spy/shopify'

export async function GET() {
  const stores = await prisma.spyStore.findMany({
    orderBy: { addedAt: 'desc' },
    include: { _count: { select: { products: true } } },
  })
  return NextResponse.json(stores)
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  let domain: string
  try { domain = normalizeDomain(String(body.domain ?? '')) }
  catch (e: unknown) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid domain' }, { status: 400 }) }
  const store = await prisma.spyStore.upsert({
    where: { domain },
    create: { domain, name: body.name || null },
    update: { name: body.name ?? undefined },
  })
  return NextResponse.json(store)
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const data: Record<string, unknown> = {}
  if ('name' in body) data.name = body.name || null
  if ('status' in body) data.status = body.status
  if ('tags' in body) data.tags = JSON.stringify(body.tags ?? [])
  const store = await prisma.spyStore.update({ where: { id: body.id }, data })
  return NextResponse.json(store)
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await prisma.spyStore.delete({ where: { id: body.id } })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Manual verification**

Start the dev server (`npm run dev -- --port 3002`). Then:

Run: `curl -s -X POST localhost:3002/api/spy/stores -H 'content-type: application/json' -d '{"domain":"https://Allbirds.com/"}'`
Expected: JSON with `"domain":"allbirds.com"` and an `id`.
Run: `curl -s localhost:3002/api/spy/stores`
Expected: array containing the store with `_count.products`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/spy/stores/route.ts
git commit -m "feat(spy): store CRUD API"
```

---

### Task 8: Scan trigger API

**Files:**
- Create: `src/app/api/spy/scan/route.ts`

**Interfaces:**
- Consumes: `runStoreProductScan` (Task 6), `prisma`.
- Produces HTTP: `POST {storeId?}` — scan one store, or all active stores when omitted; returns per-store results.

- [ ] **Step 1: Implement**

Create `src/app/api/spy/scan/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { runStoreProductScan } from '@/lib/spy/scan-runner'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const stores = body.storeId
    ? await prisma.spyStore.findMany({ where: { id: body.storeId } })
    : await prisma.spyStore.findMany({ where: { status: 'active' } })
  if (stores.length === 0) return NextResponse.json({ error: 'No stores to scan' }, { status: 404 })
  const results = []
  for (const s of stores) results.push({ store: s.domain, ...(await runStoreProductScan(s)) })
  return NextResponse.json({ results })
}
```

- [ ] **Step 2: Manual verification**

Run: `curl -s -X POST localhost:3002/api/spy/scan -H 'content-type: application/json' -d '{}'`
Expected: `{"results":[{"store":"allbirds.com","status":"success","stats":{...}}]}`.
Then confirm rows exist:
Run: `curl -s localhost:3002/api/spy/products`  *(after Task 9)* or check via Prisma Studio (`npx prisma studio`) that `SpyProduct` has rows.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/spy/scan/route.ts
git commit -m "feat(spy): manual scan trigger API"
```

---

### Task 9: Product signals + products list API

**Files:**
- Create: `src/lib/spy/signals.ts`
- Create: `src/lib/spy/signals.test.ts`
- Create: `src/app/api/spy/products/route.ts`

**Interfaces:**
- Produces:
  - `isNewProduct(firstSeenAt: Date, now?: Date, windowDays?: number): boolean` — default window 7 days.
  - `groupByNiche(products: { productType: string | null }[]): { niche: string; count: number }[]` — sorted desc, null → "Uncategorized".
  - HTTP `GET /api/spy/products?storeId&days&limit` — recent products ordered by `firstSeenAt desc`, plus `niches` breakdown.

- [ ] **Step 1: Write failing signals test**

Create `src/lib/spy/signals.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isNewProduct, groupByNiche } from './signals'

describe('spy signals', () => {
  it('isNewProduct true within window', () => {
    const now = new Date('2026-08-20T00:00:00Z')
    expect(isNewProduct(new Date('2026-08-18T00:00:00Z'), now, 7)).toBe(true)
    expect(isNewProduct(new Date('2026-08-01T00:00:00Z'), now, 7)).toBe(false)
  })
  it('groupByNiche counts and sorts desc', () => {
    const g = groupByNiche([{ productType: 'Shirt' }, { productType: 'Shirt' }, { productType: null }])
    expect(g[0]).toEqual({ niche: 'Shirt', count: 2 })
    expect(g).toContainEqual({ niche: 'Uncategorized', count: 1 })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/spy/signals.test.ts`
Expected: FAIL — cannot find module `./signals`.

- [ ] **Step 3: Implement signals**

Create `src/lib/spy/signals.ts`:

```ts
export function isNewProduct(firstSeenAt: Date, now: Date = new Date(), windowDays = 7): boolean {
  return firstSeenAt.getTime() >= now.getTime() - windowDays * 24 * 60 * 60 * 1000
}

export function groupByNiche(products: { productType: string | null }[]): { niche: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const p of products) {
    const key = p.productType || 'Uncategorized'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Array.from(counts, ([niche, count]) => ({ niche, count })).sort((a, b) => b.count - a.count)
}
```

- [ ] **Step 4: Run signals test to verify pass**

Run: `npm test -- src/lib/spy/signals.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement products list route**

Create `src/app/api/spy/products/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { groupByNiche } from '@/lib/spy/signals'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const storeId = searchParams.get('storeId') || undefined
  const days = Math.min(parseInt(searchParams.get('days') ?? '7', 10), 90)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '200', 10), 500)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const products = await prisma.spyProduct.findMany({
    where: { firstSeenAt: { gte: since }, ...(storeId ? { storeId } : {}) },
    orderBy: { firstSeenAt: 'desc' },
    take: limit,
    include: { store: { select: { domain: true } } },
  })
  return NextResponse.json({ products, niches: groupByNiche(products) })
}
```

- [ ] **Step 6: Manual verification**

Run: `curl -s "localhost:3002/api/spy/products?days=30"`
Expected: `{ "products": [...], "niches": [{ "niche": "...", "count": N }] }`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/spy/signals.ts src/lib/spy/signals.test.ts src/app/api/spy/products/route.ts
git commit -m "feat(spy): product signals + products list API"
```

---

### Task 10: IDEA vault API

**Files:**
- Create: `src/app/api/spy/ideas/route.ts`

**Interfaces:**
- Produces HTTP: `GET ?status` (list, newest first), `POST {title,note?,tags?,refType?,refAdId?,refProductId?,refStoreId?,refKeywordId?,snapshotJson?}`, `PATCH {id,...}`, `DELETE {id}`.

- [ ] **Step 1: Implement**

Create `src/app/api/spy/ideas/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

const REF_TYPES = new Set(['AD','PRODUCT','ADVERTISER','STORE','KEYWORD','NONE'])
const STATUSES = new Set(['NEW','EXPLORING','TESTING','ARCHIVED'])

export async function GET(req: NextRequest) {
  const status = new URL(req.url).searchParams.get('status') || undefined
  const ideas = await prisma.spyIdea.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json(ideas)
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.title || !String(b.title).trim()) return NextResponse.json({ error: 'title required' }, { status: 400 })
  const refType = REF_TYPES.has(b.refType) ? b.refType : 'NONE'
  const idea = await prisma.spyIdea.create({
    data: {
      title: String(b.title).trim(), note: b.note || null,
      tags: JSON.stringify(b.tags ?? []), refType,
      refAdId: b.refAdId || null, refProductId: b.refProductId || null,
      refStoreId: b.refStoreId || null, refKeywordId: b.refKeywordId || null,
      snapshotJson: b.snapshotJson ? JSON.stringify(b.snapshotJson) : null,
    },
  })
  return NextResponse.json(idea)
}

export async function PATCH(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const data: Record<string, unknown> = {}
  if ('title' in b) data.title = String(b.title).trim()
  if ('note' in b) data.note = b.note || null
  if ('tags' in b) data.tags = JSON.stringify(b.tags ?? [])
  if ('status' in b && STATUSES.has(b.status)) data.status = b.status
  const idea = await prisma.spyIdea.update({ where: { id: b.id }, data })
  return NextResponse.json(idea)
}

export async function DELETE(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await prisma.spyIdea.delete({ where: { id: b.id } })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Manual verification**

Run: `curl -s -X POST localhost:3002/api/spy/ideas -H 'content-type: application/json' -d '{"title":"Test idea","tags":["pod"]}'`
Expected: JSON idea with `"status":"NEW"`, `"tags":"[\"pod\"]"`.
Run: `curl -s localhost:3002/api/spy/ideas`
Expected: array containing the idea.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/spy/ideas/route.ts
git commit -m "feat(spy): IDEA vault API"
```

---

### Task 11: Cron scheduler (products 2×/day)

**Files:**
- Create: `src/lib/spy/scheduler.ts`
- Modify: `instrumentation.ts`

**Interfaces:**
- Consumes: `runStoreProductScan` (Task 6), `prisma`, `node-cron`.
- Produces: `initSpyScheduler(): void` — idempotent singleton registering two crons at 08:00 & 20:00 `Asia/Ho_Chi_Minh` that scan all active stores sequentially.

- [ ] **Step 1: Implement scheduler**

Create `src/lib/spy/scheduler.ts` (mirror the singleton pattern in `src/lib/auto-sync.ts`):

```ts
import cron from 'node-cron'
import { prisma } from '@/lib/db'
import { runStoreProductScan } from './scan-runner'

let initialized = false

async function scanAllStores() {
  const stores = await prisma.spyStore.findMany({ where: { status: 'active' } })
  for (const s of stores) {
    try { await runStoreProductScan(s) }
    catch (e) { console.error('[spy-scheduler] scan failed for', s.domain, e) }
  }
  console.log(`[spy-scheduler] product scan done for ${stores.length} store(s)`)
}

export function initSpyScheduler() {
  if (initialized) return
  initialized = true
  cron.schedule('0 8,20 * * *', () => { scanAllStores().catch(e => console.error('[spy-scheduler]', e)) }, { timezone: 'Asia/Ho_Chi_Minh' })
  console.log('[spy-scheduler] Initialized — product scan at 08:00 & 20:00 Asia/Ho_Chi_Minh')
}
```

- [ ] **Step 2: Wire into `instrumentation.ts`**

Modify `instrumentation.ts` `register()` to also init the spy scheduler:

```ts
export async function register() {
  if (!process.env.NEXT_RUNTIME || process.env.NEXT_RUNTIME === 'nodejs') {
    const { initAutoSync } = await import('./src/lib/auto-sync')
    initAutoSync()
    const { initSpyScheduler } = await import('./src/lib/spy/scheduler')
    initSpyScheduler()
  }
}
```

- [ ] **Step 3: Verify it registers on boot**

Run: `npm run dev -- --port 3002`
Expected: server log shows `[spy-scheduler] Initialized — product scan at 08:00 & 20:00 Asia/Ho_Chi_Minh`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/spy/scheduler.ts instrumentation.ts
git commit -m "feat(spy): 2x/day product scan scheduler"
```

---

### Task 12: Evolve `/tools/spy-idea` UI — stores + persistent products + ideas

**Files:**
- Modify: `src/app/tools/spy-idea/page.tsx`

**Interfaces:**
- Consumes HTTP: `/api/spy/stores`, `/api/spy/scan`, `/api/spy/products`, `/api/spy/ideas`.

This task turns the on-demand page into a persistent dashboard with three tabs: **Stores** (manage list + "Scan now"), **New Products** (from DB), **Ideas** (vault). Keep the existing `RoleGate` + `Sidebar` + layout wrappers.

- [ ] **Step 1: Replace the page body with a tabbed persistent dashboard**

Rewrite `src/app/tools/spy-idea/page.tsx`. Keep imports (`'use client'`, `useEffect`, `useState`, `Sidebar`, `RoleGate`) and the `formatDate` helper (en-US). Structure:

```tsx
'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'

type Store = { id: string; domain: string; name: string | null; status: string; _count?: { products: number } }
type Product = { id: string; title: string | null; handle: string | null; imageUrl: string | null; priceMin: number | null; priceMax: number | null; firstSeenAt: string; productType: string | null; store: { domain: string } }
type Idea = { id: string; title: string; note: string | null; status: string; createdAt: string }

function formatDate(v: string | null) {
  if (!v) return '-'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}
function priceText(min: number | null, max: number | null) {
  if (min == null) return '-'
  return min === max ? `$${min.toFixed(2)}` : `$${min.toFixed(2)} - $${max.toFixed(2)}`
}

export default function SpyIdeaPage() {
  const [tab, setTab] = useState<'stores' | 'products' | 'ideas'>('stores')
  const [stores, setStores] = useState<Store[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [domain, setDomain] = useState('')
  const [scanning, setScanning] = useState(false)

  async function loadStores() { setStores(await fetch('/api/spy/stores').then(r => r.json())) }
  async function loadProducts() { const d = await fetch('/api/spy/products?days=30').then(r => r.json()); setProducts(d.products ?? []) }
  async function loadIdeas() { setIdeas(await fetch('/api/spy/ideas').then(r => r.json())) }

  useEffect(() => { loadStores(); loadProducts(); loadIdeas() }, [])

  async function addStore() {
    if (!domain.trim()) return
    await fetch('/api/spy/stores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain }) })
    setDomain(''); loadStores()
  }
  async function removeStore(id: string) {
    await fetch('/api/spy/stores', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    loadStores()
  }
  async function scanAll() {
    setScanning(true)
    try { await fetch('/api/spy/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); await loadProducts(); await loadStores() }
    finally { setScanning(false) }
  }
  async function saveIdea(p: Product) {
    await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: p.title ?? 'Untitled', refType: 'PRODUCT', refProductId: p.id, snapshotJson: p }) })
    loadIdeas()
  }

  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <header className="mb-xl">
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools</p>
            <h2 className="text-display-md font-bold text-primary">Spy Idea</h2>
          </header>

          <div className="mb-lg inline-flex rounded-lg bg-surface-container p-xs">
            {(['stores','products','ideas'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`rounded-md px-md py-xs text-label-sm capitalize ${tab === t ? 'bg-secondary text-on-secondary' : 'text-on-surface-variant'}`}>
                {t}
              </button>
            ))}
          </div>

          {tab === 'stores' && (
            <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
              <div className="mb-md flex gap-sm">
                <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="store.myshopify.com"
                  className="flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
                <button onClick={addStore} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Add store</button>
                <button onClick={scanAll} disabled={scanning} className="rounded-lg bg-primary px-lg py-sm text-label-md text-on-primary disabled:opacity-50">
                  {scanning ? 'Scanning…' : 'Scan now'}
                </button>
              </div>
              <ul className="divide-y divide-outline-variant/20">
                {stores.map(s => (
                  <li key={s.id} className="flex items-center justify-between py-sm">
                    <div><p className="text-label-md text-primary">{s.domain}</p><p className="text-body-sm text-on-surface-variant">{s._count?.products ?? 0} products · {s.status}</p></div>
                    <button onClick={() => removeStore(s.id)} className="text-error text-label-sm hover:underline">Remove</button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {tab === 'products' && (
            <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {products.map(p => (
                <article key={p.id} className="overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container-lowest">
                  <div className="aspect-square bg-surface-container-low">
                    {p.imageUrl
                      ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={p.imageUrl} alt={p.title ?? ''} className="h-full w-full object-cover" />
                      : <div className="flex h-full items-center justify-center text-on-surface-variant"><span className="material-symbols-outlined text-[42px]">image_not_supported</span></div>}
                  </div>
                  <div className="p-md">
                    <p className="line-clamp-2 text-label-md font-bold text-primary">{p.title}</p>
                    <p className="mt-xs text-body-sm text-on-surface-variant">{p.store.domain} · {formatDate(p.firstSeenAt)}</p>
                    <p className="text-body-sm text-on-surface-variant">{priceText(p.priceMin, p.priceMax)}</p>
                    <button onClick={() => saveIdea(p)} className="mt-sm text-secondary text-label-sm hover:underline">＋ Save IDEA</button>
                  </div>
                </article>
              ))}
            </div>
          )}

          {tab === 'ideas' && (
            <ul className="space-y-sm">
              {ideas.map(i => (
                <li key={i.id} className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
                  <p className="text-label-md text-primary">{i.title}</p>
                  <p className="text-body-sm text-on-surface-variant">{i.status} · {formatDate(i.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </main>
      </div>
    </RoleGate>
  )
}
```

- [ ] **Step 2: Manual verification in browser**

Open `http://localhost:3002/tools/spy-idea`.
- Stores tab: add a real Shopify domain, click "Scan now", confirm the store's product count increases.
- Products tab: confirm product cards render from DB with dates in MM/DD/YYYY; click "Save IDEA".
- Ideas tab: confirm the saved idea appears.

- [ ] **Step 3: Run full test suite + lint**

Run: `npm test`
Expected: all pass.
Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/tools/spy-idea/page.tsx
git commit -m "feat(spy): evolve Spy Idea page into persistent stores/products/ideas dashboard"
```

---

## Self-Review

**Spec coverage (Phase 1 slice of spec §10.1 + §11):**
- Full DB (all 10 models) → Task 1. ✓
- Reuse existing helpers (§11.1) → Task 2. ✓
- Field alignment (§11.4) → Task 1 (`SpyProduct` fields) + Task 3 (`mapShopifyProduct`). ✓
- Store products scanner 2×/day (§5.1) → Tasks 4–6 + Task 11. ✓
- Entity + observation + provenance `scanId` (§3) → Task 5 (`SpyProductSnapshot` w/ scanId) + Task 6 (`SpyScan`). ✓
- Store list persisted (§11.3) → Task 7 + Task 12 (Stores tab). ✓
- New-product + niche signals (§6) → Task 9. ✓
- IDEA vault w/ durable `snapshotJson` (§4, §8) → Task 10 + Task 12 (Save IDEA). ✓
- Routing under `/tools/spy-idea` (§11.2) → Task 12. ✓
- Ad Library / keyword trending → **out of scope for Phase 1** (tables created in Task 1; scanners are Phase 2/3, separate plans). Noted, not a gap.

**Placeholder scan:** No TBD/TODO; every code + test step contains real content. ✓

**Type consistency:** `ParsedSpyProduct` defined in Task 3 and consumed identically in Tasks 4–5. `runStoreProductScan` signature in Task 6 matches its callers in Tasks 8 & 11. `normalizeDomain` (Task 2) used in Task 7. `groupByNiche`/`isNewProduct` (Task 9) match test + route usage. ✓

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.
