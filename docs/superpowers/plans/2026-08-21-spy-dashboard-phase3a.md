# Spy Tool — Phase 3a: Dashboard (card feeds + trending) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Spy Dashboard at `/tools/spy-idea/dashboard` that aggregates already-collected spy data into three filterable card feeds — New Products, Ads, and Trending (rising niches + winning/scaling ads) — each with "Save IDEA".

**Architecture:** Pure aggregation over existing Prisma tables — no new models, no cron. A pure `computeTrendingNiches` function derives rising niches from `SpyProduct`; a new `/api/spy/trending` route returns niches + winning/scaling ads (reusing `ad-signals`); an optional `/api/spy/dashboard/summary` route returns header counts. The dashboard page reuses existing feed endpoints (`/api/spy/products`, `/api/spy/ads`) plus the new ones.

**Tech Stack:** Next.js (App Router, `'use client'` pages), Prisma + SQLite, Vitest, Tailwind design tokens.

**Spec:** `docs/superpowers/specs/2026-08-21-spy-dashboard-phase3a-design.md`

## Global Constraints

- No new Prisma models, no migration, no cron (pure aggregation).
- Import Prisma only via `import { prisma } from '@/lib/db'`.
- API routes: `src/app/api/<feature>/<action>/route.ts`, export named `GET`, return `NextResponse.json(...)`.
- All pages `'use client'`, render `<Sidebar />` inside `<RoleGate>`, layout `<div className="flex min-h-screen bg-surface"><Sidebar /><main className="ml-[280px] flex-1 p-xl">…</main></div>`. Icons `material-symbols-outlined`. Dates `en-US` (MM/DD/YYYY). Card pattern `bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20`.
- Routing under `/tools/spy-idea` (roles `tools_spy_idea` covers children via `startsWith` — no `roles.ts` change).
- Tests: `npm test` (vitest). Test files `src/**/*.test.ts`. `@`→`src`.
- Reuse `@/lib/spy/ad-signals` (`isNewAd`, `activeDays`, `isLongRunning`, `isScaling`, `isStopped`) — do not reimplement.
- Existing endpoint shapes: `GET /api/spy/products?days` → `{ products, niches }`; `GET /api/spy/ads?filter&storeId` → `{ ads: [{ ...spyAd, advertiser:{pageName}, observations, signals }] }`; `GET /api/spy/ideas` (POST saves `{title, refType, ref*Id, snapshotJson}`).
- Known pre-existing failures unrelated to this work: `src/lib/order-profit.test.ts` (2 tests) — ignore.

---

### Task 1: `computeTrendingNiches`

**Files:**
- Create: `src/lib/spy/trending.ts`
- Test: `src/lib/spy/trending.test.ts`

**Interfaces:**
- Produces:
```ts
export type TrendingNiche = { niche: string; newCount: number; prevCount: number; deltaPct: number; topStores: string[] }
export function computeTrendingNiches(
  products: Array<{ productType: string | null; firstSeenAt: Date; store?: { domain: string } | null }>,
  opts?: { windowDays?: number; now?: Date; limit?: number },
): TrendingNiche[]
```

- [ ] **Step 1: Write the failing test**

