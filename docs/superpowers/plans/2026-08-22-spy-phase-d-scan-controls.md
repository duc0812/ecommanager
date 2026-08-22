# Spy Phase D — persistent rail + configurable cron + per-domain scan with daily quota — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Unify the spy UI behind a persistent left rail (shared layout), make the scan cron configurable from the UI, and add per-domain scan buttons with a per-user daily quota (non-admins capped at 2 domain-scans/day) to avoid IP locks.

**Architecture:** A new `SpyScanQuota` table + pure helpers gate the manual scan routes (auth via JWT cookie). Cron config lives in `AppSetting` JSON; the scheduler becomes config-driven with a runtime `reloadSpyScheduler()`. A shared `src/app/tools/spy-idea/layout.tsx` owns the app `Sidebar` + a sticky `SpyFilterSidebar` rail; all spy pages become content-only and read nav/filter state from the URL.

**Tech Stack:** Next.js 14.2 App Router, Prisma v7 + SQLite, node-cron, jose (JWT), Vitest, Tailwind tokens.

**Spec:** `docs/superpowers/specs/2026-08-22-spy-phase-d-scan-controls-design.md`

## Global Constraints

- **Prisma:** never add `url` to `datasource db {}`. After schema change: `npx prisma migrate dev --name add_spy_scan_quota` → `npx prisma generate` → bump `SCHEMA_VERSION` in `src/lib/db.ts` **v30 → v31**. Import client via `@/lib/db` only.
- **Route caching (learned in the last fix):** any NEW GET route handler that reads the DB MUST set `export const dynamic = 'force-dynamic'` (Next 14 static-caches no-request GETs). Applies to `/api/spy/cron` GET. (`/api/spy/scan-quota` reads cookies → already dynamic, but add it too for clarity.)
- **Auth:** current user via `req.cookies.get('auth_token')?.value` → `verifyToken` (`@/lib/auth`) → `{ userId, role }`. Roles from `@/lib/roles`: admins = `SUPERADMIN`|`ADMIN`.
- **Do NOT change** scan/ingest/best-seller logic, ad-scan internals, or the Meta auto-sync cron. Only add the quota gate, per-domain triggers, config-driven scheduling, and the layout.
- **Pages:** `'use client'`, Tailwind tokens, `material-symbols-outlined`, dates en-US, no code comments. After the layout lands, pages must NOT render their own `<Sidebar/>`/outer wrapper/rail.
- The 2 `src/lib/order-profit.test.ts` failures are pre-existing/unrelated — ignore.

---

## File Structure

**New:** `src/lib/spy/scan-quota.ts` (+test, +schema test), `src/lib/spy/cron-config.ts` (+test), `src/app/api/spy/scan-quota/route.ts`, `src/app/api/spy/cron/route.ts`, `src/app/tools/spy-idea/layout.tsx`, `src/components/spy/SpyChrome.tsx`, migration.

**Modified:** `prisma/schema.prisma`, `src/lib/db.ts`, `src/app/api/spy/scan/route.ts`, `src/app/api/spy/scan-ads/route.ts`, `src/lib/spy/scheduler.ts`, `src/components/spy/SpyFilterSidebar.tsx`, `src/app/tools/spy-idea/page.tsx`, `src/app/tools/spy-idea/sources/page.tsx`, `src/app/tools/spy-idea/niches/page.tsx`, `src/app/tools/spy-idea/product-types/page.tsx`, `src/app/tools/spy-idea/ads/[id]/page.tsx`.

---

## Task 1: SpyScanQuota model + quota helpers

**Files:** `prisma/schema.prisma`, `src/lib/db.ts`, migration, `src/lib/spy/scan-quota.ts` (+ `.test.ts`), `src/lib/spy/scan-quota-schema.test.ts`.

**Interfaces:** Produces `SCAN_DAILY_LIMIT`, `isUnlimited(role)`, `vnDay(now?)` from `@/lib/spy/scan-quota`; `prisma.spyScanQuota` delegate.

- [ ] **Step 1: Model**

