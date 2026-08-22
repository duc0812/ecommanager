# Spy Phase C — Best Seller (scheduled scrape + rank trend) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Populate the Product Spy → Best Seller view by scraping each Shopify store's best-selling collection on the existing 2×/day cron, storing rank snapshots, and showing best-sellers with rank-trend (▲▼), filterable by Domain × Niche × Product type.

**Architecture:** New `SpyBestSeller` snapshot table (rank + prevRank). `fetchStoreBestSellers` discovers the best-seller collection handle via `/collections.json` (handles differ per store — proven by spike), then reads `/collections/{handle}/products.json` (order = rank). Ingest upserts into `SpyProduct` (shared `upsertStoreProduct` helper) then writes a rank row. A `runStoreBestSellerScan` runs right after `runStoreProductScan` in both the scheduler and the manual scan route. `GET /api/spy/best-sellers` returns latest-scan rows grouped by store; the view renders `ProductCard` with rank/trend badges.

**Tech Stack:** Next.js 14.2 App Router (`'use client'` pages), Prisma v7 + SQLite, Vitest, Tailwind tokens, `material-symbols-outlined`.

**Spec:** `docs/superpowers/specs/2026-08-22-spy-phase-c-best-seller-design.md`

## Global Constraints

- **Prisma:** NEVER add `url` to `datasource db {}`. After the schema change run `npx prisma migrate dev --name add_spy_best_seller` then `npx prisma generate`, then bump `SCHEMA_VERSION` in `src/lib/db.ts` **v29 → v30**. Import client only via `import { prisma } from '@/lib/db'`.
- **Reuse** `mapShopifyProduct`/`normalizeStoreUrl` from `@/lib/spy/shopify`, `parseKeywords`/`nicheOrWhere` from `@/lib/spy/niche`, `domainVariants` from `@/lib/spy/domain-filter`. Do NOT fork them.
- **Do NOT change** the public behavior of `ingestStoreProducts` — `src/lib/spy/ingest-products.test.ts` must stay green after the `upsertStoreProduct` extraction (same prisma calls: `spyProduct.findUnique` → `spyProduct.upsert` → conditional `spyProductSnapshot.create`).
- **Do NOT touch** ad scan / `scan-ads` / ad cron. Only the store product path.
- **Pages:** `'use client'`, `<RoleGate>` + `<Sidebar/>`, `main.ml-[280px] flex-1 p-xl`, Tailwind tokens, material-symbols icons, dates en-US, no code comments.
- **API routes:** named exports, `NextResponse.json(...)`.
- The 2 `src/lib/order-profit.test.ts` failures are pre-existing/unrelated — ignore.

---

## File Structure

**New:**
- `prisma/migrations/<ts>_add_spy_best_seller/migration.sql`
- `src/lib/spy/best-seller.ts` (+ `.test.ts`) — pure `rankDelta`.
- `src/lib/spy/best-seller-schema.test.ts` — delegate smoke test.
- `src/lib/spy/scan-best-sellers.ts` (+ `.test.ts`) — `pickBestSellerHandle` + `fetchStoreBestSellers`.
- `src/lib/spy/ingest-best-sellers.ts` — `ingestStoreBestSellers`.
- `src/app/api/spy/best-sellers/route.ts`.

**Modified:**
- `prisma/schema.prisma` — `SpyBestSeller` + back-relations on `SpyStore`/`SpyProduct`/`SpyScan`.
- `src/lib/db.ts` — SCHEMA_VERSION v30.
- `src/lib/spy/ingest-products.ts` — extract `upsertStoreProduct` (behavior-preserving).
- `src/lib/spy/scan-runner.ts` — add `runStoreBestSellerScan`.
- `src/lib/spy/scheduler.ts` — `scanAllStores` runs best-seller after product.
- `src/app/api/spy/scan/route.ts` — run best-seller after product.
- `src/components/spy/ProductCard.tsx` — optional `rank`/`rankDelta` badges.
- `src/app/tools/spy-idea/page.tsx` — Best Seller view replaces the stub.

---

## Task 1: SpyBestSeller model + migration

**Files:** Modify `prisma/schema.prisma`, `src/lib/db.ts`; create migration; Test `src/lib/spy/best-seller-schema.test.ts`.

