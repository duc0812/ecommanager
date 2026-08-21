# Spy Tool — Phase 2: Facebook Ad Library (store ads) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scan each store's Facebook Ad Library via an Apify actor, persist ads as tracked entities with per-scan observations, expose new/long-running/scaling/stopped signals, and surface them (plus an ad detail timeline and "Save IDEA") in an Ads tab of `/tools/spy-idea`.

**Architecture:** A `SpyPageTarget` (FB page URL per store) is the scan input. `src/lib/spy/apify.ts` starts an Apify actor run and polls it to completion (no webhook). `mapApifyAd` normalizes each dataset item; `ingestAds` upserts `SpyAdvertiser` (by `fbPageId`) + `SpyAd` (by `adArchiveId`) and appends a `SpyAdObservation` per scan; `runPageAdScan` orchestrates this under a `SpyScan`. Signals are computed on read. A daily cron (09:00 VN) scans all active page targets. The ad tables already exist from Phase 1.

**Tech Stack:** Next.js (App Router, `'use client'` pages), Prisma + SQLite, Vitest (`vi.mock('@/lib/db')`, `vi.spyOn(globalThis,'fetch')`), node-cron, Apify REST API, Tailwind design tokens.

**Spec:** `docs/superpowers/specs/2026-08-21-spy-ads-phase2-design.md` (builds on `docs/superpowers/specs/2026-08-20-spy-tool-design.md`).

## Global Constraints

- **Never add `url` to the `datasource db {}` block** in `prisma/schema.prisma`.
- After schema change run IN ORDER: `npx prisma migrate dev --name <change>` → `npx prisma generate` → bump `SCHEMA_VERSION` in `src/lib/db.ts` (currently `'v24'` → `'v25'`) → restart dev server.
- Import Prisma only via `import { prisma } from '@/lib/db'`.
- SQLite: enums as `String` (allowed values in a comment), JSON as `String` default `"[]"`.
- API routes: `src/app/api/<feature>/<action>/route.ts`, export named `GET/POST/PATCH/DELETE`, return `NextResponse.json(...)`.
- All pages `'use client'`, render `<Sidebar />`, layout `<div className="flex min-h-screen bg-surface"><Sidebar /><main className="ml-[280px] flex-1 p-xl">…</main></div>`. Icons `material-symbols-outlined`. Dates `en-US` (MM/DD/YYYY).
- Routing stays under `/tools/spy-idea` (roles `tools_spy_idea` covers children via `startsWith`).
- Tests: `npm test` (vitest). Test files `src/**/*.test.ts`. `@`→`src`.
- Apify actor id: `curious_coder~facebook-ads-library-scraper`. Base URL `https://api.apify.com/v2`. Token from `process.env.APIFY_TOKEN`.
- Ad cost guard: `AD_SCAN_CAP = 200` per page/run.
- Known pre-existing failures unrelated to this work: `src/lib/order-profit.test.ts` (2 tests fail on base — ignore).

---

### Task 1: Add `SpyPageTarget` model + migration

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/lib/db.ts:6`
- Test: `src/lib/spy/page-target-schema.test.ts`

**Interfaces:**
- Produces: `prisma.spyPageTarget` delegate.

- [ ] **Step 1: Add the model to `prisma/schema.prisma`**

```prisma
model SpyPageTarget {
  id         String    @id @default(cuid())
  storeId    String?
  store      SpyStore? @relation(fields: [storeId], references: [id], onDelete: SetNull)
  pageUrl    String    @unique
  fbPageId   String?
  label      String?
  active     Boolean   @default(true)
  lastScanAt DateTime?
  createdAt  DateTime  @default(now())

  @@index([storeId])
  @@index([active])
}
```

Add the reverse relation field to the existing `SpyStore` model (alongside `products` / `advertisers`):

```prisma
  pageTargets SpyPageTarget[]
```

- [ ] **Step 2: Validate + migrate + generate**

Run: `npx prisma validate` (expect valid), then `npx prisma migrate dev --name add_spy_page_target`, then `npx prisma generate`.
Expected: migration applied, client generated.

- [ ] **Step 3: Bump SCHEMA_VERSION**

In `src/lib/db.ts:6` change `'v24'` → `'v25'`.

- [ ] **Step 4: Smoke test**

Create `src/lib/spy/page-target-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/db'

describe('spy page target schema', () => {
  it('exposes the spyPageTarget delegate', () => {
    expect((prisma as any).spyPageTarget).toBeDefined()
  })
})
```

Run: `npm test -- src/lib/spy/page-target-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma/ src/lib/db.ts src/lib/spy/page-target-schema.test.ts
git commit -m "feat(spy): add SpyPageTarget model"
```

---

### Task 2: Apify client

**Files:**
- Create: `src/lib/spy/apify.ts`
- Test: `src/lib/spy/apify.test.ts`

**Interfaces:**
- Produces:
  - `startActorRun(input: object): Promise<{ runId: string; datasetId: string }>`
  - `getRunStatus(runId: string): Promise<string>`
  - `getDatasetItems(datasetId: string): Promise<any[]>`
  - `pollRunUntilDone(runId: string, opts?: { intervalMs?: number; timeoutMs?: number }): Promise<string>` — resolves `'SUCCEEDED'`, throws on FAILED/TIMED-OUT/ABORTED or timeout.
  - `ACTOR_ID = 'curious_coder~facebook-ads-library-scraper'`
- All read `process.env.APIFY_TOKEN`; throw `Error('APIFY_TOKEN not set')` when missing.

- [ ] **Step 1: Write the failing test**

Create `src/lib/spy/apify.test.ts`:

```ts
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { startActorRun, getRunStatus, pollRunUntilDone } from './apify'

beforeEach(() => { process.env.APIFY_TOKEN = 'tok' })
afterEach(() => { vi.restoreAllMocks() })

