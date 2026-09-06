# Niche Performance Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/marketing/niche-performance` page showing, per product niche, Meta campaign spend vs Shopify revenue (ROAS, orders, AOV) with a campaign drill-down, an "Unassigned" bucket with manual overrides, and a niche/keyword manager.

**Architecture:** A new campaign-level Meta insights sync (`level=campaign`) stores daily spend per campaign in `MetaCampaignDailySpend`. A pure function `computeNichePerformance()` joins campaign spend (converted to USD) and order lines to niches by case-insensitive keyword match on campaign name / product title, with manual overrides for campaigns. A thin API route loads data with Prisma and calls the pure function; a `'use client'` page renders it.

**Tech Stack:** Next.js 14 app router, Prisma v7 (libsql/SQLite), vitest, Tailwind design tokens, Material Symbols icons. No chart library.

**Spec:** `docs/superpowers/specs/2026-09-06-niche-performance-design.md`

## Global Constraints

- Never add `url` to `datasource db {}` in `prisma/schema.prisma`.
- After the schema change run `npx prisma migrate dev --name add_niche_performance`, then `npx prisma generate`, then bump `SCHEMA_VERSION` in `src/lib/db.ts` from `'v44'` to `'v45'`, then restart the dev server.
- Import Prisma only via `import { prisma } from '@/lib/db'`. Never import from `@/generated/prisma` directly.
- Pages are `'use client'`, render `<Sidebar />`, and use the wrapper `<div className="flex min-h-screen bg-surface"><Sidebar /><main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 w-full lg:w-[calc(100vw-280px)] min-w-0 overflow-x-hidden p-xl">…</main></div>`.
- Tailwind tokens only (`bg-surface-container-lowest`, `text-on-surface-variant`, `px-lg`, `py-md`, …). Icons: `<span className="material-symbols-outlined">name</span>`.
- Dates display as US `MM/DD/YYYY` (`en-US`). Never `vi-VN` for dates.
- No code comments unless explaining a non-obvious constraint.
- Spend is converted to USD with `convertMetaAmountToUsdDated`; the 3% FX fee is NOT added.
- Revenue = `unitPrice × qty` of product lines minus pro-rata order refund. Orders with `pipelineStatus` in `PROJECT_REVENUE_EXCLUDED_STATUSES` are excluded (this is how `profit-chart` filters; the spec's mention of `financialStatus` is superseded by this).
- Run tests with `npx vitest run <path>`. Two pre-existing failures in `src/lib/order-profit.test.ts` are known and unrelated.
- Working directory: `d:\Ecom manager\ecommanager-claude-ecommerce-cashflow-tool-XsLzh`. Commit only the files you touched (the working tree has unrelated uncommitted changes; never `git add -A`).

---

## File map

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | Add `Niche`, `MetaCampaignDailySpend`, `MetaCampaignNicheOverride`; relation on `MetaAdAccount` |
| `src/lib/db.ts` | Bump `SCHEMA_VERSION` |
| `src/lib/cashflow-dates.ts` | Add shared `getPeriodRange` (with `last-7`, `last-30`) |
| `src/lib/cashflow-dates.test.ts` | Tests for `getPeriodRange` |
| `src/app/api/projects/profit-chart/route.ts` | Use shared date helpers instead of local copies |
| `src/lib/sync-meta-insights.ts` | Extract `runInsightsSync`; add `syncMetaCampaignInsights` |
| `src/lib/sync-meta-insights.test.ts` | Add campaign sync tests |
| `src/app/api/meta/sync-campaign-insights/route.ts` | Manual trigger for campaign sync |
| `src/lib/auto-sync.ts` | Call campaign sync after account sync (full + nightly) |
| `src/lib/marketing/niche-performance.ts` | Pure aggregation `computeNichePerformance` + types |
| `src/lib/marketing/niche-performance.test.ts` | Unit tests |
| `src/app/api/marketing/niches/route.ts` | Niche CRUD |
| `src/app/api/marketing/campaign-overrides/route.ts` | Override PUT/DELETE |
| `src/app/api/marketing/niche-performance/route.ts` | Dashboard data route |
| `src/lib/roles.ts` | `marketing_niche` permission |
| `src/components/Sidebar.tsx` | "Marketing" group + nav item |
| `src/components/marketing/format.ts` | Number/date formatters shared by the page components |
| `src/components/marketing/CampaignTable.tsx` | Campaign sub-table (used by niche rows and Unassigned) |
| `src/components/marketing/NicheManagerPanel.tsx` | Slide-over niche/keyword CRUD |
| `src/app/marketing/niche-performance/page.tsx` | The dashboard page |
| `NOTES.md`, `PLAN.md` | Document the feature |

---

### Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma` (the `MetaAdAccount` block at ~L107-123, and append new models after `DailyAdSpend` at ~L562-577)
- Modify: `src/lib/db.ts:7`

**Interfaces:**
- Produces Prisma models `prisma.niche`, `prisma.metaCampaignDailySpend` (unique key `adAccountId_campaignId_date`), `prisma.metaCampaignNicheOverride` (pk `campaignId`).

- [ ] **Step 1: Add the relation field on `MetaAdAccount`**

In `prisma/schema.prisma`, inside `model MetaAdAccount { … }`, after the line `dailySpends     DailyAdSpend[]` add:

```prisma
  campaignDailySpends MetaCampaignDailySpend[]
```

- [ ] **Step 2: Add the three new models**

Append directly after the `model DailyAdSpend { … }` block:

```prisma
model MetaCampaignDailySpend {
  id           String        @id @default(cuid())
  adAccountId  String
  adAccount    MetaAdAccount @relation(fields: [adAccountId], references: [id], onDelete: Cascade)
  campaignId   String
  campaignName String
  date         String        // "YYYY-MM-DD" in the Meta account timezone, same as DailyAdSpend
  spend        Float         @default(0)
  impressions  Int           @default(0)
  clicks       Int           @default(0)
  currency     String        @default("USD")
  fetchedAt    DateTime      @default(now())

  @@unique([adAccountId, campaignId, date])
  @@index([date])
  @@index([campaignId])
}

model Niche {
  id        String   @id @default(cuid())
  name      String   @unique
  keywords  String   @default("[]") // JSON string[]; matched case-insensitively on campaign names and product titles
  active    Boolean  @default(true)
  sortOrder Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  overrides MetaCampaignNicheOverride[]
}

model MetaCampaignNicheOverride {
  campaignId String   @id
  nicheId    String
  niche      Niche    @relation(fields: [nicheId], references: [id], onDelete: Cascade)
  createdAt  DateTime @default(now())
}
```

- [ ] **Step 3: Run the migration and regenerate the client**

```bash
cd "d:/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx prisma migrate dev --name add_niche_performance
npx prisma generate
```

Expected: a new folder `prisma/migrations/<timestamp>_add_niche_performance/migration.sql` containing `CREATE TABLE "MetaCampaignDailySpend"`, `CREATE TABLE "Niche"`, `CREATE TABLE "MetaCampaignNicheOverride"`. If Prisma reports drift and asks to reset, STOP and report; do not reset the database.

- [ ] **Step 4: Bump the schema version**

In `src/lib/db.ts` change `const SCHEMA_VERSION = 'v44'` to `const SCHEMA_VERSION = 'v45'`.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors (pre-existing errors, if any, are unchanged from `git stash; npx tsc --noEmit; git stash pop` baseline).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/db.ts
git commit -m "feat(marketing): add Niche, MetaCampaignDailySpend, MetaCampaignNicheOverride models

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Shared `getPeriodRange` helper

**Files:**
- Modify: `src/lib/cashflow-dates.ts`
- Create: `src/lib/cashflow-dates.test.ts`
- Modify: `src/app/api/projects/profit-chart/route.ts:1-70`

**Interfaces:**
- Produces `getPeriodRange(period: string, timeZone: string, from?: string | null, to?: string | null): { from: Date; to: Date; fromKey: string; toKey: string }` exported from `@/lib/cashflow-dates`. Periods: `today`, `this-week` (Monday start), `this-month` (default), `last-7`, `last-30`, `custom` (requires `from` and `to` as `YYYY-MM-DD`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/cashflow-dates.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getPeriodRange } from './cashflow-dates'

describe('getPeriodRange', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-06T18:00:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('this-month runs from the 1st to today in the store timezone', () => {
    const r = getPeriodRange('this-month', 'America/New_York')
    expect(r.fromKey).toBe('2026-09-01')
    expect(r.toKey).toBe('2026-09-06')
    expect(r.from.toISOString()).toBe('2026-09-01T04:00:00.000Z')
    expect(r.to.toISOString()).toBe('2026-09-07T03:59:59.999Z')
  })

  it('today is a single day', () => {
    const r = getPeriodRange('today', 'UTC')
    expect(r.fromKey).toBe('2026-09-06')
    expect(r.toKey).toBe('2026-09-06')
  })

  it('this-week starts on Monday', () => {
    const r = getPeriodRange('this-week', 'UTC')
    expect(r.fromKey).toBe('2026-08-31')
    expect(r.toKey).toBe('2026-09-06')
  })

  it('last-7 and last-30 are inclusive rolling windows ending today', () => {
    expect(getPeriodRange('last-7', 'UTC').fromKey).toBe('2026-08-31')
    expect(getPeriodRange('last-30', 'UTC').fromKey).toBe('2026-08-08')
    expect(getPeriodRange('last-30', 'UTC').toKey).toBe('2026-09-06')
  })

  it('custom uses the given keys and falls back to this-month when incomplete', () => {
    const r = getPeriodRange('custom', 'UTC', '2026-07-01', '2026-07-15')
    expect(r.fromKey).toBe('2026-07-01')
    expect(r.toKey).toBe('2026-07-15')
    expect(getPeriodRange('custom', 'UTC', '2026-07-01', null).fromKey).toBe('2026-09-01')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/cashflow-dates.test.ts`
Expected: FAIL with `getPeriodRange is not a function` / no export.

- [ ] **Step 3: Implement `getPeriodRange`**

Append to `src/lib/cashflow-dates.ts`:

```ts
export type PeriodRange = { from: Date; to: Date; fromKey: string; toKey: string }

export function getPeriodRange(period: string, timeZone: string, from?: string | null, to?: string | null): PeriodRange {
  const todayStr = dateKeyInZone(new Date(), timeZone)
  const buildRange = (fromKey: string, toKey: string): PeriodRange => ({
    from: zonedDayStartUtc(fromKey, timeZone),
    to: new Date(zonedDayStartUtc(addDays(toKey, 1), timeZone).getTime() - 1),
    fromKey,
    toKey,
  })

  if (period === 'custom' && from && to) return buildRange(from, to)
  if (period === 'today') return buildRange(todayStr, todayStr)
  if (period === 'this-week') {
    const dow = new Date(`${todayStr}T12:00:00.000Z`).getUTCDay()
    return buildRange(addDays(todayStr, -((dow + 6) % 7)), todayStr)
  }
  if (period === 'last-7') return buildRange(addDays(todayStr, -6), todayStr)
  if (period === 'last-30') return buildRange(addDays(todayStr, -29), todayStr)
  return buildRange(`${todayStr.slice(0, 7)}-01`, todayStr)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/cashflow-dates.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Point profit-chart at the shared helpers**

In `src/app/api/projects/profit-chart/route.ts` delete the local `dateKeyInZone`, `zonedDayStartUtc`, `addDays`, and `getPeriodRange` functions (lines ~9-70, keep `roundMetric`) and add the import:

```ts
import { dateKeyInZone, addDays, getPeriodRange } from '@/lib/cashflow-dates'
```

The body of `GET` is unchanged (it already calls `getPeriodRange(period, timeZone, searchParams.get('from'), searchParams.get('to'))`, `dateKeyInZone(order.placedAt, timeZone)` and `addDays(cursor, 1)`).

- [ ] **Step 6: Type-check and run the whole suite**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: tsc clean; vitest all green except the 2 known `order-profit.test.ts` failures.

- [ ] **Step 7: Commit**

```bash
git add src/lib/cashflow-dates.ts src/lib/cashflow-dates.test.ts src/app/api/projects/profit-chart/route.ts
git commit -m "refactor(cashflow): share getPeriodRange with last-7/last-30 presets

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Campaign-level insights sync

**Files:**
- Modify: `src/lib/sync-meta-insights.ts` (whole file)
- Modify: `src/lib/sync-meta-insights.test.ts`

**Interfaces:**
- Keeps `syncMetaInsights(optionsOrDays?: number | SyncMetaInsightsOptions)` behaviour and return shape unchanged.
- Produces `syncMetaCampaignInsights(optionsOrDays?: number | SyncMetaInsightsOptions): Promise<SyncMetaInsightsResult>` with the same options and result shape `{ synced, accounts, errors, perAccount, range }`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/sync-meta-insights.test.ts`, replace the `vi.mock('@/lib/db', …)` block with one that also mocks the campaign table, and add a new describe block. Full file:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const upserts: any[] = []
const campaignUpserts: any[] = []

vi.mock('@/lib/db', () => ({
  prisma: {
    metaAdAccount: {
      findMany: vi.fn(async () => [
        { id: 'acc1', accountId: 'act_123', accountName: 'Test Account', accessToken: 'tok', currency: 'USD' },
      ]),
      update: vi.fn(async () => ({})),
    },
    dailyAdSpend: {
      upsert: vi.fn(async (args: any) => {
        upserts.push(args)
        return {}
      }),
    },
    metaCampaignDailySpend: {
      upsert: vi.fn(async (args: any) => {
        campaignUpserts.push(args)
        return {}
      }),
    },
  },
}))

import { syncMetaInsights, syncMetaCampaignInsights } from '@/lib/sync-meta-insights'

function insightsRow(date: string, spend: string) {
  return { date_start: date, date_stop: date, spend, impressions: '100', clicks: '10' }
}

function campaignRow(date: string, campaignId: string, campaignName: string, spend: string) {
  return { date_start: date, date_stop: date, campaign_id: campaignId, campaign_name: campaignName, spend, impressions: '50', clicks: '5' }
}

describe('syncMetaInsights pagination', () => {
  beforeEach(() => {
    upserts.length = 0
    vi.restoreAllMocks()
  })

  it('follows paging.next so days beyond the first page are not dropped', async () => {
    const page1 = {
      data: Array.from({ length: 25 }, (_, i) => insightsRow(`2026-05-${String(i + 1).padStart(2, '0')}`, '10')),
      paging: { next: 'https://graph.facebook.com/page2' },
    }
    const page2 = {
      data: Array.from({ length: 5 }, (_, i) => insightsRow(`2026-06-0${i + 1}`, '20')),
      paging: {},
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => page1 } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => page2 } as Response)

    const result = await syncMetaInsights(30)

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[1][0]).toBe('https://graph.facebook.com/page2')
    expect(result.synced).toBe(30)
    expect(result.errors).toEqual([])
    expect(upserts).toHaveLength(30)
    expect(upserts.at(-1).create.date).toBe('2026-06-05')
  })

  it('reports per-account error when the API call fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid OAuth access token' } }),
    } as Response)

    const result = await syncMetaInsights(30)

    expect(result.synced).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Invalid OAuth access token')
  })
})

