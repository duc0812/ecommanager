# Niche Performance Dashboard — Design

**Date:** 2026-09-06
**Status:** Approved (brainstorm complete)
**Module:** Marketing analytics (new sidebar group "Marketing")

## Goal

Show, per product niche (Jeep, Honey Bear, PoMo, Stwa, …), how much Meta ad spend went in versus how much Shopify revenue came out, so the owner can see which niches are healthy and which are not. Scope is ROAS-level only: spend, revenue, ROAS, order count, AOV, plus the list of campaigns behind each niche. Profit/COGS and product-type sub-breakdown are explicitly out of scope for this iteration.

## Findings that shaped the design

- Meta insights are currently synced at `level=account` only (`DailyAdSpend`). No campaign-level data exists in the DB. The per-account access tokens already have enough permission; only the query and storage are missing.
- A live probe (last 7 days) showed all active spend on account Remi08 (VND). Campaign names contain the niche in free-form text: `Remi04 honey bear collection video 9/6`, `JEEP-(MUG)-Best-selling Jeep mug collection-CBO-5/9`, `Remi04 Pomo New Arrival Collection 27/5`, `Remi 04 STW jersay 16/5`, `Remi04 Stwa Personalized Collection 5/6`. Case-insensitive keyword matching covers all of them.
- Order lines carry the niche as a prefix/word in `OrderLine.productTitle` (`DSNY Honey Bear …`, `PoMo Celebrate …`, `Stwa Galazy Star …`, `Jeep Girl …`). Keyword matching on titles covered ~95% of 60-day revenue; the remainder was non-product lines (`Custom Text`, `Tip`, `Shipping protection`) which are excluded anyway.
- `shopifyProductType` is a garment taxonomy and is inconsistent, so it is not used for niche assignment.
- There is one project (LZ) with three ad accounts serving all niches, so project/account cannot be used to derive niche.

## Decisions

| Question | Decision |
|---|---|
| Metrics depth | ROAS only (spend, revenue, ROAS, orders, AOV). No COGS/profit. |
| Hierarchy | Niche → Campaign. No product-type layer. |
| Campaign spend source | Synced into DB (`MetaCampaignDailySpend`), not queried live. |
| Order line niche | Computed at query time by keyword match. Not stored on `OrderLine`. Keyword edits apply retroactively with no backfill. |
| Spend currency | Converted to USD per day via the existing dated rate schedule (`convertMetaAmountToUsdDated`). The 3% FX card fee is not added, to stay on the same basis as Meta Ads Manager. |
| Revenue basis | `unitPrice × qty` of product lines, minus the order's `refundedAmount` allocated pro-rata across its product lines. Shopify fees not deducted. |
| Unmatched campaigns | Shown in an "Unassigned" bucket with a per-campaign dropdown that writes a manual override. Override beats keyword. |
| Unmatched revenue | Shown as an "Unassigned" revenue figure so missing keywords are visible. |

## 1. Schema

Three new models in `prisma/schema.prisma`, one migration (`add_niche_performance`), then bump `SCHEMA_VERSION` in `src/lib/db.ts`.

```prisma
model Niche {
  id        String   @id @default(cuid())
  name      String   @unique
  keywords  String   @default("[]")   // JSON string[]; matched case-insensitively on campaign names and product titles
  active    Boolean  @default(true)
  sortOrder Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  overrides MetaCampaignNicheOverride[]
}

model MetaCampaignDailySpend {
  id           String        @id @default(cuid())
  adAccountId  String
  adAccount    MetaAdAccount @relation(fields: [adAccountId], references: [id], onDelete: Cascade)
  campaignId   String
  campaignName String
  date         String        // YYYY-MM-DD, Meta account timezone (same convention as DailyAdSpend)
  spend        Float         @default(0)
  impressions  Int           @default(0)
  clicks       Int           @default(0)
  currency     String        @default("USD")
  fetchedAt    DateTime      @default(now())
  @@unique([adAccountId, campaignId, date])
  @@index([date])
  @@index([campaignId])
}

model MetaCampaignNicheOverride {
  campaignId String   @id
  nicheId    String
  niche      Niche    @relation(fields: [nicheId], references: [id], onDelete: Cascade)
  createdAt  DateTime @default(now())
}
```

`MetaAdAccount` gains `campaignDailySpends MetaCampaignDailySpend[]`.

`Niche` is deliberately separate from `SpyNiche` (competitor research) even though the shape is similar. The pure helpers in `src/lib/spy/niche.ts` (`parseKeywords`, `nicheMatches`) are reused, not duplicated.

Initial niches (Jeep, Honey Bear, PoMo, Stwa) are entered through the UI, not seeded in code.

## 2. Campaign insights sync

New export `syncMetaCampaignInsights(options)` in `src/lib/sync-meta-insights.ts`, taking the same `SyncMetaInsightsOptions` and returning the same result shape as `syncMetaInsights`. To avoid copy-pasting the 100-line loop, the shared parts (window resolution, paging fetch, error collection) are extracted into an internal helper parameterised by `level`, `fields`, the "last stored date" lookup and the upsert callback. `syncMetaInsights` keeps its public behaviour and existing tests.