**Interfaces:** Produces `prisma.spyBestSeller` delegate; relations `SpyStore.bestSellers`, `SpyProduct.bestSellers`, `SpyScan.bestSellers`.

- [ ] **Step 1: Add the model + back-relations**

In `prisma/schema.prisma`, add the model (near the other Spy models):

```prisma
model SpyBestSeller {
  id         String     @id @default(cuid())
  storeId    String
  store      SpyStore   @relation(fields: [storeId], references: [id], onDelete: Cascade)
  productId  String
  product    SpyProduct @relation(fields: [productId], references: [id], onDelete: Cascade)
  scanId     String
  scan       SpyScan    @relation(fields: [scanId], references: [id])
  rank       Int
  prevRank   Int?
  capturedAt DateTime   @default(now())

  @@index([storeId, capturedAt])
  @@index([productId])
  @@index([scanId])
}
```

Add the back-relation field to each existing model (a line inside the model body, next to its other relations):
- `SpyStore` → `bestSellers SpyBestSeller[]`
- `SpyProduct` → `bestSellers SpyBestSeller[]`
- `SpyScan` → `bestSellers SpyBestSeller[]`

- [ ] **Step 2: Migrate + generate + bump version**

Run:
```bash
npx prisma migrate dev --name add_spy_best_seller
npx prisma generate
```
Then set `SCHEMA_VERSION` in `src/lib/db.ts` from `'v29'` to `'v30'`. Confirm `migration.sql` only `CREATE TABLE "SpyBestSeller"` + its indexes (additive; no DROP/ALTER of existing tables). If migrate prompts to reset the DB, STOP (do not reset) and report BLOCKED.

- [ ] **Step 3: Delegate smoke test**

Create `src/lib/spy/best-seller-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/db'

describe('SpyBestSeller schema', () => {
  it('exposes the spyBestSeller delegate', () => {
    expect(typeof prisma.spyBestSeller.findMany).toBe('function')
    expect(typeof prisma.spyBestSeller.create).toBe('function')
  })
})
```

- [ ] **Step 4: Run test + commit**

Run: `npx vitest run src/lib/spy/best-seller-schema.test.ts` (PASS). `npx tsc --noEmit` (0).
```bash
git add prisma/schema.prisma prisma/migrations src/lib/db.ts src/lib/spy/best-seller-schema.test.ts
git commit -m "feat(spy): SpyBestSeller model + migration (v30)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Pure trend helper + best-seller fetch (handle discovery)

**Files:** Create `src/lib/spy/best-seller.ts` (+ `.test.ts`), `src/lib/spy/scan-best-sellers.ts` (+ `.test.ts`).

**Interfaces:**
- Produces `rankDelta(rank, prevRank): number | null` from `@/lib/spy/best-seller`.
- Produces `pickBestSellerHandle(collections): string | null` and `fetchStoreBestSellers(domain): Promise<{ products: ParsedSpyProduct[]; totalScanned: number; handle: string | null }>` from `@/lib/spy/scan-best-sellers`.

- [ ] **Step 1: Failing test for rankDelta**

Create `src/lib/spy/best-seller.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { rankDelta } from './best-seller'

