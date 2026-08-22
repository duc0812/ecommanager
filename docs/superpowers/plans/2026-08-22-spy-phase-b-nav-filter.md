# Spy Phase B — 2-area nav + left facet filter + Product-type taxonomy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the spy tool into two browse areas (Ad Library / Product Spy) that share a left facet sidebar filtering by Domain × Niche × Product type, where Product type is a user-defined keyword taxonomy mirroring Niche.

**Architecture:** Add a `SpyProductType` model parallel to `SpyNiche` (reusing the generic `niche.ts` helpers). Extend `/api/spy/ads` and `/api/spy/products` with `productTypeId` + `domain` params (AND-merged). Add `/api/spy/product-types` CRUD and `/api/spy/filters`. Rebuild `/tools/spy-idea` as a two-tier nav browse page with a `SpyFilterSidebar`; move source management to a new `/sources` page and taxonomy setup to `/product-types` + existing `/niches`; delete the dashboard page.

**Tech Stack:** Next.js 14.2 App Router (all pages `'use client'`), Prisma v7 + SQLite, Tailwind design tokens, `material-symbols-outlined`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-22-spy-phase-b-nav-filter-design.md`

## Global Constraints

- **Prisma:** NEVER add `url` to the `datasource db {}` block. After any schema change run `npx prisma migrate dev --name <x>` then `npx prisma generate`, then bump `SCHEMA_VERSION` in `src/lib/db.ts`. Import the client only via `import { prisma } from '@/lib/db'`.
- **SCHEMA_VERSION:** bump `v28` → `v29` (Task 1 only).
- **Do NOT modify** `SpyNiche`, `/api/spy/niches`, or the `/tools/spy-idea/niches` URL contract. The niches page may be refactored internally to reuse `TaxonomyEditor`, but its route and API stay identical.
- **Reuse** `src/lib/spy/niche.ts` (`parseKeywords`, `nicheOrWhere`) as-is for product types — do not fork the helpers.
- **Pages:** `'use client'`; render `<Sidebar />` inside `<div className="flex min-h-screen bg-surface">` with `<main className="ml-[280px] flex-1 p-xl">`; wrap in `<RoleGate>`. Tailwind tokens only. Icons via `<span className="material-symbols-outlined">`. No code comments. Dates formatted en-US.
- **API routes:** `src/app/api/<feature>/<action>/route.ts`, named exports `GET/POST/PATCH/DELETE`, return `NextResponse.json(...)`.
- Do NOT touch scan/cron/ingest logic. The two pre-existing `src/lib/order-profit.test.ts` failures are unrelated — leave them.

---

## File Structure

**New:**
- `prisma/migrations/<ts>_add_spy_product_type/migration.sql` — additive table.
- `src/lib/spy/domain-filter.ts` (+ `.test.ts`) — pure `bareDomain` / `domainVariants`.
- `src/lib/spy/product-type-schema.test.ts` — delegate smoke test.
- `src/app/api/spy/product-types/route.ts` — CRUD (mirror niches).
- `src/app/api/spy/filters/route.ts` — facet options.
- `src/components/spy/AdCard.tsx` — extracted shared ad card + `Ad`/`AdSignals` types.
- `src/components/spy/ProductCard.tsx` — extracted shared product card + `Product` type.
- `src/components/spy/TaxonomyEditor.tsx` — shared add-form + row editor for keyword taxonomies.
- `src/components/spy/SpyFilterSidebar.tsx` — left facet sidebar.
- `src/app/tools/spy-idea/sources/page.tsx` — store + ad-domain/fanpage management.
- `src/app/tools/spy-idea/product-types/page.tsx` — product-type setup.

**Modified:**
- `prisma/schema.prisma` — add `SpyProductType`.
- `src/lib/db.ts` — `SCHEMA_VERSION` v28→v29.
- `src/app/api/spy/ads/route.ts` — `productTypeId` + `domain` params; `launching`/`winning` flags.
- `src/app/api/spy/products/route.ts` — `productTypeId` + `domain` params.
- `src/app/tools/spy-idea/page.tsx` — rebuilt browse page.
- `src/app/tools/spy-idea/niches/page.tsx` — refactor to use `TaxonomyEditor` (API/URL unchanged).
- `src/components/Sidebar.tsx` — spy link points to `/tools/spy-idea`; drop dashboard link if present.

**Deleted:**
- `src/app/tools/spy-idea/dashboard/page.tsx` — replaced by Ad Library → Winning.

---

## Task 1: SpyProductType model + migration + CRUD

**Files:**
- Modify: `prisma/schema.prisma` (after `SpyNiche`)
- Modify: `src/lib/db.ts` (SCHEMA_VERSION)
- Create: `prisma/migrations/<ts>_add_spy_product_type/migration.sql` (via migrate)
- Create: `src/app/api/spy/product-types/route.ts`
- Test: `src/lib/spy/product-type-schema.test.ts`

**Interfaces:**
- Produces: `prisma.spyProductType` delegate; `/api/spy/product-types` GET/POST/PATCH/DELETE with the same contract as `/api/spy/niches` (POST/PATCH `keywords` accepts array or comma/newline string; upsert by `name`).

- [ ] **Step 1: Add the model to the schema**

In `prisma/schema.prisma`, immediately after the `SpyNiche` model:

```prisma
model SpyProductType {
  id        String   @id @default(cuid())
  name      String   @unique
  keywords  String   @default("[]")
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
}
```

- [ ] **Step 2: Run the migration + regenerate + bump version**

Run:
```bash
npx prisma migrate dev --name add_spy_product_type
npx prisma generate
```
Then in `src/lib/db.ts` change `SCHEMA_VERSION` from `'v28'` to `'v29'`.
Confirm the generated `migration.sql` is a single `CREATE TABLE "SpyProductType"` + `CREATE UNIQUE INDEX "SpyProductType_name_key"` (additive only, no DROP/ALTER of existing tables).

- [ ] **Step 3: Write the delegate smoke test**

Create `src/lib/spy/product-type-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/db'

