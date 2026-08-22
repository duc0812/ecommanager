# Spy Tool — Ad media (image/video thumbnail) on cards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each ad's media (image, or a thumbnail for video) on the Spy dashboard/detail cards by extracting a preview URL from the scraped payload once at ingest into a new `SpyAd.mediaUrl` column, backfilling existing ads, and rendering it.

**Architecture:** Approach B (stored field — chosen for long-term scale across many brands/fanpages). A pure `extractAdMediaUrl(snapshot)` picks a preview URL (video thumbnail → image → carousel card). `mapApifyAd` computes it at ingest; `ingestAds` persists it to the new nullable `SpyAd.mediaUrl`. A one-off Python backfill populates existing rows from their stored `rawPayload`. The ads API drops the bulky `rawPayload` from its response (the small `mediaUrl` column now carries what the UI needs). Dashboard + ad-detail render `<img>`.

**Tech Stack:** Next.js 14 (App Router, `'use client'` pages), Prisma + SQLite, Vitest, Tailwind, Python 3 (VPS backfill).

**Spec:** In-chat bounded design (this conversation) — Approach B. Media source fields confirmed from a real scraped ad on the VPS: `snapshot.videos[0].video_preview_image_url`, `snapshot.images[0].resized_image_url`, `snapshot.cards[0].*`.

## Global Constraints

