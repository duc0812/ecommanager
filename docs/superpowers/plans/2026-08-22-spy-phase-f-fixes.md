# Spy Phase F — domain search term, full CTA link, fanpage exclude — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** ① domain ad-search uses the FULL domain (`familystore.com`, not `familystore`); ② ad card shows the full CTA URL as text; ④ fanpages can be EXCLUDED (soft, not deleted) so a wrongly-matched page's ads drop out of the Ad Library. (③ "re-scan is additive" already holds — scans are upsert-only, no code change.)

**Design (approved in chat):** ④ add `excluded` to `SpyPageTarget`; the ads API drops ads whose advertiser `fbPageId` belongs to an excluded page target (global, Ad Library). Fanpage row shows an Exclude checkbox instead of delete. ① `defaultSearchTerm` returns the www-stripped full host. ② AdCard renders `linkUrl` as the visible (truncated) link text.

**Tech Stack:** Next.js 14.2, Prisma v7 + SQLite, Vitest, Tailwind tokens.

## Global Constraints
- Prisma: no `url` in `datasource db {}`. After schema change: `npx prisma migrate dev --name add_pagetarget_excluded` → `npx prisma generate` → bump `SCHEMA_VERSION` in `src/lib/db.ts` **v31 → v32**. Import client via `@/lib/db` only.
- New DB-backed GET routes need `force-dynamic` (none new here; ads route already dynamic).
- No code comments. Tailwind tokens; dates en-US. Do NOT change scan/ingest logic (already additive). Do NOT touch cron/quota/best-seller.
- The 2 `src/lib/order-profit.test.ts` failures are pre-existing/unrelated — ignore. **Run the affected module's existing tests, not only new ones.**

---

## Task 1: Fanpage exclude — schema + pages PATCH + ads API filter (④)

**Files:** `prisma/schema.prisma`, `src/lib/db.ts`, migration, `src/app/api/spy/pages/route.ts`, `src/app/api/spy/ads/route.ts`.

- [ ] **Step 1: Schema.** In `prisma/schema.prisma` `model SpyPageTarget`, add after `active`:
```prisma
  excluded   Boolean      @default(false)
```

- [ ] **Step 2: Migrate + generate + bump.** `npx prisma migrate dev --name add_pagetarget_excluded` → `npx prisma generate` → `SCHEMA_VERSION` `'v31'`→`'v32'`. Confirm additive-only migration (ALTER TABLE ADD COLUMN / table-recreate that preserves rows). If it prompts to reset the DB, STOP → BLOCKED.

- [ ] **Step 3: pages PATCH accepts `excluded`.** In `src/app/api/spy/pages/route.ts` `PATCH`, add to the `data` builder:
```ts
  if ('excluded' in b) data.excluded = Boolean(b.excluded)
```

- [ ] **Step 4: ads API drops excluded fanpages' ads.** In `src/app/api/spy/ads/route.ts` `GET`, after building the `and` array and BEFORE `const where = ...`, add:
```ts
  const excludedRows = await prisma.spyPageTarget.findMany({ where: { excluded: true, fbPageId: { not: null } }, select: { fbPageId: true } })
  const excludedIds = excludedRows.map(r => r.fbPageId).filter((x): x is string => !!x)
  if (excludedIds.length) and.push({ advertiser: { fbPageId: { notIn: excludedIds } } })
```
(Leave the rest — signals, productPublishedAt, filter flags — unchanged.)

- [ ] **Step 5: tsc + build + commit.** `npx tsc --noEmit` (0); `npm run build` (success).
```bash
git add prisma/schema.prisma prisma/migrations src/lib/db.ts src/app/api/spy/pages/route.ts src/app/api/spy/ads/route.ts
git commit -m "feat(spy): fanpage exclude flag — drop excluded pages' ads from Ad Library (v32)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Domain search term = full domain (①)

**Files:** `src/lib/spy/ad-search-url.ts` (+ `.test.ts`), `src/app/api/spy/ad-domains/route.ts`.

**Interfaces:** Produces `defaultSearchTerm(domain: string): string` from `@/lib/spy/ad-search-url`.

- [ ] **Step 1: Failing test.** In `src/lib/spy/ad-search-url.test.ts` add:
```ts
import { defaultSearchTerm } from './ad-search-url'

