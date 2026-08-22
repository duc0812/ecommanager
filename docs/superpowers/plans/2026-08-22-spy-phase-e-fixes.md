# Spy Phase E — feedback fixes (fanpage auto-fill, CTA link + product date, consistent rail) — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Fix 5 live-feedback items: ① consistent left rail across all spy pages; ② domain scan auto-populates fanpages; ③ remove the ad preview from the Sources domain block; ④ show the ad's CTA link on the card; ⑤ show the product upload date on the card when the CTA is a product link.

**Design (approved in chat):** ① always render facets in `SpyFilterSidebar` (facet click always navigates to `/tools/spy-idea?...`). ② after a domain ad scan, upsert a `SpyPageTarget` per discovered advertiser (`pageUrl = https://www.facebook.com/{fbPageId}`). ③ delete the ad grid from the Sources `DomainBlock`. ④ render `linkUrl` (already stored/returned). ⑤ resolve product `publishedAt` by host+handle in the ads API, show only for `adStyle==='product'`.

**Tech Stack:** Next.js 14.2, Prisma v7 + SQLite, Vitest, Tailwind tokens. **No schema change** (no migration, no SCHEMA_VERSION bump).

## Global Constraints
- Import client via `@/lib/db` only. No code comments. Tailwind tokens; `material-symbols-outlined`; dates en-US.
- Do NOT change scan/ingest ad-mapping logic beyond the fanpage upsert; do NOT touch cron/quota/best-seller.
- The 2 `src/lib/order-profit.test.ts` failures are pre-existing/unrelated — ignore.

---

## Task 1: Domain scan auto-populates fanpages (②)

**Files:** `src/lib/spy/fb-url.ts` (+ `src/lib/spy/fb-url.test.ts` add case), `src/lib/spy/scan-ads.ts`.

**Interfaces:** Produces `fanpageUrlFromId(id: string): string`.

- [ ] **Step 1: Add + test the helper.** Append to `src/lib/spy/fb-url.ts`:
```ts
export function fanpageUrlFromId(id: string): string {
  return `https://www.facebook.com/${id}`
}
```
Add to `src/lib/spy/fb-url.test.ts` (create if absent) a test:
```ts
import { describe, it, expect } from 'vitest'
import { fanpageUrlFromId } from './fb-url'
describe('fanpageUrlFromId', () => {
  it('builds a facebook page URL from an id', () => {
    expect(fanpageUrlFromId('12345')).toBe('https://www.facebook.com/12345')
  })
})
```
(If `fb-url.test.ts` already exists, ADD this describe block; keep existing tests.)

- [ ] **Step 2: Run → PASS.** `npx vitest run src/lib/spy/fb-url.test.ts`

- [ ] **Step 3: Upsert fanpages after a domain scan.** In `src/lib/spy/scan-ads.ts` `runDomainAdScan`, import `fanpageUrlFromId`, and after `await prisma.spyAdDomain.update(...)` (still inside the try, before `return`), add:
```ts
    const advertisers = await prisma.spyAdvertiser.findMany({ where: { adDomainId: domain.id }, select: { fbPageId: true, pageName: true } })
    for (const adv of advertisers) {
      const pageUrl = fanpageUrlFromId(adv.fbPageId)
      await prisma.spyPageTarget.upsert({
        where: { pageUrl },
        create: { pageUrl, fbPageId: adv.fbPageId, label: adv.pageName ?? undefined, adDomainId: domain.id },
        update: { adDomainId: domain.id, ...(adv.pageName ? { label: adv.pageName } : {}) },
      })
    }
```

- [ ] **Step 4: tsc + commit.** `npx tsc --noEmit` (0).
```bash
git add src/lib/spy/fb-url.ts src/lib/spy/fb-url.test.ts src/lib/spy/scan-ads.ts
git commit -m "feat(spy): domain scan auto-populates fanpages from discovered advertisers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Product upload date resolver + ads API (⑤)

**Files:** `src/lib/spy/ad-product-match.ts` (+ `.test.ts`), `src/app/api/spy/ads/route.ts`.

**Interfaces:** Produces `productDateMap(linkUrls): Promise<Map<string, Date | null>>` (key `host|handle`, host www-stripped). Ads API adds `productPublishedAt: string | null` per ad.

- [ ] **Step 1: Failing test.** Add to `src/lib/spy/ad-product-match.test.ts`:
```ts
import { productDateMap } from './ad-product-match'

describe('productDateMap', () => {
  it('maps host|handle to publishedAt for product links', async () => {
    findMany.mockResolvedValueOnce([{ handle: 'hat', publishedAt: new Date('2026-08-01'), store: { domain: 'www.mystore.com' } }])
    const m = await productDateMap(['https://www.mystore.com/products/hat', 'https://mystore.com/collections/x', null])
    expect(m.get('mystore.com|hat')?.toISOString()).toBe(new Date('2026-08-01').toISOString())
    const arg = findMany.mock.calls[0][0]
    expect(arg.where.handle.in).toEqual(['hat'])
  })
  it('returns empty map when no product links', async () => {
    const m = await productDateMap(['https://mystore.com/', null])
    expect(m.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/lib/spy/ad-product-match.test.ts`