Create `src/lib/spy/trending.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeTrendingNiches } from './trending'

const now = new Date('2026-08-21T00:00:00Z')
const d = (iso: string) => new Date(iso)

describe('computeTrendingNiches', () => {
  it('counts current vs previous window and computes deltaPct', () => {
    const products = [
      // current window (Aug 14..21): 3 Shirt
      { productType: 'Shirt', firstSeenAt: d('2026-08-20T00:00:00Z'), store: { domain: 'a.com' } },
      { productType: 'Shirt', firstSeenAt: d('2026-08-19T00:00:00Z'), store: { domain: 'a.com' } },
      { productType: 'Shirt', firstSeenAt: d('2026-08-18T00:00:00Z'), store: { domain: 'b.com' } },
      // previous window (Aug 7..14): 2 Shirt
      { productType: 'Shirt', firstSeenAt: d('2026-08-10T00:00:00Z'), store: { domain: 'a.com' } },
      { productType: 'Shirt', firstSeenAt: d('2026-08-09T00:00:00Z'), store: { domain: 'a.com' } },
    ]
    const [shirt] = computeTrendingNiches(products, { now, windowDays: 7 })
    expect(shirt.niche).toBe('Shirt')
    expect(shirt.newCount).toBe(3)
    expect(shirt.prevCount).toBe(2)
    expect(shirt.deltaPct).toBe(50) // (3-2)/2 = 50%
    expect(shirt.topStores).toEqual(['a.com', 'b.com']) // a.com=2, b.com=1
  })

  it('deltaPct is 100 when previous window is empty but new exists', () => {
    const [n] = computeTrendingNiches([{ productType: 'Mug', firstSeenAt: d('2026-08-20T00:00:00Z') }], { now, windowDays: 7 })
    expect(n.deltaPct).toBe(100)
    expect(n.prevCount).toBe(0)
  })

  it('null productType becomes Uncategorized; only niches with newCount>0 returned; sorted desc', () => {
    const products = [
      { productType: null, firstSeenAt: d('2026-08-20T00:00:00Z') },
      { productType: 'Old', firstSeenAt: d('2026-08-09T00:00:00Z') }, // prev only → excluded
    ]
    const rows = computeTrendingNiches(products, { now, windowDays: 7 })
    expect(rows.map(r => r.niche)).toEqual(['Uncategorized'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/lib/spy/trending.test.ts`
Expected: FAIL — cannot find module `./trending`.

- [ ] **Step 3: Implement**

Create `src/lib/spy/trending.ts`:

```ts
export type TrendingNiche = { niche: string; newCount: number; prevCount: number; deltaPct: number; topStores: string[] }

const DAY = 24 * 60 * 60 * 1000

export function computeTrendingNiches(
  products: Array<{ productType: string | null; firstSeenAt: Date; store?: { domain: string } | null }>,
  opts: { windowDays?: number; now?: Date; limit?: number } = {},
): TrendingNiche[] {
  const windowDays = opts.windowDays ?? 7
  const now = (opts.now ?? new Date()).getTime()
  const limit = opts.limit ?? 20
  const curStart = now - windowDays * DAY
  const prevStart = now - 2 * windowDays * DAY

  type Agg = { newCount: number; prevCount: number; stores: Map<string, number> }
  const map = new Map<string, Agg>()

  for (const p of products) {
    const t = p.firstSeenAt.getTime()
    const niche = p.productType || 'Uncategorized'
    let a = map.get(niche)
    if (!a) { a = { newCount: 0, prevCount: 0, stores: new Map() }; map.set(niche, a) }
    if (t >= curStart && t <= now) {
      a.newCount++
      const dom = p.store?.domain
      if (dom) a.stores.set(dom, (a.stores.get(dom) ?? 0) + 1)
    } else if (t >= prevStart && t < curStart) {
      a.prevCount++
    }
  }

  const rows: TrendingNiche[] = []
  for (const [niche, a] of map) {
    if (a.newCount <= 0) continue
    const deltaPct = a.prevCount === 0
      ? (a.newCount > 0 ? 100 : 0)
      : Math.round(((a.newCount - a.prevCount) / a.prevCount) * 100)
    const topStores = Array.from(a.stores.entries())
      .sort((x, y) => y[1] - x[1]).slice(0, 3).map(e => e[0])
    rows.push({ niche, newCount: a.newCount, prevCount: a.prevCount, deltaPct, topStores })
  }
  rows.sort((x, y) => y.deltaPct - x.deltaPct || y.newCount - x.newCount)
  return rows.slice(0, limit)
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- src/lib/spy/trending.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/spy/trending.ts src/lib/spy/trending.test.ts
git commit -m "feat(spy): computeTrendingNiches"
```