Differences for campaign level:

- URL params: `level=campaign`, `fields=campaign_id,campaign_name,spend,impressions,clicks`, `time_increment=1`.
- Incremental window: from the latest `MetaCampaignDailySpend.date` for the account (or `META_INSIGHTS_FIRST_SYNC_SINCE` / 730 days on first run) to today.
- Upsert on `[adAccountId, campaignId, date]`, always overwriting `campaignName` with the latest value.
- Respects `isMetaBillingSyncWorkerActive()` exactly like the account sync.

Scheduling in `src/lib/auto-sync.ts`: call `syncMetaCampaignInsights()` immediately after `syncMetaInsights()` in the full-sync path, and `syncMetaCampaignInsights(2)` after `syncMetaInsights(2)` in the 01:00 America/Denver cron.

Manual trigger: `POST /api/meta/sync-campaign-insights` mirroring `src/app/api/meta/sync-insights/route.ts` (same params `days`, `since`, `until`, `accountId`, `fromProjectStart`; same ADMIN/SUPERADMIN gate).

Sanity check after first sync: total campaign spend per account per day must match `DailyAdSpend` for the same day (Meta reports both from the same delivery data).

## 3. Aggregation API

`GET /api/marketing/niche-performance`

Query params: `period` = `today | this-week | this-month | last-7 | last-30 | custom` (default `this-month`), `from`, `to` (YYYY-MM-DD, used with `custom`), `projectId` (optional; defaults to the first non-archived project).

The route resolves the project's store timezone, builds the date range with `dateKeyInZone` / `zonedDayStartUtc` / `addDays` from `src/lib/cashflow-dates.ts` (the same period logic as `profit-chart`, moved into a shared helper `getPeriodRange` in `src/lib/cashflow-dates.ts` so both routes use one copy), then loads:

- active `Niche` rows,
- `MetaCampaignNicheOverride` rows,
- `MetaCampaignDailySpend` rows for the project's ad accounts with `date` between `fromKey` and `toKey`, joined to account name/currency,
- the dated exchange-rate schedule (`getMetaRateSchedule`),
- `Order` rows for the project with `placedAt` in range and `financialStatus` not in `PROJECT_REVENUE_EXCLUDED_STATUSES`, selecting `id, refundedAmount` and `lines { productTitle, shopifyProductType, sku, unitPrice, qty }`.

It then calls the pure function and returns its result.

### `computeNichePerformance(input)` — `src/lib/marketing/niche-performance.ts`

No Prisma imports. Input types mirror the selects above. Rules:

**Campaign → niche.** For each distinct `campaignId`: if an override exists, use it; else the first active niche (by `sortOrder`) whose keywords match `campaignName` case-insensitively; else `unassigned`.

**Spend.** Each daily row is converted with `convertMetaAmountToUsdDated(spend, currency ?? accountCurrency, date, schedule)`. A `null` result means a missing VND rate: the row contributes 0 and the account is added to `missingExchangeRateAccounts`. Per campaign the function also keeps `spendOriginal` (sum in the account currency) and `currency` for display.

**Order line → niche.** Only `productLinesOnly(lines)` are considered. Line revenue = `unitPrice × qty`. Order refund is allocated pro-rata: `lineRefund = refundedAmount × lineRevenue / sum(lineRevenue of product lines)`; net line revenue = `lineRevenue − lineRefund`, floored at 0. Niche assignment uses the same first-match rule on `productTitle`. Unmatched lines go to `unassigned.revenue`.

**Orders.** Per niche, count of distinct orders with at least one line in that niche. `aov = revenue / orders` (0 when no orders).

**Derived.** `roas = spend > 0 ? revenue / spend : null`. Per campaign: `cpm = impressions > 0 ? spend / impressions × 1000 : null`, `ctr = impressions > 0 ? clicks / impressions : null`, `lastActiveDate` = max date with `spend > 0`, `isActive` = `lastActiveDate` within the last 3 days of the range end. Niche `activeCampaignCount` counts `isActive` campaigns.

**Sorting.** Niches sorted by `spend` descending; campaigns within a niche by `spend` descending. Totals are summed from unrounded values; rounding only happens in the UI.

Response shape:

```ts
type NichePerformanceResult = {
  period: { from: string; to: string; timeZone: string }
  totals: { spend: number; revenue: number; roas: number | null; orders: number }
  niches: Array<{
    nicheId: string; name: string
    spend: number; revenue: number; roas: number | null; orders: number; aov: number
    campaignCount: number; activeCampaignCount: number
    campaigns: CampaignRow[]
  }>
  unassigned: { spend: number; revenue: number; campaigns: CampaignRow[] }
  missingExchangeRateAccounts: Array<{ accountId: string; accountName: string | null; currency: string }>
}

type CampaignRow = {
  campaignId: string; campaignName: string
  accountId: string; accountName: string | null
  spend: number; spendOriginal: number; currency: string
  impressions: number; clicks: number
  cpm: number | null; ctr: number | null
  lastActiveDate: string | null; isActive: boolean
}
```