describe('syncMetaCampaignInsights', () => {
  beforeEach(() => {
    campaignUpserts.length = 0
    vi.restoreAllMocks()
  })

  it('requests campaign level with campaign fields and upserts one row per campaign per day', async () => {
    const page1 = {
      data: [
        campaignRow('2026-09-01', 'c1', 'Remi04 Pomo New Arrival', '10'),
        campaignRow('2026-09-01', 'c2', 'JEEP mug collection', '4'),
      ],
      paging: { next: 'https://graph.facebook.com/page2' },
    }
    const page2 = { data: [campaignRow('2026-09-02', 'c1', 'Remi04 Pomo New Arrival', '12')], paging: {} }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => page1 } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => page2 } as Response)

    const result = await syncMetaCampaignInsights(30)

    const firstUrl = decodeURIComponent(String(fetchSpy.mock.calls[0][0]))
    expect(firstUrl).toContain('level=campaign')
    expect(firstUrl).toContain('fields=campaign_id,campaign_name,spend,impressions,clicks')
    expect(firstUrl).toContain('time_increment=1')
    expect(result.synced).toBe(3)
    expect(result.errors).toEqual([])
    expect(campaignUpserts).toHaveLength(3)
    expect(campaignUpserts[0].where).toEqual({
      adAccountId_campaignId_date: { adAccountId: 'acc1', campaignId: 'c1', date: '2026-09-01' },
    })
    expect(campaignUpserts[0].create).toMatchObject({
      adAccountId: 'acc1', campaignId: 'c1', campaignName: 'Remi04 Pomo New Arrival',
      date: '2026-09-01', spend: 10, impressions: 50, clicks: 5, currency: 'USD',
    })
    expect(campaignUpserts[0].update).toMatchObject({ campaignName: 'Remi04 Pomo New Arrival', spend: 10 })
  })

  it('skips rows without a campaign_id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ date_start: '2026-09-01', spend: '1', impressions: '1', clicks: '0' }], paging: {} }),
    } as Response)

    const result = await syncMetaCampaignInsights(30)

    expect(result.synced).toBe(0)
    expect(campaignUpserts).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/lib/sync-meta-insights.test.ts`
Expected: the two original tests PASS; the two `syncMetaCampaignInsights` tests FAIL (`syncMetaCampaignInsights is not a function`).

- [ ] **Step 3: Refactor the sync into `runInsightsSync` and add the campaign variant**

Replace the entire contents of `src/lib/sync-meta-insights.ts` with:

```ts
import { prisma } from '@/lib/db'
import { isMetaBillingSyncWorkerActive } from '@/lib/meta-billing-sync'

const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION ?? 'v22.0'

function dateOnly(d: Date) {
  return d.toISOString().split('T')[0]
}

function daysAgo(n: number) {
  return dateOnly(new Date(Date.now() - n * 24 * 60 * 60 * 1000))
}

function safeFloat(s: string | null | undefined): number {
  const n = parseFloat(s ?? '0')
  return isNaN(n) ? 0 : n
}

function safeInt(s: string | null | undefined): number {
  const n = parseInt(s ?? '0', 10)
  return isNaN(n) ? 0 : n
}

export type SyncMetaInsightsOptions = {
  days?: number
  since?: string | null   // "YYYY-MM-DD" — backfill from this date instead of the rolling window
  until?: string | null   // "YYYY-MM-DD" — defaults to today
  accountId?: string | null  // limit the sync to a single MetaAdAccount.id
  fromProjectStart?: boolean // backfill each account from its linked project's start date
}

export type SyncMetaInsightsResult = {
  synced: number
  accounts: number
  errors: string[]
  perAccount: Array<{ name: string; rows: number }>
  range: { since: string; until: string }
}

type SyncAccount = {
  id: string
  accountId: string
  accountName: string | null
  accessToken: string
  currency: string | null
  project?: { startDate: Date } | null
}

type InsightsRow = {
  date_start: string
  spend?: string
  impressions?: string
  clicks?: string
  campaign_id?: string
  campaign_name?: string
}

type InsightsSyncConfig = {
  level: 'account' | 'campaign'
  fields: string
  skippedLabel: string
  lastStoredDate: (account: SyncAccount) => Promise<string | null>
  persistRow: (account: SyncAccount, row: InsightsRow) => Promise<boolean>
}

function validDateKey(value: string | null | undefined) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