- **After ANY schema change** run IN ORDER: `npx prisma migrate dev --name <change>` → `npx prisma generate` → bump `SCHEMA_VERSION` in `src/lib/db.ts` (currently `'v25'` → `'v26'`). Never add `url` to the `datasource db {}` block.
- Import Prisma only via `import { prisma } from '@/lib/db'`. SQLite: enums as String, JSON as String.
- API routes export named `GET`, return `NextResponse.json(...)`.
- Pages `'use client'`, render `<Sidebar />` inside `<RoleGate>`, layout `ml-[280px] flex-1 p-xl`. Dates `en-US`. `<img>` must carry `{/* eslint-disable-next-line @next/next/no-img-element */}`-style disable (use the repo's existing inline pattern: a JS `//` comment line directly above the `<img>`).
- Tests: `npm test` (vitest). `@`→`src`. Test files `src/**/*.test.ts`.
- Known pre-existing failures unrelated to this work: `src/lib/order-profit.test.ts` (2 tests) — ignore.
- Media extraction priority (single source of truth): `videos[0].video_preview_image_url` → `images[0].resized_image_url` → `images[0].original_image_url` → `cards[0].resized_image_url` → `cards[0].video_preview_image_url` → `cards[0].original_image_url` → `null`.

---

### Task 1: `extractAdMediaUrl`

**Files:**
- Create: `src/lib/spy/ad-media.ts`
- Test: `src/lib/spy/ad-media.test.ts`

**Interfaces:**
- Produces: `extractAdMediaUrl(snapshot: any): string | null`

- [ ] **Step 1: Write the failing test**

Create `src/lib/spy/ad-media.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractAdMediaUrl } from './ad-media'

describe('extractAdMediaUrl', () => {
  it('prefers the video preview image (thumbnail)', () => {
    expect(extractAdMediaUrl({ videos: [{ video_preview_image_url: 'https://v/thumb.jpg', video_hd_url: 'x' }] }))
      .toBe('https://v/thumb.jpg')
  })
  it('falls back to image resized then original', () => {
    expect(extractAdMediaUrl({ images: [{ resized_image_url: 'https://i/r.jpg', original_image_url: 'https://i/o.jpg' }] }))
      .toBe('https://i/r.jpg')
    expect(extractAdMediaUrl({ images: [{ original_image_url: 'https://i/o.jpg' }] })).toBe('https://i/o.jpg')
  })
  it('falls back to the first carousel card', () => {
    expect(extractAdMediaUrl({ cards: [{ resized_image_url: 'https://c/r.jpg' }] })).toBe('https://c/r.jpg')
    expect(extractAdMediaUrl({ cards: [{ video_preview_image_url: 'https://c/v.jpg' }] })).toBe('https://c/v.jpg')
  })
  it('returns null when nothing usable / bad input', () => {
    expect(extractAdMediaUrl({ images: [], videos: [], cards: [] })).toBeNull()
    expect(extractAdMediaUrl(null)).toBeNull()
    expect(extractAdMediaUrl('nope')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/lib/spy/ad-media.test.ts`
Expected: FAIL — cannot find module `./ad-media`.

- [ ] **Step 3: Implement**

Create `src/lib/spy/ad-media.ts`:

```ts
export function extractAdMediaUrl(snapshot: any): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null
  const videos = Array.isArray(snapshot.videos) ? snapshot.videos : []
  if (videos[0]?.video_preview_image_url) return videos[0].video_preview_image_url
  const images = Array.isArray(snapshot.images) ? snapshot.images : []
  if (images[0]?.resized_image_url) return images[0].resized_image_url
  if (images[0]?.original_image_url) return images[0].original_image_url
  const cards = Array.isArray(snapshot.cards) ? snapshot.cards : []
  const c = cards[0]
  if (c) return c.resized_image_url ?? c.video_preview_image_url ?? c.original_image_url ?? null
  return null
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- src/lib/spy/ad-media.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/spy/ad-media.ts src/lib/spy/ad-media.test.ts
git commit -m "feat(spy): extractAdMediaUrl (video thumbnail / image / carousel)"
```

---

### Task 2: Add `SpyAd.mediaUrl` column + migration

**Files:**
- Modify: `prisma/schema.prisma` (model `SpyAd`)
- Modify: `src/lib/db.ts:6`
- Test: `src/lib/spy/ad-media-schema.test.ts`

**Interfaces:**
- Produces: `SpyAd.mediaUrl` nullable String column.

- [ ] **Step 1: Add the column**

In `prisma/schema.prisma`, inside `model SpyAd`, add a nullable field near the other creative fields (e.g. after `linkUrl`):

```prisma
  mediaUrl           String?
```

- [ ] **Step 2: Migrate + generate + bump version**

Run: `npx prisma migrate dev --name add_spy_ad_media_url`, then `npx prisma generate`. Then in `src/lib/db.ts:6` change `'v25'` → `'v26'`.
Expected: migration applied, client generated.

- [ ] **Step 3: Smoke test the column exists**

Create `src/lib/spy/ad-media-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/db'

describe('SpyAd.mediaUrl', () => {
  it('is a queryable field on the spyAd delegate', async () => {
    // findMany selecting mediaUrl must not throw (proves the column/select is valid)
    await expect(prisma.spyAd.findMany({ select: { id: true, mediaUrl: true }, take: 1 })).resolves.toBeDefined()
  })
})
```

Run: `npm test -- src/lib/spy/ad-media-schema.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add prisma/ src/lib/db.ts src/lib/spy/ad-media-schema.test.ts
git commit -m "feat(spy): add SpyAd.mediaUrl column"
```

---

### Task 3: Populate `mediaUrl` at ingest (mapApifyAd + ingestAds)

**Files:**
- Modify: `src/lib/spy/ad-mapping.ts`
- Modify: `src/lib/spy/ad-mapping.test.ts`
- Modify: `src/lib/spy/ingest-ads.ts`
- Modify: `src/lib/spy/ingest-ads.test.ts`

**Interfaces:**
- Consumes: `extractAdMediaUrl` (Task 1).
- Produces: `ParsedSpyAd.mediaUrl: string | null`; `ingestAds` persists `mediaUrl`.

- [ ] **Step 1: Add `mediaUrl` to the mapApifyAd test**

In `src/lib/spy/ad-mapping.test.ts`, add to the first test (the video ad case) an assertion:

```ts
    expect(a.mediaUrl).toBe('v') // from snapshot.videos[0].video_preview_image_url
```

And in the raw fixture for that test, ensure the video object has a preview URL, e.g. change the videos entry to:
```ts
      snapshot: { display_format: 'video', videos: [{ video_hd_url: 'v', video_preview_image_url: 'v' }], body: { text: 'Buy now' }, caption: 'cap', cta_type: 'SHOP_NOW', cta_text: 'Shop Now', link_url: 'https://shop', title: 'T' },
```

- [ ] **Step 2: Run to verify the new assertion fails**

Run: `npm test -- src/lib/spy/ad-mapping.test.ts`
Expected: FAIL — `a.mediaUrl` is undefined.

- [ ] **Step 3: Add `mediaUrl` to `ParsedSpyAd` + `mapApifyAd`**

In `src/lib/spy/ad-mapping.ts`:
1. Add to the `ParsedSpyAd` type (after `mediaType`): `mediaUrl: string | null`.
2. Import the helper at top: `import { extractAdMediaUrl } from './ad-media'`.
3. In the returned object, add (next to `mediaType`): `mediaUrl: extractAdMediaUrl(snapshot),`.

- [ ] **Step 4: Run mapping test to verify pass**

Run: `npm test -- src/lib/spy/ad-mapping.test.ts`
Expected: PASS.

- [ ] **Step 5: Persist `mediaUrl` in `ingestAds`**

In `src/lib/spy/ingest-ads.ts`, in the `data` object (the block with `mediaType: a.mediaType, ...`), add `mediaUrl: a.mediaUrl,` (e.g. right after `mediaType: a.mediaType,`).

Then in `src/lib/spy/ingest-ads.test.ts`, the `ad(id)` fixture object must include `mediaUrl` so it type-checks — add `mediaUrl: 'https://thumb.jpg',` to the returned `ParsedSpyAd` fixture. (No new assertion required; this keeps the fixture a valid `ParsedSpyAd`.)

- [ ] **Step 6: Run ingest test + full lib suite**

Run: `npm test -- src/lib/spy/ingest-ads.test.ts` (pass).
Run: `npx tsc --noEmit` (0 errors — the fixture must satisfy `ParsedSpyAd`).

- [ ] **Step 7: Commit**

```bash
git add src/lib/spy/ad-mapping.ts src/lib/spy/ad-mapping.test.ts src/lib/spy/ingest-ads.ts src/lib/spy/ingest-ads.test.ts
git commit -m "feat(spy): persist mediaUrl at ingest"
```

---

### Task 4: Surface `mediaUrl` + drop `rawPayload` from ad API responses

**Files:**
- Modify: `src/app/api/spy/ads/route.ts`
- Modify: `src/app/api/spy/ads/[id]/route.ts`

**Interfaces:**
- Produces HTTP: each ad in `/api/spy/ads` and `/api/spy/ads/[id]` includes `mediaUrl` (a `SpyAd` column, already returned by the spread) and NO LONGER includes the bulky `rawPayload`.

- [ ] **Step 1: Drop `rawPayload` in the list route**

In `src/app/api/spy/ads/route.ts`, in the `.map(a => { ... return { ...a, signals: {...} } })` step, destructure `rawPayload` out before spreading:

```ts
  const enriched = ads.map(a => {
    const p = parseAdLink(a.linkUrl)
    const newProductLaunching = p.kind === 'product' && !!p.host && !!p.handle && launch.has(`${p.host}|${p.handle}`)
    const { rawPayload: _rawPayload, ...rest } = a
    return {
      ...rest,
      signals: { /* unchanged: isNew, activeDays, isLongRunning, isScaling, isStopped, adStyle, newProductLaunching */ },
    }
  })
```

Keep the rest of the route (the `signals` block, the `flags` filter map, `recentLaunchSet`) exactly as-is. `mediaUrl` is a `SpyAd` column so it stays in `rest` automatically. If lint flags `_rawPayload` as unused, add an inline `// eslint-disable-line @typescript-eslint/no-unused-vars` on that line (repo pattern).

- [ ] **Step 2: Drop `rawPayload` in the detail route**

In `src/app/api/spy/ads/[id]/route.ts`, after `findUnique` returns `ad`, exclude `rawPayload` from the returned `ad`:

```ts
  if (!ad) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { rawPayload: _rawPayload, ...adNoRaw } = ad
  const now = new Date()
  return NextResponse.json({ ad: adNoRaw, signals: { /* unchanged */ } })
```

Keep the `signals` computation using `ad` (it still has startDate/endDate/observations). `mediaUrl` stays on `adNoRaw`.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` (clean) + `npm run lint` (clean on both routes).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/spy/ads/route.ts "src/app/api/spy/ads/[id]/route.ts"
git commit -m "feat(spy): expose mediaUrl, drop rawPayload from ad API responses"
```

---

### Task 5: Render media on dashboard cards + ad detail

**Files:**
- Modify: `src/app/tools/spy-idea/dashboard/page.tsx`
- Modify: `src/app/tools/spy-idea/ads/[id]/page.tsx`

**Interfaces:**
- Consumes HTTP: `/api/spy/ads` (now returns `mediaUrl`), `/api/spy/ads/[id]`.

- [ ] **Step 1: Add `mediaUrl` to the dashboard `Ad` type + render it in `AdCard`**

In `src/app/tools/spy-idea/dashboard/page.tsx`:
1. Add `mediaUrl: string | null` to the `Ad` type.
2. At the top of the `AdCard` article (before the badges block), render a media thumbnail:

```tsx
      {a.mediaUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={a.mediaUrl} alt={a.title ?? ''} className="mb-sm aspect-video w-full rounded-lg object-cover" />
      ) : (
        <div className="mb-sm flex aspect-video w-full items-center justify-center rounded-lg bg-surface-container-low text-on-surface-variant">
          <span className="material-symbols-outlined text-[36px]">image_not_supported</span>
        </div>
      )}
```

- [ ] **Step 2: Render media on the ad detail page**

In `src/app/tools/spy-idea/ads/[id]/page.tsx`:
1. Add `mediaUrl: string | null` to the `ad` shape in the `AdDetail` type.
2. Just inside the detail card (before the body `<p>`), render:

```tsx
              {data.ad.mediaUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={data.ad.mediaUrl} alt={data.ad.title ?? ''} className="mb-md max-h-96 w-full rounded-lg object-contain" />
              )}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` (clean) + `npm run lint` (clean on both pages; the `<img>` eslint-disable lines are present). Confirm both pages still start with `'use client'` and render `<Sidebar />`.

- [ ] **Step 4: Commit**

```bash
git add src/app/tools/spy-idea/dashboard/page.tsx "src/app/tools/spy-idea/ads/[id]/page.tsx"
git commit -m "feat(spy): show ad media thumbnail on dashboard + detail cards"
```

---

### Task 6: Backfill script for existing ads

**Files:**
- Create: `scripts/backfill-ad-media.py`

**Interfaces:**
- A standalone Python 3 script (VPS has python3; node20 lacks `node:sqlite`). Reads `dev.db`, populates `SpyAd.mediaUrl` from each row's stored `rawPayload` using the SAME priority as `extractAdMediaUrl`.

- [ ] **Step 1: Create the script**

Create `scripts/backfill-ad-media.py`:

```python
#!/usr/bin/env python3
"""Backfill SpyAd.mediaUrl from stored rawPayload. Idempotent; only fills NULL mediaUrl.
Run from the project root (where dev.db and DATABASE_URL resolve): python3 scripts/backfill-ad-media.py
"""
import sqlite3, json, sys, os

DB = os.environ.get("SPY_DB", "dev.db")

def extract_media(snapshot):
    if not isinstance(snapshot, dict):
        return None
    videos = snapshot.get("videos") or []
    if videos and videos[0].get("video_preview_image_url"):
        return videos[0]["video_preview_image_url"]
    images = snapshot.get("images") or []
    if images and images[0].get("resized_image_url"):
        return images[0]["resized_image_url"]
    if images and images[0].get("original_image_url"):
        return images[0]["original_image_url"]
    cards = snapshot.get("cards") or []
    if cards:
        c = cards[0]
        return c.get("resized_image_url") or c.get("video_preview_image_url") or c.get("original_image_url")
    return None

def main():
    conn = sqlite3.connect(DB)
    rows = conn.execute("SELECT id, rawPayload FROM SpyAd WHERE mediaUrl IS NULL AND rawPayload IS NOT NULL").fetchall()
    filled = 0
    for ad_id, raw in rows:
        try:
            snap = (json.loads(raw) or {}).get("snapshot") or {}
        except Exception:
            continue
        url = extract_media(snap)
        if url:
            conn.execute("UPDATE SpyAd SET mediaUrl = ? WHERE id = ?", (url, ad_id))
            filled += 1
    conn.commit()
    print(f"scanned={len(rows)} filled={filled}")

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verify it runs locally (no error) against the local dev.db**

Run: `python3 scripts/backfill-ad-media.py`
Expected: prints `scanned=<n> filled=<m>` with no traceback. (Local dev.db may have 0 ads — `scanned=0 filled=0` is fine; the goal is that the script runs cleanly. It will be run for real on the VPS during deploy.)

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-ad-media.py
git commit -m "chore(spy): backfill script for SpyAd.mediaUrl"
```

---

## Self-Review

**Spec coverage (in-chat Approach B design):**
- `extractAdMediaUrl` helper (video thumbnail → image → carousel) → Task 1. ✓
- `SpyAd.mediaUrl` column + migration + version bump → Task 2. ✓
- Populate at ingest (mapApifyAd + ingestAds) → Task 3. ✓
- Drop `rawPayload` from ad responses; expose `mediaUrl` → Task 4. ✓
- Render on dashboard cards + ad detail → Task 5. ✓
- Backfill existing ads → Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code step has real content. Task 4's `signals` blocks are marked "unchanged" with the exact field list, not a placeholder.

**Type consistency:** `extractAdMediaUrl(snapshot): string|null` (Task 1) consumed in Task 3 mapApifyAd. `ParsedSpyAd.mediaUrl` (Task 3) persisted by ingest in the same task; the ingest-ads test fixture is updated to include `mediaUrl` so it stays a valid `ParsedSpyAd`. `SpyAd.mediaUrl` column (Task 2) is what the ads route returns (Task 4) and the UI `Ad`/`AdDetail` types read (Task 5). The Python backfill (Task 6) mirrors the Task 1 priority exactly.

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.
