# Spy Tool — Ad↔Product match + ad-focused dashboard + card enrich — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Label ads that link to a recently-listed product ("New Product Launching"), classify each ad's link style (Product/Collection/Homepage/Other), surface a clickable Ad ID, refocus the dashboard on ads only, and improve the scan UX (feedback + delete page target).

**Architecture:** A pure `parseAdLink` classifies an ad's `linkUrl` (unwrapping Facebook redirects). A `recentLaunchSet` helper batch-matches product-linking ads against recently-listed `SpyProduct`s (by store domain + handle, ≤7 days). `/api/spy/ads` and `/api/spy/dashboard/summary` use these to enrich responses. The dashboard page is refocused on ads (drops New Products/Trending) and renders the new badges; the Ads tab gets scan feedback + a delete button. No new DB models.

**Tech Stack:** Next.js (App Router, `'use client'` pages), Prisma + SQLite, Vitest, Tailwind design tokens.

**Spec:** `docs/superpowers/specs/2026-08-22-spy-ad-product-match-design.md`

## Global Constraints

- No new Prisma models, no migration, no cron, no Apify change (keep `activeStatus: 'all'`).
- Import Prisma only via `import { prisma } from '@/lib/db'`.
- API routes export named `GET`, return `NextResponse.json(...)`.
- All pages `'use client'`, render `<Sidebar />` inside `<RoleGate>`, layout `ml-[280px] flex-1 p-xl`. Icons `material-symbols-outlined`. Dates `en-US`. Card pattern `bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20`.
- Reuse `@/lib/spy/ad-signals` (`isNewAd`, `activeDays`, `isLongRunning`, `isScaling`, `isStopped`).
- Tests: `npm test` (vitest). `@`→`src`. Test files `src/**/*.test.ts`.
- Known pre-existing failures unrelated to this work: `src/lib/order-profit.test.ts` (2 tests) — ignore.
- Matching rule: an ad is "New Product Launching" iff `parseAdLink(linkUrl).kind === 'product'` AND a `SpyProduct` exists with `store.domain === host` AND `handle === parsed.handle` AND `firstSeenAt` within 7 days.

---

### Task 1: `parseAdLink`

**Files:**
- Create: `src/lib/spy/ad-link.ts`
- Test: `src/lib/spy/ad-link.test.ts`

**Interfaces:**
- Produces:
```ts
export type AdLinkKind = 'product' | 'collection' | 'homepage' | 'other'
export type ParsedAdLink = { host: string | null; kind: AdLinkKind | null; handle: string | null }
export function parseAdLink(linkUrl: string | null): ParsedAdLink
```

- [ ] **Step 1: Write the failing test**

