# Spy Tool — Ad domains + domain keyword-scan + Domain→Fanpage→Ads report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `SpyAdDomain` layer above fanpages: scan a domain via an Ad Library keyword-search, attribute discovered ads/pages to the domain, and restructure the Ads tab into a Domain→Fanpages→Ads report with a New Ads section.

**Architecture:** New `SpyAdDomain` model; `SpyPageTarget` and `SpyAdvertiser` gain a nullable `adDomainId`. A pure `buildAdLibrarySearchUrl` builds the Apify search input; `runDomainAdScan` runs it and `ingestAds` tags the resulting advertisers with the domain (a new `adDomainId` option). REST endpoints for domain CRUD + scan trigger; the Ads tab becomes a report grouped by domain.

**Tech Stack:** Next.js 14 (App Router, `'use client'`), Prisma + SQLite, Vitest, Apify REST, Tailwind.

**Spec:** `docs/superpowers/specs/2026-08-22-spy-ad-domains-design.md`

## Global Constraints

- **After schema change** run IN ORDER: `npx prisma migrate dev --name <change>` → `npx prisma generate` → bump `SCHEMA_VERSION` in `src/lib/db.ts` (`'v26'`→`'v27'`). Never add `url` to `datasource db {}`.
- Prisma only via `import { prisma } from '@/lib/db'`. SQLite: enums as String, JSON as String.
- API routes export named `GET/POST/PATCH/DELETE`, return `NextResponse.json`.
- Pages `'use client'`, `<Sidebar/>` in `<RoleGate>`, layout `ml-[280px] flex-1 p-xl`. Dates `en-US`. `<img>` needs a `// eslint-disable-next-line @next/next/no-img-element` line above it.
- Reuse `@/lib/spy/ad-signals`, `@/lib/spy/apify`, `@/lib/spy/ad-mapping`, `@/lib/spy/normalize` (`normalizeDomain`), `@/lib/spy/fb-url` (`normalizeFbPageUrl`).
- Tests: `npm test` (vitest). `@`→`src`. Known pre-existing failures: `src/lib/order-profit.test.ts` (2) — ignore.
- Apify actor unchanged (`activeStatus: 'all'`). `AD_SCAN_CAP` reused.
- `searchTerm` default from a domain: `domain.replace(/^www\./,'').split('.')[0]`.

---

### Task 1: `SpyAdDomain` model + `adDomainId` fields + migration

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/lib/db.ts:6`
- Test: `src/lib/spy/ad-domain-schema.test.ts`

**Interfaces:**
- Produces: `prisma.spyAdDomain` delegate; `SpyPageTarget.adDomainId`, `SpyAdvertiser.adDomainId`.

- [ ] **Step 1: Add the model + fields**

In `prisma/schema.prisma` add:

```prisma
model SpyAdDomain {
  id         String    @id @default(cuid())
  domain     String    @unique
  searchTerm String
  label      String?
  country    String    @default("ALL")
  active     Boolean   @default(true)
  lastScanAt DateTime?
  createdAt  DateTime  @default(now())

  pages       SpyPageTarget[]
  advertisers SpyAdvertiser[]

  @@index([active])
}
```

In `model SpyPageTarget` add:
```prisma
  adDomainId String?
  adDomain   SpyAdDomain? @relation(fields: [adDomainId], references: [id], onDelete: SetNull)
```
and add `@@index([adDomainId])`.

In `model SpyAdvertiser` add:
```prisma
  adDomainId String?
  adDomain   SpyAdDomain? @relation(fields: [adDomainId], references: [id], onDelete: SetNull)
```
and add `@@index([adDomainId])`.

- [ ] **Step 2: Migrate + generate + bump version**

Run: `npx prisma migrate dev --name add_spy_ad_domain`, then `npx prisma generate`. Then `src/lib/db.ts:6` `'v26'`→`'v27'`.

- [ ] **Step 3: Smoke test**

Create `src/lib/spy/ad-domain-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/db'