In `prisma/schema.prisma`:
```prisma
model SpyScanQuota {
  id     String @id @default(cuid())
  userId String
  day    String
  count  Int    @default(0)

  @@unique([userId, day])
}
```

- [ ] **Step 2: Migrate + generate + bump**

`npx prisma migrate dev --name add_spy_scan_quota` → `npx prisma generate` → `SCHEMA_VERSION` `'v30'`→`'v31'`. Confirm additive-only migration. (If it prompts to reset the DB, STOP → BLOCKED.)

- [ ] **Step 3: Failing tests for helpers**

`src/lib/spy/scan-quota.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { isUnlimited, vnDay, SCAN_DAILY_LIMIT } from './scan-quota'

describe('isUnlimited', () => {
  it('admins are unlimited', () => { expect(isUnlimited('SUPERADMIN')).toBe(true); expect(isUnlimited('ADMIN')).toBe(true) })
  it('sellers/support are limited', () => { expect(isUnlimited('SELLER')).toBe(false); expect(isUnlimited('SUPPORT')).toBe(false) })
})
describe('vnDay', () => {
  it('formats YYYY-MM-DD', () => { expect(vnDay(new Date('2026-08-22T12:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/) })
  it('uses Asia/Ho_Chi_Minh (UTC+7) — 18:00Z is next day', () => {
    expect(vnDay(new Date('2026-08-22T18:00:00Z'))).toBe('2026-08-23')
  })
  it('default limit is 2', () => { expect(SCAN_DAILY_LIMIT).toBe(2) })
})
```

- [ ] **Step 4: Run → FAIL.** `npx vitest run src/lib/spy/scan-quota.test.ts`

- [ ] **Step 5: Implement `scan-quota.ts`**
```ts
import type { UserRole } from '@/lib/roles'

export const SCAN_DAILY_LIMIT = 2

export function isUnlimited(role: UserRole): boolean {
  return role === 'SUPERADMIN' || role === 'ADMIN'
}

export function vnDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
```

- [ ] **Step 6: Run → PASS.**

- [ ] **Step 7: Delegate smoke test** — `src/lib/spy/scan-quota-schema.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/db'
describe('SpyScanQuota schema', () => {
  it('exposes the spyScanQuota delegate', () => {
    expect(typeof prisma.spyScanQuota.upsert).toBe('function')
    expect(typeof prisma.spyScanQuota.findUnique).toBe('function')
  })
})
```