---

### Task 2: Trending + dashboard-summary API routes

**Files:**
- Create: `src/app/api/spy/trending/route.ts`
- Create: `src/app/api/spy/dashboard/summary/route.ts`

**Interfaces:**
- Consumes: `computeTrendingNiches` (Task 1); `prisma`; `isNewAd/activeDays/isLongRunning/isScaling/isStopped` from `@/lib/spy/ad-signals`.
- Produces HTTP:
  - `GET /api/spy/trending?days` → `{ niches: TrendingNiche[], winningAds: Array<{...spyAd, advertiser:{pageName}, signals}> }`.
  - `GET /api/spy/dashboard/summary` → `{ newProducts7d, activeAds, scalingAds, trendingNiches }`.

- [ ] **Step 1: Implement the trending route**

Create `src/app/api/spy/trending/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { computeTrendingNiches } from '@/lib/spy/trending'
import { isNewAd, activeDays, isLongRunning, isScaling, isStopped } from '@/lib/spy/ad-signals'

const DAY = 24 * 60 * 60 * 1000

export async function GET(req: NextRequest) {
  const days = Math.min(parseInt(new URL(req.url).searchParams.get('days') ?? '7', 10) || 7, 90)
  const since = new Date(Date.now() - 2 * days * DAY)

  const products = await prisma.spyProduct.findMany({
    where: { firstSeenAt: { gte: since } },
    select: { productType: true, firstSeenAt: true, store: { select: { domain: true } } },
  })
  const niches = computeTrendingNiches(products, { windowDays: days })

  const ads = await prisma.spyAd.findMany({
    orderBy: { lastSeenAt: 'desc' },
    take: 500,
    include: {
      advertiser: { select: { pageName: true } },
      observations: { select: { isActive: true, collationCount: true, observedAt: true } },
    },
  })
  const now = new Date()
  const winningAds = ads
    .map(a => ({
      ...a,
      signals: {
        isNew: isNewAd(a.startDate, now),
        activeDays: activeDays(a.startDate, a.endDate, now),
        isLongRunning: isLongRunning(a, now),
        isScaling: isScaling(a.observations),
        isStopped: isStopped(a.observations),
      },
    }))
    .filter(a => a.signals.isLongRunning || a.signals.isScaling)
    .sort((x, y) => y.signals.activeDays - x.signals.activeDays)
    .slice(0, 100)

  return NextResponse.json({ niches, winningAds })
}
```

- [ ] **Step 2: Implement the summary route**

Create `src/app/api/spy/dashboard/summary/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { computeTrendingNiches } from '@/lib/spy/trending'
import { isScaling } from '@/lib/spy/ad-signals'

const DAY = 24 * 60 * 60 * 1000

export async function GET() {
  const since7 = new Date(Date.now() - 7 * DAY)
  const since14 = new Date(Date.now() - 14 * DAY)

  const [newProducts7d, activeAds, products, adsForScaling] = await Promise.all([
    prisma.spyProduct.count({ where: { firstSeenAt: { gte: since7 } } }),
    prisma.spyAd.count({ where: { isActive: true } }),
    prisma.spyProduct.findMany({ where: { firstSeenAt: { gte: since14 } }, select: { productType: true, firstSeenAt: true } }),
    prisma.spyAd.findMany({ take: 500, orderBy: { lastSeenAt: 'desc' }, select: { observations: { select: { isActive: true, collationCount: true, observedAt: true } } } }),
  ])

  const scalingAds = adsForScaling.filter(a => isScaling(a.observations)).length
  const trendingNiches = computeTrendingNiches(products, { windowDays: 7 }).length

  return NextResponse.json({ newProducts7d, activeAds, scalingAds, trendingNiches })
}
```

- [ ] **Step 3: Verify (no dev server)**