describe('rankDelta', () => {
  it('returns null when prevRank is missing (NEW)', () => {
    expect(rankDelta(3, null)).toBeNull()
    expect(rankDelta(3, undefined)).toBeNull()
  })
  it('is positive when the product climbed (rank got smaller)', () => {
    expect(rankDelta(3, 5)).toBe(2)
  })
  it('is negative when the product dropped', () => {
    expect(rankDelta(5, 3)).toBe(-2)
  })
  it('is 0 when unchanged', () => {
    expect(rankDelta(4, 4)).toBe(0)
  })
})
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module './best-seller'`). Run: `npx vitest run src/lib/spy/best-seller.test.ts`.

- [ ] **Step 3: Implement best-seller.ts**

```ts
export function rankDelta(rank: number, prevRank: number | null | undefined): number | null {
  if (prevRank == null) return null
  return prevRank - rank
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Failing tests for the fetch module**

Create `src/lib/spy/scan-best-sellers.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { pickBestSellerHandle, fetchStoreBestSellers } from './scan-best-sellers'

afterEach(() => vi.restoreAllMocks())

describe('pickBestSellerHandle', () => {
  it('prefers exact best-selling handle', () => {
    expect(pickBestSellerHandle([{ handle: 'all' }, { handle: 'best-selling' }])).toBe('best-selling')
  })
  it('falls back to the singular best-seller handle', () => {
    expect(pickBestSellerHandle([{ handle: 'best-seller', title: 'Best Seller' }])).toBe('best-seller')
  })
  it('matches by title containing best + sell', () => {
    expect(pickBestSellerHandle([{ handle: 'top', title: 'Our Best Sellers' }])).toBe('top')
  })
  it('returns null when nothing matches', () => {
    expect(pickBestSellerHandle([{ handle: 'all', title: 'All' }, { handle: 'new', title: 'New In' }])).toBeNull()
  })
})

describe('fetchStoreBestSellers', () => {
  it('discovers the handle then maps products in rank order', async () => {
    const collections = { collections: [{ handle: 'all', title: 'All' }, { handle: 'best-seller', title: 'Best Seller' }] }
    const products = { products: [
      { id: 10, title: 'Top', handle: 't', variants: [{ price: '9.99', available: true }] },
      { id: 11, title: 'Second', handle: 's', variants: [] },
    ] }
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => collections } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => products } as Response)
    const { products: out, totalScanned, handle } = await fetchStoreBestSellers('foo.com')
    expect(handle).toBe('best-seller')
    expect(totalScanned).toBe(2)
    expect(out[0].externalProductId).toBe('10')
  })
  it('returns empty when no best-seller collection exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ collections: [{ handle: 'all' }] }) } as Response)
    const r = await fetchStoreBestSellers('foo.com')
    expect(r).toEqual({ products: [], totalScanned: 0, handle: null })
  })
  it('returns empty (with handle) when the collection has no products (404)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ collections: [{ handle: 'best-selling' }] }) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
    const r = await fetchStoreBestSellers('foo.com')
    expect(r).toEqual({ products: [], totalScanned: 0, handle: 'best-selling' })
  })
  it('throws when collections.json errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' } as Response)
    await expect(fetchStoreBestSellers('foo.com')).rejects.toThrow('500')
  })
})
```

- [ ] **Step 6: Run → FAIL** (module missing).

- [ ] **Step 7: Implement scan-best-sellers.ts**

```ts
import { normalizeStoreUrl, mapShopifyProduct, type ParsedSpyProduct, type ShopifyRawProduct } from '@/lib/spy/shopify'

const HANDLE_PRIORITY = ['best-selling', 'best-sellers', 'best-seller', 'bestsellers', 'bestseller', 'best-selling-products']

export function pickBestSellerHandle(collections: { handle: string; title?: string | null }[]): string | null {
  const byHandle = new Map(collections.map(c => [String(c.handle ?? '').toLowerCase(), c.handle]))
  for (const h of HANDLE_PRIORITY) { const hit = byHandle.get(h); if (hit) return hit }
  for (const c of collections) {
    const s = `${c.handle ?? ''} ${c.title ?? ''}`.toLowerCase()
    if (s.includes('best') && s.includes('sell')) return c.handle
  }
  return null
}

async function getJson(url: string): Promise<{ status: number; data: any }> {
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { accept: 'application/json', 'user-agent': 'EcomManagerSpy/1.0' },
    signal: AbortSignal.timeout(20000),
  })
  if (res.status === 404) return { status: 404, data: null }
  if (!res.ok) throw new Error(`Store returned ${res.status} ${res.statusText ?? ''}`.trim())
  return { status: res.status, data: await res.json() }
}

export async function fetchStoreBestSellers(domain: string): Promise<{ products: ParsedSpyProduct[]; totalScanned: number; handle: string | null }> {
  const origin = normalizeStoreUrl(domain)
  const col = await getJson(`${origin}/collections.json?limit=250`)
  const collections: { handle: string; title?: string | null }[] = Array.isArray(col.data?.collections) ? col.data.collections : []
  if (collections.length === 0) return { products: [], totalScanned: 0, handle: null }
  const handle = pickBestSellerHandle(collections)
  if (!handle) return { products: [], totalScanned: 0, handle: null }
  const prod = await getJson(`${origin}/collections/${handle}/products.json?limit=250`)
  const raw: ShopifyRawProduct[] = Array.isArray(prod.data?.products) ? prod.data.products : []
  return { products: raw.map(p => mapShopifyProduct(p, origin)), totalScanned: raw.length, handle }
}
```

- [ ] **Step 8: Run → PASS, tsc, commit**

Run: `npx vitest run src/lib/spy/best-seller.test.ts src/lib/spy/scan-best-sellers.test.ts` (PASS). `npx tsc --noEmit` (0).
```bash
git add src/lib/spy/best-seller.ts src/lib/spy/best-seller.test.ts src/lib/spy/scan-best-sellers.ts src/lib/spy/scan-best-sellers.test.ts
git commit -m "feat(spy): best-seller rankDelta + collection-handle discovery fetch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Ingest + runner + cron/manual wiring

**Files:** Modify `src/lib/spy/ingest-products.ts`, `src/lib/spy/scan-runner.ts`, `src/lib/spy/scheduler.ts`, `src/app/api/spy/scan/route.ts`; create `src/lib/spy/ingest-best-sellers.ts`.

**Interfaces:**
- Consumes: `fetchStoreBestSellers` (T2), `prisma.spyBestSeller` (T1).
- Produces: `upsertStoreProduct(storeId, scanId, p, now): Promise<{ id: string; created: boolean }>`; `ingestStoreBestSellers(storeId, scanId, products): Promise<{ found: number }>`; `runStoreBestSellerScan(store)`.

- [ ] **Step 1: Extract `upsertStoreProduct` (behavior-preserving)**

Rewrite `src/lib/spy/ingest-products.ts` to:

```ts
import { prisma } from '@/lib/db'
import type { ParsedSpyProduct } from '@/lib/spy/shopify'

export async function upsertStoreProduct(
  storeId: string, scanId: string, p: ParsedSpyProduct, now: Date,
): Promise<{ id: string; created: boolean }> {
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
    const changed = existing.priceMin !== p.priceMin || existing.priceMax !== p.priceMax || existing.title !== p.title
    if (changed) {
      await prisma.spyProductSnapshot.create({
        data: { productId: row.id, scanId, title: p.title, priceMin: p.priceMin, priceMax: p.priceMax, available: p.availableVariantCount > 0 },
      })
    }
  }
  return { id: row.id, created: !existing }
}