async function runInsightsSync(
  optionsOrDays: number | SyncMetaInsightsOptions,
  config: InsightsSyncConfig,
): Promise<SyncMetaInsightsResult> {
  const options: SyncMetaInsightsOptions = typeof optionsOrDays === 'number' ? { days: optionsOrDays } : optionsOrDays

  const emptyRange = { since: '', until: '' }
  if (isMetaBillingSyncWorkerActive()) {
    return {
      synced: 0,
      accounts: 0,
      errors: [`Meta billing đang chạy nền; ${config.skippedLabel} được bỏ qua để tránh gọi API đồng thời.`],
      perAccount: [],
      range: emptyRange,
    }
  }

  const accountId = options.accountId?.trim() || null
  const accounts: SyncAccount[] = await prisma.metaAdAccount.findMany({
    ...(accountId ? { where: { id: accountId } } : {}),
    include: { project: { select: { startDate: true } } },
  })
  if (accounts.length === 0) return { synced: 0, accounts: 0, errors: ['No Meta accounts configured'], perAccount: [], range: emptyRange }

  // Sync-window strategy:
  //   1. explicit since/until → manual backfill of an exact range (same for all accounts)
  //   2. explicit days        → fixed rolling last-N-days window (nightly finalization / back-compat)
  //   3. neither (default)    → smart per-account incremental:
  //        first sync  = from firstSyncSince (reaches back to capture the account's first spend day)
  //        next syncs  = from the last stored day → today (only the missing tail; also re-finalizes the last day)
  const explicitSince = validDateKey(options.since)
  const fromProjectStart = options.fromProjectStart === true
  const fixedDays = (typeof optionsOrDays === 'number' || options.days != null) ? (options.days ?? 30) : null
  const until = validDateKey(options.until) ?? dateOnly(new Date())
  // Meta only returns days that had delivery, so a wide first-sync range is cheap.
  const firstSyncSince = validDateKey(process.env.META_INSIGHTS_FIRST_SYNC_SINCE) ?? daysAgo(730)

  let totalSynced = 0
  const errors: string[] = []
  const perAccount: Array<{ name: string; rows: number }> = []
  let earliestSince = until

  for (const account of accounts) {
    let since: string
    if (explicitSince) {
      since = explicitSince
    } else if (fromProjectStart) {
      // Anchor to the project's start date; if it is missing or misconfigured
      // (later than today), fall back to the wide default so the backfill still works.
      const projectStart = account.project?.startDate ? dateOnly(account.project.startDate) : null
      since = projectStart && projectStart <= until ? projectStart : firstSyncSince
    } else if (fixedDays != null) {
      since = daysAgo(fixedDays)
    } else {
      since = (await config.lastStoredDate(account)) ?? firstSyncSince
    }
    if (since > until) since = until
    if (since < earliestSince) earliestSince = since

    const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${account.accountId}/insights`)
    url.searchParams.set('fields', config.fields)
    url.searchParams.set('time_increment', '1')
    url.searchParams.set('time_range', JSON.stringify({ since, until }))
    url.searchParams.set('level', config.level)
    url.searchParams.set('limit', '500')

    // Insights API pages its results (default 25 rows) — follow paging.next or recent days get dropped
    const rows: InsightsRow[] = []
    let nextUrl: string | null = url.toString()
    let failed = false
    while (nextUrl) {
      try {
        const res: Response = await fetch(nextUrl, {
          headers: { Authorization: `Bearer ${account.accessToken}` },
        })
        const json: any = await res.json()
        if (!res.ok || json.error) {
          const errMsg = json.error?.message ?? json.error ?? `HTTP ${res.status}`
          errors.push(`${account.accountName ?? account.accountId}: ${errMsg}`)
          failed = rows.length === 0
          break
        }
        rows.push(...(json.data ?? []))
        nextUrl = json.paging?.next ?? null
      } catch (e: any) {
        errors.push(`${account.accountName ?? account.accountId}: ${e?.message ?? 'Network error'}`)
        failed = rows.length === 0
        break
      }
    }
    if (failed) {
      perAccount.push({ name: account.accountName ?? account.accountId, rows: 0 })
      continue
    }

    let persisted = 0
    for (const row of rows) {
      if (await config.persistRow(account, row)) persisted++
    }
    totalSynced += persisted

    perAccount.push({ name: account.accountName ?? account.accountId, rows: persisted })

    await prisma.metaAdAccount.update({
      where: { id: account.id },
      data: { lastSyncAt: new Date() },
    })
  }

  return { synced: totalSynced, accounts: accounts.length, errors, perAccount, range: { since: earliestSince, until } }
}

export async function syncMetaInsights(
  optionsOrDays: number | SyncMetaInsightsOptions = {}
): Promise<SyncMetaInsightsResult> {
  return runInsightsSync(optionsOrDays, {
    level: 'account',
    fields: 'spend,impressions,clicks',
    skippedLabel: 'Insights',
    lastStoredDate: async account => {
      const lastStored = await prisma.dailyAdSpend.findFirst({
        where: { adAccountId: account.id },
        orderBy: { date: 'desc' },
        select: { date: true },
      })
      return lastStored?.date ?? null
    },
    persistRow: async (account, row) => {
      const spend = safeFloat(row.spend)
      const impressions = safeInt(row.impressions)
      const clicks = safeInt(row.clicks)
      const currency = account.currency ?? 'USD'
      await prisma.dailyAdSpend.upsert({
        where: { adAccountId_date: { adAccountId: account.id, date: row.date_start } },
        create: { adAccountId: account.id, date: row.date_start, spend, impressions, clicks, currency, fetchedAt: new Date() },
        update: { spend, impressions, clicks, fetchedAt: new Date() },
      })
      return true
    },
  })
}

export async function syncMetaCampaignInsights(
  optionsOrDays: number | SyncMetaInsightsOptions = {}
): Promise<SyncMetaInsightsResult> {
  return runInsightsSync(optionsOrDays, {
    level: 'campaign',
    fields: 'campaign_id,campaign_name,spend,impressions,clicks',
    skippedLabel: 'Campaign insights',
    lastStoredDate: async account => {
      const lastStored = await prisma.metaCampaignDailySpend.findFirst({
        where: { adAccountId: account.id },
        orderBy: { date: 'desc' },
        select: { date: true },
      })
      return lastStored?.date ?? null
    },
    persistRow: async (account, row) => {
      const campaignId = row.campaign_id?.trim()
      if (!campaignId) return false
      const campaignName = row.campaign_name?.trim() || campaignId
      const spend = safeFloat(row.spend)
      const impressions = safeInt(row.impressions)
      const clicks = safeInt(row.clicks)
      const currency = account.currency ?? 'USD'
      await prisma.metaCampaignDailySpend.upsert({
        where: { adAccountId_campaignId_date: { adAccountId: account.id, campaignId, date: row.date_start } },
        create: { adAccountId: account.id, campaignId, campaignName, date: row.date_start, spend, impressions, clicks, currency, fetchedAt: new Date() },
        update: { campaignName, spend, impressions, clicks, fetchedAt: new Date() },
      })
      return true
    },
  })
}
```

Note: the account-level `perAccount.rows` previously reported `rows.length`; it now reports the persisted count, which is identical for account level (every row persists).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/sync-meta-insights.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean. (`prisma.metaCampaignDailySpend` exists because Task 1 ran `prisma generate`.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/sync-meta-insights.ts src/lib/sync-meta-insights.test.ts
git commit -m "feat(meta): campaign-level insights sync into MetaCampaignDailySpend

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Campaign sync route and scheduling

**Files:**
- Create: `src/app/api/meta/sync-campaign-insights/route.ts`
- Modify: `src/lib/auto-sync.ts:3,41,60`

**Interfaces:**
- Consumes `syncMetaCampaignInsights` from Task 3.
- Produces `POST /api/meta/sync-campaign-insights` with the same params as `/api/meta/sync-insights` (`since`, `until`, `accountId`, `days`, `fromProjectStart` via query or JSON body), returning `{ success: true, synced, accounts, errors, perAccount, range }`.

- [ ] **Step 1: Create the route**

Create `src/app/api/meta/sync-campaign-insights/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { syncMetaCampaignInsights } from '@/lib/sync-meta-insights'
import { verifyToken } from '@/lib/auth'

const ADMIN_ROLES = new Set(['ADMIN', 'SUPERADMIN'])

export async function POST(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value
  const user = token ? await verifyToken(token) : null
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!ADMIN_ROLES.has(user.role)) {
    return NextResponse.json({ error: 'Chỉ Admin mới có quyền sync Meta campaign insights.' }, { status: 403 })
  }

  try {
    const { searchParams } = new URL(req.url)
    const body = await req.json().catch(() => ({} as Record<string, unknown>))

    const since = searchParams.get('since') ?? (body.since as string | undefined) ?? null
    const until = searchParams.get('until') ?? (body.until as string | undefined) ?? null
    const accountId = searchParams.get('accountId') ?? (body.accountId as string | undefined) ?? null
    const daysRaw = searchParams.get('days') ?? (body.days as string | number | undefined)
    const days = daysRaw != null && Number.isFinite(Number(daysRaw)) ? Number(daysRaw) : undefined
    const fromProjectStartRaw = searchParams.get('fromProjectStart') ?? (body.fromProjectStart as unknown)
    const fromProjectStart = fromProjectStartRaw === '1' || fromProjectStartRaw === 'true' || fromProjectStartRaw === true

    const result = await syncMetaCampaignInsights({ since, until, accountId, fromProjectStart, ...(days ? { days } : {}) })
    return NextResponse.json({ success: true, ...result })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
```

- [ ] **Step 2: Wire the campaign sync into auto-sync**

In `src/lib/auto-sync.ts`:

Change the import on line 3 to:

```ts
import { syncMetaInsights, syncMetaCampaignInsights } from '@/lib/sync-meta-insights'
```

In `runAutoSync`, after the `try { result.insights = await syncMetaInsights() } catch …` block, add:

```ts
  try {
    result.campaignInsights = await syncMetaCampaignInsights()
  } catch (e: unknown) {
    result.campaignInsights = { error: e instanceof Error ? e.message : 'Unknown error' }
  }
```

In `runNightlyMetaSync`, replace the line `const result = await syncMetaInsights(2)` and the following `appSetting.upsert` + logs with:

```ts
    const result = await syncMetaInsights(2)
    const campaigns = await syncMetaCampaignInsights(2)
    const payload = { ...result, campaigns, ranAt: new Date().toISOString() }
    await prisma.appSetting.upsert({
      where: { key: 'last_nightly_meta_sync' },
      create: { key: 'last_nightly_meta_sync', value: JSON.stringify(payload) },
      update: { value: JSON.stringify(payload) },
    })
    console.log(`[nightly-meta-sync] Done — synced ${result.synced} account rows, ${campaigns.synced} campaign rows across ${result.accounts} accounts`)
    if (result.errors.length) console.error('[nightly-meta-sync] Errors:', result.errors)
    if (campaigns.errors.length) console.error('[nightly-meta-sync] Campaign errors:', campaigns.errors)
```

- [ ] **Step 3: Type-check and smoke-test the route**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean.

Start the dev server if not running (`npm run dev -- --port 3002`), log in in a browser, then from the browser devtools console run:

```js
fetch('/api/meta/sync-campaign-insights?days=30', { method: 'POST' }).then(r => r.json()).then(console.log)
```

Expected: `{ success: true, synced: <n>, accounts: 3, errors: [], perAccount: [...] }` with `synced > 0` (Remi08 had 13 active campaigns in the last 7 days at spec time).

- [ ] **Step 4: Verify campaign totals match account totals**

Run this one-off check (create the file, run it, delete it):

```bash
cat > scripts/_check-campaign-totals.mjs <<'EOF'
import { createClient } from '@libsql/client'
const db = createClient({ url: 'file:./dev.db' })
const { rows } = await db.execute(`
  SELECT a.accountName, d.date, ROUND(d.spend, 2) accountSpend,
         ROUND((SELECT SUM(c.spend) FROM MetaCampaignDailySpend c WHERE c.adAccountId = d.adAccountId AND c.date = d.date), 2) campaignSpend
  FROM DailyAdSpend d JOIN MetaAdAccount a ON a.id = d.adAccountId
  WHERE d.date >= date('now', '-30 day') AND d.spend > 0
  ORDER BY d.date DESC LIMIT 40`)
for (const r of rows) console.log(r.accountName, r.date, r.accountSpend, r.campaignSpend, Math.abs(r.accountSpend - (r.campaignSpend ?? 0)) < 1 ? 'OK' : 'MISMATCH')
EOF
node scripts/_check-campaign-totals.mjs; rm scripts/_check-campaign-totals.mjs
```

Expected: every row prints `OK` (difference under 1 unit of account currency). A `MISMATCH` means the campaign sync window did not cover that day; re-run the sync with a wider `days` and re-check.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/meta/sync-campaign-insights/route.ts src/lib/auto-sync.ts
git commit -m "feat(meta): campaign insights sync route + nightly scheduling

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `computeNichePerformance` pure function

**Files:**
- Create: `src/lib/marketing/niche-performance.ts`
- Create: `src/lib/marketing/niche-performance.test.ts`

**Interfaces:**
- Consumes `parseKeywords`, `nicheMatches` from `@/lib/spy/niche`; `productLinesOnly` from `@/lib/order-lines`; `convertMetaAmountToUsdDated`, `normalizeMetaCurrency`, `DatedRate` from `@/lib/meta-currency`; `addDays` from `@/lib/cashflow-dates`.
- Produces `computeNichePerformance(input: NichePerformanceInput): NichePerformanceResult` and the exported types below (the page in Task 10 mirrors `NichePerformanceResult`, `NicheRow`, `CampaignRow`).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/marketing/niche-performance.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeNichePerformance, type NichePerformanceInput } from './niche-performance'

const period = { from: '2026-09-01', to: '2026-09-10', timeZone: 'UTC' }
const usdAccount = { id: 'acc-usd', accountId: 'act_1', accountName: 'Remi04', currency: 'USD' }
const vndAccount = { id: 'acc-vnd', accountId: 'act_2', accountName: 'Remi08', currency: 'VND' }
const schedule = [{ effectiveDate: '2026-01-01', rate: 25000 }]

const jeep = { id: 'n-jeep', name: 'Jeep', keywords: '["jeep"]', active: true, sortOrder: 0 }
const pomo = { id: 'n-pomo', name: 'PoMo', keywords: '["pomo"]', active: true, sortOrder: 1 }
const honey = { id: 'n-honey', name: 'Honey Bear', keywords: '["honey bear"]', active: true, sortOrder: 2 }

function spend(over: Partial<NichePerformanceInput['campaignSpends'][number]>) {
  return { adAccountId: 'acc-usd', campaignId: 'c1', campaignName: 'x', date: '2026-09-05', spend: 0, impressions: 0, clicks: 0, currency: 'USD', ...over }
}

function line(productTitle: string, unitPrice: number, qty = 1, extra: Partial<{ sku: string | null; shopifyProductType: string | null }> = {}) {
  return { sku: 'SKU-1', productTitle, unitPrice, qty, shopifyProductType: 'T shirt', ...extra }
}

function base(over: Partial<NichePerformanceInput> = {}): NichePerformanceInput {
  return { period, niches: [jeep, pomo, honey], overrides: [], accounts: [usdAccount, vndAccount], campaignSpends: [], orders: [], schedule, ...over }
}

describe('computeNichePerformance', () => {
  it('matches campaign names and product titles case-insensitively', () => {
    const r = computeNichePerformance(base({
      campaignSpends: [spend({ campaignId: 'c1', campaignName: 'Remi04 POMO new arrival', spend: 100, impressions: 1000, clicks: 50 })],
      orders: [{ id: 'o1', refundedAmount: 0, lines: [line('PoMo Celebrate 30 Years Jersey', 40, 2)] }],
    }))
    const p = r.niches.find(n => n.nicheId === 'n-pomo')!
    expect(p.spend).toBeCloseTo(100)
    expect(p.revenue).toBeCloseTo(80)
    expect(p.roas).toBeCloseTo(0.8)
    expect(p.orders).toBe(1)
    expect(p.aov).toBeCloseTo(80)
    expect(p.campaignCount).toBe(1)
    expect(p.campaigns[0]).toMatchObject({ campaignId: 'c1', accountName: 'Remi04', cpm: 100, ctr: 0.05 })
    expect(r.unassigned.spend).toBe(0)
    expect(r.unassigned.revenue).toBe(0)
  })

  it('override beats keyword even when the name matches another niche', () => {
    const r = computeNichePerformance(base({
      overrides: [{ campaignId: 'c1', nicheId: 'n-honey' }],
      campaignSpends: [spend({ campaignId: 'c1', campaignName: 'Jeep mug', spend: 10 })],
    }))
    expect(r.niches.find(n => n.nicheId === 'n-honey')!.spend).toBeCloseTo(10)
    expect(r.niches.find(n => n.nicheId === 'n-jeep')!.spend).toBe(0)
  })

  it('first active niche by sortOrder wins when two niches match', () => {
    const both = { id: 'n-both', name: 'Both', keywords: '["jeep"]', active: true, sortOrder: -1 }
    const r = computeNichePerformance(base({
      niches: [jeep, both],
      campaignSpends: [spend({ campaignId: 'c1', campaignName: 'jeep shirt', spend: 5 })],
    }))
    expect(r.niches.find(n => n.nicheId === 'n-both')!.spend).toBeCloseTo(5)
    expect(r.niches.find(n => n.nicheId === 'n-jeep')!.spend).toBe(0)
  })

  it('inactive niches are ignored and their campaigns/lines go to unassigned', () => {
    const r = computeNichePerformance(base({
      niches: [{ ...jeep, active: false }],
      overrides: [{ campaignId: 'c2', nicheId: 'n-jeep' }],
      campaignSpends: [
        spend({ campaignId: 'c1', campaignName: 'jeep shirt', spend: 5 }),
        spend({ campaignId: 'c2', campaignName: 'other', spend: 7 }),
      ],
      orders: [{ id: 'o1', refundedAmount: 0, lines: [line('Jeep Girl Hoodie', 60)] }],
    }))
    expect(r.niches).toHaveLength(0)
    expect(r.unassigned.spend).toBeCloseTo(12)
    expect(r.unassigned.revenue).toBeCloseTo(60)
    expect(r.unassigned.campaigns).toHaveLength(2)
  })

  it('mixed-niche order: refund allocated pro-rata, order counted once per niche', () => {
    const r = computeNichePerformance(base({
      orders: [{ id: 'o1', refundedAmount: 30, lines: [line('Jeep Hoodie', 60), line('PoMo Jersey', 40), line('Jeep Mug', 20, 2)] }],
    }))
    const j = r.niches.find(n => n.nicheId === 'n-jeep')!
    const p = r.niches.find(n => n.nicheId === 'n-pomo')!
    expect(j.revenue).toBeCloseTo(100 - 30 * (100 / 140))
    expect(p.revenue).toBeCloseTo(40 - 30 * (40 / 140))
    expect(j.orders).toBe(1)
    expect(p.orders).toBe(1)
    expect(r.totals.orders).toBe(1)
    expect(r.totals.revenue).toBeCloseTo(110)
  })

  it('excludes non-product lines (Tip, Shipping protection, Custom Text)', () => {
    const r = computeNichePerformance(base({
      orders: [{
        id: 'o1', refundedAmount: 0, lines: [
          line('Jeep Hoodie', 60),
          line('Tip', 5, 1, { sku: null, shopifyProductType: null }),
          line('Shipping protection', 3, 1, { sku: null, shopifyProductType: 'Kaching Cart Upsell Toggle' }),
          line('Custom Text', 4, 1, { sku: null, shopifyProductType: 'Custom Text' }),
        ],
      }],
    }))
    expect(r.niches.find(n => n.nicheId === 'n-jeep')!.revenue).toBeCloseTo(60)
    expect(r.unassigned.revenue).toBe(0)
    expect(r.totals.revenue).toBeCloseTo(60)
  })

  it('converts VND with the dated schedule and keeps the original amount', () => {
    const r = computeNichePerformance(base({
      campaignSpends: [spend({ adAccountId: 'acc-vnd', campaignId: 'c9', campaignName: 'Honey Bear video', spend: 2_500_000, currency: 'VND' })],
    }))
    const h = r.niches.find(n => n.nicheId === 'n-honey')!
    expect(h.spend).toBeCloseTo(100)
    expect(h.campaigns[0]).toMatchObject({ spendOriginal: 2_500_000, currency: 'VND', accountName: 'Remi08' })
    expect(r.missingExchangeRateAccounts).toEqual([])
  })

  it('missing exchange rate contributes 0 spend and lists the account', () => {
    const r = computeNichePerformance(base({
      schedule: [],
      campaignSpends: [spend({ adAccountId: 'acc-vnd', campaignId: 'c9', campaignName: 'Honey Bear video', spend: 2_500_000, currency: 'VND' })],
    }))
    expect(r.niches.find(n => n.nicheId === 'n-honey')!.spend).toBe(0)
    expect(r.missingExchangeRateAccounts).toEqual([{ accountId: 'act_2', accountName: 'Remi08', currency: 'VND' }])
  })

  it('a campaign with impressions but zero spend still appears', () => {
    const r = computeNichePerformance(base({
      campaignSpends: [spend({ campaignId: 'c1', campaignName: 'jeep test', spend: 0, impressions: 10 })],
    }))
    const j = r.niches.find(n => n.nicheId === 'n-jeep')!
    expect(j.campaigns).toHaveLength(1)
    expect(j.campaigns[0].spend).toBe(0)
    expect(j.campaigns[0].lastActiveDate).toBeNull()
    expect(j.campaigns[0].isActive).toBe(false)
    expect(j.roas).toBeNull()
  })

  it('derives lastActiveDate, isActive (spend within last 3 days of the range) and latest campaignName', () => {
    const r = computeNichePerformance(base({
      campaignSpends: [
        spend({ campaignId: 'c1', campaignName: 'jeep old name', date: '2026-09-02', spend: 5 }),
        spend({ campaignId: 'c1', campaignName: 'jeep new name', date: '2026-09-08', spend: 5 }),
        spend({ campaignId: 'c2', campaignName: 'jeep paused', date: '2026-09-03', spend: 5 }),
      ],
    }))
    const j = r.niches.find(n => n.nicheId === 'n-jeep')!
    const c1 = j.campaigns.find(c => c.campaignId === 'c1')!
    const c2 = j.campaigns.find(c => c.campaignId === 'c2')!
    expect(c1).toMatchObject({ campaignName: 'jeep new name', lastActiveDate: '2026-09-08', isActive: true, spend: 10 })
    expect(c2).toMatchObject({ lastActiveDate: '2026-09-03', isActive: false })
    expect(j.campaignCount).toBe(2)
    expect(j.activeCampaignCount).toBe(1)
  })

  it('totals equal the sum of niche and unassigned values; niches sorted by spend desc', () => {
    const r = computeNichePerformance(base({
      campaignSpends: [
        spend({ campaignId: 'c1', campaignName: 'jeep', spend: 10 }),
        spend({ campaignId: 'c2', campaignName: 'pomo', spend: 30 }),
        spend({ campaignId: 'c3', campaignName: 'mystery', spend: 2 }),
      ],
      orders: [
        { id: 'o1', refundedAmount: 0, lines: [line('Jeep Hoodie', 50)] },
        { id: 'o2', refundedAmount: 0, lines: [line('Unknown thing', 9)] },
      ],
    }))
    expect(r.niches.map(n => n.name)).toEqual(['PoMo', 'Jeep', 'Honey Bear'])
    expect(r.totals.spend).toBeCloseTo(42)
    expect(r.totals.revenue).toBeCloseTo(59)
    expect(r.totals.roas).toBeCloseTo(59 / 42)
    expect(r.totals.orders).toBe(2)
    expect(r.unassigned.spend).toBeCloseTo(2)
    expect(r.unassigned.revenue).toBeCloseTo(9)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/marketing/niche-performance.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the pure function**

Create `src/lib/marketing/niche-performance.ts`:

```ts
import { parseKeywords, nicheMatches } from '@/lib/spy/niche'
import { productLinesOnly } from '@/lib/order-lines'
import { convertMetaAmountToUsdDated, normalizeMetaCurrency, type DatedRate } from '@/lib/meta-currency'
import { addDays } from '@/lib/cashflow-dates'

export type NicheInput = { id: string; name: string; keywords: string; active: boolean; sortOrder: number }
export type OverrideInput = { campaignId: string; nicheId: string }
export type AccountInput = { id: string; accountId: string; accountName: string | null; currency: string | null }
export type CampaignSpendInput = {
  adAccountId: string
  campaignId: string
  campaignName: string
  date: string
  spend: number
  impressions: number
  clicks: number
  currency: string | null
}
export type OrderLineInput = { sku: string | null; productTitle: string; shopifyProductType: string | null; unitPrice: number; qty: number }
export type OrderInput = { id: string; refundedAmount: number; lines: OrderLineInput[] }

export type NichePerformanceInput = {
  period: { from: string; to: string; timeZone: string }
  niches: NicheInput[]
  overrides: OverrideInput[]
  accounts: AccountInput[]
  campaignSpends: CampaignSpendInput[]
  orders: OrderInput[]
  schedule: DatedRate[]
}

export type CampaignRow = {
  campaignId: string
  campaignName: string
  accountId: string
  accountName: string | null
  spend: number
  spendOriginal: number
  currency: string
  impressions: number
  clicks: number
  cpm: number | null
  ctr: number | null
  lastActiveDate: string | null
  isActive: boolean
}

export type NicheRow = {
  nicheId: string
  name: string
  spend: number
  revenue: number
  roas: number | null
  orders: number
  aov: number
  campaignCount: number
  activeCampaignCount: number
  campaigns: CampaignRow[]
}

export type NichePerformanceResult = {
  period: { from: string; to: string; timeZone: string }
  totals: { spend: number; revenue: number; roas: number | null; orders: number }
  niches: NicheRow[]
  unassigned: { spend: number; revenue: number; campaigns: CampaignRow[] }
  missingExchangeRateAccounts: Array<{ accountId: string; accountName: string | null; currency: string }>
}

const ACTIVE_WINDOW_DAYS = 3

type CampaignAgg = CampaignRow & { latestDate: string; nicheId: string | null }

function roas(revenue: number, spend: number) {
  return spend > 0 ? revenue / spend : null
}

export function computeNichePerformance(input: NichePerformanceInput): NichePerformanceResult {
  const activeNiches = input.niches
    .filter(n => n.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map(n => ({ ...n, kws: parseKeywords(n.keywords) }))
  const activeIds = new Set(activeNiches.map(n => n.id))
  const overrideMap = new Map(input.overrides.filter(o => activeIds.has(o.nicheId)).map(o => [o.campaignId, o.nicheId]))
  const accountMap = new Map(input.accounts.map(a => [a.id, a]))
  const matchNiche = (text: string) => activeNiches.find(n => nicheMatches(text, n.kws))?.id ?? null

  const activeThreshold = addDays(input.period.to, -(ACTIVE_WINDOW_DAYS - 1))
  const campaigns = new Map<string, CampaignAgg>()
  const missingRate = new Map<string, AccountInput>()

  for (const s of input.campaignSpends) {
    const account = accountMap.get(s.adAccountId)
    const currency = normalizeMetaCurrency(account?.currency || s.currency)
    const usd = convertMetaAmountToUsdDated(s.spend, currency, s.date, input.schedule)
    if (usd === null && account) missingRate.set(account.id, account)

    let c = campaigns.get(s.campaignId)
    if (!c) {
      c = {
        campaignId: s.campaignId,
        campaignName: s.campaignName,
        accountId: account?.accountId ?? s.adAccountId,
        accountName: account?.accountName ?? null,
        spend: 0,
        spendOriginal: 0,
        currency,
        impressions: 0,
        clicks: 0,
        cpm: null,
        ctr: null,
        lastActiveDate: null,
        isActive: false,
        latestDate: '',
        nicheId: null,
      }
      campaigns.set(s.campaignId, c)
    }
    c.spend += usd ?? 0
    c.spendOriginal += s.spend
    c.impressions += s.impressions
    c.clicks += s.clicks
    if (s.date >= c.latestDate) {
      c.latestDate = s.date
      c.campaignName = s.campaignName
    }
    if (s.spend > 0 && (!c.lastActiveDate || s.date > c.lastActiveDate)) c.lastActiveDate = s.date
  }

  for (const c of campaigns.values()) {
    c.nicheId = overrideMap.get(c.campaignId) ?? matchNiche(c.campaignName)
    c.cpm = c.impressions > 0 ? (c.spend / c.impressions) * 1000 : null
    c.ctr = c.impressions > 0 ? c.clicks / c.impressions : null
    c.isActive = c.lastActiveDate != null && c.lastActiveDate >= activeThreshold
  }

  const revenueByNiche = new Map<string, number>()
  const ordersByNiche = new Map<string, Set<string>>()
  let unassignedRevenue = 0
  const allOrders = new Set<string>()

  for (const order of input.orders) {
    const lines = productLinesOnly(order.lines)
    if (lines.length === 0) continue
    allOrders.add(order.id)
    const gross = lines.map(l => l.unitPrice * l.qty)
    const total = gross.reduce((a, b) => a + b, 0)
    const refund = Math.max(0, order.refundedAmount || 0)
    lines.forEach((l, i) => {
      const lineRefund = total > 0 ? (refund * gross[i]) / total : 0
      const net = Math.max(0, gross[i] - lineRefund)
      const nicheId = matchNiche(l.productTitle)
      if (!nicheId) {
        unassignedRevenue += net
        return
      }
      revenueByNiche.set(nicheId, (revenueByNiche.get(nicheId) ?? 0) + net)
      if (!ordersByNiche.has(nicheId)) ordersByNiche.set(nicheId, new Set())
      ordersByNiche.get(nicheId)!.add(order.id)
    })
  }

  const toRow = ({ latestDate: _latest, nicheId: _niche, ...row }: CampaignAgg): CampaignRow => row
  const bySpendDesc = (a: { spend: number }, b: { spend: number }) => b.spend - a.spend

  const niches: NicheRow[] = activeNiches.map(n => {
    const rows = [...campaigns.values()].filter(c => c.nicheId === n.id).sort(bySpendDesc).map(toRow)
    const spend = rows.reduce((s, c) => s + c.spend, 0)
    const revenue = revenueByNiche.get(n.id) ?? 0
    const orders = ordersByNiche.get(n.id)?.size ?? 0
    return {
      nicheId: n.id,
      name: n.name,
      spend,
      revenue,
      roas: roas(revenue, spend),
      orders,
      aov: orders > 0 ? revenue / orders : 0,
      campaignCount: rows.length,
      activeCampaignCount: rows.filter(c => c.isActive).length,
      campaigns: rows,
    }
  }).sort(bySpendDesc)

  const unassignedCampaigns = [...campaigns.values()].filter(c => c.nicheId === null).sort(bySpendDesc).map(toRow)
  const unassignedSpend = unassignedCampaigns.reduce((s, c) => s + c.spend, 0)

  const totalSpend = niches.reduce((s, n) => s + n.spend, 0) + unassignedSpend
  const totalRevenue = niches.reduce((s, n) => s + n.revenue, 0) + unassignedRevenue

  return {
    period: input.period,
    totals: { spend: totalSpend, revenue: totalRevenue, roas: roas(totalRevenue, totalSpend), orders: allOrders.size },
    niches,
    unassigned: { spend: unassignedSpend, revenue: unassignedRevenue, campaigns: unassignedCampaigns },
    missingExchangeRateAccounts: [...missingRate.values()].map(a => ({
      accountId: a.accountId,
      accountName: a.accountName,
      currency: normalizeMetaCurrency(a.currency),
    })),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/marketing/niche-performance.test.ts`
Expected: PASS (11 tests). If the "converts VND" test fails on `spend` precision, note that `convertMetaAmountToUsdDated` rounds to cents per row, which is intended; use `toBeCloseTo(100, 1)`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing/niche-performance.ts src/lib/marketing/niche-performance.test.ts
git commit -m "feat(marketing): computeNichePerformance pure aggregation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Niche CRUD and override APIs

**Files:**
- Create: `src/app/api/marketing/niches/route.ts`
- Create: `src/app/api/marketing/campaign-overrides/route.ts`

**Interfaces:**
- `GET /api/marketing/niches` → `Niche[]` ordered by `sortOrder, name`.
- `POST /api/marketing/niches { name, keywords?: string[] | string, sortOrder? }` → created `Niche` (409 on duplicate name).
- `PATCH /api/marketing/niches { id, name?, keywords?, active?, sortOrder? }` → updated `Niche`.
- `DELETE /api/marketing/niches { id }` → `{ ok: true }`.
- `PUT /api/marketing/campaign-overrides { campaignId, nicheId }` → override row.
- `DELETE /api/marketing/campaign-overrides { campaignId }` → `{ ok: true }`.
- All write methods require ADMIN or SUPERADMIN.

- [ ] **Step 1: Create the niches route**

Create `src/app/api/marketing/niches/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const ADMIN_ROLES = new Set(['ADMIN', 'SUPERADMIN'])

async function requireAdmin(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value
  const user = token ? await verifyToken(token) : null
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!ADMIN_ROLES.has(user.role)) return NextResponse.json({ error: 'Chỉ Admin mới được sửa niche.' }, { status: 403 })
  return null
}

function normKeywords(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(k => String(k).trim()).filter(Boolean)
  return String(v ?? '').split(/[\n,]/).map(k => k.trim()).filter(Boolean)
}

function isUniqueError(e: unknown) {
  return typeof e === 'object' && e !== null && (e as any).code === 'P2002'
}

export async function GET() {
  const niches = await prisma.niche.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })
  return NextResponse.json(niches)
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const b = await req.json().catch(() => ({}))
  const name = String(b.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
  const sortOrder = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : await prisma.niche.count()
  try {
    const niche = await prisma.niche.create({ data: { name, keywords: JSON.stringify(normKeywords(b.keywords)), sortOrder } })
    return NextResponse.json(niche)
  } catch (e) {
    if (isUniqueError(e)) return NextResponse.json({ error: `Niche "${name}" đã tồn tại.` }, { status: 409 })
    throw e
  }
}

export async function PATCH(req: NextRequest) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const data: Record<string, unknown> = {}
  if ('name' in b) {
    const name = String(b.name).trim()
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
    data.name = name
  }
  if ('keywords' in b) data.keywords = JSON.stringify(normKeywords(b.keywords))
  if ('active' in b) data.active = Boolean(b.active)
  if ('sortOrder' in b && Number.isFinite(Number(b.sortOrder))) data.sortOrder = Number(b.sortOrder)
  try {
    const niche = await prisma.niche.update({ where: { id: String(b.id) }, data })
    return NextResponse.json(niche)
  } catch (e) {
    if (isUniqueError(e)) return NextResponse.json({ error: `Niche "${data.name}" đã tồn tại.` }, { status: 409 })
    throw e
  }
}

export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await prisma.niche.delete({ where: { id: String(b.id) } })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Create the overrides route**

Create `src/app/api/marketing/campaign-overrides/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const ADMIN_ROLES = new Set(['ADMIN', 'SUPERADMIN'])

async function requireAdmin(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value
  const user = token ? await verifyToken(token) : null
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!ADMIN_ROLES.has(user.role)) return NextResponse.json({ error: 'Chỉ Admin mới được gán niche cho campaign.' }, { status: 403 })
  return null
}

export async function PUT(req: NextRequest) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const b = await req.json().catch(() => ({}))
  const campaignId = String(b.campaignId ?? '').trim()
  const nicheId = String(b.nicheId ?? '').trim()
  if (!campaignId || !nicheId) return NextResponse.json({ error: 'campaignId and nicheId required' }, { status: 400 })
  const niche = await prisma.niche.findUnique({ where: { id: nicheId }, select: { id: true } })
  if (!niche) return NextResponse.json({ error: 'Niche not found' }, { status: 404 })
  const override = await prisma.metaCampaignNicheOverride.upsert({
    where: { campaignId },
    create: { campaignId, nicheId },
    update: { nicheId },
  })
  return NextResponse.json(override)
}

export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const b = await req.json().catch(() => ({}))
  const campaignId = String(b.campaignId ?? '').trim()
  if (!campaignId) return NextResponse.json({ error: 'campaignId required' }, { status: 400 })
  await prisma.metaCampaignNicheOverride.deleteMany({ where: { campaignId } })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Type-check and smoke-test**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean.

With the dev server running and logged in as admin, in the browser console:

```js
await fetch('/api/marketing/niches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Jeep', keywords: 'jeep' }) }).then(r => r.json())
await fetch('/api/marketing/niches').then(r => r.json())
```

Expected: first call returns the created niche with `keywords: '["jeep"]'`; second returns an array containing it. Posting `Jeep` again returns status 409.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/marketing/niches/route.ts src/app/api/marketing/campaign-overrides/route.ts
git commit -m "feat(marketing): niche CRUD and campaign override APIs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Niche performance data route

**Files:**
- Create: `src/app/api/marketing/niche-performance/route.ts`

**Interfaces:**
- Consumes `computeNichePerformance` (Task 5), `getPeriodRange` (Task 2).
- Produces `GET /api/marketing/niche-performance?period=&from=&to=&projectId=` → `{ project: { id, name }, ...NichePerformanceResult }`.

- [ ] **Step 1: Create the route**

Create `src/app/api/marketing/niche-performance/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getPeriodRange } from '@/lib/cashflow-dates'
import { getMetaRateSchedule } from '@/lib/meta-exchange-rates'
import { PROJECT_REVENUE_EXCLUDED_STATUSES } from '@/lib/project-metrics'
import { computeNichePerformance } from '@/lib/marketing/niche-performance'

export const dynamic = 'force-dynamic'

const PERIODS = new Set(['today', 'this-week', 'this-month', 'last-7', 'last-30', 'custom'])

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const periodRaw = searchParams.get('period') ?? 'this-month'
  const period = PERIODS.has(periodRaw) ? periodRaw : 'this-month'

  try {
    let projectId = searchParams.get('projectId')
    if (!projectId) {
      const first = await prisma.project.findFirst({ where: { archivedAt: null }, orderBy: { startDate: 'desc' }, select: { id: true } })
      projectId = first?.id ?? null
    }
    if (!projectId) return NextResponse.json({ error: 'No project found' }, { status: 404 })

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, shopifyStore: { select: { ianaTimezone: true } } },
    })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const timeZone = project.shopifyStore?.ianaTimezone ?? 'UTC'
    const { from, to, fromKey, toKey } = getPeriodRange(period, timeZone, searchParams.get('from'), searchParams.get('to'))

    const [niches, overrides, accounts, schedule] = await Promise.all([
      prisma.niche.findMany({ select: { id: true, name: true, keywords: true, active: true, sortOrder: true } }),
      prisma.metaCampaignNicheOverride.findMany({ select: { campaignId: true, nicheId: true } }),
      prisma.metaAdAccount.findMany({
        where: { projectId },
        select: { id: true, accountId: true, accountName: true, currency: true },
      }),
      getMetaRateSchedule(),
    ])

    const accountIds = accounts.map(a => a.id)
    const campaignSpends = accountIds.length > 0
      ? await prisma.metaCampaignDailySpend.findMany({
          where: { adAccountId: { in: accountIds }, date: { gte: fromKey, lte: toKey } },
          select: { adAccountId: true, campaignId: true, campaignName: true, date: true, spend: true, impressions: true, clicks: true, currency: true },
        })
      : []

    const orders = await prisma.order.findMany({
      where: {
        projectId,
        placedAt: { gte: from, lte: to },
        pipelineStatus: { notIn: [...PROJECT_REVENUE_EXCLUDED_STATUSES] },
      },
      select: {
        id: true,
        refundedAmount: true,
        lines: { select: { sku: true, productTitle: true, shopifyProductType: true, unitPrice: true, qty: true } },
      },
    })

    const result = computeNichePerformance({
      period: { from: fromKey, to: toKey, timeZone },
      niches,
      overrides,
      accounts,
      campaignSpends,
      orders,
      schedule,
    })

    return NextResponse.json({ project: { id: project.id, name: project.name }, ...result })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
```

- [ ] **Step 2: Type-check and smoke-test**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean.

In the browser (logged in): open `http://localhost:3002/api/marketing/niche-performance?period=last-30`.
Expected: JSON with `project.name === 'LZ'`, `niches` containing the Jeep niche created in Task 6 with non-zero `spend` and `revenue`, and `unassigned.campaigns` listing Honey Bear / PoMo / Stwa campaigns (until those niches are created).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/marketing/niche-performance/route.ts
git commit -m "feat(marketing): niche performance data route

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Permission and sidebar entry

**Files:**
- Modify: `src/lib/roles.ts` (`FeaturePermission` union ~L2-23, `FEATURE_LABELS` ~L32, `FEATURE_GROUPS` ~L56, `DEFAULT_ROLE_PERMISSIONS.ADMIN` ~L79, `FEATURE_PATHS` ~L113)
- Modify: `src/components/Sidebar.tsx:13-48`

**Interfaces:**
- Produces permission literal `'marketing_niche'` mapped to path `/marketing/niche-performance`.

- [ ] **Step 1: Add the permission in `roles.ts`**

In the `FeaturePermission` union, after `| 'projects'` add:

```ts
  | 'marketing_niche'
```

In `FEATURE_LABELS`, after `projects: 'Project Management',` add:

```ts
  marketing_niche: 'Niche Performance',
```

In `FEATURE_GROUPS`, after the `{ label: 'Project Management', permissions: ['projects'] },` entry add:

```ts
  { label: 'Marketing', permissions: ['marketing_niche'] },
```

In `DEFAULT_ROLE_PERMISSIONS.ADMIN`, after `'projects',` add:

```ts
    'marketing_niche',
```

In `FEATURE_PATHS`, after `projects: ['/projects'],` add:

```ts
  marketing_niche: ['/marketing/niche-performance'],
```

- [ ] **Step 2: Add the sidebar group**

In `src/components/Sidebar.tsx`, in the `nav` array, replace

```ts
  { type: 'child', href: '/projects/seller-profit', icon: 'workspace_premium', label: 'Seller Profit', superAdminOnly: true },
  { type: 'divider' },
  { type: 'group', label: 'Finance' },
```

with

```ts
  { type: 'child', href: '/projects/seller-profit', icon: 'workspace_premium', label: 'Seller Profit', superAdminOnly: true },
  { type: 'divider' },
  { type: 'group', label: 'Marketing' },
  { type: 'child', href: '/marketing/niche-performance', icon: 'insights', label: 'Niche Performance' },
  { type: 'divider' },
  { type: 'group', label: 'Finance' },
```

- [ ] **Step 3: Type-check and run tests**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: tsc clean (the `Record<FeaturePermission, …>` maps all include the new key); vitest green except the 2 known failures.

- [ ] **Step 4: Commit**

```bash
git add src/lib/roles.ts src/components/Sidebar.tsx
git commit -m "feat(marketing): marketing_niche permission and sidebar group

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Shared formatters, CampaignTable, and NicheManagerPanel components

**Files:**
- Create: `src/components/marketing/format.ts`
- Create: `src/components/marketing/CampaignTable.tsx`
- Create: `src/components/marketing/NicheManagerPanel.tsx`

**Interfaces:**
- `format.ts` exports `fmtUsd(n)`, `fmtMoney(n, currency)`, `fmtRoas(n | null)`, `fmtPct(n | null)`, `fmtInt(n)`, `fmtDate(key: string | null)`, `roasTone(n | null)`.
- `CampaignTable` props: `{ campaigns: CampaignRow[]; niches?: Array<{ id: string; name: string }>; onAssign?: (campaignId: string, nicheId: string) => Promise<void> }`. When `niches` and `onAssign` are given, each row shows a niche `<select>`.
- `NicheManagerPanel` props: `{ open: boolean; onClose: () => void; onChanged: () => void }`. Owns its own fetches to `/api/marketing/niches`.
- `CampaignRow` type is re-declared locally in the page (Task 10) and imported here from `@/lib/marketing/niche-performance` (type-only import is safe in a client component).

- [ ] **Step 1: Create the formatters**

Create `src/components/marketing/format.ts`:

```ts
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const int = new Intl.NumberFormat('en-US')

export function fmtUsd(n: number) {
  return usd.format(n)
}

export function fmtMoney(n: number, currency: string) {
  if (currency === 'USD') return usd.format(n)
  return `${int.format(Math.round(n))} ${currency}`
}

export function fmtRoas(n: number | null) {
  return n == null ? '—' : `${n.toFixed(2)}x`
}

export function fmtPct(n: number | null) {
  return n == null ? '—' : `${(n * 100).toFixed(2)}%`
}

export function fmtInt(n: number) {
  return int.format(n)
}

export function fmtDate(key: string | null) {
  if (!key) return '—'
  const [y, m, d] = key.split('-')
  return `${m}/${d}/${y}`
}

export function roasTone(n: number | null) {
  if (n == null) return 'text-on-surface-variant'
  if (n >= 3) return 'text-emerald-700'
  if (n >= 1.5) return 'text-amber-700'
  return 'text-error'
}
```

- [ ] **Step 2: Create `CampaignTable`**

Create `src/components/marketing/CampaignTable.tsx`:

```tsx
'use client'
import { useState } from 'react'
import type { CampaignRow } from '@/lib/marketing/niche-performance'
import { fmtUsd, fmtMoney, fmtPct, fmtInt, fmtDate } from './format'

type Props = {
  campaigns: CampaignRow[]
  niches?: Array<{ id: string; name: string }>
  onAssign?: (campaignId: string, nicheId: string) => Promise<void>
}

export default function CampaignTable({ campaigns, niches, onAssign }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const canAssign = Boolean(niches && onAssign)

  if (campaigns.length === 0) {
    return <p className="px-lg py-md text-body-sm text-on-surface-variant">Không có campaign nào trong kỳ này.</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-body-sm">
        <thead>
          <tr className="text-label-sm text-on-surface-variant uppercase tracking-wider border-b border-outline-variant/20">
            <th className="text-left px-lg py-sm font-medium">Campaign</th>
            <th className="text-left px-md py-sm font-medium">Account</th>
            <th className="text-right px-md py-sm font-medium">Spend</th>
            <th className="text-right px-md py-sm font-medium">Impr.</th>
            <th className="text-right px-md py-sm font-medium">Clicks</th>
            <th className="text-right px-md py-sm font-medium">CPM</th>
            <th className="text-right px-md py-sm font-medium">CTR</th>
            <th className="text-left px-md py-sm font-medium">Last active</th>
            {canAssign && <th className="text-left px-md py-sm font-medium">Niche</th>}
          </tr>
        </thead>
        <tbody>
          {campaigns.map(c => (
            <tr key={c.campaignId} className="border-b border-outline-variant/10 last:border-0">
              <td className="px-lg py-sm">
                <div className="flex items-center gap-xs">
                  <span className={`inline-block w-2 h-2 rounded-full ${c.isActive ? 'bg-emerald-500' : 'bg-on-surface-variant/30'}`} />
                  <span className="text-on-surface">{c.campaignName}</span>
                </div>
              </td>
              <td className="px-md py-sm text-on-surface-variant">{c.accountName ?? c.accountId}</td>
              <td className="px-md py-sm text-right">
                <div className="text-on-surface">{fmtUsd(c.spend)}</div>
                {c.currency !== 'USD' && <div className="text-label-sm text-on-surface-variant">{fmtMoney(c.spendOriginal, c.currency)}</div>}
              </td>
              <td className="px-md py-sm text-right text-on-surface-variant">{fmtInt(c.impressions)}</td>
              <td className="px-md py-sm text-right text-on-surface-variant">{fmtInt(c.clicks)}</td>
              <td className="px-md py-sm text-right text-on-surface-variant">{c.cpm == null ? '—' : fmtUsd(c.cpm)}</td>
              <td className="px-md py-sm text-right text-on-surface-variant">{fmtPct(c.ctr)}</td>
              <td className="px-md py-sm text-on-surface-variant">{fmtDate(c.lastActiveDate)}</td>
              {canAssign && (
                <td className="px-md py-sm">
                  <select
                    defaultValue=""
                    disabled={busy === c.campaignId}
                    onChange={async e => {
                      const nicheId = e.target.value
                      if (!nicheId) return
                      setBusy(c.campaignId)
                      try { await onAssign!(c.campaignId, nicheId) } finally { setBusy(null) }
                    }}
                    className="rounded-lg border border-outline-variant/30 bg-surface-container px-sm py-xs text-body-sm"
                  >
                    <option value="">Gán niche…</option>
                    {niches!.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
                  </select>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 3: Create `NicheManagerPanel`**

Create `src/components/marketing/NicheManagerPanel.tsx`:

```tsx
'use client'
import { useCallback, useEffect, useState } from 'react'

type Niche = { id: string; name: string; keywords: string; active: boolean; sortOrder: number }

function parseKw(json: string): string[] {
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.map(String) : [] } catch { return [] }
}

async function send(method: string, body: unknown) {
  const res = await fetch('/api/marketing/niches', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `${method} failed with ${res.status}`)
  return data
}

export default function NicheManagerPanel({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<Niche[]>([])
  const [name, setName] = useState('')
  const [keywords, setKeywords] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const res = await fetch('/api/marketing/niches')
    if (res.ok) setRows(await res.json())
  }, [])

  useEffect(() => { if (open) load() }, [open, load])

  const run = async (fn: () => Promise<unknown>) => {
    setError('')
    try { await fn(); await load(); onChanged() } catch (e: any) { setError(e.message) }
  }

  const add = () => run(async () => {
    if (!name.trim()) throw new Error('Nhập tên niche')
    await send('POST', { name, keywords })
    setName(''); setKeywords('')
  })

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-primary/40" onClick={onClose} />
      <aside className="w-full max-w-xl h-full overflow-y-auto bg-surface-container-lowest shadow-card border-l border-outline-variant/20 p-lg">
        <div className="flex items-center justify-between mb-lg">
          <h2 className="text-headline-sm text-primary">Quản lý niche</h2>
          <button onClick={onClose} className="material-symbols-outlined text-on-surface-variant">close</button>
        </div>

        <section className="mb-lg rounded-xl border border-outline-variant/20 bg-surface-container-low p-md">
          <div className="grid grid-cols-1 gap-sm md:grid-cols-[1fr_2fr_auto]">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Tên niche (Jeep, PoMo…)"
              className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-md py-sm text-body-md outline-none focus:border-secondary" />
            <input value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="keywords: jeep, jeep girl"
              className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-md py-sm text-body-md outline-none focus:border-secondary" />
            <button onClick={add} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Thêm</button>
          </div>
          <p className="mt-xs text-body-sm text-on-surface-variant">
            Keyword match tên campaign và tên sản phẩm, không phân biệt hoa/thường. Niche đứng trước thắng khi nhiều niche cùng match.
          </p>
        </section>

        {error && <p className="mb-md text-body-sm text-error">{error}</p>}

        <ul className="space-y-sm">
          {rows.map(r => (
            <NicheRowEditor key={r.id} row={r}
              onSave={(patch) => run(() => send('PATCH', { id: r.id, ...patch }))}
              onRemove={() => {
                if (!confirm(`Xoá niche "${r.name}"? Các campaign đã gán tay vào niche này sẽ mất gán.`)) return
                run(() => send('DELETE', { id: r.id }))
              }} />
          ))}
          {rows.length === 0 && <p className="text-body-md text-on-surface-variant">Chưa có niche nào.</p>}
        </ul>
      </aside>
    </div>
  )
}

function NicheRowEditor({ row, onSave, onRemove }: {
  row: Niche
  onSave: (patch: Partial<{ name: string; keywords: string; active: boolean; sortOrder: number }>) => void
  onRemove: () => void
}) {
  const [name, setName] = useState(row.name)
  const [kw, setKw] = useState(parseKw(row.keywords).join(', '))
  const [sortOrder, setSortOrder] = useState(String(row.sortOrder))
  const dirty = name !== row.name || kw !== parseKw(row.keywords).join(', ') || sortOrder !== String(row.sortOrder)

  return (
    <li className={`rounded-xl border border-outline-variant/20 p-md ${row.active ? 'bg-surface-container-lowest' : 'bg-surface-container opacity-70'}`}>
      <div className="flex flex-wrap items-center gap-sm">
        <input value={sortOrder} onChange={e => setSortOrder(e.target.value)} title="Thứ tự ưu tiên"
          className="w-14 rounded-lg border border-outline-variant/30 bg-surface-container px-sm py-xs text-body-sm text-center" />
        <input value={name} onChange={e => setName(e.target.value)}
          className="w-40 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-xs text-label-md font-bold text-primary" />
        <input value={kw} onChange={e => setKw(e.target.value)} placeholder="keywords"
          className="min-w-[200px] flex-1 rounded-lg border border-outline-variant/30 bg-surface-container px-md py-xs text-body-sm" />
        <button
          disabled={!dirty}
          onClick={() => onSave({ name, keywords: kw, sortOrder: Number(sortOrder) || 0 })}
          className="rounded-lg bg-secondary px-md py-xs text-label-sm text-on-secondary disabled:opacity-40">Lưu</button>
        <button onClick={() => onSave({ active: !row.active })} className="rounded-lg bg-surface-container px-md py-xs text-label-sm">
          {row.active ? 'Tắt' : 'Bật'}
        </button>
        <button onClick={onRemove} className="text-error text-label-sm hover:underline">Xoá</button>
      </div>
    </li>
  )
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/marketing/format.ts src/components/marketing/CampaignTable.tsx src/components/marketing/NicheManagerPanel.tsx
git commit -m "feat(marketing): CampaignTable and NicheManagerPanel components

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Niche Performance page

**Files:**
- Create: `src/app/marketing/niche-performance/page.tsx`

**Interfaces:**
- Consumes `GET /api/marketing/niche-performance` (Task 7), `POST /api/meta/sync-campaign-insights` (Task 4), `PUT /api/marketing/campaign-overrides` (Task 6), components from Task 9.

- [ ] **Step 1: Create the page**

Create `src/app/marketing/niche-performance/page.tsx`:

```tsx
'use client'
import { useCallback, useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import CampaignTable from '@/components/marketing/CampaignTable'
import NicheManagerPanel from '@/components/marketing/NicheManagerPanel'
import { fmtUsd, fmtRoas, fmtInt, roasTone } from '@/components/marketing/format'
import type { NichePerformanceResult } from '@/lib/marketing/niche-performance'

type Data = NichePerformanceResult & { project: { id: string; name: string } }
type Project = { id: string; name: string; archivedAt?: string | null }

const PERIODS = [
  { key: 'today', label: 'Hôm nay' },
  { key: 'this-week', label: 'Tuần này' },
  { key: 'this-month', label: 'Tháng này' },
  { key: 'last-7', label: '7 ngày' },
  { key: 'last-30', label: '30 ngày' },
  { key: 'custom', label: 'Tuỳ chọn' },
]

export default function NichePerformancePage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [period, setPeriod] = useState('this-month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showManager, setShowManager] = useState(false)

  useEffect(() => {
    fetch('/api/projects').then(r => r.json()).then(d => {
      const list: Project[] = (Array.isArray(d) ? d : (d.projects ?? [])).filter((p: Project) => !p.archivedAt)
      setProjects(list)
      if (list.length > 0 && !projectId) setProjectId(list[0].id)
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!projectId) return
    if (period === 'custom' && (!from || !to)) return
    setLoading(true); setError('')
    const params = new URLSearchParams({ projectId, period })
    if (period === 'custom') { params.set('from', from); params.set('to', to) }
    try {
      const res = await fetch(`/api/marketing/niche-performance?${params}`)
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setData(body)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [projectId, period, from, to])

  useEffect(() => { load() }, [load])

  const syncCampaigns = async () => {
    setSyncing(true); setMessage('Đang sync campaign insights…')
    try {
      const res = await fetch('/api/meta/sync-campaign-insights', { method: 'POST' })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      const errs = Array.isArray(body.errors) && body.errors.length ? ` Lỗi: ${body.errors.join('; ')}` : ''
      setMessage(`Sync xong: ${body.synced} dòng campaign/ngày trên ${body.accounts} account.${errs}`)
      await load()
    } catch (e: any) {
      setMessage(`Lỗi sync: ${e.message}`)
    } finally {
      setSyncing(false)
    }
  }

  const assign = async (campaignId: string, nicheId: string) => {
    const res = await fetch('/api/marketing/campaign-overrides', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId, nicheId }),
    })
    if (!res.ok) { const b = await res.json().catch(() => ({})); setMessage(`Lỗi gán niche: ${b.error ?? res.status}`); return }
    await load()
  }

  const toggle = (id: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const nicheOptions = data?.niches.map(n => ({ id: n.nicheId, name: n.name })) ?? []
  const showUnassigned = Boolean(data && (data.unassigned.spend > 0 || data.unassigned.revenue > 0 || data.unassigned.campaigns.length > 0))

  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 w-full lg:w-[calc(100vw-280px)] min-w-0 overflow-x-hidden p-xl">
          <div className="flex items-start justify-between mb-lg gap-md flex-wrap">
            <div>
              <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Marketing</p>
              <h1 className="text-display-md text-primary">Niche Performance</h1>
              <p className="text-on-surface-variant text-body-md mt-xs">Meta spend theo campaign vs doanh thu Shopify theo niche</p>
            </div>
            <div className="flex items-center gap-xs flex-wrap">
              {projects.length > 1 && (
                <select value={projectId} onChange={e => setProjectId(e.target.value)}
                  className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-md py-sm text-body-sm">
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
              <button onClick={syncCampaigns} disabled={syncing}
                className="bg-surface-container-lowest text-on-surface border border-outline-variant/40 px-lg py-sm rounded-lg text-label-md disabled:opacity-50 flex items-center gap-xs hover:bg-surface-container">
                <span className={`material-symbols-outlined text-[18px] ${syncing ? 'animate-spin' : ''}`}>sync</span>
                {syncing ? 'Syncing…' : 'Sync campaign'}
              </button>
              <button onClick={() => setShowManager(true)}
                className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md flex items-center gap-xs">
                <span className="material-symbols-outlined text-[18px]">tune</span>
                Quản lý niche
              </button>
            </div>
          </div>

          <div className="flex items-center gap-xs flex-wrap mb-lg">
            {PERIODS.map(p => (
              <button key={p.key} onClick={() => setPeriod(p.key)}
                className={`px-md py-xs rounded-lg text-label-sm font-semibold transition-all ${
                  period === p.key ? 'bg-secondary text-on-secondary' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                }`}>
                {p.label}
              </button>
            ))}
            {period === 'custom' && (
              <>
                <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                  className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-md py-xs text-body-sm" />
                <span className="text-on-surface-variant text-body-sm">→</span>
                <input type="date" value={to} onChange={e => setTo(e.target.value)}
                  className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-md py-xs text-body-sm" />
              </>
            )}
            {data && (
              <span className="ml-auto text-label-sm text-on-surface-variant">
                {data.period.from.replace(/(\d{4})-(\d{2})-(\d{2})/, '$2/$3/$1')} – {data.period.to.replace(/(\d{4})-(\d{2})-(\d{2})/, '$2/$3/$1')} · {data.period.timeZone}
              </span>
            )}
          </div>

          {message && <p className="mb-md text-body-sm text-on-surface-variant">{message}</p>}
          {error && <p className="mb-md text-body-sm text-error">{error}</p>}

          {data && data.missingExchangeRateAccounts.length > 0 && (
            <div className="mb-lg rounded-xl border border-amber-300 bg-amber-50 px-lg py-md text-body-sm text-amber-900 flex items-center gap-sm">
              <span className="material-symbols-outlined text-[18px]">warning</span>
              Thiếu tỷ giá cho {data.missingExchangeRateAccounts.map(a => `${a.accountName ?? a.accountId} (${a.currency})`).join(', ')} — spend các account này đang tính 0.
              <a href="/setup/meta-rates" className="underline ml-auto">Cập nhật tỷ giá</a>
            </div>
          )}

          {loading && !data && (
            <div className="flex items-center justify-center py-xl">
              <span className="material-symbols-outlined animate-spin text-secondary">sync</span>
            </div>
          )}

          {data && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-md mb-lg">
                <StatCard label="Total Spend" value={fmtUsd(data.totals.spend)} />
                <StatCard label="Total Revenue" value={fmtUsd(data.totals.revenue)} />
                <StatCard label="ROAS" value={fmtRoas(data.totals.roas)} tone={roasTone(data.totals.roas)} />
                <StatCard label="Orders" value={fmtInt(data.totals.orders)} />
              </div>

              <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
                <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                  <span className="material-symbols-outlined text-secondary">insights</span>
                  <h3 className="text-headline-sm text-primary">Theo niche</h3>
                  <span className="text-label-sm text-on-surface-variant">bấm vào niche để xem campaign</span>
                  {loading && <span className="material-symbols-outlined animate-spin text-secondary text-[18px] ml-auto">sync</span>}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-body-sm">
                    <thead>
                      <tr className="text-label-sm text-on-surface-variant uppercase tracking-wider border-b border-outline-variant/20">
                        <th className="text-left px-lg py-sm font-medium">Niche</th>
                        <th className="text-right px-md py-sm font-medium">Spend</th>
                        <th className="text-right px-md py-sm font-medium">Revenue</th>
                        <th className="text-right px-md py-sm font-medium">ROAS</th>
                        <th className="text-right px-md py-sm font-medium">Orders</th>
                        <th className="text-right px-md py-sm font-medium">AOV</th>
                        <th className="text-right px-lg py-sm font-medium">Campaigns</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.niches.map(n => (
                        <NicheRows key={n.nicheId} open={expanded.has(n.nicheId)} onToggle={() => toggle(n.nicheId)}
                          name={n.name} spend={n.spend} revenue={n.revenue} roas={n.roas} orders={n.orders} aov={n.aov}
                          campaignsLabel={`${n.activeCampaignCount}/${n.campaignCount}`}>
                          <CampaignTable campaigns={n.campaigns} />
                        </NicheRows>
                      ))}
                      {showUnassigned && (
                        <NicheRows open={expanded.has('__unassigned')} onToggle={() => toggle('__unassigned')}
                          name="Chưa gán" muted spend={data.unassigned.spend} revenue={data.unassigned.revenue}
                          roas={null} orders={null} aov={null}
                          campaignsLabel={String(data.unassigned.campaigns.length)}
                          revenueTitle="Doanh thu từ sản phẩm không match keyword niche nào">
                          <CampaignTable campaigns={data.unassigned.campaigns} niches={nicheOptions} onAssign={assign} />
                        </NicheRows>
                      )}
                      {data.niches.length === 0 && !showUnassigned && (
                        <tr><td colSpan={7} className="px-lg py-xl text-center text-on-surface-variant">
                          Chưa có niche. Bấm &quot;Quản lý niche&quot; để thêm, rồi &quot;Sync campaign&quot; để lấy dữ liệu.
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      <NicheManagerPanel open={showManager} onClose={() => setShowManager(false)} onChanged={load} />
    </RoleGate>
  )
}

function StatCard({ label, value, tone = 'text-primary' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-lg">
      <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">{label}</p>
      <p className={`text-stats-lg font-bold ${tone}`}>{value}</p>
    </div>
  )
}

function NicheRows({ open, onToggle, name, muted, spend, revenue, roas, orders, aov, campaignsLabel, revenueTitle, children }: {
  open: boolean
  onToggle: () => void
  name: string
  muted?: boolean
  spend: number
  revenue: number
  roas: number | null
  orders: number | null
  aov: number | null
  campaignsLabel: string
  revenueTitle?: string
  children: React.ReactNode
}) {
  return (
    <>
      <tr onClick={onToggle} className={`cursor-pointer border-b border-outline-variant/10 hover:bg-surface-container-low ${muted ? 'text-on-surface-variant' : ''}`}>
        <td className="px-lg py-md">
          <div className="flex items-center gap-xs">
            <span className="material-symbols-outlined text-[18px] text-on-surface-variant">{open ? 'expand_more' : 'chevron_right'}</span>
            <span className={`text-label-md ${muted ? '' : 'font-bold text-primary'}`}>{name}</span>
          </div>
        </td>
        <td className="px-md py-md text-right">{fmtUsd(spend)}</td>
        <td className="px-md py-md text-right" title={revenueTitle}>{fmtUsd(revenue)}</td>
        <td className={`px-md py-md text-right font-bold ${roasTone(roas)}`}>{fmtRoas(roas)}</td>
        <td className="px-md py-md text-right">{orders == null ? '—' : fmtInt(orders)}</td>
        <td className="px-md py-md text-right">{aov == null ? '—' : fmtUsd(aov)}</td>
        <td className="px-lg py-md text-right">{campaignsLabel}</td>
      </tr>
      {open && (
        <tr className="bg-surface-container-low/60">
          <td colSpan={7} className="p-0">{children}</td>
        </tr>
      )}
    </>
  )
}
```

- [ ] **Step 2: Type-check and lint**

Run: `npx tsc --noEmit -p tsconfig.json && npx next lint --dir src/app/marketing --dir src/components/marketing`
Expected: clean.

- [ ] **Step 3: Manual verification in the browser**

With the dev server running, log in as SUPERADMIN and open `http://localhost:3002/marketing/niche-performance`.

1. Sidebar shows a "Marketing" group with "Niche Performance" between Project Management and Finance.
2. Click "Quản lý niche" and create: `Jeep` (keywords `jeep`), `Honey Bear` (`honey bear`), `PoMo` (`pomo`), `Stwa` (`stwa, stw`). Close the panel; the table refreshes.
3. Click "Sync campaign"; the message reports rows synced with no errors.
4. Select "30 ngày". Expected: four niche rows with non-zero spend and revenue; ROAS coloured; totals card matches the sum of the rows plus "Chưa gán".
5. Expand "Jeep": campaigns listed with spend in USD and the VND amount underneath for Remi08; active campaigns have a green dot.
6. Expand "Chưa gán": revenue should be small (only titles without any niche word). If a real campaign appears there, use the dropdown to assign it; the row moves into the niche after refresh.
7. Toggle a niche off in the panel: its campaigns and revenue move to "Chưa gán".
8. Log in as a SELLER (or a user without `marketing_niche`): the page shows "No Access" and the nav item is hidden.

- [ ] **Step 4: Commit**

```bash
git add src/app/marketing/niche-performance/page.tsx
git commit -m "feat(marketing): Niche Performance dashboard page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Docs

**Files:**
- Modify: `NOTES.md`
- Modify: `PLAN.md`

- [ ] **Step 1: Add a section to `NOTES.md`**

Append under the current-state notes:

```markdown
## Niche Performance (Marketing) — 2026-09-06
- Page `/marketing/niche-performance`, permission `marketing_niche` (SUPERADMIN + ADMIN by default).
- Campaign spend comes from `MetaCampaignDailySpend` (Meta insights `level=campaign`), synced by `syncMetaCampaignInsights()` right after the account-level sync in `runAutoSync` and the 01:00 America/Denver cron. Manual: `POST /api/meta/sync-campaign-insights?days=30`.
- Niche = `Niche` table (name + JSON keywords). Campaign → niche by keyword on `campaignName` (override table `MetaCampaignNicheOverride` wins); order line → niche by keyword on `productTitle`, computed at query time (no column on OrderLine).
- Spend converted to USD with the dated rate schedule; no 3% FX fee added. Revenue = line price × qty minus pro-rata order refund; excludes non-product lines and REFUNDED/CANCELLED pipeline statuses.
- Aggregation logic is pure: `src/lib/marketing/niche-performance.ts` (tested).
```

- [ ] **Step 2: Add the feature to `PLAN.md`**

In the "done" section of `PLAN.md` add a line:

```markdown
- [x] Niche Performance dashboard (campaign-level Meta spend vs Shopify revenue per niche) — spec `docs/superpowers/specs/2026-09-06-niche-performance-design.md`
```

and under future work:

```markdown
- [ ] Niche Performance: product-type layer inside a niche, per-niche profit (COGS), daily trend chart
```

- [ ] **Step 3: Commit**

```bash
git add NOTES.md PLAN.md
git commit -m "docs: Niche Performance notes and plan status

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** Schema (Task 1), campaign sync + scheduling + route (Tasks 3–4), aggregation rules (Task 5: overrides, first-match by sortOrder, inactive niches, pro-rata refund, non-product exclusion, VND conversion, missing rate, zero-spend campaign, isActive/lastActiveDate, sort order, totals), period presets incl. last-7/last-30 (Task 2), niche CRUD + override API (Task 6), data route with project/timezone resolution (Task 7), permission + sidebar (Task 8), UI header/period/sync/manage, warning strip, stat cards, niche table with ROAS tone, campaign sub-table with VND original, unassigned row with assign dropdown, manager panel with delete warning (Tasks 9–10), docs (Task 11). Error handling: 404 no project, per-account sync errors surfaced in the message line, missing rate degrades to 0 + warning, empty keywords match nothing (`nicheMatches` returns false on empty list).

**Deviation from spec, made explicit:** revenue exclusion uses `pipelineStatus notIn PROJECT_REVENUE_EXCLUDED_STATUSES` (the repo's existing convention in `profit-chart`), not `financialStatus`. `totals.orders` counts every order in the period with at least one product line, not only matched orders.

**Type consistency.** `CampaignRow`/`NicheRow`/`NichePerformanceResult` are defined once in Task 5 and imported (type-only) by Tasks 9–10. `SyncMetaInsightsResult` from Task 3 is what Task 4's route spreads. `getPeriodRange` signature in Task 2 matches its use in Task 7. Override API field names (`campaignId`, `nicheId`) match the page's `assign` call.