Run: `npx tsc --noEmit` (no errors in new files) and `npm run lint` (clean on new files). Runtime exercised in Task 3.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/spy/trending/route.ts src/app/api/spy/dashboard/summary/route.ts
git commit -m "feat(spy): trending + dashboard summary API"
```

---

### Task 3: Dashboard page + Sidebar nav

**Files:**
- Create: `src/app/tools/spy-idea/dashboard/page.tsx`
- Modify: `src/components/Sidebar.tsx`

**Interfaces:**
- Consumes HTTP: `/api/spy/dashboard/summary`, `/api/spy/products?days=30`, `/api/spy/ads?filter=`, `/api/spy/trending?days=7`, `/api/spy/ideas` (POST).

- [ ] **Step 1: Add the Sidebar nav entry**

In `src/components/Sidebar.tsx`, inside the `nav` array, immediately after the existing Spy Idea entry (`{ type: 'child', href: '/tools/spy-idea', icon: 'travel_explore', label: 'Spy Idea' }`), add:

```tsx
  { type: 'child', href: '/tools/spy-idea/dashboard', icon: 'space_dashboard', label: 'Spy Dashboard' },
```

Note: the existing "Spy Idea" entry uses `active = pathname === entry.href || pathname.startsWith(entry.href)`, so it would also highlight on the dashboard route — acceptable (both are Spy). No other change needed.

- [ ] **Step 2: Create the dashboard page**

Create `src/app/tools/spy-idea/dashboard/page.tsx`:

```tsx
'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'

type Summary = { newProducts7d: number; activeAds: number; scalingAds: number; trendingNiches: number }
type Product = { id: string; title: string | null; imageUrl: string | null; priceMin: number | null; priceMax: number | null; firstSeenAt: string; productType: string | null; store: { domain: string } }
type AdSignals = { isNew: boolean; activeDays: number; isLongRunning: boolean; isScaling: boolean; isStopped: boolean }
type Ad = { id: string; title: string | null; body: string | null; advertiser: { pageName: string | null }; signals: AdSignals; startDate: string | null }
type TrendingNiche = { niche: string; newCount: number; prevCount: number; deltaPct: number; topStores: string[] }

function formatDate(v: string | null) {
  if (!v) return '-'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}
function priceText(min: number | null, max: number | null) {
  if (min == null || max == null) return '-'
  return min === max ? `$${min.toFixed(2)}` : `$${min.toFixed(2)} - $${max.toFixed(2)}`
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
      <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">{label}</p>
      <p className="mt-xs text-stats-lg text-primary">{value}</p>
    </div>
  )
}

function AdBadges({ s }: { s: AdSignals }) {
  return (
    <div className="mb-xs flex flex-wrap gap-xs">
      {s.isNew && <span className="rounded-full bg-secondary/10 px-sm py-xs text-label-sm text-secondary">New</span>}
      {s.isLongRunning && <span className="rounded-full bg-on-tertiary-container/15 px-sm py-xs text-label-sm text-on-tertiary-container">Long-running</span>}
      {s.isScaling && <span className="rounded-full bg-primary/10 px-sm py-xs text-label-sm text-primary">Scaling</span>}
      {s.isStopped && <span className="rounded-full bg-error/10 px-sm py-xs text-label-sm text-error">Stopped</span>}
    </div>
  )
}