describe('SpyProductType schema', () => {
  it('exposes the spyProductType delegate', () => {
    expect(typeof prisma.spyProductType.findMany).toBe('function')
    expect(typeof prisma.spyProductType.upsert).toBe('function')
  })
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/spy/product-type-schema.test.ts`
Expected: PASS (delegate exists after generate).

- [ ] **Step 5: Write the CRUD route**

Create `src/app/api/spy/product-types/route.ts` (mirror of niches route, swapping the delegate):

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

function normKeywords(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(k => String(k).trim()).filter(Boolean)
  return String(v ?? '').split(/[\n,]/).map(k => k.trim()).filter(Boolean)
}

export async function GET() {
  const rows = await prisma.spyProductType.findMany({ orderBy: { name: 'asc' } })
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  const name = String(b.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
  const keywords = JSON.stringify(normKeywords(b.keywords))
  const row = await prisma.spyProductType.upsert({
    where: { name },
    create: { name, keywords },
    update: { keywords },
  })
  return NextResponse.json(row)
}

export async function PATCH(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const data: Record<string, unknown> = {}
  if ('name' in b) data.name = String(b.name).trim()
  if ('keywords' in b) data.keywords = JSON.stringify(normKeywords(b.keywords))
  if ('active' in b) data.active = Boolean(b.active)
  const row = await prisma.spyProductType.update({ where: { id: b.id }, data })
  return NextResponse.json(row)
}

export async function DELETE(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await prisma.spyProductType.delete({ where: { id: b.id } })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit` (expect 0 errors).
```bash
git add prisma/schema.prisma prisma/migrations src/lib/db.ts src/app/api/spy/product-types/route.ts src/lib/spy/product-type-schema.test.ts
git commit -m "feat(spy): SpyProductType model + CRUD (mirror niche)"
```

---

## Task 2: Filters API + domain/productType params on ads & products

**Files:**
- Create: `src/lib/spy/domain-filter.ts`
- Test: `src/lib/spy/domain-filter.test.ts`
- Create: `src/app/api/spy/filters/route.ts`
- Modify: `src/app/api/spy/ads/route.ts`
- Modify: `src/app/api/spy/products/route.ts`

**Interfaces:**
- Consumes: `parseKeywords`, `nicheOrWhere` from `@/lib/spy/niche`; `prisma.spyProductType` (Task 1).
- Produces:
  - `bareDomain(input: string): string` and `domainVariants(input: string): string[]` from `@/lib/spy/domain-filter`.
  - `GET /api/spy/filters` → `{ domains: string[]; niches: {id:string;name:string}[]; productTypes: {id:string;name:string}[] }`.
  - `/api/spy/ads` accepts `domain`, `productTypeId`, and `filter` values `launching`/`winning` (plus existing).
  - `/api/spy/products` accepts `domain`, `productTypeId`.

- [ ] **Step 1: Write failing tests for the domain helper**

Create `src/lib/spy/domain-filter.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { bareDomain, domainVariants } from '@/lib/spy/domain-filter'

describe('bareDomain', () => {
  it('lowercases and strips protocol, path, and www', () => {
    expect(bareDomain('https://WWW.FamilyStore.com/collections')).toBe('familystore.com')
    expect(bareDomain('familystore.com')).toBe('familystore.com')
    expect(bareDomain('www.homesizy.com')).toBe('homesizy.com')
  })
  it('returns empty string for blank input', () => {
    expect(bareDomain('   ')).toBe('')
  })
})

describe('domainVariants', () => {
  it('returns the bare and www-prefixed variants', () => {
    expect(domainVariants('familystore.com')).toEqual(['familystore.com', 'www.familystore.com'])
    expect(domainVariants('www.familystore.com')).toEqual(['familystore.com', 'www.familystore.com'])
  })
  it('returns [] for blank input', () => {
    expect(domainVariants('')).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/spy/domain-filter.test.ts`
Expected: FAIL ("Cannot find module '@/lib/spy/domain-filter'").

- [ ] **Step 3: Implement the domain helper**

Create `src/lib/spy/domain-filter.ts`:

```ts
export function bareDomain(input: string): string {
  return String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '')
}

export function domainVariants(input: string): string[] {
  const bare = bareDomain(input)
  return bare ? [bare, `www.${bare}`] : []
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/spy/domain-filter.test.ts`
Expected: PASS (6 assertions).

- [ ] **Step 5: Create the filters route**

Create `src/app/api/spy/filters/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { bareDomain } from '@/lib/spy/domain-filter'

export async function GET() {
  const [stores, adDomains, niches, productTypes] = await Promise.all([
    prisma.spyStore.findMany({ select: { domain: true } }),
    prisma.spyAdDomain.findMany({ select: { domain: true } }),
    prisma.spyNiche.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.spyProductType.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ])
  const domainSet = new Set<string>()
  for (const s of stores) { const d = bareDomain(s.domain); if (d) domainSet.add(d) }
  for (const a of adDomains) { const d = bareDomain(a.domain); if (d) domainSet.add(d) }
  const domains = Array.from(domainSet).sort()
  return NextResponse.json({ domains, niches, productTypes })
}
```

- [ ] **Step 6: Rewrite the ads route where-clause to an AND array + new params/flags**

Replace the body of `GET` in `src/app/api/spy/ads/route.ts`. Add imports at top:

```ts
import { domainVariants } from '@/lib/spy/domain-filter'
```

Read params and build `where` (replace the current `base`/`where`/`nicheId` block, lines ~10-25):

```ts
  const filter = searchParams.get('filter') || undefined
  const storeId = searchParams.get('storeId') || undefined
  const domainId = searchParams.get('domainId') || undefined
  const domain = searchParams.get('domain') || undefined
  const nicheId = searchParams.get('nicheId') || undefined
  const productTypeId = searchParams.get('productTypeId') || undefined
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '200', 10) || 200, 500)

  const and: any[] = []
  if (storeId) and.push({ advertiser: { storeId } })
  if (domainId) and.push({ advertiser: { adDomainId: domainId } })
  if (domain) {
    const v = domainVariants(domain)
    and.push({ advertiser: { OR: [{ store: { domain: { in: v } } }, { adDomain: { domain: { in: v } } }] } })
  }
  if (nicheId) {
    const n = await prisma.spyNiche.findUnique({ where: { id: nicheId }, select: { keywords: true } })
    const nw = nicheOrWhere(parseKeywords(n?.keywords), ['title', 'body'])
    if (nw) and.push(nw)
  }
  if (productTypeId) {
    const pt = await prisma.spyProductType.findUnique({ where: { id: productTypeId }, select: { keywords: true } })
    const pw = nicheOrWhere(parseKeywords(pt?.keywords), ['title', 'body'])
    if (pw) and.push(pw)
  }
  const where: any = and.length ? { AND: and } : {}
```

Then extend the `flags` map (after the existing entries) with:

```ts
    launching: x => x.signals.newProductLaunching,
    winning: x => x.signals.isLongRunning || x.signals.isScaling,
```

Leave the rest (query, enrich, filter application, response) unchanged.

- [ ] **Step 7: Add domain/productType params to the products route**

In `src/app/api/spy/products/route.ts`, add import:

```ts
import { domainVariants } from '@/lib/spy/domain-filter'
```

Replace the `base`/`where`/`nicheId` block (lines ~8-19) with:

```ts
  const storeId = searchParams.get('storeId') || undefined
  const domain = searchParams.get('domain') || undefined
  const nicheId = searchParams.get('nicheId') || undefined
  const productTypeId = searchParams.get('productTypeId') || undefined
  const days = Math.min(parseInt(searchParams.get('days') ?? '7', 10), 90)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '200', 10), 500)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const and: any[] = [{ firstSeenAt: { gte: since } }]
  if (storeId) and.push({ storeId })
  if (domain) and.push({ store: { domain: { in: domainVariants(domain) } } })
  if (nicheId) {
    const n = await prisma.spyNiche.findUnique({ where: { id: nicheId }, select: { keywords: true } })
    const nw = nicheOrWhere(parseKeywords(n?.keywords), ['title'])
    if (nw) and.push(nw)
  }
  if (productTypeId) {
    const pt = await prisma.spyProductType.findUnique({ where: { id: productTypeId }, select: { keywords: true } })
    const pw = nicheOrWhere(parseKeywords(pt?.keywords), ['title'])
    if (pw) and.push(pw)
  }
  const where: any = { AND: and }
```

Leave the `findMany` (using `where`) and response unchanged.

- [ ] **Step 8: Typecheck, run tests, commit**

Run: `npx tsc --noEmit` (expect 0). `npx vitest run src/lib/spy/domain-filter.test.ts` (PASS).
```bash
git add src/lib/spy/domain-filter.ts src/lib/spy/domain-filter.test.ts src/app/api/spy/filters/route.ts src/app/api/spy/ads/route.ts src/app/api/spy/products/route.ts
git commit -m "feat(spy): filters API + domain/productType filter on ads & products"
```

---

## Task 3: Extract shared components (AdCard, ProductCard, TaxonomyEditor)

**Files:**
- Create: `src/components/spy/AdCard.tsx`
- Create: `src/components/spy/ProductCard.tsx`
- Create: `src/components/spy/TaxonomyEditor.tsx`
- Modify: `src/app/tools/spy-idea/niches/page.tsx` (use TaxonomyEditor)

**Interfaces:**
- Produces:
  - `AdCard` (default export) + `export type Ad`, `export type AdSignals` from `@/components/spy/AdCard`. Props: `{ a: Ad; onSave: (a: Ad) => void }`.
  - `ProductCard` (default export) + `export type Product` from `@/components/spy/ProductCard`. Props: `{ p: Product; onSave: (p: Product) => void }`.
  - `TaxonomyEditor` (default export) from `@/components/spy/TaxonomyEditor`. Props: `{ title: string; endpoint: string; hint?: string }`. Self-contained: fetches `GET endpoint`, POST/PATCH/DELETE against the same endpoint.

- [ ] **Step 1: Create AdCard**

Create `src/components/spy/AdCard.tsx` by lifting the `AdCard` currently in `src/app/tools/spy-idea/page.tsx` (lines 15-49) and exporting the types. Include `startDate` in the meta line:

```tsx
'use client'

export type AdSignals = { isNew: boolean; activeDays: number; isLongRunning: boolean; isScaling: boolean; isStopped: boolean; adStyle: 'product'|'collection'|'homepage'|'other'|null; newProductLaunching: boolean }
export type Ad = { id: string; title: string | null; body: string | null; adArchiveId: string; adLibraryUrl: string | null; linkUrl?: string | null; isActive?: boolean; mediaUrl: string | null; mediaType: 'video'|'image'|'carousel'|'dco'|null; startDate: string | null; advertiser: { pageName: string | null }; signals: AdSignals }

const MEDIA_LABEL: Record<string, string> = { video: '🎬 Video', image: '🖼 Image', carousel: '🎠 Carousel', dco: 'DCO' }
const STYLE_LABEL: Record<string, string> = { product: 'Product', collection: 'Collection', homepage: 'Homepage', other: 'Other' }

function formatDate(v: string | null) {
  if (!v) return '-'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}

export default function AdCard({ a, onSave }: { a: Ad; onSave: (a: Ad) => void }) {
  const s = a.signals
  return (
    <article className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
      <div className="relative mb-sm">
        {a.mediaUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={a.mediaUrl} alt={a.title ?? ''} className="aspect-square w-full rounded-lg bg-surface-container-low object-contain" />
        ) : (
          <div className="flex aspect-square w-full items-center justify-center rounded-lg bg-surface-container-low text-on-surface-variant"><span className="material-symbols-outlined text-[36px]">image_not_supported</span></div>
        )}
        {a.mediaType && <span className="absolute right-xs top-xs rounded-full bg-primary/80 px-sm py-xs text-label-sm text-on-primary">{MEDIA_LABEL[a.mediaType]}</span>}
      </div>
      <div className="mb-xs flex flex-wrap gap-xs">
        {s.newProductLaunching && <span className="rounded-full bg-secondary/15 px-sm py-xs text-label-sm text-secondary">🚀 New Product Launching</span>}
        {s.adStyle && <span className="rounded-full bg-surface-container px-sm py-xs text-label-sm text-on-surface-variant">{STYLE_LABEL[s.adStyle]}</span>}
        {s.isNew && <span className="rounded-full bg-secondary/10 px-sm py-xs text-label-sm text-secondary">New</span>}
        {s.isLongRunning && <span className="rounded-full bg-on-tertiary-container/15 px-sm py-xs text-label-sm text-on-tertiary-container">Long-running</span>}
        {s.isScaling && <span className="rounded-full bg-primary/10 px-sm py-xs text-label-sm text-primary">Scaling</span>}
        {s.isStopped && <span className="rounded-full bg-error/10 px-sm py-xs text-label-sm text-error">Stopped</span>}
      </div>
      <p className="line-clamp-2 text-label-md font-bold text-primary">{a.title ?? a.advertiser.pageName ?? 'Ad'}</p>
      <p className="mt-xs line-clamp-2 text-body-sm text-on-surface-variant">{a.body}</p>
      <p className="mt-xs text-body-sm text-on-surface-variant">{a.advertiser.pageName} · {s.activeDays}d · {formatDate(a.startDate)}</p>
      {a.adLibraryUrl && <a href={a.adLibraryUrl} target="_blank" rel="noreferrer" className="mt-xs block truncate text-label-sm text-secondary hover:underline" title={a.adArchiveId}>#{a.adArchiveId}</a>}
      <div className="mt-sm flex items-center justify-between">
        <a href={`/tools/spy-idea/ads/${a.id}`} className="text-secondary text-label-sm hover:underline">Detail</a>
        <button onClick={() => onSave(a)} className="text-secondary text-label-sm hover:underline">＋ Save IDEA</button>
      </div>
    </article>
  )
}
```

- [ ] **Step 2: Create ProductCard**

Create `src/components/spy/ProductCard.tsx` by lifting the product `<article>` from `src/app/tools/spy-idea/page.tsx` (lines 237-254):

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

export default function ProductCard({ p, onSave }: { p: Product; onSave: (p: Product) => void }) {
  return (
    <article className="overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container-lowest">
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

- [ ] **Step 3: Create TaxonomyEditor**

Create `src/components/spy/TaxonomyEditor.tsx` (generalized from the niches page add-form + `NicheRow`):

```tsx
'use client'
import { useEffect, useState } from 'react'

type Row = { id: string; name: string; keywords: string; active: boolean }

function parseKw(json: string): string[] {
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.map(String) : [] } catch { return [] }
}

export default function TaxonomyEditor({ title, endpoint, hint }: { title: string; endpoint: string; hint?: string }) {
  const [rows, setRows] = useState<Row[]>([])
  const [name, setName] = useState('')
  const [keywords, setKeywords] = useState('')

  async function load() { setRows(await fetch(endpoint).then(r => r.json())) }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    if (!name.trim()) return
    await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, keywords }) })
    setName(''); setKeywords(''); load()
  }
  async function save(id: string, kw: string) {
    await fetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, keywords: kw }) })
    load()
  }
  async function remove(id: string) {
    await fetch(endpoint, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    load()
  }

  return (
    <>
      <section className="mb-xl rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
        <div className="grid grid-cols-1 gap-md md:grid-cols-[1fr_2fr_auto]">
          <input value={name} onChange={e => setName(e.target.value)} placeholder={`${title} name`}
            className="rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
          <input value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="keywords: comma, separated"
            className="rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
          <button onClick={add} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Add</button>
        </div>
        {hint && <p className="mt-xs text-body-sm text-on-surface-variant">{hint}</p>}
      </section>

      <ul className="space-y-sm">
        {rows.map(r => <TaxonomyRow key={r.id} row={r} onSave={save} onRemove={remove} />)}
        {rows.length === 0 && <p className="text-body-md text-on-surface-variant">Nothing yet.</p>}
      </ul>
    </>
  )
}

function TaxonomyRow({ row, onSave, onRemove }: { row: Row; onSave: (id: string, kw: string) => void; onRemove: (id: string) => void }) {
  const [kw, setKw] = useState(parseKw(row.keywords).join(', '))
  return (
    <li className="flex flex-wrap items-center gap-sm rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
      <span className="text-label-md font-bold text-primary">{row.name}</span>
      <input value={kw} onChange={e => setKw(e.target.value)}
        className="min-w-[240px] flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-xs text-body-sm" />
      <button onClick={() => onSave(row.id, kw)} className="rounded-lg bg-surface-container px-md py-xs text-label-sm">Save</button>
      <button onClick={() => onRemove(row.id)} className="text-error text-label-sm hover:underline">Xoá</button>
    </li>
  )
}
```

- [ ] **Step 4: Refactor the niches page to use TaxonomyEditor**

Rewrite the body of `src/app/tools/spy-idea/niches/page.tsx` to delegate to `TaxonomyEditor` (keep `'use client'`, Sidebar, RoleGate, SpySectionNav, layout, header — only replace the add-form + list + local handlers). The `NAV_ITEMS`/`SpySectionNav` block stays for now (Task 5 updates the nav items). Replace the form + `<ul>` + `NicheRow` with:

```tsx
          <TaxonomyEditor title="Niche" endpoint="/api/spy/niches"
            hint="Keywords match product titles and ad title/body (case-insensitive, any keyword)." />
```

Add `import TaxonomyEditor from '@/components/spy/TaxonomyEditor'` and delete the now-unused `parseKw`/`NicheRow`/`addNiche`/`saveKeywords`/`removeNiche`/`useState`/`useEffect` locals. Verify the page still fetches `/api/spy/niches` (now inside `TaxonomyEditor`).

- [ ] **Step 5: Point the main page at the shared components (interim)**

In `src/app/tools/spy-idea/page.tsx`, replace the local `AdCard` and product `<article>` markup usages with imports from `@/components/spy/AdCard` and `@/components/spy/ProductCard` (full page rebuild is Task 4, but do the swap now so this task is independently verifiable and the app compiles). Remove the local `AdCard` function and the local `MEDIA_LABEL`/`STYLE_LABEL` it used; keep `DomainBlock` using the imported `AdCard`.

- [ ] **Step 6: Typecheck + build + commit**

Run: `npx tsc --noEmit` (expect 0). `npm run build` (expect success).
```bash
git add src/components/spy/AdCard.tsx src/components/spy/ProductCard.tsx src/components/spy/TaxonomyEditor.tsx src/app/tools/spy-idea/niches/page.tsx src/app/tools/spy-idea/page.tsx
git commit -m "refactor(spy): extract AdCard/ProductCard/TaxonomyEditor shared components"
```

---

## Task 4: SpyFilterSidebar + rebuilt browse page; remove dashboard

**Files:**
- Create: `src/components/spy/SpyFilterSidebar.tsx`
- Modify (rewrite): `src/app/tools/spy-idea/page.tsx`
- Delete: `src/app/tools/spy-idea/dashboard/page.tsx`

**Interfaces:**
- Consumes: `AdCard`/`Ad`, `ProductCard`/`Product` (Task 3); `/api/spy/filters`, `/api/spy/ads`, `/api/spy/products`, `/api/spy/ideas` (Task 2).
- Produces: `SpyFilterSidebar` (default export). Props: `{ filters: FiltersData; selected: Selected; onSelect: (dim: 'domain'|'niche'|'type', value: string | null) => void }` where `FiltersData = { domains: string[]; niches: {id:string;name:string}[]; productTypes: {id:string;name:string}[] }` and `Selected = { domain: string | null; niche: string | null; type: string | null }`.

- [ ] **Step 1: Create SpyFilterSidebar**

Create `src/components/spy/SpyFilterSidebar.tsx`:

```tsx
'use client'
import Link from 'next/link'

export type FiltersData = { domains: string[]; niches: { id: string; name: string }[]; productTypes: { id: string; name: string }[] }
export type Selected = { domain: string | null; niche: string | null; type: string | null }

function Facet({ title, options, value, onPick }: { title: string; options: { key: string | null; label: string }[]; value: string | null; onPick: (v: string | null) => void }) {
  return (
    <div className="mb-md">
      <p className="mb-xs px-xs text-label-sm uppercase tracking-wider text-on-surface-variant">{title}</p>
      {options.map(o => {
        const active = (o.key ?? null) === value
        return (
          <button key={o.key ?? '__all'} onClick={() => onPick(o.key)}
            className={`flex w-full items-center rounded-lg px-md py-xs text-left text-body-sm ${active ? 'bg-secondary-fixed font-semibold text-primary' : 'text-on-surface hover:bg-surface-container-low'}`}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export default function SpyFilterSidebar({ filters, selected, onSelect }: { filters: FiltersData; selected: Selected; onSelect: (dim: 'domain'|'niche'|'type', value: string | null) => void }) {
  return (
    <aside className="w-[220px] flex-none rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md shadow-card">
      <Facet title="Domain" value={selected.domain} onPick={v => onSelect('domain', v)}
        options={[{ key: null, label: 'All' }, ...filters.domains.map(d => ({ key: d, label: d }))]} />
      <Facet title="Niche" value={selected.niche} onPick={v => onSelect('niche', v)}
        options={[{ key: null, label: 'All' }, ...filters.niches.map(n => ({ key: n.id, label: n.name }))]} />
      <Facet title="Product type" value={selected.type} onPick={v => onSelect('type', v)}
        options={[{ key: null, label: 'All' }, ...filters.productTypes.map(t => ({ key: t.id, label: t.name }))]} />
      <div className="my-md h-px bg-outline-variant/40" />
      <div>
        <p className="mb-xs px-xs text-label-sm uppercase tracking-wider text-on-surface-variant">Setup</p>
        {[
          { href: '/tools/spy-idea/sources', icon: 'storefront', label: 'Sources' },
          { href: '/tools/spy-idea/niches', icon: 'sell', label: 'Niche' },
          { href: '/tools/spy-idea/product-types', icon: 'category', label: 'Product type' },
        ].map(s => (
          <Link key={s.href} href={s.href} className="flex items-center gap-sm rounded-lg px-md py-xs text-body-sm text-secondary hover:bg-surface-container-low">
            <span className="material-symbols-outlined text-[18px]">{s.icon}</span>{s.label}
          </Link>
        ))}
      </div>
    </aside>
  )
}
```

- [ ] **Step 2: Rewrite the browse page**

Replace `src/app/tools/spy-idea/page.tsx` entirely:

```tsx
'use client'
import { useCallback, useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import SpySectionNav from '@/components/SpySectionNav'
import SpyFilterSidebar, { FiltersData, Selected } from '@/components/spy/SpyFilterSidebar'
import AdCard, { Ad } from '@/components/spy/AdCard'
import ProductCard, { Product } from '@/components/spy/ProductCard'

type Idea = { id: string; title: string; note: string | null; status: string; createdAt: string }
type Area = 'ads' | 'products' | 'ideas'

const AD_VIEWS = [
  { key: 'new', label: 'New Ads' },
  { key: 'launching', label: 'New Launching Ads' },
  { key: 'winning', label: 'Winning Ads (Long Ads)' },
]
const PRODUCT_VIEWS = [
  { key: 'new-add', label: 'New Product Add' },
  { key: 'best-seller', label: 'Best Seller' },
]

function formatDate(v: string) {
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}

function readParams(): { area: Area; view: string; sel: Selected } {
  const p = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
  const area = (['ads', 'products', 'ideas'].includes(p.get('area') || '') ? p.get('area') : 'ads') as Area
  const view = p.get('view') || (area === 'products' ? 'new-add' : 'new')
  return { area, view, sel: { domain: p.get('domain'), niche: p.get('niche'), type: p.get('type') } }
}

function writeParams(area: Area, view: string, sel: Selected) {
  const p = new URLSearchParams()
  p.set('area', area); p.set('view', view)
  if (sel.domain) p.set('domain', sel.domain)
  if (sel.niche) p.set('niche', sel.niche)
  if (sel.type) p.set('type', sel.type)
  window.history.replaceState(null, '', `?${p.toString()}`)
}

export default function SpyIdeaPage() {
  const [filters, setFilters] = useState<FiltersData>({ domains: [], niches: [], productTypes: [] })
  const [area, setArea] = useState<Area>('ads')
  const [view, setView] = useState('new')
  const [sel, setSel] = useState<Selected>({ domain: null, niche: null, type: null })
  const [ads, setAds] = useState<Ad[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [ideas, setIdeas] = useState<Idea[]>([])

  useEffect(() => {
    const init = readParams(); setArea(init.area); setView(init.view); setSel(init.sel)
    fetch('/api/spy/filters').then(r => r.json()).then(setFilters).catch(() => {})
  }, [])

  const filterQuery = useCallback(() => {
    const q = new URLSearchParams()
    if (sel.domain) q.set('domain', sel.domain)
    if (sel.niche) q.set('nicheId', sel.niche)
    if (sel.type) q.set('productTypeId', sel.type)
    return q.toString()
  }, [sel])

  useEffect(() => {
    if (area === 'ads') {
      fetch(`/api/spy/ads?filter=${view}&limit=200&${filterQuery()}`).then(r => r.json()).then(d => setAds(d.ads ?? [])).catch(() => {})
    } else if (area === 'products' && view === 'new-add') {
      fetch(`/api/spy/products?days=30&limit=200&${filterQuery()}`).then(r => r.json()).then(d => setProducts(d.products ?? [])).catch(() => {})
    } else if (area === 'ideas') {
      fetch('/api/spy/ideas').then(r => r.json()).then(setIdeas).catch(() => {})
    }
  }, [area, view, filterQuery])

  function go(nextArea: Area, nextView?: string) {
    const v = nextView ?? (nextArea === 'products' ? 'new-add' : nextArea === 'ads' ? 'new' : 'ideas')
    setArea(nextArea); setView(v); writeParams(nextArea, v, sel)
  }
  function pickView(v: string) { setView(v); writeParams(area, v, sel) }
  function onSelect(dim: 'domain'|'niche'|'type', value: string | null) {
    const next = { ...sel, [dim]: value }; setSel(next); writeParams(area, view, next)
  }

  async function saveAdIdea(a: Ad) {
    await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: a.title ?? a.advertiser.pageName ?? 'Ad', refType: 'AD', refAdId: a.id, snapshotJson: a }) })
  }
  async function saveProductIdea(p: Product) {
    await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: p.title ?? 'Untitled', refType: 'PRODUCT', refProductId: p.id, snapshotJson: p }) })
  }

  const subViews = area === 'ads' ? AD_VIEWS : area === 'products' ? PRODUCT_VIEWS : []

  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <header className="mb-lg">
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools</p>
            <h2 className="text-display-md font-bold text-primary">Spy</h2>
          </header>

          <SpySectionNav active={area} items={[
            { key: 'ads', label: 'Ad Library', icon: 'library_books', onClick: () => go('ads') },
            { key: 'products', label: 'Product Spy', icon: 'inventory_2', onClick: () => go('products') },
            { key: 'ideas', label: 'Ideas', icon: 'lightbulb', onClick: () => go('ideas') },
          ]} />

          <div className="flex gap-lg">
            <SpyFilterSidebar filters={filters} selected={sel} onSelect={onSelect} />

            <div className="min-w-0 flex-1">
              {subViews.length > 0 && (
                <nav className="mb-md flex flex-wrap gap-sm">
                  {subViews.map(v => (
                    <button key={v.key} onClick={() => pickView(v.key)}
                      className={`rounded-md px-md py-xs text-label-sm ${view === v.key ? 'bg-secondary text-on-secondary' : 'bg-surface-container text-on-surface-variant'}`}>{v.label}</button>
                  ))}
                </nav>
              )}

              {area === 'ads' && (
                <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {ads.map(a => <AdCard key={a.id} a={a} onSave={saveAdIdea} />)}
                  {ads.length === 0 && <p className="text-body-md text-on-surface-variant">No ads for this filter.</p>}
                </div>
              )}

              {area === 'products' && view === 'new-add' && (
                <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {products.map(p => <ProductCard key={p.id} p={p} onSave={saveProductIdea} />)}
                  {products.length === 0 && <p className="text-body-md text-on-surface-variant">No products for this filter.</p>}
                </div>
              )}

              {area === 'products' && view === 'best-seller' && (
                <div className="rounded-xl border border-dashed border-outline-variant bg-surface-container-lowest p-2xl text-center text-on-surface-variant">
                  <span className="material-symbols-outlined text-[44px] text-outline-variant">trending_up</span>
                  <h3 className="mt-sm text-headline-sm text-primary">Best Seller</h3>
                  <p className="mt-xs text-body-md">Coming in Phase C — scrape the store&apos;s best-selling collection.</p>
                </div>
              )}

              {area === 'ideas' && (
                <ul className="space-y-sm">
                  {ideas.map(i => (
                    <li key={i.id} className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
                      <p className="text-label-md text-primary">{i.title}</p>
                      <p className="text-body-sm text-on-surface-variant">{i.status} · {formatDate(i.createdAt)}</p>
                    </li>
                  ))}
                  {ideas.length === 0 && <p className="text-body-md text-on-surface-variant">No ideas saved yet.</p>}
                </ul>
              )}
            </div>
          </div>
        </main>
      </div>
    </RoleGate>
  )
}
```

- [ ] **Step 3: Delete the dashboard page**

```bash
git rm src/app/tools/spy-idea/dashboard/page.tsx
```

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit` (expect 0). `npm run build` (expect success; confirm `/tools/spy-idea` compiles and `/tools/spy-idea/dashboard` is gone from the route list).

- [ ] **Step 5: Manual smoke (dev server)**

Run `npm run dev -- --port 3002`, log in, open `/tools/spy-idea`. Verify: area tabs switch (Ad Library/Product Spy/Ideas); Ad Library sub-tabs (New Ads/New Launching/Winning) change the grid; facets highlight and filter; Best Seller shows the Phase C stub; URL updates with `?area=&view=&domain=&niche=&type=` and survives refresh.

- [ ] **Step 6: Commit**

```bash
git add src/components/spy/SpyFilterSidebar.tsx src/app/tools/spy-idea/page.tsx
git commit -m "feat(spy): 2-area browse page + left facet sidebar; remove dashboard"
```

---

## Task 5: Sources page + Product Types page + nav wiring

**Files:**
- Create: `src/app/tools/spy-idea/sources/page.tsx`
- Create: `src/app/tools/spy-idea/product-types/page.tsx`
- Modify: `src/components/Sidebar.tsx` (spy link → `/tools/spy-idea`; drop any `/dashboard` link)
- Modify: `src/app/tools/spy-idea/niches/page.tsx` (nav item set aligned with new structure)

**Interfaces:**
- Consumes: `TaxonomyEditor` (Task 3); `AdCard` (Task 3); existing `/api/spy/stores`, `/api/spy/ad-domains`, `/api/spy/pages`, `/api/spy/scan`, `/api/spy/scan-ads`, `/api/spy/ads`.

- [ ] **Step 1: Create the Product Types setup page**

Create `src/app/tools/spy-idea/product-types/page.tsx`:

```tsx
'use client'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import TaxonomyEditor from '@/components/spy/TaxonomyEditor'

export default function ProductTypesPage() {
  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <header className="mb-lg">
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools · Spy · Setup</p>
            <h2 className="text-display-md font-bold text-primary">Product types</h2>
          </header>
          <TaxonomyEditor title="Product type" endpoint="/api/spy/product-types"
            hint="Keywords match product titles and ad title/body (case-insensitive, any keyword)." />
          <a href="/tools/spy-idea?area=ads&view=new" className="mt-lg inline-block text-secondary text-label-md hover:underline">← Back to Spy</a>
        </main>
      </div>
    </RoleGate>
  )
}
```

- [ ] **Step 2: Create the Sources page (move store + ad-domain/fanpage management)**

Create `src/app/tools/spy-idea/sources/page.tsx`. Move the store-management block (add/scan/remove store) and the `DomainBlock` (add domain, add fanpage, scan page, scan domain, remove) out of the old main page into this page. Full content:

```tsx
'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import AdCard, { Ad } from '@/components/spy/AdCard'

type Store = { id: string; domain: string; name: string | null; status: string; _count?: { products: number } }
type AdDomain = { id: string; domain: string; searchTerm: string; country: string; lastScanAt: string | null; pageCount: number; adCount: number; newAdCount: number }
type PageTarget = { id: string; pageUrl: string; label: string | null; lastScanAt: string | null }

function DomainBlock({ domain, onScan, onRemove, onChanged }: { domain: AdDomain; onScan: () => void; onRemove: () => void; onChanged: () => void }) {
  const [pages, setPages] = useState<PageTarget[]>([])
  const [ads, setAds] = useState<Ad[]>([])
  const [pageUrl, setPageUrl] = useState('')
  const [term, setTerm] = useState(domain.searchTerm)

  async function load() {
    setPages(await fetch(`/api/spy/pages?adDomainId=${domain.id}`).then(r => r.json()))
    const d = await fetch(`/api/spy/ads?domainId=${domain.id}`).then(r => r.json()); setAds(d.ads ?? [])
  }
  useEffect(() => { load() }, [domain.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function saveTerm() {
    await fetch('/api/spy/ad-domains', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: domain.id, searchTerm: term }) })
    onChanged()
  }
  async function addPage() {
    if (!pageUrl.trim()) return
    await fetch('/api/spy/pages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageUrl, adDomainId: domain.id }) })
    setPageUrl(''); load()
  }
  async function scanPage(id: string) {
    await fetch('/api/spy/scan-ads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId: id }) })
    setTimeout(load, 30000)
  }
  async function removePage(id: string) {
    await fetch('/api/spy/pages', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    load()
  }

  return (
    <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
      <div className="mb-md flex flex-wrap items-center gap-sm">
        <h3 className="text-headline-sm text-primary">{domain.domain}</h3>
        <span className="text-body-sm text-on-surface-variant">{domain.pageCount} pages · {domain.adCount} ads · {domain.newAdCount} new</span>
        <input value={term} onChange={e => setTerm(e.target.value)} className="ml-auto w-48 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-xs text-body-sm" />
        <button onClick={saveTerm} className="rounded-lg bg-surface-container px-md py-xs text-label-sm">Save term</button>
        <button onClick={onScan} className="rounded-lg bg-primary px-md py-xs text-label-sm text-on-primary">Scan domain</button>
        <button onClick={onRemove} className="text-error text-label-sm hover:underline">Xoá</button>
      </div>
      <div className="mb-md">
        <p className="mb-xs text-label-sm uppercase tracking-wider text-on-surface-variant">Fanpages</p>
        <div className="mb-sm flex gap-sm">
          <input value={pageUrl} onChange={e => setPageUrl(e.target.value)} placeholder="https://www.facebook.com/BrandPage"
            className="flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-sm outline-none focus:border-secondary" />
          <button onClick={addPage} className="rounded-lg bg-secondary px-lg py-sm text-label-sm text-on-secondary">Add fanpage</button>
        </div>
        <ul className="divide-y divide-outline-variant/20">
          {pages.map(p => (
            <li key={p.id} className="flex items-center justify-between py-xs">
              <span className="text-body-sm text-primary">{p.label ?? p.pageUrl}</span>
              <span className="flex items-center gap-md">
                <button onClick={() => scanPage(p.id)} className="text-secondary text-label-sm hover:underline">Scan page</button>
                <button onClick={() => removePage(p.id)} className="text-error text-label-sm hover:underline">Xoá</button>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {ads.map(a => <AdCard key={a.id} a={a} onSave={() => {}} />)}
        {ads.length === 0 && <p className="text-body-md text-on-surface-variant">No ads yet — scan the domain or a fanpage.</p>}
      </div>
    </section>
  )
}

export default function SourcesPage() {
  const [stores, setStores] = useState<Store[]>([])
  const [adDomains, setAdDomains] = useState<AdDomain[]>([])
  const [domain, setDomain] = useState('')
  const [domainInput, setDomainInput] = useState('')
  const [scanning, setScanning] = useState(false)

  async function loadStores() { setStores(await fetch('/api/spy/stores').then(r => r.json())) }
  async function loadAdDomains() { setAdDomains(await fetch('/api/spy/ad-domains').then(r => r.json())) }
  useEffect(() => { loadStores(); loadAdDomains() }, [])

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
    try { await fetch('/api/spy/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); await loadStores() }
    finally { setScanning(false) }
  }
  async function addAdDomain() {
    if (!domainInput.trim()) return
    await fetch('/api/spy/ad-domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: domainInput }) })
    setDomainInput(''); loadAdDomains()
  }
  async function scanDomain(id: string) {
    await fetch('/api/spy/scan-ads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domainId: id }) })
    setTimeout(loadAdDomains, 30000)
  }
  async function removeAdDomain(id: string) {
    await fetch('/api/spy/ad-domains', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    loadAdDomains()
  }

  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <header className="mb-lg">
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools · Spy · Setup</p>
            <h2 className="text-display-md font-bold text-primary">Sources</h2>
          </header>

          <section className="mb-xl rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
            <h3 className="mb-md text-headline-sm text-primary">Shopify stores</h3>
            <div className="mb-md flex gap-sm">
              <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="store.myshopify.com"
                className="flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
              <button onClick={addStore} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Add store</button>
              <button onClick={scanAll} disabled={scanning} className="rounded-lg bg-primary px-lg py-sm text-label-md text-on-primary disabled:opacity-50">{scanning ? 'Scanning…' : 'Scan now'}</button>
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

          <section className="mb-md rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
            <h3 className="mb-md text-headline-sm text-primary">Ad domains</h3>
            <div className="flex gap-sm">
              <input value={domainInput} onChange={e => setDomainInput(e.target.value)} placeholder="familystore.com"
                className="flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
              <button onClick={addAdDomain} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Add domain</button>
            </div>
          </section>

          <div className="space-y-lg">
            {adDomains.map(d => <DomainBlock key={d.id} domain={d} onScan={() => scanDomain(d.id)} onRemove={() => removeAdDomain(d.id)} onChanged={loadAdDomains} />)}
          </div>
        </main>
      </div>
    </RoleGate>
  )
}
```

- [ ] **Step 3: Update the niches page nav item set**

In `src/app/tools/spy-idea/niches/page.tsx`, replace the `NAV_ITEMS` array so it matches the new structure (no dashboard/products/stores tabs pointing at removed views):

```tsx
const NAV_ITEMS = [
  { key: 'ads', label: 'Ad Library', icon: 'library_books', href: '/tools/spy-idea?area=ads&view=new' },
  { key: 'products', label: 'Product Spy', icon: 'inventory_2', href: '/tools/spy-idea?area=products&view=new-add' },
  { key: 'sources', label: 'Sources', icon: 'storefront', href: '/tools/spy-idea/sources' },
  { key: 'niches', label: 'Niches', icon: 'sell', href: '/tools/spy-idea/niches' },
  { key: 'types', label: 'Product types', icon: 'category', href: '/tools/spy-idea/product-types' },
]
```

- [ ] **Step 4: Update the app Sidebar link**

In `src/components/Sidebar.tsx`, find the Spy tool nav link. Ensure it points to `/tools/spy-idea` (browse). If any link points to `/tools/spy-idea/dashboard`, change it to `/tools/spy-idea`. (Grep for `spy-idea/dashboard` across `src/` and fix any remaining reference.)

- [ ] **Step 5: Typecheck + build + grep for stale references**

Run: `npx tsc --noEmit` (0). `npm run build` (success). Grep `spy-idea/dashboard` across `src/` — expect no matches.

- [ ] **Step 6: Manual smoke**

On the dev server: open `/tools/spy-idea/sources` — add/scan store works; add ad-domain + fanpage + scan works. Open `/tools/spy-idea/product-types` — add a type (e.g. `Tumbler` = `tumbler, 20oz, 40oz`), edit, delete. Back on the browse page, the new type appears in the Product type facet and filtering narrows results.

- [ ] **Step 7: Commit**

```bash
git add src/app/tools/spy-idea/sources/page.tsx src/app/tools/spy-idea/product-types/page.tsx src/app/tools/spy-idea/niches/page.tsx src/components/Sidebar.tsx
git commit -m "feat(spy): Sources + Product Types pages; nav wiring"
```

---

## Self-Review Notes (author)

- **Spec coverage:** §3 model → T1; §4 filtering (niche/type/domain + launching/winning flags) → T2; §5 layout/URL state → T4; §6 APIs → T1+T2; §7 pages/components → T3+T4+T5; §8 non-goals respected (Best Seller stub in T4; single-select facets; SpyNiche untouched). ✅
- **Type consistency:** `Ad`/`AdSignals` defined in `@/components/spy/AdCard` and consumed by browse page + Sources; `Product` in `@/components/spy/ProductCard`; `FiltersData`/`Selected` in `@/components/spy/SpyFilterSidebar` consumed by browse page. Filter param names: UI `niche`/`type` → API `nicheId`/`productTypeId`/`domain` (mapped in `filterQuery`). ✅
- **No dashboard leftovers:** T4 deletes the page; T5 greps for stale links. ✅
- **DB safety:** only additive migration in T1; `SCHEMA_VERSION` bumped once (v29). ✅