describe('SpyAdDomain schema', () => {
  it('exposes spyAdDomain and adDomainId relations', async () => {
    expect((prisma as any).spyAdDomain).toBeDefined()
    await expect(prisma.spyPageTarget.findMany({ select: { id: true, adDomainId: true }, take: 1 })).resolves.toBeDefined()
    await expect(prisma.spyAdvertiser.findMany({ select: { id: true, adDomainId: true }, take: 1 })).resolves.toBeDefined()
  })
})
```

Run: `npm test -- src/lib/spy/ad-domain-schema.test.ts` → PASS.

- [ ] **Step 4: Commit**

```bash
git add prisma/ src/lib/db.ts src/lib/spy/ad-domain-schema.test.ts
git commit -m "feat(spy): add SpyAdDomain model + adDomainId fields"
```

---

### Task 2: `buildAdLibrarySearchUrl`

**Files:**
- Create: `src/lib/spy/ad-search-url.ts`
- Test: `src/lib/spy/ad-search-url.test.ts`

**Interfaces:**
- Produces: `buildAdLibrarySearchUrl(searchTerm: string, country?: string): string` (default country `'ALL'`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/spy/ad-search-url.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildAdLibrarySearchUrl } from './ad-search-url'

describe('buildAdLibrarySearchUrl', () => {
  it('builds an Ad Library keyword-search URL with encoded term and country', () => {
    const url = buildAdLibrarySearchUrl('family store', 'US')
    expect(url).toBe('https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&q=family%20store&search_type=keyword_unordered&media_type=all')
  })
  it('defaults country to ALL', () => {
    expect(buildAdLibrarySearchUrl('familystore')).toContain('country=ALL')
    expect(buildAdLibrarySearchUrl('familystore')).toContain('q=familystore')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/lib/spy/ad-search-url.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/lib/spy/ad-search-url.ts`:

```ts
export function buildAdLibrarySearchUrl(searchTerm: string, country = 'ALL'): string {
  const q = encodeURIComponent(searchTerm)
  return `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${country}&q=${q}&search_type=keyword_unordered&media_type=all`
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- src/lib/spy/ad-search-url.test.ts` → PASS.