### Niche CRUD API

`src/app/api/marketing/niches/route.ts` — `GET` (list, ordered by `sortOrder, name`), `POST` (create; accepts `keywords` as array or comma/newline string, normalised like `src/app/api/spy/niches/route.ts`), `PATCH` (update name/keywords/active/sortOrder by id), `DELETE` (by id; overrides cascade). Name uniqueness errors return 409.

### Override API

`src/app/api/marketing/campaign-overrides/route.ts` — `PUT { campaignId, nicheId }` upserts; `DELETE { campaignId }` removes. Both ADMIN/SUPERADMIN.

## 4. UI

Page `src/app/marketing/niche-performance/page.tsx` (`'use client'`, `<RoleGate>`, `<Sidebar/>`, standard layout wrapper).

Sidebar: new `{ type: 'group', label: 'Marketing' }` placed between "Project Management" and "Finance", with one child `{ href: '/marketing/niche-performance', icon: 'insights', label: 'Niche Performance' }`.

Roles (`src/lib/roles.ts`): new permission `marketing_niche` added to `FeaturePermission`, `FEATURE_LABELS` ("Niche Performance"), a new `FEATURE_GROUPS` bucket "Marketing", `DEFAULT_ROLE_PERMISSIONS` for SUPERADMIN and ADMIN, and `FEATURE_PATHS: ['/marketing/niche-performance']`.

Layout, top to bottom:

1. **Header row** — page title; period selector (Today / This week / This month / Last 7 / Last 30 / Custom with two date inputs); "Sync campaign" button calling `POST /api/meta/sync-campaign-insights` then refetching; "Manage niches" button opening the panel.
2. **Warning strip** — shown only when `missingExchangeRateAccounts` is non-empty, linking to `/setup/meta-rates`.
3. **Stat cards (4)** — Total Spend (USD), Total Revenue, ROAS, Orders.
4. **Niche table** — columns: Niche | Spend | Revenue | ROAS | Orders | AOV | Campaigns (`active/total`). ROAS cell coloured by threshold: ≥ 3 green, 1.5–3 amber, < 1.5 red, `—` when no spend. Clicking a row toggles an inline **campaign sub-table**: Campaign | Account | Spend (USD, with original VND amount underneath when currency ≠ USD) | Impressions | Clicks | CPM | CTR | Last active. Active campaigns get a small green dot.
5. **Unassigned row** — last row of the table, always visible when it has spend or revenue. Expanded view lists unassigned campaigns, each with a niche `<select>` that writes an override on change and refetches. Its revenue figure carries a tooltip "Product titles that matched no niche keyword".
6. **Manage niches panel** — slide-over on the same page: list of niches with name, keywords (comma-separated input), active toggle, sort order, delete. Save calls the CRUD API and refetches the dashboard. Deleting a niche warns that its overrides are removed.

Number formatting: USD with 2 decimals, VND with no decimals, ROAS with 2 decimals, CTR as percent with 2 decimals, dates in `en-US` (MM/DD/YYYY). No chart library.

## 5. Error handling

- Missing project or store timezone → 404 / 400 from the API with a message; the page shows an empty state.
- Campaign sync errors are returned per account in `errors[]` (existing pattern) and displayed in a toast-like line under the header.
- Missing exchange rate never throws; it degrades to 0 spend for the affected rows plus the warning strip.
- Keyword lists that are empty match nothing (never everything).

## 6. Testing

Unit tests (vitest) for `computeNichePerformance` in `src/lib/marketing/niche-performance.test.ts`:

- case-insensitive keyword match on campaign name and product title,
- override beats keyword and applies even when the name matches another niche,
- first active niche wins when two niches' keywords both match,
- inactive niche is ignored (its campaigns/lines go to unassigned),
- mixed-niche order: refund allocated pro-rata, distinct order counted once per niche,
- non-product lines (Tip, Shipping protection, Custom Text) excluded,
- VND rows converted with the dated schedule; missing rate → 0 spend + account listed,
- campaign with impressions but zero spend still appears with `spend: 0`,
- `isActive` / `lastActiveDate` derivation,
- totals equal the sum of niche + unassigned values.

Unit test for the campaign sync helper: mock `fetch` returning two pages of campaign rows and assert the upsert payloads (follows the existing insights sync test if one exists; otherwise a small new test with a mocked prisma).

Unit test for `getPeriodRange` after it moves to `cashflow-dates.ts` (`last-7`, `last-30`, week start on Monday, custom).

Manual verification before shipping:

1. Run migration, restart dev server.
2. Create the four niches in the panel.
3. Sync campaigns for 30 days; compare per-day campaign totals against `DailyAdSpend` for Remi08.
4. Open the dashboard on "Last 30" and confirm the unassigned revenue is only non-product noise.

## Out of scope (future)

- Product-type layer inside a niche.
- Profit/COGS per niche.
- Ad-set or ad-level breakdown.
- Per-niche daily trend chart.