- [ ] **Step 8: tsc + tests + commit**
`npx tsc --noEmit` (0); `npx vitest run src/lib/spy/scan-quota.test.ts src/lib/spy/scan-quota-schema.test.ts` (pass).
```bash
git add prisma/schema.prisma prisma/migrations src/lib/db.ts src/lib/spy/scan-quota.ts src/lib/spy/scan-quota.test.ts src/lib/spy/scan-quota-schema.test.ts
git commit -m "feat(spy): SpyScanQuota model + quota helpers (v31)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Quota enforcement on scan routes + quota API

**Files:** `src/app/api/spy/scan/route.ts`, `src/app/api/spy/scan-ads/route.ts`, `src/app/api/spy/scan-quota/route.ts`.

**Interfaces:** Consumes `SCAN_DAILY_LIMIT`/`isUnlimited`/`vnDay` (T1), `verifyToken` (`@/lib/auth`). Produces `GET /api/spy/scan-quota` → `{ isAdmin, used, limit, remaining }`.

- [ ] **Step 1: Enforce in `/api/spy/scan`**

Rewrite `src/app/api/spy/scan/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { runStoreProductScan, runStoreBestSellerScan } from '@/lib/spy/scan-runner'
import { verifyToken } from '@/lib/auth'
import { SCAN_DAILY_LIMIT, isUnlimited, vnDay } from '@/lib/spy/scan-quota'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value
  const auth = token ? await verifyToken(token) : null
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const stores = body.storeId
    ? await prisma.spyStore.findMany({ where: { id: body.storeId } })
    : await prisma.spyStore.findMany({ where: { status: 'active' } })
  if (stores.length === 0) return NextResponse.json({ error: 'No stores to scan' }, { status: 404 })

  const n = stores.length
  const limited = !isUnlimited(auth.role)
  const day = vnDay()
  if (limited) {
    const q = await prisma.spyScanQuota.findUnique({ where: { userId_day: { userId: auth.userId, day } } })
    const used = q?.count ?? 0
    if (used + n > SCAN_DAILY_LIMIT) return NextResponse.json({ error: 'Daily scan limit reached', used, limit: SCAN_DAILY_LIMIT }, { status: 429 })
  }

  const results = []
  for (const s of stores) {
    const r = await runStoreProductScan(s)
    await runStoreBestSellerScan(s)
    results.push({ store: s.domain, ...r })
  }
  if (limited) {
    await prisma.spyScanQuota.upsert({
      where: { userId_day: { userId: auth.userId, day } },
      create: { userId: auth.userId, day, count: n },
      update: { count: { increment: n } },
    })
  }
  return NextResponse.json({ results })
}
```

- [ ] **Step 2: Enforce in `/api/spy/scan-ads`**

Open `src/app/api/spy/scan-ads/route.ts`. At the top of `POST`, before running the scan, add the same auth + quota check with `n = 1`, and after a successful run `upsert` increment by 1 (only when `limited`). Keep the existing scan logic (runPageAdScan/runDomainAdScan) unchanged. Add `export const dynamic = 'force-dynamic'` and the imports (`verifyToken`, `SCAN_DAILY_LIMIT`, `isUnlimited`, `vnDay`). Pattern:
```ts
  const token = req.cookies.get('auth_token')?.value
  const auth = token ? await verifyToken(token) : null
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const limited = !isUnlimited(auth.role)
  const day = vnDay()
  if (limited) {
    const q = await prisma.spyScanQuota.findUnique({ where: { userId_day: { userId: auth.userId, day } } })
    if ((q?.count ?? 0) + 1 > SCAN_DAILY_LIMIT) return NextResponse.json({ error: 'Daily scan limit reached', used: q?.count ?? 0, limit: SCAN_DAILY_LIMIT }, { status: 429 })
  }
  // ... existing scan run ...
  // after success:
  if (limited) await prisma.spyScanQuota.upsert({ where: { userId_day: { userId: auth.userId, day } }, create: { userId: auth.userId, day, count: 1 }, update: { count: { increment: 1 } } })
```
(If `prisma` isn't already imported there, add it.)

- [ ] **Step 3: Quota API** — `src/app/api/spy/scan-quota/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth'
import { SCAN_DAILY_LIMIT, isUnlimited, vnDay } from '@/lib/spy/scan-quota'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value
  const auth = token ? await verifyToken(token) : null
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (isUnlimited(auth.role)) return NextResponse.json({ isAdmin: true, used: 0, limit: SCAN_DAILY_LIMIT, remaining: null })
  const q = await prisma.spyScanQuota.findUnique({ where: { userId_day: { userId: auth.userId, day: vnDay() } } })
  const used = q?.count ?? 0
  return NextResponse.json({ isAdmin: false, used, limit: SCAN_DAILY_LIMIT, remaining: Math.max(0, SCAN_DAILY_LIMIT - used) })
}
```

- [ ] **Step 4: tsc + build + commit**
`npx tsc --noEmit` (0); `npm run build` (success). Commit:
```bash
git add src/app/api/spy/scan/route.ts src/app/api/spy/scan-ads/route.ts src/app/api/spy/scan-quota/route.ts
git commit -m "feat(spy): daily scan quota enforcement + /api/spy/scan-quota

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Configurable cron

**Files:** `src/lib/spy/cron-config.ts` (+ `.test.ts`), `src/lib/spy/scheduler.ts`, `src/app/api/spy/cron/route.ts`.

**Interfaces:** Produces `SpyCronConfig`, `DEFAULT_CRON`, `SPY_CRON_CONFIG_KEY`, `parseCronConfig(json)`, `cronExpr(hours)` from `@/lib/spy/cron-config`; `reloadSpyScheduler()` from `@/lib/spy/scheduler`; `GET/POST /api/spy/cron`.