export async function ingestStoreProducts(
  storeId: string, scanId: string, products: ParsedSpyProduct[],
): Promise<{ found: number; created: number; updated: number }> {
  let created = 0, updated = 0
  const now = new Date()
  for (const p of products) {
    const { created: wasCreated } = await upsertStoreProduct(storeId, scanId, p, now)
    if (wasCreated) created++
    else updated++
  }
  return { found: products.length, created, updated }
}
```

- [ ] **Step 2: Confirm the existing ingest test still passes**

Run: `npx vitest run src/lib/spy/ingest-products.test.ts`
Expected: PASS (same prisma calls: findUnique→upsert, no snapshot when findUnique returns null; `res.found === 2`, 2 upserts).

- [ ] **Step 3: Create `ingest-best-sellers.ts`**

```ts
import { prisma } from '@/lib/db'
import type { ParsedSpyProduct } from '@/lib/spy/shopify'
import { upsertStoreProduct } from '@/lib/spy/ingest-products'

export async function ingestStoreBestSellers(
  storeId: string, scanId: string, products: ParsedSpyProduct[],
): Promise<{ found: number }> {
  const now = new Date()
  for (let i = 0; i < products.length; i++) {
    const { id } = await upsertStoreProduct(storeId, scanId, products[i], now)
    const prev = await prisma.spyBestSeller.findFirst({
      where: { storeId, productId: id }, orderBy: { capturedAt: 'desc' }, select: { rank: true },
    })
    await prisma.spyBestSeller.create({
      data: { storeId, productId: id, scanId, rank: i + 1, prevRank: prev?.rank ?? null },
    })
  }
  return { found: products.length }
}
```

- [ ] **Step 4: Add `runStoreBestSellerScan` to `scan-runner.ts`**

Append to `src/lib/spy/scan-runner.ts` (and add the two imports at top):

```ts
import { fetchStoreBestSellers } from './scan-best-sellers'
import { ingestStoreBestSellers } from './ingest-best-sellers'