Create `src/lib/spy/ad-link.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseAdLink } from './ad-link'

describe('parseAdLink', () => {
  it('classifies a product link and extracts the handle (strips www)', () => {
    expect(parseAdLink('https://www.mystore.com/products/cool-shirt?variant=1'))
      .toEqual({ host: 'mystore.com', kind: 'product', handle: 'cool-shirt' })
  })
  it('classifies collection / homepage / other', () => {
    expect(parseAdLink('https://mystore.com/collections/summer').kind).toBe('collection')
    expect(parseAdLink('https://mystore.com/').kind).toBe('homepage')
    expect(parseAdLink('https://mystore.com').kind).toBe('homepage')
    expect(parseAdLink('https://mystore.com/pages/about').kind).toBe('other')
  })
  it('unwraps a Facebook redirect (l.facebook.com?u=)', () => {
    const real = encodeURIComponent('https://mystore.com/products/hat')
    expect(parseAdLink(`https://l.facebook.com/l.php?u=${real}&h=abc`))
      .toEqual({ host: 'mystore.com', kind: 'product', handle: 'hat' })
  })
  it('returns nulls for empty or invalid input', () => {
    expect(parseAdLink(null)).toEqual({ host: null, kind: null, handle: null })
    expect(parseAdLink('not a url')).toEqual({ host: null, kind: null, handle: null })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/lib/spy/ad-link.test.ts`
Expected: FAIL — cannot find module `./ad-link`.

- [ ] **Step 3: Implement**

Create `src/lib/spy/ad-link.ts`:

```ts
export type AdLinkKind = 'product' | 'collection' | 'homepage' | 'other'
export type ParsedAdLink = { host: string | null; kind: AdLinkKind | null; handle: string | null }

const NULLS: ParsedAdLink = { host: null, kind: null, handle: null }

export function parseAdLink(linkUrl: string | null): ParsedAdLink {
  if (!linkUrl) return NULLS
  let u: URL
  try {
    u = new URL(linkUrl)
  } catch {
    return NULLS
  }
  // Unwrap Facebook click redirect once.
  if (/^(l|lm)\.facebook\.com$/i.test(u.hostname)) {
    const target = u.searchParams.get('u')
    if (target) {
      try { u = new URL(target) } catch { return NULLS }
    }
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const path = u.pathname
  const product = path.match(/\/products\/([^/?#]+)/)
  if (product) return { host, kind: 'product', handle: decodeURIComponent(product[1]) }
  if (/\/collections\//.test(path)) return { host, kind: 'collection', handle: null }
  if (path === '' || path === '/') return { host, kind: 'homepage', handle: null }
  return { host, kind: 'other', handle: null }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- src/lib/spy/ad-link.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/spy/ad-link.ts src/lib/spy/ad-link.test.ts
git commit -m "feat(spy): parseAdLink (classify + unwrap FB redirect)"
```

---

### Task 2: `recentLaunchSet` helper + enrich ads & summary routes

**Files:**
- Create: `src/lib/spy/ad-product-match.ts`
- Test: `src/lib/spy/ad-product-match.test.ts`
- Modify: `src/app/api/spy/ads/route.ts`
- Modify: `src/app/api/spy/dashboard/summary/route.ts`

**Interfaces:**
- Consumes: `parseAdLink` (Task 1); `prisma` (`spyProduct`, `spyAd`); ad-signals.
- Produces: `recentLaunchSet(linkUrls: Array<string | null>, windowDays?: number): Promise<Set<string>>` — set of `` `${domain}|${handle}` `` for products linked by the ads and listed within `windowDays` (default 7). Consumers test membership with `` `${parsed.host}|${parsed.handle}` ``.

- [ ] **Step 1: Write the failing test for the helper (mock prisma)**

Create `src/lib/spy/ad-product-match.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const findMany = vi.fn()
vi.mock('@/lib/db', () => ({ prisma: { spyProduct: { findMany: (...a: any[]) => findMany(...a) } } }))

import { recentLaunchSet } from './ad-product-match'

beforeEach(() => { findMany.mockReset() })

describe('recentLaunchSet', () => {
  it('queries by distinct hosts+handles and returns domain|handle keys', async () => {
    findMany.mockResolvedValueOnce([{ handle: 'hat', store: { domain: 'mystore.com' } }])
    const set = await recentLaunchSet([
      'https://www.mystore.com/products/hat',
      'https://mystore.com/collections/x', // not a product → ignored
      null,
    ])
    expect(set.has('mystore.com|hat')).toBe(true)
    const arg = findMany.mock.calls[0][0]
    expect(arg.where.handle.in).toEqual(['hat'])
    expect(arg.where.store.domain.in).toEqual(['mystore.com'])
  })
  it('skips the query and returns empty when no product links', async () => {
    const set = await recentLaunchSet(['https://mystore.com/', null])
    expect(set.size).toBe(0)
    expect(findMany).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/lib/spy/ad-product-match.test.ts`
Expected: FAIL — cannot find module `./ad-product-match`.

- [ ] **Step 3: Implement the helper**

Create `src/lib/spy/ad-product-match.ts`:

```ts
import { prisma } from '@/lib/db'
import { parseAdLink } from './ad-link'

export async function recentLaunchSet(linkUrls: Array<string | null>, windowDays = 7): Promise<Set<string>> {
  const parsed = linkUrls.map(parseAdLink).filter(p => p.kind === 'product' && p.host && p.handle)
  const hosts = Array.from(new Set(parsed.map(p => p.host as string)))
  const handles = Array.from(new Set(parsed.map(p => p.handle as string)))
  if (hosts.length === 0 || handles.length === 0) return new Set()
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
  const products = await prisma.spyProduct.findMany({
    where: { handle: { in: handles }, firstSeenAt: { gte: since }, store: { domain: { in: hosts } } },
    select: { handle: true, store: { select: { domain: true } } },
  })
  return new Set(products.map(p => `${p.store?.domain}|${p.handle}`))
}
```

- [ ] **Step 4: Run helper test to verify pass**

Run: `npm test -- src/lib/spy/ad-product-match.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewrite `src/app/api/spy/ads/route.ts`**

Replace the file with (adds `adStyle` + `newProductLaunching` to signals, and a `filter=active` option):

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isNewAd, activeDays, isLongRunning, isScaling, isStopped } from '@/lib/spy/ad-signals'
import { parseAdLink } from '@/lib/spy/ad-link'
import { recentLaunchSet } from '@/lib/spy/ad-product-match'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const filter = searchParams.get('filter') || undefined
  const storeId = searchParams.get('storeId') || undefined
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '200', 10) || 200, 500)

  const ads = await prisma.spyAd.findMany({
    where: storeId ? { advertiser: { storeId } } : undefined,
    orderBy: { lastSeenAt: 'desc' },
    take: limit,
    include: {
      advertiser: { select: { pageName: true, storeId: true } },
      observations: { select: { isActive: true, collationCount: true, observedAt: true } },
    },
  })

  const launch = await recentLaunchSet(ads.map(a => a.linkUrl))
  const now = new Date()
  const enriched = ads.map(a => {
    const p = parseAdLink(a.linkUrl)
    const newProductLaunching = p.kind === 'product' && !!p.host && !!p.handle && launch.has(`${p.host}|${p.handle}`)
    return {
      ...a,
      signals: {
        isNew: isNewAd(a.startDate, now),
        activeDays: activeDays(a.startDate, a.endDate, now),
        isLongRunning: isLongRunning(a, now),
        isScaling: isScaling(a.observations),
        isStopped: isStopped(a.observations),
        adStyle: p.kind,
        newProductLaunching,
      },
    }
  })

  const flags: Record<string, (x: typeof enriched[number]) => boolean> = {
    active: x => x.isActive,
    new: x => x.signals.isNew,
    'long-running': x => x.signals.isLongRunning,
    scaling: x => x.signals.isScaling,
    stopped: x => x.signals.isStopped,
  }
  const result = filter && flags[filter] ? enriched.filter(flags[filter]) : enriched
  return NextResponse.json({ ads: result })
}
```

- [ ] **Step 6: Rewrite `src/app/api/spy/dashboard/summary/route.ts`**

Replace the file with (ads-focused counts):

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isScaling, isLongRunning } from '@/lib/spy/ad-signals'
import { parseAdLink } from '@/lib/spy/ad-link'
import { recentLaunchSet } from '@/lib/spy/ad-product-match'

export async function GET() {
  const activeAds = await prisma.spyAd.count({ where: { isActive: true } })
  const ads = await prisma.spyAd.findMany({
    take: 500,
    orderBy: { lastSeenAt: 'desc' },
    select: {
      isActive: true, startDate: true, endDate: true, linkUrl: true,
      observations: { select: { isActive: true, collationCount: true, observedAt: true } },
    },
  })
  const now = new Date()
  const scalingAds = ads.filter(a => isScaling(a.observations)).length
  const longRunningAds = ads.filter(a => isLongRunning(a, now)).length

  const launch = await recentLaunchSet(ads.map(a => a.linkUrl))
  const newLaunchingAds = ads.filter(a => {
    const p = parseAdLink(a.linkUrl)
    return p.kind === 'product' && !!p.host && !!p.handle && launch.has(`${p.host}|${p.handle}`)
  }).length

  return NextResponse.json({ activeAds, newLaunchingAds, scalingAds, longRunningAds })
}
```

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit` (clean) and `npm run lint` (clean on the four files). Then `npm test -- src/lib/spy/ad-product-match.test.ts` (pass).

- [ ] **Step 8: Commit**

```bash
git add src/lib/spy/ad-product-match.ts src/lib/spy/ad-product-match.test.ts src/app/api/spy/ads/route.ts src/app/api/spy/dashboard/summary/route.ts
git commit -m "feat(spy): enrich ads with adStyle + newProductLaunching; ads-focused summary"
```

---

### Task 3: Dashboard refocus on ads + card badges + Ad ID link

**Files:**
- Modify (replace): `src/app/tools/spy-idea/dashboard/page.tsx`

**Interfaces:**
- Consumes HTTP: `/api/spy/dashboard/summary` → `{ activeAds, newLaunchingAds, scalingAds, longRunningAds }`; `/api/spy/ads?filter=` → `{ ads: [{ ...spyAd, advertiser:{pageName}, signals:{...,adStyle,newProductLaunching} }] }`; `/api/spy/ideas` (POST).

- [ ] **Step 1: Replace the dashboard page**

Replace `src/app/tools/spy-idea/dashboard/page.tsx` with:

```tsx
'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'

type Summary = { activeAds: number; newLaunchingAds: number; scalingAds: number; longRunningAds: number }
type Signals = { isNew: boolean; activeDays: number; isLongRunning: boolean; isScaling: boolean; isStopped: boolean; adStyle: 'product'|'collection'|'homepage'|'other'|null; newProductLaunching: boolean }
type Ad = { id: string; title: string | null; body: string | null; adArchiveId: string; adLibraryUrl: string | null; linkUrl: string | null; isActive: boolean; startDate: string | null; advertiser: { pageName: string | null }; signals: Signals }

function formatDate(v: string | null) {
  if (!v) return '-'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
      <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">{label}</p>
      <p className="mt-xs text-stats-lg text-primary">{value}</p>
    </div>
  )
}

const STYLE_LABEL: Record<string, string> = { product: 'Product', collection: 'Collection', homepage: 'Homepage', other: 'Other' }

function AdCard({ a, onSave }: { a: Ad; onSave: (a: Ad) => void }) {
  const s = a.signals
  return (
    <article className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
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
      {a.adLibraryUrl && (
        <a href={a.adLibraryUrl} target="_blank" rel="noreferrer" className="mt-xs block truncate text-label-sm text-secondary hover:underline" title={a.adArchiveId}>
          #{a.adArchiveId}
        </a>
      )}
      <div className="mt-sm flex items-center justify-between">
        <a href={`/tools/spy-idea/ads/${a.id}`} className="text-secondary text-label-sm hover:underline">Detail</a>
        <button onClick={() => onSave(a)} className="text-secondary text-label-sm hover:underline">＋ Save IDEA</button>
      </div>
    </article>
  )
}

export default function SpyDashboardPage() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [ads, setAds] = useState<Ad[]>([])
  const [adFilter, setAdFilter] = useState('active')

  async function loadAds() {
    const d = await fetch(`/api/spy/ads?filter=${adFilter}&limit=500`).then(r => r.json())
    setAds(d.ads ?? [])
  }

  useEffect(() => {
    fetch('/api/spy/dashboard/summary').then(r => r.json()).then(setSummary).catch(() => {})
  }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadAds() }, [adFilter])

  // Winning = long-running or scaling, from the same enriched set.
  const winning = [...ads].filter(a => a.signals.isLongRunning || a.signals.isScaling).sort((x, y) => y.signals.activeDays - x.signals.activeDays).slice(0, 20)

  async function saveIdea(a: Ad) {
    await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: a.title ?? a.advertiser.pageName ?? 'Ad', refType: 'AD', refAdId: a.id, snapshotJson: a }) })
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
              <Stat label="Active ads" value={summary.activeAds} />
              <Stat label="New Product Launching" value={summary.newLaunchingAds} />
              <Stat label="Scaling ads" value={summary.scalingAds} />
              <Stat label="Long-running ads" value={summary.longRunningAds} />
            </div>
          )}

          <section className="mb-xl">
            <h3 className="mb-md text-headline-sm text-primary">Winning / scaling ads</h3>
            <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {winning.map(a => <AdCard key={a.id} a={a} onSave={saveIdea} />)}
              {winning.length === 0 && <p className="text-body-md text-on-surface-variant">No winning ads yet.</p>}
            </div>
          </section>

          <section className="mb-xl">
            <div className="mb-md flex items-center gap-md">
              <h3 className="text-headline-sm text-primary">Ads</h3>
              <div className="flex flex-wrap gap-xs">
                {['active', 'new', 'long-running', 'scaling', 'stopped', 'all'].map(f => (
                  <button key={f} onClick={() => setAdFilter(f)} className={`rounded-md px-md py-xs text-label-sm capitalize ${adFilter === f ? 'bg-secondary text-on-secondary' : 'bg-surface-container text-on-surface-variant'}`}>{f}</button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {ads.map(a => <AdCard key={a.id} a={a} onSave={saveIdea} />)}
              {ads.length === 0 && <p className="text-body-md text-on-surface-variant">No ads for this filter.</p>}
            </div>
          </section>
        </main>
      </div>
    </RoleGate>
  )
}
```

Note: the `all` filter chip maps to no server filter — the route treats any unknown `filter` value as "no filter" (returns all). `active` is now a supported server filter (Task 2). Both work.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` (clean) and `npm run lint` (clean on the page). Confirm `'use client'` + `<Sidebar />` present.

- [ ] **Step 3: Commit**

```bash
git add src/app/tools/spy-idea/dashboard/page.tsx
git commit -m "feat(spy): ad-focused dashboard with New Product Launching + Style + Ad ID"
```

---

### Task 4: Ads tab UX — scan feedback/auto-refresh + delete page target

**Files:**
- Modify: `src/app/tools/spy-idea/page.tsx`

**Interfaces:**
- Consumes HTTP: `/api/spy/scan-ads` (POST), `/api/spy/ads`, `/api/spy/pages` (DELETE).

The existing Ads tab has `scanAds()`, `loadAds()`, `loadPages()`, `pages`, and a page-target list. Add scan feedback + auto-refresh + a delete button.

- [ ] **Step 1: Add a scan-status message + auto-refresh to `scanAds`**

In `src/app/tools/spy-idea/page.tsx`, add a state near the other Ads state:

```tsx
const [scanMsg, setScanMsg] = useState('')
```

Replace the existing `scanAds` function with:

```tsx
async function scanAds() {
  setScanningAds(true)
  setScanMsg('Đang quét… ads sẽ xuất hiện sau ~30s.')
  try {
    await fetch('/api/spy/scan-ads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    // Scans run in the background (fire-and-forget). Refresh a couple of times.
    setTimeout(() => { loadAds() }, 15000)
    setTimeout(() => { loadAds(); loadPages(); setScanMsg('') }, 30000)
  } finally {
    setScanningAds(false)
  }
}
```

- [ ] **Step 2: Add a delete-page function**

Add near the other page actions:

```tsx
async function removePage(id: string) {
  await fetch('/api/spy/pages', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
  loadPages()
}
```

- [ ] **Step 3: Render the message + delete button**

In the Ads tab JSX: (a) after the "Scan ads now" button row, show `{scanMsg && <p className="text-body-sm text-on-surface-variant">{scanMsg}</p>}`; (b) in each page-target `<li>`, add a delete button on the right:

```tsx
<li key={p.id} className="flex items-center justify-between py-sm">
  <div>
    <p className="text-label-md text-primary">{p.label ?? p.pageUrl}</p>
    <p className="text-body-sm text-on-surface-variant">{p.store?.domain ?? 'unlinked'} · last {formatDate(p.lastScanAt)}</p>
  </div>
  <button onClick={() => removePage(p.id)} className="text-error text-label-sm hover:underline">Xoá</button>
</li>
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` (clean) and `npm run lint` (clean on the page; keep existing eslint-disable comments). Confirm existing tabs still present. Then full `npm test` (all pass except the 2 known `order-profit.test.ts` failures).

- [ ] **Step 5: Commit**

```bash
git add src/app/tools/spy-idea/page.tsx
git commit -m "feat(spy): scan feedback/auto-refresh + delete page target"
```

---

## Self-Review

**Spec coverage (spec §3–§8):**
- `parseAdLink` (§3) → Task 1. ✓
- New Product Launching batch match (§4) → Task 2 (`recentLaunchSet`). ✓
- `/api/spy/ads` enrich + `filter=active` (§5) → Task 2. ✓
- `/api/spy/dashboard/summary` ads-focused (§6) → Task 2. ✓
- Dashboard restructure + badges + Ad ID + default active + single ads source (§7) → Task 3. ✓
- UX scan feedback/auto-refresh + delete page (§8) → Task 4. ✓
- Non-goals (§9): no Apify change, no models/migration — respected. ✓

**Placeholder scan:** No TBD/TODO; every step has real code or a concrete command.

**Type consistency:** `ParsedAdLink`/`parseAdLink` (Task 1) consumed identically in Task 2. `recentLaunchSet(linkUrls, windowDays?)` (Task 2) called from both routes with `ads.map(a => a.linkUrl)`. `Signals` type in Task 3 UI includes `adStyle`+`newProductLaunching` exactly as Task 2's route adds them. Summary shape `{activeAds,newLaunchingAds,scalingAds,longRunningAds}` matches Task 3's `Summary` type. `filter=active` added in Task 2 matches the `active` default chip in Task 3.

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.