- [ ] **Step 1: Failing tests** — `src/lib/spy/cron-config.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseCronConfig, cronExpr, DEFAULT_CRON } from './cron-config'

describe('parseCronConfig', () => {
  it('returns defaults for null/invalid', () => {
    expect(parseCronConfig(null)).toEqual(DEFAULT_CRON)
    expect(parseCronConfig('not json')).toEqual(DEFAULT_CRON)
  })
  it('merges + clamps + dedupes + sorts hours', () => {
    const c = parseCronConfig(JSON.stringify({ productBestSeller: { enabled: false, hours: [20, 8, 8, 30, -1] }, ads: { enabled: true, hours: [9] } }))
    expect(c.productBestSeller).toEqual({ enabled: false, hours: [8, 20] })
    expect(c.ads).toEqual({ enabled: true, hours: [9] })
  })
  it('keeps an explicitly empty hours array', () => {
    expect(parseCronConfig(JSON.stringify({ ads: { enabled: true, hours: [] } })).ads.hours).toEqual([])
  })
})
describe('cronExpr', () => {
  it('builds a daily expr', () => { expect(cronExpr([8, 20])).toBe('0 8,20 * * *') })
  it('returns null for empty', () => { expect(cronExpr([])).toBeNull() })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `cron-config.ts`**
```ts
export const SPY_CRON_CONFIG_KEY = 'spy.cron_config'

export type SpyCronConfig = {
  productBestSeller: { enabled: boolean; hours: number[] }
  ads: { enabled: boolean; hours: number[] }
}

export const DEFAULT_CRON: SpyCronConfig = {
  productBestSeller: { enabled: true, hours: [8, 20] },
  ads: { enabled: true, hours: [9] },
}

function normHours(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  const hs = v.map(Number).filter(h => Number.isInteger(h) && h >= 0 && h <= 23)
  return Array.from(new Set(hs)).sort((a, b) => a - b)
}

function group(o: any, key: keyof SpyCronConfig): { enabled: boolean; hours: number[] } {
  const g = o?.[key]
  return {
    enabled: typeof g?.enabled === 'boolean' ? g.enabled : DEFAULT_CRON[key].enabled,
    hours: Array.isArray(g?.hours) ? normHours(g.hours) : DEFAULT_CRON[key].hours,
  }
}

export function parseCronConfig(json: string | null | undefined): SpyCronConfig {
  if (!json) return DEFAULT_CRON
  try {
    const o = JSON.parse(json)
    return { productBestSeller: group(o, 'productBestSeller'), ads: group(o, 'ads') }
  } catch {
    return DEFAULT_CRON
  }
}