export async function runStoreBestSellerScan(store: { id: string; domain: string }) {
  const scan = await prisma.spyScan.create({
    data: { type: 'STORE_BESTSELLER', targetType: 'STORE', targetId: store.id, status: 'running' },
  })
  try {
    const { products, totalScanned, handle } = await fetchStoreBestSellers(store.domain)
    const ingest = await ingestStoreBestSellers(store.id, scan.id, products)
    const stats = { handle, totalScanned, ...ingest }
    await prisma.spyScan.update({ where: { id: scan.id }, data: { status: 'success', stats: JSON.stringify(stats), finishedAt: new Date() } })
    return { scanId: scan.id, status: 'success' as const, stats }
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : 'Unknown error'
    await prisma.spyScan.update({ where: { id: scan.id }, data: { status: 'failed', error, finishedAt: new Date() } })
    return { scanId: scan.id, status: 'failed' as const, error }
  }
}
```

- [ ] **Step 5: Wire the scheduler**

In `src/lib/spy/scheduler.ts`: import `runStoreBestSellerScan` from `./scan-runner`, and update `scanAllStores`:

```ts
async function scanAllStores() {
  const stores = await prisma.spyStore.findMany({ where: { status: 'active' } })
  for (const s of stores) {
    try { await runStoreProductScan(s) }
    catch (e) { console.error('[spy-scheduler] scan failed for', s.domain, e) }
    try { await runStoreBestSellerScan(s) }
    catch (e) { console.error('[spy-scheduler] best-seller scan failed for', s.domain, e) }
  }
  console.log(`[spy-scheduler] product + best-seller scan done for ${stores.length} store(s)`)
}
```

- [ ] **Step 6: Wire the manual scan route**

In `src/app/api/spy/scan/route.ts`: import `runStoreBestSellerScan` and run it after the product scan (keep the response shape):

```ts
import { runStoreProductScan, runStoreBestSellerScan } from '@/lib/spy/scan-runner'
...
  for (const s of stores) {
    const r = await runStoreProductScan(s)
    await runStoreBestSellerScan(s)
    results.push({ store: s.domain, ...r })
  }
```

- [ ] **Step 7: Typecheck + tests + commit**

Run: `npx tsc --noEmit` (0). `npx vitest run src/lib/spy/ingest-products.test.ts` (PASS).
```bash
git add src/lib/spy/ingest-products.ts src/lib/spy/ingest-best-sellers.ts src/lib/spy/scan-runner.ts src/lib/spy/scheduler.ts src/app/api/spy/scan/route.ts
git commit -m "feat(spy): best-seller ingest + runner wired into product scan (cron + manual)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: GET /api/spy/best-sellers

**Files:** Create `src/app/api/spy/best-sellers/route.ts`.

**Interfaces:**
- Consumes: `domainVariants` (`@/lib/spy/domain-filter`), `parseKeywords`/`nicheOrWhere` (`@/lib/spy/niche`), `rankDelta` (`@/lib/spy/best-seller`), `prisma.spyBestSeller`/`spyScan`.
- Produces: `GET /api/spy/best-sellers?domain=&nicheId=&productTypeId=&limit=` → `{ groups: Array<{ store: { domain: string }, items: Array<product & { rank, prevRank, delta }> }> }`.