describe('apify client', () => {
  it('startActorRun returns runId + datasetId', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { id: 'run1', defaultDatasetId: 'ds1' } }),
    } as Response)
    const r = await startActorRun({ urls: [{ url: 'https://facebook.com/x' }] })
    expect(r).toEqual({ runId: 'run1', datasetId: 'ds1' })
  })

  it('throws when APIFY_TOKEN missing', async () => {
    delete process.env.APIFY_TOKEN
    await expect(getRunStatus('run1')).rejects.toThrow('APIFY_TOKEN not set')
  })

  it('pollRunUntilDone polls until SUCCEEDED', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { status: 'RUNNING' } }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { status: 'SUCCEEDED' } }) } as Response)
    const status = await pollRunUntilDone('run1', { intervalMs: 1, timeoutMs: 1000 })
    expect(status).toBe('SUCCEEDED')
  })

  it('pollRunUntilDone throws on FAILED', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { status: 'FAILED' } }) } as Response)
    await expect(pollRunUntilDone('run1', { intervalMs: 1, timeoutMs: 1000 })).rejects.toThrow('FAILED')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/spy/apify.test.ts`
Expected: FAIL — cannot find module `./apify`.

- [ ] **Step 3: Implement**

Create `src/lib/spy/apify.ts`:

```ts
export const ACTOR_ID = 'curious_coder~facebook-ads-library-scraper'
const BASE = 'https://api.apify.com/v2'

function token(): string {
  const t = process.env.APIFY_TOKEN
  if (!t) throw new Error('APIFY_TOKEN not set')
  return t
}