export function cronExpr(hours: number[]): string | null {
  const hs = normHours(hours)
  return hs.length ? `0 ${hs.join(',')} * * *` : null
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Make the scheduler config-driven**

Rewrite `src/lib/spy/scheduler.ts` keeping `sweepStaleScans`, `scanAllStores`, `scanAllPageTargets` bodies unchanged (Phase C intact):
```ts
import cron from 'node-cron'
import { prisma } from '@/lib/db'
import { runStoreProductScan, runStoreBestSellerScan } from './scan-runner'
import { runPageAdScan } from './scan-ads'
import { parseCronConfig, cronExpr, SPY_CRON_CONFIG_KEY, type SpyCronConfig } from './cron-config'

const TZ = 'Asia/Ho_Chi_Minh'
let initialized = false
let tasks: cron.ScheduledTask[] = []

async function sweepStaleScans() { /* unchanged */ }
async function scanAllStores() { /* unchanged (product + best-seller) */ }
async function scanAllPageTargets() { /* unchanged */ }

async function loadConfig(): Promise<SpyCronConfig> {
  const row = await prisma.appSetting.findUnique({ where: { key: SPY_CRON_CONFIG_KEY } })
  return parseCronConfig(row?.value)
}

function applySchedule(cfg: SpyCronConfig) {
  tasks.forEach(t => t.stop())
  tasks = []
  if (cfg.productBestSeller.enabled) {
    const e = cronExpr(cfg.productBestSeller.hours)
    if (e) tasks.push(cron.schedule(e, () => { scanAllStores().catch(err => console.error('[spy-scheduler]', err)) }, { timezone: TZ }))
  }
  if (cfg.ads.enabled) {
    const e = cronExpr(cfg.ads.hours)
    if (e) tasks.push(cron.schedule(e, () => { scanAllPageTargets().catch(err => console.error('[spy-scheduler]', err)) }, { timezone: TZ }))
  }
  console.log(`[spy-scheduler] applied ${tasks.length} task(s) (tz ${TZ})`)
}

export async function reloadSpyScheduler() {
  applySchedule(await loadConfig())
}

export function initSpyScheduler() {
  if (initialized) return
  initialized = true
  sweepStaleScans().catch(e => console.error('[spy-scheduler]', e))
  reloadSpyScheduler().catch(e => console.error('[spy-scheduler]', e))
  console.log('[spy-scheduler] Initialized (config-driven)')
}
```
(Copy the exact existing bodies of `sweepStaleScans`/`scanAllStores`/`scanAllPageTargets` from the current file — do not change their logic.)

- [ ] **Step 6: Cron API** — `src/app/api/spy/cron/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { parseCronConfig, SPY_CRON_CONFIG_KEY } from '@/lib/spy/cron-config'
import { reloadSpyScheduler } from '@/lib/spy/scheduler'

export const dynamic = 'force-dynamic'

export async function GET() {
  const row = await prisma.appSetting.findUnique({ where: { key: SPY_CRON_CONFIG_KEY } })
  return NextResponse.json(parseCronConfig(row?.value))
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const cfg = parseCronConfig(JSON.stringify(body))
  await prisma.appSetting.upsert({
    where: { key: SPY_CRON_CONFIG_KEY },
    create: { key: SPY_CRON_CONFIG_KEY, value: JSON.stringify(cfg) },
    update: { value: JSON.stringify(cfg) },
  })
  await reloadSpyScheduler()
  return NextResponse.json(cfg)
}
```

- [ ] **Step 7: tsc + build + commit**
`npx tsc --noEmit` (0); `npm run build` (success). Commit:
```bash
git add src/lib/spy/cron-config.ts src/lib/spy/cron-config.test.ts src/lib/spy/scheduler.ts src/app/api/spy/cron/route.ts
git commit -m "feat(spy): configurable cron (AppSetting) + runtime reloadSpyScheduler + /api/spy/cron

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Persistent layout — shared rail across all spy pages

**Files:** Create `src/app/tools/spy-idea/layout.tsx`, `src/components/spy/SpyChrome.tsx`; modify `src/components/spy/SpyFilterSidebar.tsx`; refactor `page.tsx`, `sources/page.tsx`, `niches/page.tsx`, `product-types/page.tsx`, `ads/[id]/page.tsx` to content-only.

**Interfaces:** `SpyChrome` renders the app Sidebar wrapper is in layout; SpyChrome renders the sticky rail + children. `SpyFilterSidebar` becomes self-contained (fetches filters, reads/writes URL).

- [ ] **Step 1: Make `SpyFilterSidebar` self-contained + URL-driven**

Rewrite `src/components/spy/SpyFilterSidebar.tsx` so it needs no props: it fetches `/api/spy/filters` itself, reads `domain/niche/type` from `useSearchParams`, and on select calls `router.replace` preserving other params. Hide the facets (show only the Setup group) when `usePathname()` is NOT the browse root (`/tools/spy-idea`).
```tsx
'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

type FiltersData = { domains: string[]; niches: { id: string; name: string }[]; productTypes: { id: string; name: string }[] }

function Facet({ title, options, value, onPick }: { title: string; options: { key: string | null; label: string }[]; value: string | null; onPick: (v: string | null) => void }) {
  return (
    <div className="mb-md">
      <p className="mb-xs px-xs text-label-sm uppercase tracking-wider text-on-surface-variant">{title}</p>
      {options.map(o => {
        const active = (o.key ?? null) === value
        return (
          <button key={o.key ?? '__all'} onClick={() => onPick(o.key)}
            className={`flex w-full items-center rounded-lg px-md py-xs text-left text-body-sm ${active ? 'bg-secondary-fixed font-semibold text-primary' : 'text-on-surface hover:bg-surface-container-low'}`}>{o.label}</button>
        )
      })}
    </div>
  )
}

export default function SpyFilterSidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const params = useSearchParams()
  const [filters, setFilters] = useState<FiltersData>({ domains: [], niches: [], productTypes: [] })
  const showFacets = pathname === '/tools/spy-idea'

  useEffect(() => { fetch('/api/spy/filters', { cache: 'no-store' }).then(r => r.json()).then(setFilters).catch(() => {}) }, [])

  function setParam(key: string, value: string | null) {
    const p = new URLSearchParams(Array.from(params.entries()))
    if (value) p.set(key, value); else p.delete(key)
    router.replace(`/tools/spy-idea?${p.toString()}`)
  }

  return (
    <aside className="sticky top-md w-[220px] flex-none self-start rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md shadow-card">
      {showFacets && (
        <>
          <Facet title="Domain" value={params.get('domain')} onPick={v => setParam('domain', v)} options={[{ key: null, label: 'All' }, ...filters.domains.map(d => ({ key: d, label: d }))]} />
          <Facet title="Niche" value={params.get('niche')} onPick={v => setParam('niche', v)} options={[{ key: null, label: 'All' }, ...filters.niches.map(n => ({ key: n.id, label: n.name }))]} />
          <Facet title="Product type" value={params.get('type')} onPick={v => setParam('type', v)} options={[{ key: null, label: 'All' }, ...filters.productTypes.map(t => ({ key: t.id, label: t.name }))]} />
          <div className="my-md h-px bg-outline-variant/40" />
        </>
      )}
      <div>
        <p className="mb-xs px-xs text-label-sm uppercase tracking-wider text-on-surface-variant">Setup</p>
        {[
          { href: '/tools/spy-idea/sources', icon: 'storefront', label: 'Sources' },
          { href: '/tools/spy-idea/niches', icon: 'sell', label: 'Niche' },
          { href: '/tools/spy-idea/product-types', icon: 'category', label: 'Product type' },
        ].map(s => {
          const active = pathname === s.href
          return (
            <Link key={s.href} href={s.href} className={`flex items-center gap-sm rounded-lg px-md py-xs text-body-sm ${active ? 'bg-secondary-fixed font-semibold text-primary' : 'text-secondary hover:bg-surface-container-low'}`}>
              <span className="material-symbols-outlined text-[18px]">{s.icon}</span>{s.label}
            </Link>
          )
        })}
      </div>
    </aside>
  )
}
```

- [ ] **Step 2: SpyChrome** — `src/components/spy/SpyChrome.tsx`:
```tsx
'use client'
import { Suspense } from 'react'
import SpyFilterSidebar from '@/components/spy/SpyFilterSidebar'