- [ ] **Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { domainVariants } from '@/lib/spy/domain-filter'
import { parseKeywords, nicheOrWhere } from '@/lib/spy/niche'
import { rankDelta } from '@/lib/spy/best-seller'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const domain = searchParams.get('domain') || undefined
  const nicheId = searchParams.get('nicheId') || undefined
  const productTypeId = searchParams.get('productTypeId') || undefined
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '12', 10) || 12, 100)

  const stores = domain
    ? await prisma.spyStore.findMany({ where: { domain: { in: domainVariants(domain) } }, select: { id: true, domain: true } })
    : await prisma.spyStore.findMany({ where: { status: 'active' }, select: { id: true, domain: true }, orderBy: { domain: 'asc' } })

  const prodAnd: any[] = []
  if (nicheId) {
    const n = await prisma.spyNiche.findUnique({ where: { id: nicheId }, select: { keywords: true } })
    const nw = nicheOrWhere(parseKeywords(n?.keywords), ['title'])
    if (nw) prodAnd.push(nw)
  }
  if (productTypeId) {
    const pt = await prisma.spyProductType.findUnique({ where: { id: productTypeId }, select: { keywords: true } })
    const pw = nicheOrWhere(parseKeywords(pt?.keywords), ['title'])
    if (pw) prodAnd.push(pw)
  }
  const productWhere = prodAnd.length ? { AND: prodAnd } : undefined

  const groups: any[] = []
  for (const s of stores) {
    const scan = await prisma.spyScan.findFirst({
      where: { type: 'STORE_BESTSELLER', targetId: s.id, status: 'success' },
      orderBy: { startedAt: 'desc' }, select: { id: true },
    })
    if (!scan) continue
    const rows = await prisma.spyBestSeller.findMany({
      where: { scanId: scan.id, ...(productWhere ? { product: productWhere } : {}) },
      orderBy: { rank: 'asc' }, take: limit,
      include: { product: { include: { store: { select: { domain: true } } } } },
    })
    if (rows.length === 0) continue
    const items = rows.map(r => ({ ...r.product, rank: r.rank, prevRank: r.prevRank, delta: rankDelta(r.rank, r.prevRank) }))
    groups.push({ store: { domain: s.domain }, items })
  }
  return NextResponse.json({ groups })
}
```

- [ ] **Step 2: Typecheck + build + commit**

Run: `npx tsc --noEmit` (0). `npm run build` (success; `/api/spy/best-sellers` in route list).
```bash
git add src/app/api/spy/best-sellers/route.ts
git commit -m "feat(spy): GET /api/spy/best-sellers (latest-scan rows grouped by store)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Best Seller view (ProductCard badges + grouped/flat)

**Files:** Modify `src/components/spy/ProductCard.tsx`, `src/app/tools/spy-idea/page.tsx`.

**Interfaces:**
- Consumes: `GET /api/spy/best-sellers` (T4); `ProductCard` with new optional props.
- Produces: `ProductCard` accepts optional `rank?: number` and `rankDelta?: number | null`.

- [ ] **Step 1: Add rank/trend badges to ProductCard**

Rewrite `src/components/spy/ProductCard.tsx`:

```tsx
'use client'

export type Product = { id: string; title: string | null; handle: string | null; imageUrl: string | null; priceMin: number | null; priceMax: number | null; firstSeenAt: string; productType: string | null; store: { domain: string } }

function formatDate(v: string | null) {
  if (!v) return '-'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}
function priceText(min: number | null, max: number | null) {
  if (min == null || max == null) return '-'
  return min === max ? `$${min.toFixed(2)}` : `$${min.toFixed(2)} - $${max.toFixed(2)}`
}
function TrendBadge({ delta }: { delta?: number | null }) {
  if (delta === null || delta === undefined) return <span className="rounded-full bg-secondary/15 px-sm py-xs text-label-sm text-secondary">NEW</span>
  if (delta > 0) return <span className="rounded-full bg-on-tertiary-container/15 px-sm py-xs text-label-sm text-on-tertiary-container">▲{delta}</span>
  if (delta < 0) return <span className="rounded-full bg-error/10 px-sm py-xs text-label-sm text-error">▼{Math.abs(delta)}</span>
  return <span className="rounded-full bg-surface-container px-sm py-xs text-label-sm text-on-surface-variant">—</span>
}

export default function ProductCard({ p, onSave, rank, rankDelta }: { p: Product; onSave: (p: Product) => void; rank?: number; rankDelta?: number | null }) {
  return (
    <article className="relative overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container-lowest">
      {rank !== undefined && (
        <div className="absolute left-xs top-xs z-10 flex items-center gap-xs">
          <span className="rounded-full bg-primary/85 px-sm py-xs text-label-sm text-on-primary">#{rank}</span>
          <TrendBadge delta={rankDelta} />
        </div>
      )}
      <div className="aspect-square bg-surface-container-low">
        {p.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.imageUrl} alt={p.title ?? ''} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-on-surface-variant"><span className="material-symbols-outlined text-[42px]">image_not_supported</span></div>
        )}
      </div>
      <div className="p-md">
        <p className="line-clamp-2 text-label-md font-bold text-primary">{p.title}</p>
        <p className="mt-xs text-body-sm text-on-surface-variant">{p.store.domain} · {formatDate(p.firstSeenAt)}</p>
        <p className="text-body-sm text-on-surface-variant">{priceText(p.priceMin, p.priceMax)}</p>
        <button onClick={() => onSave(p)} className="mt-sm text-secondary text-label-sm hover:underline">＋ Save IDEA</button>
      </div>
    </article>
  )
}
```