describe('defaultSearchTerm', () => {
  it('keeps the full domain including TLD (strips only www)', () => {
    expect(defaultSearchTerm('familystore.com')).toBe('familystore.com')
    expect(defaultSearchTerm('www.familystore.com')).toBe('familystore.com')
    expect(defaultSearchTerm('shop.familystore.co.uk')).toBe('shop.familystore.co.uk')
  })
})
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/lib/spy/ad-search-url.test.ts`

- [ ] **Step 3: Implement.** Add to `src/lib/spy/ad-search-url.ts`:
```ts
export function defaultSearchTerm(domain: string): string {
  return domain.replace(/^www\./, '')
}
```

- [ ] **Step 4: Run → PASS (keep existing ad-search-url tests green).**

- [ ] **Step 5: Use it in the route.** In `src/app/api/spy/ad-domains/route.ts`: remove the local `defaultSearchTerm` function, `import { buildAdLibrarySearchUrl, defaultSearchTerm } from '@/lib/spy/ad-search-url'` (or add `defaultSearchTerm` to the existing import), and keep the `POST` usage `... || defaultSearchTerm(domain)`.

- [ ] **Step 6: tsc + commit.** `npx tsc --noEmit` (0).
```bash
git add src/lib/spy/ad-search-url.ts src/lib/spy/ad-search-url.test.ts src/app/api/spy/ad-domains/route.ts
git commit -m "fix(spy): domain ad-search term keeps full domain (familystore.com not familystore)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: UI — full CTA URL (②) + fanpage Exclude checkbox (④)

**Files:** `src/components/spy/AdCard.tsx`, `src/app/tools/spy-idea/sources/page.tsx`.

- [ ] **Step 1: AdCard full CTA URL (②).** In `src/components/spy/AdCard.tsx`, replace the CTA link (currently `🔗 {linkHost(a.linkUrl)} CTA`) with the full URL as the visible text, truncated, full URL in `title`:
```tsx
      {a.linkUrl && (
        <a href={a.linkUrl} target="_blank" rel="noreferrer" title={a.linkUrl} className="mt-xs block truncate text-label-sm text-secondary hover:underline">🔗 {a.linkUrl}</a>
      )}
```
Remove the now-unused `linkHost` helper. Keep the product-uploaded date line unchanged.

- [ ] **Step 2: Sources fanpage Exclude checkbox (④).** In `src/app/tools/spy-idea/sources/page.tsx` `DomainBlock`:
  - Add `excluded?: boolean` to the `PageTarget` type.
  - Add a handler:
```tsx
  async function toggleExclude(id: string, excluded: boolean) {
    await fetch('/api/spy/pages', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, excluded }) })
    load()
  }
```
  - In each fanpage `<li>`, REPLACE the "Xoá" button with an exclude checkbox:
```tsx
              <label className="flex items-center gap-xs text-label-sm text-on-surface-variant">
                <input type="checkbox" checked={!!p.excluded} onChange={e => toggleExclude(p.id, e.target.checked)} />
                Exclude
              </label>
```
  - Optionally dim excluded rows: add `className={p.excluded ? 'opacity-50' : ''}` on the row's label span. Keep the "Scan page" button.

- [ ] **Step 3: tsc + build + commit.** `npx tsc --noEmit` (0); `npm run build` (success).
```bash
git add src/components/spy/AdCard.tsx src/app/tools/spy-idea/sources/page.tsx
git commit -m "feat(spy): full CTA URL on ad card; fanpage Exclude checkbox (soft, not delete)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes
- ① `defaultSearchTerm` now returns full host; existing ad-domain rows get their `searchTerm` backfilled to the bare domain at deploy (manual VPS step). ② AdCard shows full `linkUrl`. ④ `excluded` on SpyPageTarget (additive migration v32); ads API drops ads whose advertiser `fbPageId` ∈ excluded page targets — global Ad Library filter; fanpage delete replaced by exclude checkbox (data preserved). ③ no change (scans are upsert-only/additive). Run `ad-search-url.test.ts` (existing + new) and `npm run build` as gates.