export default function SpyChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-lg">
      <Suspense fallback={<aside className="w-[220px] flex-none" />}>
        <SpyFilterSidebar />
      </Suspense>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
```

- [ ] **Step 3: Layout** — `src/app/tools/spy-idea/layout.tsx`:
```tsx
'use client'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import SpyChrome from '@/components/spy/SpyChrome'

export default function SpyLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <SpyChrome>{children}</SpyChrome>
        </main>
      </div>
    </RoleGate>
  )
}
```

- [ ] **Step 4: Refactor the browse page to content-only + URL-driven**

In `src/app/tools/spy-idea/page.tsx`: remove `RoleGate`, `<Sidebar/>`, the outer `flex min-h-screen` wrapper, the `<main className="ml-[280px]...">`, and the in-page `<SpyFilterSidebar .../>` + `flex gap-lg` row (the layout now supplies chrome + rail). Keep the header, tier-1 nav, tier-2 sub-tabs, and the grids. Replace local `sel`/`readParams`/`writeParams` state with reads from `useSearchParams` (`area`/`view`/`domain`/`niche`/`type`); tier-1/tier-2 clicks update the URL via `useRouter().replace`. The results-fetch effect depends on those URL values. Return just the header + nav + views (no wrappers). Keep `saveAdIdea`/`saveProductIdea` and all view rendering (New Ads/Launching/Winning, New Product Add, Best Seller groups, Ideas).

- [ ] **Step 5: Refactor the setup/detail pages to content-only**

For `sources/page.tsx`, `niches/page.tsx`, `product-types/page.tsx`, `ads/[id]/page.tsx`: remove `RoleGate`, `<Sidebar/>`, the `flex min-h-screen` wrapper and `<main className="ml-[280px]...">` (and any `SpySectionNav` on the niches page that duplicates nav) — return only the page's inner content (headers + sections). The layout supplies the shell + rail.

- [ ] **Step 6: tsc + build + manual**
`npx tsc --noEmit` (0); `npm run build` (success). Manual: rail stays put navigating browse ↔ Sources ↔ Niche ↔ Product type; facets show only on browse and drive the grid; refresh preserves state.

- [ ] **Step 7: Commit**
```bash
git add src/app/tools/spy-idea/layout.tsx src/components/spy/SpyChrome.tsx src/components/spy/SpyFilterSidebar.tsx src/app/tools/spy-idea/page.tsx src/app/tools/spy-idea/sources/page.tsx src/app/tools/spy-idea/niches/page.tsx src/app/tools/spy-idea/product-types/page.tsx src/app/tools/spy-idea/ads/[id]/page.tsx
git commit -m "feat(spy): persistent shared rail via layout; pages content-only, URL-driven

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Sources UI — cron config + quota badge + per-store scan