- [ ] **Step 3: Implement `productDateMap`.** Append to `src/lib/spy/ad-product-match.ts`:
```ts
export async function productDateMap(linkUrls: Array<string | null>): Promise<Map<string, Date | null>> {
  const parsed = linkUrls.map(parseAdLink).filter(p => p.kind === 'product' && p.host && p.handle)
  const hosts = Array.from(new Set(parsed.map(p => p.host as string)))
  const handles = Array.from(new Set(parsed.map(p => p.handle as string)))
  if (hosts.length === 0 || handles.length === 0) return new Map()
  const domainCandidates = Array.from(new Set(hosts.flatMap(h => [h, `www.${h}`])))
  const products = await prisma.spyProduct.findMany({
    where: { handle: { in: handles }, store: { domain: { in: domainCandidates } } },
    select: { handle: true, publishedAt: true, store: { select: { domain: true } } },
  })
  const map = new Map<string, Date | null>()
  for (const p of products) map.set(`${(p.store?.domain ?? '').replace(/^www\./, '')}|${p.handle}`, p.publishedAt ?? null)
  return map
}
```

- [ ] **Step 4: Run → PASS + keep existing recentLaunchSet tests green.** `npx vitest run src/lib/spy/ad-product-match.test.ts`

- [ ] **Step 5: Wire into ads API.** In `src/app/api/spy/ads/route.ts`: import `productDateMap`; after `const launch = await recentLaunchSet(...)` add `const dates = await productDateMap(ads.map(a => a.linkUrl))`. In the `enriched` map, compute the product key and add `productPublishedAt` to the returned object:
```ts
    const key = p.kind === 'product' && p.host && p.handle ? `${p.host}|${p.handle}` : null
    return {
      ...rest,
      productPublishedAt: key && dates.has(key) ? dates.get(key) : null,
      signals: { /* unchanged */ },
    }
```
(`linkUrl` is already part of `rest` — do not strip it.)

- [ ] **Step 6: tsc + commit.** `npx tsc --noEmit` (0).
```bash
git add src/lib/spy/ad-product-match.ts src/lib/spy/ad-product-match.test.ts src/app/api/spy/ads/route.ts
git commit -m "feat(spy): resolve product upload date for product-link ads (ads API)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: UI — consistent rail (①), CTA link + product date on card (④⑤), remove Sources ad preview (③)

**Files:** `src/components/spy/SpyFilterSidebar.tsx`, `src/components/spy/AdCard.tsx`, `src/app/tools/spy-idea/sources/page.tsx`.

- [ ] **Step 1: Consistent rail (①).** In `src/components/spy/SpyFilterSidebar.tsx`, remove the `showFacets` condition so the Domain/Niche/Product type facets + divider ALWAYS render (delete `const showFacets = ...` and the `{showFacets && ( ... )}` wrapper, keeping its inner facet JSX unconditionally). The Setup group stays below. (Facet clicks already `router.replace('/tools/spy-idea?...')`, so clicking from a setup page navigates to the browse view filtered.)

- [ ] **Step 2: AdCard CTA link + product date (④⑤).** In `src/components/spy/AdCard.tsx`:
  - Add `productPublishedAt?: string | null` to the `Ad` type.
  - Add a safe host helper:
```ts
function linkHost(url: string | null): string {
  if (!url) return 'CTA'
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return 'CTA' }
}
```
  - After the `#{adArchiveId}` link, before the Detail/Save row, add:
```tsx
      {a.linkUrl && (
        <a href={a.linkUrl} target="_blank" rel="noreferrer" title={a.linkUrl} className="mt-xs block truncate text-label-sm text-secondary hover:underline">🔗 {linkHost(a.linkUrl)} CTA</a>
      )}
      {a.signals.adStyle === 'product' && a.productPublishedAt && (
        <p className="mt-xs text-body-sm text-on-surface-variant">Product uploaded: {formatDate(a.productPublishedAt)}</p>
      )}
```

- [ ] **Step 3: Remove Sources ad preview (③).** In `src/app/tools/spy-idea/sources/page.tsx` `DomainBlock`: remove the ad grid `<div className="grid ...">{ads.map(...)}</div>` block AND the `ads` state + its fetch (the `/api/spy/ads?domainId=` call inside `load()`), and the `AdCard` import if now unused. Keep the domain header, fanpages list/add, and scan buttons. (Fanpages now auto-populate from Task 1.)

- [ ] **Step 4: tsc + build.** `npx tsc --noEmit` (0); `npm run build` (success).

- [ ] **Step 5: Commit.**
```bash
git add src/components/spy/SpyFilterSidebar.tsx src/components/spy/AdCard.tsx src/app/tools/spy-idea/sources/page.tsx
git commit -m "feat(spy): consistent rail; CTA link + product date on ad card; drop Sources ad preview

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes
- ① rail: remove gate only; facet nav already URL-based. ② fanpage upsert by unique `pageUrl`; idempotent across scans. ③ removes preview only; scan still ingests ads (visible in Ad Library filtered by domain). ④ linkUrl already returned. ⑤ `productPublishedAt` resolved server-side, shown only for product links (adStyle). No schema change. AdCard `Ad` type gains one optional field — other consumers (browse) pass the ad through unchanged.