export async function startActorRun(input: object): Promise<{ runId: string; datasetId: string }> {
  const res = await fetch(`${BASE}/acts/${ACTOR_ID}/runs?token=${token()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`Apify start run failed: ${res.status}`)
  const json = await res.json()
  return { runId: json.data.id, datasetId: json.data.defaultDatasetId }
}

export async function getRunStatus(runId: string): Promise<string> {
  const res = await fetch(`${BASE}/actor-runs/${runId}?token=${token()}`)
  if (!res.ok) throw new Error(`Apify run status failed: ${res.status}`)
  const json = await res.json()
  return json.data.status
}

export async function getDatasetItems(datasetId: string): Promise<any[]> {
  const res = await fetch(`${BASE}/datasets/${datasetId}/items?clean=true&token=${token()}`)
  if (!res.ok) throw new Error(`Apify dataset fetch failed: ${res.status}`)
  return res.json()
}

const TERMINAL_OK = new Set(['SUCCEEDED'])
const TERMINAL_BAD = new Set(['FAILED', 'TIMED-OUT', 'ABORTED'])

export async function pollRunUntilDone(
  runId: string, opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<string> {
  const intervalMs = opts.intervalMs ?? 10_000
  const timeoutMs = opts.timeoutMs ?? 300_000
  const start = Date.now()
  for (;;) {
    const status = await getRunStatus(runId)
    if (TERMINAL_OK.has(status)) return status
    if (TERMINAL_BAD.has(status)) throw new Error(`Apify run ${status}`)
    if (Date.now() - start > timeoutMs) throw new Error('Apify run timeout')
    await new Promise(r => setTimeout(r, intervalMs))
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- src/lib/spy/apify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/spy/apify.ts src/lib/spy/apify.test.ts
git commit -m "feat(spy): apify client (start/status/dataset/poll)"
```

---

### Task 3: `mapApifyAd`

**Files:**
- Create: `src/lib/spy/ad-mapping.ts`
- Test: `src/lib/spy/ad-mapping.test.ts`

**Interfaces:**
- Produces:
```ts
export type ParsedSpyAd = {
  adArchiveId: string; pageId: string; pageName: string | null; pageCategory: string | null
  pageLikes: number | null; igUsername: string | null; igFollowers: number | null
  isActive: boolean; startDate: Date | null; endDate: Date | null
  collationCount: number | null; collationId: string | null
  mediaType: 'video' | 'image' | 'carousel' | 'dco' | null; displayFormat: string | null
  ctaType: string | null; ctaText: string | null; linkUrl: string | null
  title: string | null; body: string | null; caption: string | null
  publisherPlatforms: string[]; currency: string | null; adLibraryUrl: string | null; rawPayload: any
}
export function mapApifyAd(raw: any): ParsedSpyAd
```

- [ ] **Step 1: Write the failing test**

Create `src/lib/spy/ad-mapping.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mapApifyAd } from './ad-mapping'

describe('mapApifyAd', () => {
  it('maps core fields, unix dates, advertiser info, video mediaType', () => {
    const raw = {
      ad_archive_id: 'A1', page_id: '123', page_name: 'Brand', is_active: true,
      start_date: 1735689600, end_date: 1736294400, collation_count: 5, collation_id: 'c1',
      currency: 'USD', ad_library_url: 'https://facebook.com/ads/library/?id=A1',
      publisher_platform: ['facebook', 'instagram'],
      advertiser: { ad_library_page_info: { page_info: { likes: 1000, page_category: 'Retail', ig_username: 'brand', ig_followers: 50 } } },
      snapshot: { display_format: 'video', videos: [{ video_hd_url: 'v' }], body: { text: 'Buy now' }, caption: 'cap', cta_type: 'SHOP_NOW', cta_text: 'Shop Now', link_url: 'https://shop', title: 'T' },
    }
    const a = mapApifyAd(raw)
    expect(a.adArchiveId).toBe('A1')
    expect(a.pageId).toBe('123')
    expect(a.pageLikes).toBe(1000)
    expect(a.igUsername).toBe('brand')
    expect(a.isActive).toBe(true)
    expect(a.startDate?.toISOString()).toBe('2025-01-01T00:00:00.000Z')
    expect(a.mediaType).toBe('video')
    expect(a.body).toBe('Buy now')
    expect(a.ctaType).toBe('SHOP_NOW')
    expect(a.publisherPlatforms).toEqual(['facebook', 'instagram'])
  })

  it('detects carousel when cards>1 and handles string body + missing dates', () => {
    const a = mapApifyAd({ ad_archive_id: 'A2', page_id: '9', is_active: false, snapshot: { cards: [{}, {}], body: 'plain' } })
    expect(a.mediaType).toBe('carousel')
    expect(a.body).toBe('plain')
    expect(a.startDate).toBeNull()
    expect(a.pageLikes).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/spy/ad-mapping.test.ts`
Expected: FAIL — cannot find module `./ad-mapping`.

- [ ] **Step 3: Implement**

Create `src/lib/spy/ad-mapping.ts`:

```ts
export type ParsedSpyAd = {
  adArchiveId: string; pageId: string; pageName: string | null; pageCategory: string | null
  pageLikes: number | null; igUsername: string | null; igFollowers: number | null
  isActive: boolean; startDate: Date | null; endDate: Date | null
  collationCount: number | null; collationId: string | null
  mediaType: 'video' | 'image' | 'carousel' | 'dco' | null; displayFormat: string | null
  ctaType: string | null; ctaText: string | null; linkUrl: string | null
  title: string | null; body: string | null; caption: string | null
  publisherPlatforms: string[]; currency: string | null; adLibraryUrl: string | null; rawPayload: any
}

function unixToDate(v: any): Date | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null
}

function bodyToString(body: any): string | null {
  if (body == null) return null
  if (typeof body === 'string') return body
  if (typeof body === 'object' && typeof body.text === 'string') return body.text
  return null
}

function detectMediaType(snapshot: any): ParsedSpyAd['mediaType'] {
  if (!snapshot) return null
  if (Array.isArray(snapshot.cards) && snapshot.cards.length > 1) return 'carousel'
  if (Array.isArray(snapshot.videos) && snapshot.videos.length > 0) return 'video'
  if (Array.isArray(snapshot.images) && snapshot.images.length > 0) return 'image'
  const df = String(snapshot.display_format ?? '').toLowerCase()
  if (df === 'dco' || df === 'dpa') return 'dco'
  return null
}

export function mapApifyAd(raw: any): ParsedSpyAd {
  const snapshot = raw?.snapshot ?? {}
  const pageInfo = raw?.advertiser?.ad_library_page_info?.page_info ?? {}
  const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : null)
  return {
    adArchiveId: String(raw?.ad_archive_id ?? raw?.adArchiveId ?? ''),
    pageId: String(raw?.page_id ?? snapshot.page_id ?? ''),
    pageName: raw?.page_name ?? snapshot.page_name ?? null,
    pageCategory: pageInfo.page_category ?? null,
    pageLikes: num(pageInfo.likes),
    igUsername: pageInfo.ig_username ?? null,
    igFollowers: num(pageInfo.ig_followers),
    isActive: Boolean(raw?.is_active),
    startDate: unixToDate(raw?.start_date),
    endDate: unixToDate(raw?.end_date),
    collationCount: num(raw?.collation_count),
    collationId: raw?.collation_id ?? null,
    mediaType: detectMediaType(snapshot),
    displayFormat: snapshot.display_format ?? null,
    ctaType: snapshot.cta_type ?? null,
    ctaText: snapshot.cta_text ?? null,
    linkUrl: snapshot.link_url ?? null,
    title: snapshot.title ?? null,
    body: bodyToString(snapshot.body),
    caption: snapshot.caption ?? null,
    publisherPlatforms: Array.isArray(raw?.publisher_platform) ? raw.publisher_platform : [],
    currency: raw?.currency ?? null,
    adLibraryUrl: raw?.ad_library_url ?? null,
    rawPayload: raw,
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- src/lib/spy/ad-mapping.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/spy/ad-mapping.ts src/lib/spy/ad-mapping.test.ts
git commit -m "feat(spy): map Apify ad payload to ParsedSpyAd"
```

---

### Task 4: `ingestAds`

**Files:**
- Create: `src/lib/spy/ingest-ads.ts`
- Test: `src/lib/spy/ingest-ads.test.ts`

**Interfaces:**
- Consumes: `ParsedSpyAd` from `@/lib/spy/ad-mapping`; `prisma` (delegates `spyAdvertiser`, `spyAd`, `spyAdObservation`).
- Produces: `ingestAds(scanId: string, storeId: string | null, ads: ParsedSpyAd[]): Promise<{ found: number; newAds: number; updated: number }>`.

- [ ] **Step 1: Write the failing test (mock prisma)**

Create `src/lib/spy/ingest-ads.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: any = { advUpsert: [], adUpsert: [], obs: [] }
vi.mock('@/lib/db', () => ({
  prisma: {
    spyAdvertiser: { upsert: vi.fn(async (a: any) => { calls.advUpsert.push(a); return { id: 'adv1' } }) },
    spyAd: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async (a: any) => { calls.adUpsert.push(a); return { id: 'ad1' } }),
    },
    spyAdObservation: { upsert: vi.fn(async (a: any) => { calls.obs.push(a); return {} }) },
  },
}))

import { ingestAds } from './ingest-ads'
import type { ParsedSpyAd } from '@/lib/spy/ad-mapping'

const ad = (id: string): ParsedSpyAd => ({
  adArchiveId: id, pageId: '123', pageName: 'Brand', pageCategory: 'Retail', pageLikes: 10,
  igUsername: null, igFollowers: null, isActive: true, startDate: new Date('2026-08-01'),
  endDate: null, collationCount: 3, collationId: 'c', mediaType: 'video', displayFormat: 'video',
  ctaType: 'SHOP_NOW', ctaText: 'Shop', linkUrl: 'https://x', title: 'T', body: 'B', caption: null,
  publisherPlatforms: ['facebook'], currency: 'USD', adLibraryUrl: 'https://l', rawPayload: { x: 1 },
})

beforeEach(() => { calls.advUpsert.length = 0; calls.adUpsert.length = 0; calls.obs.length = 0; vi.clearAllMocks() })

describe('ingestAds', () => {
  it('upserts advertiser by fbPageId, ad by adArchiveId, observation per scan', async () => {
    const res = await ingestAds('scan1', 'store1', [ad('A1')])
    expect(res.found).toBe(1)
    expect(calls.advUpsert[0].where).toEqual({ fbPageId: '123' })
    expect(calls.adUpsert[0].where).toEqual({ adArchiveId: 'A1' })
    expect(calls.adUpsert[0].create.publisherPlatforms).toBe('["facebook"]')
    expect(calls.adUpsert[0].create.rawPayload).toBe('{"x":1}')
    expect(calls.obs[0].where).toEqual({ adId_scanId: { adId: 'ad1', scanId: 'scan1' } })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/spy/ingest-ads.test.ts`
Expected: FAIL — cannot find module `./ingest-ads`.

- [ ] **Step 3: Implement**

Create `src/lib/spy/ingest-ads.ts`:

```ts
import { prisma } from '@/lib/db'
import type { ParsedSpyAd } from '@/lib/spy/ad-mapping'

export async function ingestAds(
  scanId: string, storeId: string | null, ads: ParsedSpyAd[],
): Promise<{ found: number; newAds: number; updated: number }> {
  let newAds = 0, updated = 0
  const now = new Date()
  for (const a of ads) {
    if (!a.adArchiveId || !a.pageId) continue
    const advertiser = await prisma.spyAdvertiser.upsert({
      where: { fbPageId: a.pageId },
      create: {
        fbPageId: a.pageId, pageName: a.pageName, pageCategory: a.pageCategory,
        likes: a.pageLikes, igUsername: a.igUsername, igFollowers: a.igFollowers,
        storeId: storeId ?? undefined, firstSeenAt: now, lastSeenAt: now,
      },
      update: {
        pageName: a.pageName, pageCategory: a.pageCategory, likes: a.pageLikes,
        igUsername: a.igUsername, igFollowers: a.igFollowers, lastSeenAt: now,
        ...(storeId ? { storeId } : {}),
      },
    })

    const existing = await prisma.spyAd.findUnique({ where: { adArchiveId: a.adArchiveId }, select: { id: true } })
    const data = {
      advertiserId: advertiser.id, pageId: a.pageId, startDate: a.startDate, endDate: a.endDate,
      isActive: a.isActive, collationCount: a.collationCount, collationId: a.collationId,
      mediaType: a.mediaType, displayFormat: a.displayFormat, ctaType: a.ctaType, ctaText: a.ctaText,
      linkUrl: a.linkUrl, title: a.title, body: a.body, caption: a.caption,
      publisherPlatforms: JSON.stringify(a.publisherPlatforms), currency: a.currency,
      adLibraryUrl: a.adLibraryUrl, rawPayload: JSON.stringify(a.rawPayload),
    }
    const row = await prisma.spyAd.upsert({
      where: { adArchiveId: a.adArchiveId },
      create: { adArchiveId: a.adArchiveId, firstSeenAt: now, lastSeenAt: now, ...data },
      update: { lastSeenAt: now, ...data },
    })
    if (existing) updated++; else newAds++

    await prisma.spyAdObservation.upsert({
      where: { adId_scanId: { adId: row.id, scanId } },
      create: { adId: row.id, scanId, isActive: a.isActive, collationCount: a.collationCount, observedAt: now },
      update: { isActive: a.isActive, collationCount: a.collationCount },
    })
  }
  return { found: ads.length, newAds, updated }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- src/lib/spy/ingest-ads.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/spy/ingest-ads.ts src/lib/spy/ingest-ads.test.ts
git commit -m "feat(spy): ingest ads (advertiser + ad + observation)"
```

---

### Task 5: Ad signals + `AD_SCAN_CAP`

**Files:**
- Create: `src/lib/spy/ad-signals.ts`
- Test: `src/lib/spy/ad-signals.test.ts`

**Interfaces:**
- Produces:
  - `AD_SCAN_CAP = 200`
  - `isNewAd(startDate: Date|null, now?: Date, windowDays?: number): boolean` (default 7)
  - `activeDays(startDate: Date|null, endDate: Date|null, now?: Date): number`
  - `isLongRunning(a: { isActive: boolean; startDate: Date|null; endDate: Date|null }, now?: Date, minDays?: number): boolean` (default 21)
  - `isScaling(obs: { collationCount: number|null; observedAt: Date }[]): boolean`
  - `isStopped(obs: { isActive: boolean; observedAt: Date }[]): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/lib/spy/ad-signals.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { AD_SCAN_CAP, isNewAd, activeDays, isLongRunning, isScaling, isStopped } from './ad-signals'

const now = new Date('2026-08-21T00:00:00Z')
describe('ad signals', () => {
  it('AD_SCAN_CAP is 200', () => { expect(AD_SCAN_CAP).toBe(200) })
  it('isNewAd within 7 days', () => {
    expect(isNewAd(new Date('2026-08-18T00:00:00Z'), now)).toBe(true)
    expect(isNewAd(new Date('2026-08-01T00:00:00Z'), now)).toBe(false)
    expect(isNewAd(null, now)).toBe(false)
  })
  it('activeDays counts to now when endDate null', () => {
    expect(activeDays(new Date('2026-08-11T00:00:00Z'), null, now)).toBe(10)
    expect(activeDays(null, null, now)).toBe(0)
  })
  it('isLongRunning requires active + >=21 days', () => {
    expect(isLongRunning({ isActive: true, startDate: new Date('2026-07-01T00:00:00Z'), endDate: null }, now)).toBe(true)
    expect(isLongRunning({ isActive: false, startDate: new Date('2026-07-01T00:00:00Z'), endDate: null }, now)).toBe(false)
    expect(isLongRunning({ isActive: true, startDate: new Date('2026-08-15T00:00:00Z'), endDate: null }, now)).toBe(false)
  })
  it('isScaling when latest collation > earliest', () => {
    expect(isScaling([{ collationCount: 2, observedAt: new Date('2026-08-01') }, { collationCount: 6, observedAt: new Date('2026-08-10') }])).toBe(true)
    expect(isScaling([{ collationCount: 5, observedAt: new Date('2026-08-01') }])).toBe(false)
  })
  it('isStopped when was active then inactive', () => {
    expect(isStopped([{ isActive: true, observedAt: new Date('2026-08-01') }, { isActive: false, observedAt: new Date('2026-08-10') }])).toBe(true)
    expect(isStopped([{ isActive: true, observedAt: new Date('2026-08-10') }])).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/spy/ad-signals.test.ts`
Expected: FAIL — cannot find module `./ad-signals`.

- [ ] **Step 3: Implement**

Create `src/lib/spy/ad-signals.ts`:

```ts
export const AD_SCAN_CAP = 200
const DAY = 24 * 60 * 60 * 1000

export function isNewAd(startDate: Date | null, now: Date = new Date(), windowDays = 7): boolean {
  if (!startDate) return false
  return startDate.getTime() >= now.getTime() - windowDays * DAY
}

export function activeDays(startDate: Date | null, endDate: Date | null, now: Date = new Date()): number {
  if (!startDate) return 0
  const end = endDate ?? now
  return Math.max(0, Math.floor((end.getTime() - startDate.getTime()) / DAY))
}

export function isLongRunning(
  a: { isActive: boolean; startDate: Date | null; endDate: Date | null }, now: Date = new Date(), minDays = 21,
): boolean {
  return a.isActive && activeDays(a.startDate, a.endDate, now) >= minDays
}

export function isScaling(obs: { collationCount: number | null; observedAt: Date }[]): boolean {
  if (obs.length < 2) return false
  const sorted = [...obs].sort((x, y) => x.observedAt.getTime() - y.observedAt.getTime())
  const first = sorted[0].collationCount ?? 0
  const last = sorted[sorted.length - 1].collationCount ?? 0
  return last > first
}

export function isStopped(obs: { isActive: boolean; observedAt: Date }[]): boolean {
  if (obs.length < 2) return false
  const sorted = [...obs].sort((x, y) => x.observedAt.getTime() - y.observedAt.getTime())
  return sorted.some(o => o.isActive) && sorted[sorted.length - 1].isActive === false
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- src/lib/spy/ad-signals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/spy/ad-signals.ts src/lib/spy/ad-signals.test.ts
git commit -m "feat(spy): ad signals + AD_SCAN_CAP"
```

---

### Task 6: `runPageAdScan` orchestrator

**Files:**
- Create: `src/lib/spy/scan-ads.ts`
- Test: `src/lib/spy/scan-ads.test.ts`

**Interfaces:**
- Consumes: `startActorRun`, `pollRunUntilDone`, `getDatasetItems` (Task 2); `mapApifyAd` (Task 3); `ingestAds` (Task 4); `AD_SCAN_CAP` (Task 5); `prisma` (delegates `spyScan`, `spyPageTarget`).
- Produces: `runPageAdScan(pageTarget: { id: string; storeId: string | null; pageUrl: string }): Promise<{ scanId: string; status: 'success' | 'failed'; stats?: object; error?: string }>`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/spy/scan-ads.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db: any = { scans: [] }
vi.mock('@/lib/db', () => ({
  prisma: {
    spyScan: {
      create: vi.fn(async ({ data }: any) => { const s = { id: 'scan1', ...data }; db.scans.push(s); return s }),
      update: vi.fn(async ({ data }: any) => { Object.assign(db.scans[0], data); return db.scans[0] }),
    },
    spyPageTarget: { update: vi.fn(async () => ({})) },
  },
}))
vi.mock('./apify', () => ({
  startActorRun: vi.fn(async () => ({ runId: 'r1', datasetId: 'd1' })),
  pollRunUntilDone: vi.fn(async () => 'SUCCEEDED'),
  getDatasetItems: vi.fn(async () => [{ ad_archive_id: 'A1', page_id: '9', is_active: true }]),
}))
vi.mock('./ingest-ads', () => ({ ingestAds: vi.fn(async () => ({ found: 1, newAds: 1, updated: 0 })) }))

import { runPageAdScan } from './scan-ads'
import { startActorRun, pollRunUntilDone } from './apify'

beforeEach(() => { db.scans.length = 0; vi.clearAllMocks() })

describe('runPageAdScan', () => {
  it('success path records stats and updates page target', async () => {
    const r = await runPageAdScan({ id: 'pt1', storeId: 'store1', pageUrl: 'https://facebook.com/Brand' })
    expect(r.status).toBe('success')
    expect(db.scans[0].status).toBe('success')
    expect((startActorRun as any).mock.calls[0][0].count).toBe(200)
    expect(JSON.parse(db.scans[0].stats)).toMatchObject({ found: 1, newAds: 1 })
  })
  it('failed path when apify run fails', async () => {
    ;(pollRunUntilDone as any).mockRejectedValueOnce(new Error('Apify run FAILED'))
    const r = await runPageAdScan({ id: 'pt1', storeId: null, pageUrl: 'https://facebook.com/Brand' })
    expect(r.status).toBe('failed')
    expect(db.scans[0].status).toBe('failed')
    expect(db.scans[0].error).toContain('FAILED')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/lib/spy/scan-ads.test.ts`
Expected: FAIL — cannot find module `./scan-ads`.

- [ ] **Step 3: Implement**

Create `src/lib/spy/scan-ads.ts`:

```ts
import { prisma } from '@/lib/db'
import { startActorRun, pollRunUntilDone, getDatasetItems } from './apify'
import { mapApifyAd } from './ad-mapping'
import { ingestAds } from './ingest-ads'
import { AD_SCAN_CAP } from './ad-signals'

export async function runPageAdScan(pageTarget: { id: string; storeId: string | null; pageUrl: string }) {
  const scan = await prisma.spyScan.create({
    data: { type: 'STORE_ADS', targetType: 'STORE', targetId: pageTarget.storeId ?? pageTarget.id, status: 'running' },
  })
  try {
    const { runId, datasetId } = await startActorRun({
      urls: [{ url: pageTarget.pageUrl }],
      'scrapePageAds.activeStatus': 'all',
      'scrapePageAds.sortBy': 'impressions_desc',
      'scrapePageAds.countryCode': 'ALL',
      count: AD_SCAN_CAP,
    })
    await prisma.spyScan.update({ where: { id: scan.id }, data: { apifyRunId: runId, apifyDatasetId: datasetId } })
    await pollRunUntilDone(runId)
    const items = await getDatasetItems(datasetId)
    const ads = items.map(mapApifyAd)
    const ingest = await ingestAds(scan.id, pageTarget.storeId, ads)
    const stats = { totalScanned: items.length, ...ingest }
    await prisma.spyScan.update({ where: { id: scan.id }, data: { status: 'success', stats: JSON.stringify(stats), finishedAt: new Date() } })
    const fbPageId = ads.find(a => a.pageId)?.pageId ?? null
    await prisma.spyPageTarget.update({ where: { id: pageTarget.id }, data: { lastScanAt: new Date(), ...(fbPageId ? { fbPageId } : {}) } })
    return { scanId: scan.id, status: 'success' as const, stats }
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : 'Unknown error'
    await prisma.spyScan.update({ where: { id: scan.id }, data: { status: 'failed', error, finishedAt: new Date() } })
    return { scanId: scan.id, status: 'failed' as const, error }
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- src/lib/spy/scan-ads.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/spy/scan-ads.ts src/lib/spy/scan-ads.test.ts
git commit -m "feat(spy): runPageAdScan orchestrator"
```

---

### Task 7: Page target CRUD API

**Files:**
- Create: `src/app/api/spy/pages/route.ts`

**Interfaces:**
- Consumes: `prisma` (`spyPageTarget`).
- Produces HTTP: `GET` (list w/ store), `POST {pageUrl,storeId?,label?}` (validate facebook.com host, upsert by pageUrl), `PATCH {id,active?,label?,storeId?}`, `DELETE {id}`.

- [ ] **Step 1: Implement the route**

Create `src/app/api/spy/pages/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

function validFbUrl(raw: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return null
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, '')
  } catch { return null }
}

export async function GET() {
  const pages = await prisma.spyPageTarget.findMany({
    orderBy: { createdAt: 'desc' },
    include: { store: { select: { domain: true } } },
  })
  return NextResponse.json(pages)
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  const pageUrl = validFbUrl(String(b.pageUrl ?? ''))
  if (!pageUrl) return NextResponse.json({ error: 'A facebook.com page URL is required' }, { status: 400 })
  const page = await prisma.spyPageTarget.upsert({
    where: { pageUrl },
    create: { pageUrl, storeId: b.storeId || null, label: b.label || null },
    update: { storeId: b.storeId ?? undefined, label: b.label ?? undefined },
  })
  return NextResponse.json(page)
}

export async function PATCH(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const data: Record<string, unknown> = {}
  if ('active' in b) data.active = Boolean(b.active)
  if ('label' in b) data.label = b.label || null
  if ('storeId' in b) data.storeId = b.storeId || null
  const page = await prisma.spyPageTarget.update({ where: { id: b.id }, data })
  return NextResponse.json(page)
}

export async function DELETE(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await prisma.spyPageTarget.delete({ where: { id: b.id } })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Verify (no dev server)**

Run: `npx tsc --noEmit` (no errors in new file) and `npm run lint` (clean on new file). Runtime exercised in Task 11.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/spy/pages/route.ts
git commit -m "feat(spy): page target CRUD API"
```

---

### Task 8: Scan-ads trigger API (fire-and-forget)

**Files:**
- Create: `src/app/api/spy/scan-ads/route.ts`

**Interfaces:**
- Consumes: `runPageAdScan` (Task 6); `prisma` (`spyPageTarget`).
- Produces HTTP: `POST {pageId?}` scans that page target; else all `active`. Returns immediately with the started scans (fire-and-forget — do not await the full run in the request).

- [ ] **Step 1: Implement**

Create `src/app/api/spy/scan-ads/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { runPageAdScan } from '@/lib/spy/scan-ads'

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  const targets = b.pageId
    ? await prisma.spyPageTarget.findMany({ where: { id: b.pageId } })
    : await prisma.spyPageTarget.findMany({ where: { active: true } })
  if (targets.length === 0) return NextResponse.json({ error: 'No page targets to scan' }, { status: 404 })

  // Fire-and-forget: kick off scans without blocking the HTTP response.
  for (const t of targets) {
    void runPageAdScan({ id: t.id, storeId: t.storeId, pageUrl: t.pageUrl })
      .catch(err => console.error('[spy] ad scan failed for', t.pageUrl, err))
  }
  return NextResponse.json({ started: targets.map(t => ({ pageId: t.id, pageUrl: t.pageUrl })) })
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` + `npm run lint` (clean on new file).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/spy/scan-ads/route.ts
git commit -m "feat(spy): scan-ads trigger API (fire-and-forget)"
```

---

### Task 9: Ads list + detail API

**Files:**
- Create: `src/app/api/spy/ads/route.ts`
- Create: `src/app/api/spy/ads/[id]/route.ts`

**Interfaces:**
- Consumes: `prisma` (`spyAd`, `spyAdObservation`); signals from `@/lib/spy/ad-signals`.
- Produces HTTP:
  - `GET /api/spy/ads?storeId&filter=new|long-running|scaling|stopped&limit` — list ads (join advertiser + observations) with computed signal flags.
  - `GET /api/spy/ads/[id]` — one ad + advertiser + observations (timeline) + signal flags.

- [ ] **Step 1: Implement list route**

Create `src/app/api/spy/ads/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isNewAd, activeDays, isLongRunning, isScaling, isStopped } from '@/lib/spy/ad-signals'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const filter = searchParams.get('filter') || undefined
  const storeId = searchParams.get('storeId') || undefined
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '200', 10) || 200, 500)

  const ads = await prisma.spyAd.findMany({
    where: storeId ? { advertiser: { storeId } } : undefined,
    orderBy: { lastSeenAt: 'desc' },
    take: limit,
    include: { advertiser: { select: { pageName: true, storeId: true } }, observations: { select: { isActive: true, collationCount: true, observedAt: true } } },
  })

  const now = new Date()
  const enriched = ads.map(a => ({
    ...a,
    signals: {
      isNew: isNewAd(a.startDate, now),
      activeDays: activeDays(a.startDate, a.endDate, now),
      isLongRunning: isLongRunning(a, now),
      isScaling: isScaling(a.observations),
      isStopped: isStopped(a.observations),
    },
  }))

  const flags: Record<string, (x: typeof enriched[number]) => boolean> = {
    new: x => x.signals.isNew,
    'long-running': x => x.signals.isLongRunning,
    scaling: x => x.signals.isScaling,
    stopped: x => x.signals.isStopped,
  }
  const result = filter && flags[filter] ? enriched.filter(flags[filter]) : enriched
  return NextResponse.json({ ads: result })
}
```

- [ ] **Step 2: Implement detail route**

Create `src/app/api/spy/ads/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isNewAd, activeDays, isLongRunning, isScaling, isStopped } from '@/lib/spy/ad-signals'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params
  const ad = await prisma.spyAd.findUnique({
    where: { id },
    include: { advertiser: true, observations: { orderBy: { observedAt: 'asc' } } },
  })
  if (!ad) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const now = new Date()
  return NextResponse.json({
    ad,
    signals: {
      isNew: isNewAd(ad.startDate, now),
      activeDays: activeDays(ad.startDate, ad.endDate, now),
      isLongRunning: isLongRunning(ad, now),
      isScaling: isScaling(ad.observations),
      isStopped: isStopped(ad.observations),
    },
  })
}
```

Note: this repo uses the **non-Promise** dynamic-route signature `{ params }: { params: { id: string } }` and accesses `params.id` directly (confirmed in `src/app/api/suppliers/[id]/route.ts`). Use exactly that form as shown above.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` + `npm run lint` (clean on new files).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/spy/ads/route.ts "src/app/api/spy/ads/[id]/route.ts"
git commit -m "feat(spy): ads list + detail API with signals"
```

---

### Task 10: Daily ad-scan cron tick

**Files:**
- Modify: `src/lib/spy/scheduler.ts`

**Interfaces:**
- Consumes: `runPageAdScan` (Task 6); `prisma` (`spyPageTarget`).

- [ ] **Step 1: Add the ad-scan schedule**

In `src/lib/spy/scheduler.ts`, add an import and a helper, and register a third cron inside `initSpyScheduler()` (keep the existing product-scan cron intact):

```ts
import { runPageAdScan } from './scan-ads'

async function scanAllPageTargets() {
  const targets = await prisma.spyPageTarget.findMany({ where: { active: true } })
  for (const t of targets) {
    try { await runPageAdScan({ id: t.id, storeId: t.storeId, pageUrl: t.pageUrl }) }
    catch (e) { console.error('[spy-scheduler] ad scan failed for', t.pageUrl, e) }
  }
  console.log(`[spy-scheduler] ad scan done for ${targets.length} page target(s)`)
}
```

Inside `initSpyScheduler()`, after the existing `cron.schedule('0 8,20 * * *', ...)`, add:

```ts
  cron.schedule('0 9 * * *', () => { scanAllPageTargets().catch(e => console.error('[spy-scheduler]', e)) }, { timezone: 'Asia/Ho_Chi_Minh' })
```

Update the init log line to mention ad scan at 09:00.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` + `npm run lint` (clean on the file).

- [ ] **Step 3: Commit**

```bash
git add src/lib/spy/scheduler.ts
git commit -m "feat(spy): daily 09:00 VN ad-scan cron"
```

---

### Task 11: UI — Ads tab (page targets + ad grid + Save IDEA)

**Files:**
- Modify: `src/app/tools/spy-idea/page.tsx`

**Interfaces:**
- Consumes HTTP: `/api/spy/pages`, `/api/spy/scan-ads`, `/api/spy/ads`, `/api/spy/stores`, `/api/spy/ideas`.

Add a fourth tab `ads` to the existing tab set (`stores | products | ideas | ads`). The Ads tab has two sections: page-target management and the ad grid.

- [ ] **Step 1: Extend the page with the Ads tab**

In `src/app/tools/spy-idea/page.tsx`:

1. Widen the tab type and tab list to include `'ads'`.
2. Add state + loaders:

```tsx
type PageTarget = { id: string; pageUrl: string; label: string | null; active: boolean; lastScanAt: string | null; store: { domain: string } | null }
type Ad = { id: string; title: string | null; body: string | null; pageId: string; adLibraryUrl: string | null; mediaType: string | null; startDate: string | null; advertiser: { pageName: string | null }; signals: { isNew: boolean; activeDays: number; isLongRunning: boolean; isScaling: boolean; isStopped: boolean } }

const [pages, setPages] = useState<PageTarget[]>([])
const [ads, setAds] = useState<Ad[]>([])
const [pageUrl, setPageUrl] = useState('')
const [adFilter, setAdFilter] = useState('')
const [scanningAds, setScanningAds] = useState(false)

async function loadPages() { setPages(await fetch('/api/spy/pages').then(r => r.json())) }
async function loadAds() { const d = await fetch(`/api/spy/ads${adFilter ? `?filter=${adFilter}` : ''}`).then(r => r.json()); setAds(d.ads ?? []) }
```

3. Call `loadPages()` and `loadAds()` in the initial `useEffect`, and re-run `loadAds()` when `adFilter` changes (add a `useEffect` on `[adFilter]`).
4. Actions:

```tsx
async function addPage() {
  if (!pageUrl.trim()) return
  await fetch('/api/spy/pages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageUrl }) })
  setPageUrl(''); loadPages()
}
async function scanAds() {
  setScanningAds(true)
  try { await fetch('/api/spy/scan-ads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }) }
  finally { setScanningAds(false) }
}
async function saveAdIdea(a: Ad) {
  await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: a.title ?? a.advertiser.pageName ?? 'Ad', refType: 'AD', refAdId: a.id, snapshotJson: a }) })
  loadIdeas()
}
```

5. Render the Ads tab (place after the `ideas` tab block):

```tsx
{tab === 'ads' && (
  <div className="space-y-lg">
    <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
      <div className="mb-md flex gap-sm">
        <input value={pageUrl} onChange={e => setPageUrl(e.target.value)} placeholder="https://www.facebook.com/BrandName"
          className="flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
        <button onClick={addPage} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Add page</button>
        <button onClick={scanAds} disabled={scanningAds} className="rounded-lg bg-primary px-lg py-sm text-label-md text-on-primary disabled:opacity-50">
          {scanningAds ? 'Starting…' : 'Scan ads now'}
        </button>
      </div>
      <ul className="divide-y divide-outline-variant/20">
        {pages.map(p => (
          <li key={p.id} className="flex items-center justify-between py-sm">
            <div><p className="text-label-md text-primary">{p.label ?? p.pageUrl}</p>
              <p className="text-body-sm text-on-surface-variant">{p.store?.domain ?? 'unlinked'} · last {formatDate(p.lastScanAt)}</p></div>
          </li>
        ))}
      </ul>
    </section>

    <div className="flex gap-xs">
      {['', 'new', 'long-running', 'scaling', 'stopped'].map(f => (
        <button key={f} onClick={() => setAdFilter(f)}
          className={`rounded-md px-md py-xs text-label-sm ${adFilter === f ? 'bg-secondary text-on-secondary' : 'bg-surface-container text-on-surface-variant'}`}>
          {f === '' ? 'All' : f}
        </button>
      ))}
    </div>

    <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {ads.map(a => (
        <article key={a.id} className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
          <div className="mb-xs flex flex-wrap gap-xs">
            {a.signals.isNew && <span className="rounded-full bg-secondary/10 px-sm py-xs text-label-sm text-secondary">New</span>}
            {a.signals.isLongRunning && <span className="rounded-full bg-on-tertiary-container/15 px-sm py-xs text-label-sm text-on-tertiary-container">Long-running</span>}
            {a.signals.isScaling && <span className="rounded-full bg-primary/10 px-sm py-xs text-label-sm text-primary">Scaling</span>}
            {a.signals.isStopped && <span className="rounded-full bg-error/10 px-sm py-xs text-label-sm text-error">Stopped</span>}
          </div>
          <p className="line-clamp-2 text-label-md font-bold text-primary">{a.title ?? a.advertiser.pageName ?? 'Ad'}</p>
          <p className="mt-xs line-clamp-3 text-body-sm text-on-surface-variant">{a.body}</p>
          <p className="mt-xs text-body-sm text-on-surface-variant">{a.advertiser.pageName} · {a.signals.activeDays}d · {formatDate(a.startDate)}</p>
          <div className="mt-sm flex items-center justify-between">
            <a href={`/tools/spy-idea/ads/${a.id}`} className="text-secondary text-label-sm hover:underline">Detail</a>
            <button onClick={() => saveAdIdea(a)} className="text-secondary text-label-sm hover:underline">＋ Save IDEA</button>
          </div>
        </article>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 2: Verify (no dev server)**

Run: `npx tsc --noEmit` + `npm run lint` (page still lints; keep the existing eslint-disable pattern for any `<img>`). Confirm the file still starts with `'use client'` and renders `<Sidebar />`.

- [ ] **Step 3: Commit**

```bash
git add src/app/tools/spy-idea/page.tsx
git commit -m "feat(spy): Ads tab (page targets, ad grid, save idea)"
```

---

### Task 12: UI — Ad detail page

**Files:**
- Create: `src/app/tools/spy-idea/ads/[id]/page.tsx`

**Interfaces:**
- Consumes HTTP: `/api/spy/ads/[id]`, `/api/spy/ideas`.

- [ ] **Step 1: Implement the ad detail page**

Create `src/app/tools/spy-idea/ads/[id]/page.tsx`:

```tsx
'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'

function formatDate(v: string | null) {
  if (!v) return '-'
  return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v))
}

type Obs = { id: string; isActive: boolean; collationCount: number | null; observedAt: string }
type AdDetail = {
  ad: { id: string; title: string | null; body: string | null; caption: string | null; ctaText: string | null; linkUrl: string | null; adLibraryUrl: string | null; mediaType: string | null; startDate: string | null; endDate: string | null; advertiser: { pageName: string | null; pageCategory: string | null; likes: number | null }; observations: Obs[] }
  signals: { isNew: boolean; activeDays: number; isLongRunning: boolean; isScaling: boolean; isStopped: boolean }
}

export default function AdDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<AdDetail | null>(null)

  useEffect(() => { fetch(`/api/spy/ads/${id}`).then(r => r.json()).then(setData).catch(() => {}) }, [id])

  async function saveIdea() {
    if (!data) return
    await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: data.ad.title ?? data.ad.advertiser.pageName ?? 'Ad', refType: 'AD', refAdId: data.ad.id, snapshotJson: data.ad }) })
  }

  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <a href="/tools/spy-idea" className="text-secondary text-label-sm hover:underline">← Back to Spy</a>
          {!data ? (
            <p className="mt-lg text-body-md text-on-surface-variant">Loading…</p>
          ) : (
            <div className="mt-md max-w-3xl">
              <h2 className="text-display-md font-bold text-primary">{data.ad.title ?? data.ad.advertiser.pageName ?? 'Ad'}</h2>
              <p className="text-body-sm text-on-surface-variant">{data.ad.advertiser.pageName} · {data.ad.advertiser.pageCategory} · {data.signals.activeDays} active days</p>
              <div className="my-md flex flex-wrap gap-xs">
                {data.signals.isNew && <span className="rounded-full bg-secondary/10 px-sm py-xs text-label-sm text-secondary">New</span>}
                {data.signals.isLongRunning && <span className="rounded-full bg-on-tertiary-container/15 px-sm py-xs text-label-sm text-on-tertiary-container">Long-running</span>}
                {data.signals.isScaling && <span className="rounded-full bg-primary/10 px-sm py-xs text-label-sm text-primary">Scaling</span>}
                {data.signals.isStopped && <span className="rounded-full bg-error/10 px-sm py-xs text-label-sm text-error">Stopped</span>}
              </div>
              <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
                <p className="whitespace-pre-wrap text-body-md text-primary">{data.ad.body}</p>
                {data.ad.caption && <p className="mt-sm text-body-sm text-on-surface-variant">{data.ad.caption}</p>}
                <div className="mt-md flex gap-md text-label-sm">
                  {data.ad.linkUrl && <a href={data.ad.linkUrl} target="_blank" rel="noreferrer" className="text-secondary hover:underline">Landing page</a>}
                  {data.ad.adLibraryUrl && <a href={data.ad.adLibraryUrl} target="_blank" rel="noreferrer" className="text-secondary hover:underline">Ad Library</a>}
                  <button onClick={saveIdea} className="text-secondary hover:underline">＋ Save IDEA</button>
                </div>
              </div>
              <h3 className="mt-lg mb-sm text-headline-sm text-primary">Run timeline</h3>
              <ul className="space-y-xs">
                {data.ad.observations.map(o => (
                  <li key={o.id} className="flex items-center gap-md rounded-lg bg-surface-container px-md py-sm text-body-sm">
                    <span className={o.isActive ? 'text-on-tertiary-container' : 'text-error'}>{o.isActive ? 'Active' : 'Inactive'}</span>
                    <span className="text-on-surface-variant">collation: {o.collationCount ?? '-'}</span>
                    <span className="ml-auto text-on-surface-variant">{formatDate(o.observedAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </main>
      </div>
    </RoleGate>
  )
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` + `npm run lint`. Confirm `'use client'` + `<Sidebar />` present.

- [ ] **Step 3: Full suite + commit**

Run: `npm test` (all pass except the 2 known pre-existing `order-profit.test.ts` failures).

```bash
git add "src/app/tools/spy-idea/ads/[id]/page.tsx"
git commit -m "feat(spy): ad detail page with run timeline"
```

---

## Self-Review

**Spec coverage (spec §3–§11):**
- SpyPageTarget model + migration (§3) → Task 1. ✓
- Apify client async+poll (§4) → Task 2. ✓
- mapApifyAd (§5) → Task 3. ✓
- ingestAds advertiser+ad+observation (§6) → Task 4. ✓
- Signals + AD_SCAN_CAP (§8) → Task 5. ✓
- runPageAdScan (§7) → Task 6. ✓
- Pages CRUD (§9) → Task 7. ✓
- scan-ads fire-and-forget (§9) → Task 8. ✓
- ads list + detail (§9) → Task 9. ✓
- Daily cron 09:00 VN (§10) → Task 10. ✓
- Ads tab UI + Save IDEA (§11) → Task 11. ✓
- Ad detail + timeline (§11) → Task 12. ✓
- Edge cases (§12): token-missing/run-failed → Task 2/6; empty dataset → Task 6 (0 ads success); body object → Task 3; dedup observation → Task 4. ✓
- Keyword trending → out of scope (Phase 3). Noted, not a gap.

**Placeholder scan:** No TBD/TODO; every step has real code or a concrete command. The Task 9 `params` note is a concrete "check existing route and match" instruction, not a placeholder.

**Type consistency:** `ParsedSpyAd` defined in Task 3, consumed identically in Tasks 4 & 6. `runPageAdScan` signature (Task 6) matches callers in Tasks 8 & 10. Signal function signatures (Task 5) match callers in Task 9. `AD_SCAN_CAP` used in Task 6 asserted as 200 in Task 6's test and defined in Task 5. Prisma composite keys `adId_scanId` (Task 4) and `fbPageId`/`adArchiveId` unique keys match the Phase 1 schema.

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.