**Files:** `src/app/tools/spy-idea/sources/page.tsx`.

**Interfaces:** Consumes `/api/spy/cron` (GET/POST), `/api/spy/scan-quota` (GET), `/api/spy/scan` (POST `{storeId}`).

- [ ] **Step 1: Quota badge + per-store Scan button + limit handling**

In `sources/page.tsx`: on mount, `GET /api/spy/scan-quota` → state `quota`. Show a badge at top: admin → "Admin · không giới hạn"; else "Đã dùng {used}/{limit} lượt scan hôm nay". Add a **Scan** button to each store row → `POST /api/spy/scan {storeId}`; on `429` show an inline message and refetch quota; on success refetch quota + stores. Disable per-store Scan + "Scan now" (all) when `quota && !quota.isAdmin && quota.remaining <= 0` (title "Hết lượt hôm nay"). After the existing ad-domain scan actions, also refetch quota.

- [ ] **Step 2: Cron config section**

Add a "Scheduled scans (cron)" card near the top: `GET /api/spy/cron` → state. Two groups (Product + Best Seller, Ads): an enable checkbox + hour multi-select (buttons 0–23 toggling membership). "Save" → `POST /api/spy/cron` with the edited config, then refetch. Show a note "Timezone: Asia/Ho_Chi_Minh". (Read-only "last run" is optional; skip if it complicates — not required.)

- [ ] **Step 3: tsc + build + commit**
`npx tsc --noEmit` (0); `npm run build` (success).
```bash
git add src/app/tools/spy-idea/sources/page.tsx
git commit -m "feat(spy): Sources cron config + scan quota badge + per-store scan buttons

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes (author)

- **Spec coverage:** §3 layout → T4; §4 cron → T3; §5 quota → T1/T2/T5. ✅
- **Type consistency:** quota API `{isAdmin,used,limit,remaining}` consumed by Sources; `SpyCronConfig` shared by cron-config/scheduler/API/UI; `userId_day` composite unique used consistently. ✅
- **Caching lesson applied:** new no-req GET (`/api/spy/cron`) + cookie GETs get `force-dynamic`. ✅
- **DB safety:** one additive migration (SpyScanQuota); SCHEMA_VERSION v31. ✅
- **Isolation:** cron scans never touch quota; scheduler bodies unchanged; ad-scan internals unchanged. ✅
- **Risk (T4):** the layout refactor is the delicate one — pages must drop their own Sidebar/wrapper/rail exactly once (no double rail, no double Sidebar). tsc+build+manual gate at T4 Step 6.