- [ ] **Step 2: Wire the Best Seller view in the browse page**

In `src/app/tools/spy-idea/page.tsx`:

(a) Add a type + state near the other state:
```tsx
type BestSellerItem = Product & { rank: number; prevRank: number | null; delta: number | null }
type BestSellerGroup = { store: { domain: string }; items: BestSellerItem[] }
```
```tsx
  const [bestSellers, setBestSellers] = useState<BestSellerGroup[]>([])
```

(b) In the results-fetch `useEffect`, add a branch for the best-seller view (alongside the existing `new-add` branch):
```tsx
    } else if (area === 'products' && view === 'best-seller') {
      const lim = sel.domain ? 50 : 12
      fetch(`/api/spy/best-sellers?limit=${lim}&${filterQuery()}`).then(r => r.json()).then(d => setBestSellers(d.groups ?? [])).catch(() => {})
    }
```

(c) Replace the current Best Seller stub block (`area === 'products' && view === 'best-seller'`) with:
```tsx
              {area === 'products' && view === 'best-seller' && (
                <div className="space-y-xl">
                  {bestSellers.map(g => (
                    <section key={g.store.domain}>
                      <h3 className="mb-md text-headline-sm text-primary">{g.store.domain}</h3>
                      <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {g.items.map(it => <ProductCard key={it.id} p={it} onSave={saveProductIdea} rank={it.rank} rankDelta={it.delta} />)}
                      </div>
                    </section>
                  ))}
                  {bestSellers.length === 0 && <p className="text-body-md text-on-surface-variant">No best sellers yet — scan a store first (Setup → Sources).</p>}
                </div>
              )}
```

(Keep the existing `import ProductCard, { Product } from '@/components/spy/ProductCard'`. `saveProductIdea` already exists.)

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit` (0). `npm run build` (success).

- [ ] **Step 4: Manual smoke (optional but recommended)**

On the dev server, log in, go to Product Spy → Best Seller. With Domain=All you should see per-store sections once a best-seller scan has run; selecting a domain shows that store's ranked list; Niche/Product type facets narrow it. (Trigger a scan via Setup → Sources → Scan now, or wait for cron.)

- [ ] **Step 5: Commit**

```bash
git add src/components/spy/ProductCard.tsx src/app/tools/spy-idea/page.tsx
git commit -m "feat(spy): Best Seller view with rank + trend badges

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes (author)

- **Spec coverage:** §3 model → T1; §4.1 rankDelta → T2; §4.2 pickBestSellerHandle+fetch (handle discovery) → T2; §4.3 upsertStoreProduct → T3; §4.4 ingestStoreBestSellers → T3; §4.5 runner → T3; §5 wiring → T3; §6 API → T4; §7 view → T5. ✅
- **Type consistency:** `fetchStoreBestSellers` returns `{products,totalScanned,handle}` (T2) consumed by runner (T3). API items = `product & {rank,prevRank,delta}` (T4) → `BestSellerItem` (T5) → `ProductCard` `rank`/`rankDelta`. `rankDelta` used in both `best-seller.ts` and API. ✅
- **Behavior preservation:** `upsertStoreProduct` keeps the exact prisma call sequence the ingest test asserts (T3 Step 2 gate). ✅
- **DB safety:** single additive migration (T1); SCHEMA_VERSION bumped once to v30. ✅
- **Empirical grounding:** handle discovery reflects the spike (best-selling vs best-seller vs title match); `.json` sort_by ignored → not used. ✅