export default function SpyDashboardPage() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [ads, setAds] = useState<Ad[]>([])
  const [niches, setNiches] = useState<TrendingNiche[]>([])
  const [winningAds, setWinningAds] = useState<Ad[]>([])
  const [adFilter, setAdFilter] = useState('')

  async function loadAds() {
    const d = await fetch(`/api/spy/ads${adFilter ? `?filter=${adFilter}` : ''}`).then(r => r.json())
    setAds(d.ads ?? [])
  }

  useEffect(() => {
    fetch('/api/spy/dashboard/summary').then(r => r.json()).then(setSummary).catch(() => {})
    fetch('/api/spy/products?days=30').then(r => r.json()).then(d => setProducts(d.products ?? [])).catch(() => {})
    fetch('/api/spy/trending?days=7').then(r => r.json()).then(d => { setNiches(d.niches ?? []); setWinningAds(d.winningAds ?? []) }).catch(() => {})
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadAds() }, [adFilter])

  async function saveProductIdea(p: Product) {
    await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: p.title ?? 'Product', refType: 'PRODUCT', refProductId: p.id, snapshotJson: p }) })
  }
  async function saveAdIdea(a: Ad) {
    await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: a.title ?? a.advertiser.pageName ?? 'Ad', refType: 'AD', refAdId: a.id, snapshotJson: a }) })
  }

  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <header className="mb-lg">
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools</p>
            <h2 className="text-display-md font-bold text-primary">Spy Dashboard</h2>
          </header>

          {summary && (
            <div className="mb-xl grid grid-cols-2 gap-lg md:grid-cols-4">
              <Stat label="New products 7d" value={summary.newProducts7d} />
              <Stat label="Active ads" value={summary.activeAds} />
              <Stat label="Scaling ads" value={summary.scalingAds} />
              <Stat label="Trending niches" value={summary.trendingNiches} />
            </div>
          )}

          <section className="mb-xl">
            <h3 className="mb-md text-headline-sm text-primary">Trending niches</h3>
            <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3">
              {niches.map(n => (
                <div key={n.niche} className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
                  <div className="flex items-center justify-between">
                    <p className="text-label-md font-bold text-primary">{n.niche}</p>
                    <span className={`rounded-full px-sm py-xs text-label-sm ${n.deltaPct >= 0 ? 'bg-on-tertiary-container/15 text-on-tertiary-container' : 'bg-error/10 text-error'}`}>{n.deltaPct >= 0 ? '+' : ''}{n.deltaPct}%</span>
                  </div>
                  <p className="mt-xs text-body-sm text-on-surface-variant">{n.newCount} new (prev {n.prevCount})</p>
                  {n.topStores.length > 0 && <p className="mt-xs text-body-sm text-on-surface-variant">{n.topStores.join(' · ')}</p>}
                </div>
              ))}
              {niches.length === 0 && <p className="text-body-md text-on-surface-variant">No trending niches yet.</p>}
            </div>
          </section>

          <section className="mb-xl">
            <h3 className="mb-md text-headline-sm text-primary">Winning / scaling ads</h3>
            <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {winningAds.map(a => (
                <article key={a.id} className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
                  <AdBadges s={a.signals} />
                  <p className="line-clamp-2 text-label-md font-bold text-primary">{a.title ?? a.advertiser.pageName ?? 'Ad'}</p>
                  <p className="mt-xs line-clamp-2 text-body-sm text-on-surface-variant">{a.body}</p>
                  <p className="mt-xs text-body-sm text-on-surface-variant">{a.advertiser.pageName} · {a.signals.activeDays}d</p>
                  <div className="mt-sm flex items-center justify-between">
                    <a href={`/tools/spy-idea/ads/${a.id}`} className="text-secondary text-label-sm hover:underline">Detail</a>
                    <button onClick={() => saveAdIdea(a)} className="text-secondary text-label-sm hover:underline">＋ Save IDEA</button>
                  </div>
                </article>
              ))}
              {winningAds.length === 0 && <p className="text-body-md text-on-surface-variant">No winning ads yet.</p>}
            </div>
          </section>

          <section className="mb-xl">
            <div className="mb-md flex items-center gap-md">
              <h3 className="text-headline-sm text-primary">Ads</h3>
              <div className="flex gap-xs">
                {['', 'new', 'long-running', 'scaling', 'stopped'].map(f => (
                  <button key={f} onClick={() => setAdFilter(f)} className={`rounded-md px-md py-xs text-label-sm ${adFilter === f ? 'bg-secondary text-on-secondary' : 'bg-surface-container text-on-surface-variant'}`}>{f === '' ? 'All' : f}</button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {ads.map(a => (
                <article key={a.id} className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
                  <AdBadges s={a.signals} />
                  <p className="line-clamp-2 text-label-md font-bold text-primary">{a.title ?? a.advertiser.pageName ?? 'Ad'}</p>
                  <p className="mt-xs text-body-sm text-on-surface-variant">{a.advertiser.pageName} · {a.signals.activeDays}d · {formatDate(a.startDate)}</p>
                  <div className="mt-sm flex items-center justify-between">
                    <a href={`/tools/spy-idea/ads/${a.id}`} className="text-secondary text-label-sm hover:underline">Detail</a>
                    <button onClick={() => saveAdIdea(a)} className="text-secondary text-label-sm hover:underline">＋ Save IDEA</button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="mb-xl">
            <h3 className="mb-md text-headline-sm text-primary">New products</h3>
            <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {products.map(p => (
                <article key={p.id} className="overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container-lowest">
                  <div className="aspect-square bg-surface-container-low">
                    {p.imageUrl
                      ? // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.imageUrl} alt={p.title ?? ''} className="h-full w-full object-cover" />
                      : <div className="flex h-full items-center justify-center text-on-surface-variant"><span className="material-symbols-outlined text-[42px]">image_not_supported</span></div>}
                  </div>
                  <div className="p-md">
                    <p className="line-clamp-2 text-label-md font-bold text-primary">{p.title}</p>
                    <p className="mt-xs text-body-sm text-on-surface-variant">{p.store.domain} · {formatDate(p.firstSeenAt)}</p>
                    <p className="text-body-sm text-on-surface-variant">{priceText(p.priceMin, p.priceMax)}</p>
                    <button onClick={() => saveProductIdea(p)} className="mt-sm text-secondary text-label-sm hover:underline">＋ Save IDEA</button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </main>
      </div>
    </RoleGate>
  )
}
```

- [ ] **Step 3: Verify (no dev server)**

Run: `npx tsc --noEmit` (clean) and `npm run lint` (clean on new page + Sidebar; keep the `<img>` eslint-disable). Confirm the page starts with `'use client'` and renders `<Sidebar />`.

- [ ] **Step 4: Full suite + commit**

Run: `npm test` (all pass except the 2 known `order-profit.test.ts` failures).

```bash
git add src/app/tools/spy-idea/dashboard/page.tsx src/components/Sidebar.tsx
git commit -m "feat(spy): Spy Dashboard page (feeds + trending) + nav"
```

---

## Self-Review

**Spec coverage (spec §3–§7):**
- New Products feed (§3A) → Task 3 (reuses `/api/spy/products`). ✓
- Ads feed + filter chips (§3B) → Task 3 (reuses `/api/spy/ads`). ✓
- Trending: rising niches (§3C) → Task 1 (`computeTrendingNiches`) + Task 2 (route) + Task 3 (UI). ✓
- Trending: winning/scaling ads (§3C) → Task 2 (`winningAds`) + Task 3 (UI). ✓
- `/api/spy/trending` (§4.2) → Task 2. ✓
- `/api/spy/dashboard/summary` (§4.3, was optional — included) → Task 2. ✓
- `computeTrendingNiches` (§5) → Task 1. ✓
- Dashboard page (§6) → Task 3. ✓
- Sidebar nav (§7) → Task 3. ✓
- Non-goals (§8): no new models/cron/kanban/AI — respected. ✓

**Placeholder scan:** No TBD/TODO; every step has real code or a concrete command.

**Type consistency:** `TrendingNiche` defined in Task 1, consumed in Task 2 response + Task 3 UI type. `computeTrendingNiches(products, {windowDays})` signature identical across Tasks 1–2. Ad-signals functions reused with the same names as Phase 2. Reused endpoint shapes match Global Constraints.

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.