Note: `encodeURIComponent('family store')` yields `family%20store` (matches the test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/spy/ad-search-url.ts src/lib/spy/ad-search-url.test.ts
git commit -m "feat(spy): buildAdLibrarySearchUrl"
```

---

### Task 3: `ingestAds` adDomainId + `runDomainAdScan` + page-scan domain tag

**Files:**
- Modify: `src/lib/spy/ingest-ads.ts`
- Modify: `src/lib/spy/ingest-ads.test.ts`
- Modify: `src/lib/spy/scan-ads.ts`
- Modify: `src/lib/spy/scan-ads.test.ts`

**Interfaces:**
- Consumes: `buildAdLibrarySearchUrl` (Task 2), apify + mapApifyAd + AD_SCAN_CAP.
- Produces: `ingestAds(scanId, storeId, ads, opts?: { adDomainId?: string | null })`; `runDomainAdScan(domain: { id: string; searchTerm: string; country: string })`.

- [ ] **Step 1: Add the `adDomainId` assertion to the ingest test**

In `src/lib/spy/ingest-ads.test.ts`, add a test (mirroring the existing mocked-prisma setup) asserting that when `ingestAds('scan1','store1',[ad('A1')],{ adDomainId:'dom1' })` runs, the advertiser upsert `create` includes `adDomainId: 'dom1'`:

```ts
  it('tags advertiser with adDomainId when provided', async () => {
    await ingestAds('scan1', null, [ad('A1')], { adDomainId: 'dom1' })
    expect(calls.advUpsert[0].create.adDomainId).toBe('dom1')
    expect(calls.advUpsert[0].update.adDomainId).toBe('dom1')
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/lib/spy/ingest-ads.test.ts`
Expected: FAIL — `adDomainId` not in the upsert / arg mismatch.

- [ ] **Step 3: Add the option to `ingestAds`**

In `src/lib/spy/ingest-ads.ts`:
1. Change the signature to `export async function ingestAds(scanId: string, storeId: string | null, ads: ParsedSpyAd[], opts: { adDomainId?: string | null } = {}): Promise<{ found: number; newAds: number; updated: number }> {`.
2. At the top of the loop body compute `const adDomainId = opts.adDomainId ?? undefined`.
3. In the advertiser `upsert.create`, add `adDomainId,` (alongside `storeId: storeId ?? undefined`).
4. In the advertiser `upsert.update`, add `...(adDomainId ? { adDomainId } : {}),` (alongside the storeId spread).

- [ ] **Step 4: Run ingest test**

Run: `npm test -- src/lib/spy/ingest-ads.test.ts` → PASS (new + existing).

- [ ] **Step 5: Write the failing `runDomainAdScan` test**

In `src/lib/spy/scan-ads.test.ts`, extend the existing `vi.mock('./apify')`/`./ingest-ads` setup and add:

```ts
import { runDomainAdScan } from './scan-ads'

describe('runDomainAdScan', () => {
  beforeEach(() => { db.scans.length = 0; vi.clearAllMocks() })
  it('runs a keyword search and tags ads with the domain', async () => {
    ;(startActorRun as any).mockResolvedValue({ runId: 'r1', datasetId: 'd1' })
    ;(pollRunUntilDone as any).mockResolvedValue('SUCCEEDED')
    ;(getDatasetItems as any).mockResolvedValue([{ ad_archive_id: 'A1', page_id: '9', is_active: true }])
    ;(ingestAds as any).mockResolvedValue({ found: 1, newAds: 1, updated: 0 })
    const r = await runDomainAdScan({ id: 'dom1', searchTerm: 'familystore', country: 'ALL' })
    expect(r.status).toBe('success')
    expect(db.scans[0].type).toBe('DOMAIN_ADS')
    // 4th arg to ingestAds carries adDomainId
    expect((ingestAds as any).mock.calls[0][3]).toEqual({ adDomainId: 'dom1' })
    // the actor URL is a keyword-search URL
    expect(String((startActorRun as any).mock.calls[0][0].urls[0].url)).toContain('q=familystore')
  })
})
```

Ensure the test file's `vi.mock('@/lib/db')` mock also stubs `prisma.spyAdDomain.update` (add `spyAdDomain: { update: vi.fn(async () => ({})) }` to the mock) and that `getDatasetItems` is imported/mocked.

- [ ] **Step 6: Run to verify it fails**

Run: `npm test -- src/lib/spy/scan-ads.test.ts`
Expected: FAIL — `runDomainAdScan` not a function.

- [ ] **Step 7: Implement `runDomainAdScan` + pass adDomainId in `runPageAdScan`**

In `src/lib/spy/scan-ads.ts`:
1. Add imports: `import { buildAdLibrarySearchUrl } from './ad-search-url'`.
2. In `runPageAdScan`, change the signature to accept `adDomainId`: `runPageAdScan(pageTarget: { id: string; storeId: string | null; pageUrl: string; adDomainId?: string | null })`, and change the ingest call to `await ingestAds(scan.id, pageTarget.storeId, ads, { adDomainId: pageTarget.adDomainId ?? undefined })`.
3. Add:

```ts
export async function runDomainAdScan(domain: { id: string; searchTerm: string; country: string }) {
  const scan = await prisma.spyScan.create({
    data: { type: 'DOMAIN_ADS', targetType: 'DOMAIN', targetId: domain.id, status: 'running' },
  })
  try {
    const { runId, datasetId } = await startActorRun({
      urls: [{ url: buildAdLibrarySearchUrl(domain.searchTerm, domain.country) }],
      count: AD_SCAN_CAP,
    })
    await prisma.spyScan.update({ where: { id: scan.id }, data: { apifyRunId: runId, apifyDatasetId: datasetId } })
    await pollRunUntilDone(runId)
    const items = await getDatasetItems(datasetId)
    const ads = items.map(mapApifyAd)
    const ingest = await ingestAds(scan.id, null, ads, { adDomainId: domain.id })
    const stats = { totalScanned: items.length, ...ingest }
    await prisma.spyScan.update({ where: { id: scan.id }, data: { status: 'success', stats: JSON.stringify(stats), finishedAt: new Date() } })
    await prisma.spyAdDomain.update({ where: { id: domain.id }, data: { lastScanAt: new Date() } })
    return { scanId: scan.id, status: 'success' as const, stats }
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : 'Unknown error'
    await prisma.spyScan.update({ where: { id: scan.id }, data: { status: 'failed', error, finishedAt: new Date() } })
    return { scanId: scan.id, status: 'failed' as const, error }
  }
}
```

- [ ] **Step 8: Run tests + tsc**

Run: `npm test -- src/lib/spy/scan-ads.test.ts src/lib/spy/ingest-ads.test.ts` → PASS.
Run: `npx tsc --noEmit` → 0 errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/spy/ingest-ads.ts src/lib/spy/ingest-ads.test.ts src/lib/spy/scan-ads.ts src/lib/spy/scan-ads.test.ts
git commit -m "feat(spy): ingest adDomainId + runDomainAdScan + tag page-scan ads"
```

---

### Task 4: API — ad-domains CRUD + scan-ads domainId + pages/ads domain wiring

**Files:**
- Create: `src/app/api/spy/ad-domains/route.ts`
- Modify: `src/app/api/spy/scan-ads/route.ts`
- Modify: `src/app/api/spy/pages/route.ts`
- Modify: `src/app/api/spy/ads/route.ts`

**Interfaces:**
- Produces HTTP: `/api/spy/ad-domains` (CRUD + counts); `/api/spy/scan-ads {domainId}`; `/api/spy/pages` accepts+filters `adDomainId`; `/api/spy/ads?domainId`.

- [ ] **Step 1: Create the ad-domains route**

Create `src/app/api/spy/ad-domains/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { normalizeDomain } from '@/lib/spy/normalize'
import { isNewAd } from '@/lib/spy/ad-signals'

function defaultSearchTerm(domain: string): string {
  return domain.replace(/^www\./, '').split('.')[0]
}

export async function GET() {
  const domains = await prisma.spyAdDomain.findMany({ orderBy: { createdAt: 'desc' } })
  const now = new Date()
  const result = await Promise.all(domains.map(async d => {
    const pageCount = await prisma.spyPageTarget.count({ where: { adDomainId: d.id } })
    const ads = await prisma.spyAd.findMany({ where: { advertiser: { adDomainId: d.id } }, select: { startDate: true } })
    const newAdCount = ads.filter(a => isNewAd(a.startDate, now)).length
    return { ...d, pageCount, adCount: ads.length, newAdCount }
  }))
  return NextResponse.json(result)
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  let domain: string
  try { domain = normalizeDomain(String(b.domain ?? '')) }
  catch (e: unknown) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid domain' }, { status: 400 }) }
  const searchTerm = (b.searchTerm && String(b.searchTerm).trim()) || defaultSearchTerm(domain)
  const d = await prisma.spyAdDomain.upsert({
    where: { domain },
    create: { domain, searchTerm, label: b.label || null, country: b.country || 'ALL' },
    update: { searchTerm, label: b.label ?? undefined, country: b.country ?? undefined },
  })
  return NextResponse.json(d)
}

export async function PATCH(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const data: Record<string, unknown> = {}
  if ('searchTerm' in b) data.searchTerm = String(b.searchTerm)
  if ('label' in b) data.label = b.label || null
  if ('country' in b) data.country = b.country || 'ALL'
  if ('active' in b) data.active = Boolean(b.active)
  const d = await prisma.spyAdDomain.update({ where: { id: b.id }, data })
  return NextResponse.json(d)
}

export async function DELETE(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await prisma.spyAdDomain.delete({ where: { id: b.id } })
  return NextResponse.json({ ok: true })
}
```

Note: verify `normalizeDomain` is exported from `@/lib/spy/normalize` (it is used by `/api/spy/stores`). If it actually lives elsewhere, import from the same module `/api/spy/stores/route.ts` imports it from.

- [ ] **Step 2: Extend scan-ads to accept domainId**

In `src/app/api/spy/scan-ads/route.ts`, import `runDomainAdScan` and handle a `domainId` body: if `b.domainId` present, load the domain and run `runDomainAdScan` (fire-and-forget, same pattern as page scans):

```ts
import { runPageAdScan, runDomainAdScan } from '@/lib/spy/scan-ads'
// ...
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (b.domainId) {
    const d = await prisma.spyAdDomain.findUnique({ where: { id: b.domainId } })
    if (!d) return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
    void runDomainAdScan({ id: d.id, searchTerm: d.searchTerm, country: d.country })
      .catch(err => console.error('[spy] domain ad scan failed for', d.domain, err))
    return NextResponse.json({ started: [{ domainId: d.id, domain: d.domain }] })
  }
  // existing page-scan behavior unchanged below (pageId / all active pages)
  const targets = b.pageId
    ? await prisma.spyPageTarget.findMany({ where: { id: b.pageId } })
    : await prisma.spyPageTarget.findMany({ where: { active: true } })
  if (targets.length === 0) return NextResponse.json({ error: 'No page targets to scan' }, { status: 404 })
  for (const t of targets) {
    void runPageAdScan({ id: t.id, storeId: t.storeId, pageUrl: t.pageUrl, adDomainId: t.adDomainId })
      .catch(err => console.error('[spy] ad scan failed for', t.pageUrl, err))
  }
  return NextResponse.json({ started: targets.map(t => ({ pageId: t.id, pageUrl: t.pageUrl })) })
}
```

(Read the existing file and preserve its exact page-scan block; only add the `domainId` branch at the top and add `adDomainId: t.adDomainId` to the page-scan call.)

- [ ] **Step 3: Extend pages route (adDomainId create + filter)**

In `src/app/api/spy/pages/route.ts`:
- `GET`: read `adDomainId` from query; add to `where` when present: `const adDomainId = new URL(req.url).searchParams.get('adDomainId') || undefined` and `where: adDomainId ? { adDomainId } : undefined` in `findMany`. (GET currently has no req param — change signature to `GET(req: NextRequest)`.)
- `POST`: include `adDomainId: b.adDomainId || null` in the `create` and `update` of the upsert.

- [ ] **Step 4: Extend ads route (domainId filter)**

In `src/app/api/spy/ads/route.ts`, read `domainId` and combine into `where`:

```ts
  const domainId = searchParams.get('domainId') || undefined
  // ...
  where: {
    ...(storeId ? { advertiser: { storeId } } : {}),
    ...(domainId ? { advertiser: { adDomainId: domainId } } : {}),
  },
```
(If both storeId+domainId given, the later spread wins — acceptable; they are not used together by the UI. Keep the existing `orderBy`/`take`/`include`.)

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` (0 errors) + `npm run lint` (clean on the 4 files).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/spy/ad-domains/route.ts src/app/api/spy/scan-ads/route.ts src/app/api/spy/pages/route.ts src/app/api/spy/ads/route.ts
git commit -m "feat(spy): ad-domains CRUD + domain scan trigger + domain wiring"
```

---

### Task 5: UI — Ads tab report (Domain → Fanpages → Ads + New Ads)

**Files:**
- Modify: `src/app/tools/spy-idea/page.tsx`

**Interfaces:**
- Consumes HTTP: `/api/spy/ad-domains`, `/api/spy/pages?adDomainId=`, `/api/spy/ads?domainId=`, `/api/spy/ads?filter=new`, `/api/spy/scan-ads`, `/api/spy/ideas`.

Read the current file first. Keep the `stores`/`products`/`ideas` tabs and their code intact. Replace the **`ads` tab block** with the report below, and add the supporting types/state/functions. Reuse the existing `formatDate` helper.

- [ ] **Step 1: Add types + a shared AdCard (if not already present) near the top of the component module**

```tsx
type AdSignals = { isNew: boolean; activeDays: number; isLongRunning: boolean; isScaling: boolean; isStopped: boolean; adStyle: 'product'|'collection'|'homepage'|'other'|null; newProductLaunching: boolean }
type Ad = { id: string; title: string | null; body: string | null; adArchiveId: string; adLibraryUrl: string | null; mediaUrl: string | null; mediaType: 'video'|'image'|'carousel'|'dco'|null; startDate: string | null; advertiser: { pageName: string | null }; signals: AdSignals }
type AdDomain = { id: string; domain: string; searchTerm: string; country: string; lastScanAt: string | null; pageCount: number; adCount: number; newAdCount: number }
type PageTarget = { id: string; pageUrl: string; label: string | null; lastScanAt: string | null }

const MEDIA_LABEL: Record<string, string> = { video: '🎬 Video', image: '🖼 Image', carousel: '🎠 Carousel', dco: 'DCO' }
const STYLE_LABEL: Record<string, string> = { product: 'Product', collection: 'Collection', homepage: 'Homepage', other: 'Other' }

function AdCard({ a, onSave }: { a: Ad; onSave: (a: Ad) => void }) {
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
      <p className="mt-xs text-body-sm text-on-surface-variant">{a.advertiser.pageName} · {s.activeDays}d</p>
      {a.adLibraryUrl && <a href={a.adLibraryUrl} target="_blank" rel="noreferrer" className="mt-xs block truncate text-label-sm text-secondary hover:underline" title={a.adArchiveId}>#{a.adArchiveId}</a>}
      <div className="mt-sm flex items-center justify-between">
        <a href={`/tools/spy-idea/ads/${a.id}`} className="text-secondary text-label-sm hover:underline">Detail</a>
        <button onClick={() => onSave(a)} className="text-secondary text-label-sm hover:underline">＋ Save IDEA</button>
      </div>
    </article>
  )
}
```

- [ ] **Step 2: Add state + loaders + actions (inside the component)**

```tsx
const [adDomains, setAdDomains] = useState<AdDomain[]>([])
const [newAds, setNewAds] = useState<Ad[]>([])
const [domainInput, setDomainInput] = useState('')

async function loadAdDomains() { setAdDomains(await fetch('/api/spy/ad-domains').then(r => r.json())) }
async function loadNewAds() { const d = await fetch('/api/spy/ads?filter=new').then(r => r.json()); setNewAds(d.ads ?? []) }

async function addAdDomain() {
  if (!domainInput.trim()) return
  await fetch('/api/spy/ad-domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: domainInput }) })
  setDomainInput(''); loadAdDomains()
}
async function scanDomain(id: string) {
  await fetch('/api/spy/scan-ads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domainId: id }) })
  setTimeout(() => { loadAdDomains(); loadNewAds() }, 30000)
}
async function removeAdDomain(id: string) {
  await fetch('/api/spy/ad-domains', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
  loadAdDomains()
}
async function saveAdIdea(a: Ad) {
  await fetch('/api/spy/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: a.title ?? a.advertiser.pageName ?? 'Ad', refType: 'AD', refAdId: a.id, snapshotJson: a }) })
}
```

Call `loadAdDomains()` and `loadNewAds()` in the initial `useEffect` (alongside the existing loaders).

- [ ] **Step 3: Replace the `ads` tab block with the report**

```tsx
{tab === 'ads' && (
  <div className="space-y-lg">
    <section>
      <h3 className="mb-md text-headline-sm text-primary">🆕 New Ads (just launched)</h3>
      <div className="grid grid-cols-1 gap-md sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {newAds.map(a => <AdCard key={a.id} a={a} onSave={saveAdIdea} />)}
        {newAds.length === 0 && <p className="text-body-md text-on-surface-variant">No newly launched ads.</p>}
      </div>
    </section>

    <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
      <div className="flex gap-sm">
        <input value={domainInput} onChange={e => setDomainInput(e.target.value)} placeholder="familystore.com"
          className="flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
        <button onClick={addAdDomain} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Add domain</button>
      </div>
    </section>

    {adDomains.map(d => <DomainBlock key={d.id} domain={d} onScan={() => scanDomain(d.id)} onRemove={() => removeAdDomain(d.id)} onSaveIdea={saveAdIdea} onChanged={loadAdDomains} />)}
  </div>
)}
```

- [ ] **Step 4: Add the `DomainBlock` component (module scope, below AdCard)**

```tsx
function DomainBlock({ domain, onScan, onRemove, onSaveIdea, onChanged }: { domain: AdDomain; onScan: () => void; onRemove: () => void; onSaveIdea: (a: Ad) => void; onChanged: () => void }) {
  const [pages, setPages] = useState<PageTarget[]>([])
  const [ads, setAds] = useState<Ad[]>([])
  const [pageUrl, setPageUrl] = useState('')
  const [term, setTerm] = useState(domain.searchTerm)

  async function load() {
    setPages(await fetch(`/api/spy/pages?adDomainId=${domain.id}`).then(r => r.json()))
    const d = await fetch(`/api/spy/ads?domainId=${domain.id}`).then(r => r.json()); setAds(d.ads ?? [])
  }
  useEffect(() => { load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [domain.id])

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
        <span className="text-body-sm text-on-surface-variant">{domain.adCount} ads · {domain.newAdCount} new</span>
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
        {ads.map(a => <AdCard key={a.id} a={a} onSave={onSaveIdea} />)}
        {ads.length === 0 && <p className="text-body-md text-on-surface-variant">No ads yet — scan the domain or a fanpage.</p>}
      </div>
    </section>
  )
}
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` (0 errors) + `npm run lint` (clean; keep the `<img>` + exhaustive-deps eslint-disable lines). Confirm page still `'use client'` + `<Sidebar/>`, and stores/products/ideas tabs unchanged. Then full `npm test` (pass except the 2 known `order-profit.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add src/app/tools/spy-idea/page.tsx
git commit -m "feat(spy): Ads tab report (domain -> fanpages -> ads + New Ads)"
```

---

## Self-Review

**Spec coverage (spec §3–§6):**
- `SpyAdDomain` + `adDomainId` fields + migration (§3) → Task 1. ✓
- `buildAdLibrarySearchUrl` (§4) → Task 2. ✓
- `ingestAds` adDomainId + `runDomainAdScan` + page-scan tag (§4) → Task 3. ✓
- ad-domains CRUD + scan-ads domainId + pages/ads wiring (§5) → Task 4. ✓
- Ads-tab report + New Ads (§6) → Task 5. ✓
- Non-goals (§7): no keyword table, no domain cron, no Apify change, no auto-page-create — respected. ✓

**Placeholder scan:** No TBD/TODO; every step has real code or a concrete command. Task 4/5 "read the existing file" notes point at concrete edits, not placeholders.

**Type consistency:** `ingestAds(..., opts:{adDomainId?})` (Task 3) called by `runDomainAdScan` + `runPageAdScan` (Task 3) and no other caller signature drifts (existing callers pass 3 args → opts defaults to `{}`). `runDomainAdScan({id,searchTerm,country})` (Task 3) matches the scan-ads route call (Task 4). `SpyAdDomain` fields (Task 1) match the ad-domains route select/return (Task 4) and the UI `AdDomain` type (Task 5). `buildAdLibrarySearchUrl(term,country)` (Task 2) used in Task 3. `adDomainId` on SpyPageTarget/SpyAdvertiser (Task 1) used in Task 3/4.

**Note:** existing `ingestAds` callers pass 3 args; the new 4th param is optional (`= {}`), so they keep compiling. Confirmed no breakage.

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.
