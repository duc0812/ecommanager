# Ecom Manager — Processing Notes

## Current Phase: Phase 6 Complete → Phase 13 Brainstorming (Fulfillment & POD)

Last updated: 2026-05-19

---

## 🔥 Active Work — Phase 13 Fulfillment & POD (BRAINSTORMING)

**Spec location:** [docs/superpowers/specs/2026-05-19-fulfillment-pod-design.md](docs/superpowers/specs/2026-05-19-fulfillment-pod-design.md) (all 9 sections drafted)

**Plan 1 location:** [docs/superpowers/plans/2026-05-19-fulfillment-pod-phase1-foundation-sync.md](docs/superpowers/plans/2026-05-19-fulfillment-pod-phase1-foundation-sync.md) — DONE. Phase 13.1+13.2 shipped.

**Plan 2 location:** [docs/superpowers/plans/2026-05-19-fulfillment-pod-phase2-supplier-csv-export.md](docs/superpowers/plans/2026-05-19-fulfillment-pod-phase2-supplier-csv-export.md) — DONE. Phase 13.3+13.4+13.5 shipped (Supplier UI, Product mapping, CSV templates, Export).

**Plan 3:** Not yet written — will cover Phase 13.6+13.7 (Pipeline Kanban + Alert panel + Project P&L integration).

**Multi-tenancy architecture (decided 2026-05-19 round 2):**
- 1 Shopify store = 1 Project (`ShopifyStore.projectId UNIQUE`)
- Suppliers + SupplierProduct + CsvTemplate + Staff = SHARED (global, no projectId)
- Order, OrderLine = project-scoped (`projectId` required)
- Soft delete via `Project.archivedAt` (no hard delete)
- Repository pattern: routes go through `src/lib/repos/<domain>.ts`, never `prisma` directly. Cross-domain JOIN only in `repos/reports.ts`.
- Single SQLite DB (not multi-DB file) — chosen because cross-domain reports (P&L per project = orders + ad spend + staff cost) need JOIN.

**Git:** Initialized 2026-05-19, baseline commit `b8ce2d9`.

**Where we are:** ✅ Plan 1 + Plan 2 + Plan 3 COMPLETE — full Fulfillment & POD module shipped. 34 tests pass.

**What works now (full E2E):**
- Multi-tenant Shopify order sync (1 store = 1 project) with paginated, fees-aware, idempotent GraphQL
- 11-state pipeline taxonomy with auto-detect: REFUNDED/CANCELLED from Shopify, PENDING_DESIGN if unmapped SKU OR `requiresDesign` flag, else PENDING. Manual statuses preserved across re-sync.
- Supplier CRUD + SKU mapping + cost history + custom-design flag (`requiresDesign`)
- CSV template builder with live preview + Export Center (date range, supplier, template, preview, download, mark exported)
- Tab-based `/orders` UI (Printful-style): All + 11 status tabs with counts, search, More Filters panel, status dropdown per row, bulk action bar
- Combined Project P&L: Fulfillment Profit − Meta Ad Spend − Staff Cost = Net Profit per project, visible on `/projects`

**Plans status:**
- [Plan 1](docs/superpowers/plans/2026-05-19-fulfillment-pod-phase1-foundation-sync.md) — DONE
- [Plan 2](docs/superpowers/plans/2026-05-19-fulfillment-pod-phase2-supplier-csv-export.md) — DONE
- [Plan 3](docs/superpowers/plans/2026-05-19-fulfillment-pod-phase3-pipeline-statuses-pl.md) — DONE

**Deferred to future plans:**
- Printful API auto-sync of cost + fulfillment status
- Printify API auto-sync
- Webhook-based realtime (currently polling + manual Sync Now)
- Email digest / daily report
- Pipeline Kanban view (chose tab-based list instead — simpler, scales better)
- Bulk product mapping import from Printful catalog

**Key decisions locked-in (full detail in spec Section 2):**
- Polling Shopify Orders API (not webhook) + Sync Now button
- Variant/SKU-level cost mapping, hybrid cost source (API for Printful/Printify, manual/CSV for others)
- Expected payout per order = `transaction.amount − fees` from Shopify GraphQL (the "$X will be added to your payout" number)
- Cost per order = `Σ(SKU baseCost × qty) + supplierShip(first+additional)`
- CSV template export per supplier (not auto-push), VN timezone default + US-time date range filter

---

---

## What Was Just Built (Phase 6 — Meta Ads)

### New Files Created
- `src/app/finance/meta/page.tsx` — Meta Billing dashboard (auto-load from DB, SETTLED filter, account tabs, stats)
- `src/app/setup/meta/page.tsx` — Add/manage Meta ad accounts, assign to projects, trigger sync
- `src/app/api/meta/accounts/route.ts` — CRUD + PATCH (project assignment) for MetaAdAccount
- `src/app/api/meta/sync/route.ts` — Fetches `/{accountId}/transactions` from Meta Graph API v19.0, upserts to MetaBilling
- `src/app/api/meta/db-billing/route.ts` — Reads SETTLED billing from DB with stats aggregation

### Schema Changes Applied
- Added `MetaAdAccount` model
- Added `MetaBilling` model
- Added `Project.metaAccounts MetaAdAccount[]` relation
- Migration: `20260512060839_add_meta_billing`

### Other Changes in This Session
- `ShopifyStore.currentBalance Float?` + `currentBalanceCurrency String?` added
- Migration: `20260512060123_add_balance_to_store`
- `sync/route.ts`: now fetches balance in parallel with payouts, saves to store record
- `db-payouts/route.ts`: returns stored balance in response
- Finance page: shows "Last synced: X" and auto-loads from DB on mount
- Sidebar restructured: Finance became a group (Shopify + Meta Billing sub-items)
- `src/lib/db.ts`: added `SCHEMA_VERSION` guard to force singleton reset after migrations

---

## Active Data in DB (as of last test)

| Table | Records | Notes |
|-------|---------|-------|
| ShopifyStore | 1 | caramiaus-store.myshopify.com |
| Payout | 66 | 2022-11-15 → 2026-05-13 |
| BankAccount | 1 | CITIBANK NA ****0611, US, Verified |
| PayoutTransaction | unknown | |
| Project | 1+ | "LZ" confirmed; "POD" created in testing |
| Staff | 1+ | Nghĩa (Seller, ~$200-500/month) |
| StaffAssignment | 1 | Nghĩa → LZ project |
| MetaAdAccount | 0 | Not yet connected |
| MetaBilling | 0 | Not yet synced |

---

## Critical Implementation Details

### Prisma v7 Quirks
- **No `url` in schema.prisma datasource block** — breaks build if added
- **Must use LibSQL adapter**: `new PrismaLibSql({ url: 'file:/absolute/path.db' })`
- **Correct import**: `from '@/generated/prisma/client'` (not `@/generated/prisma`)
- **Correct class name**: `PrismaLibSql` (not `PrismaLibSQL`)
- **After schema change workflow**:
  1. Edit `prisma/schema.prisma`
  2. `cd "project-dir" && npx prisma migrate dev --name <description>`
  3. `npx prisma generate` (must be run from project root)
  4. Bump `SCHEMA_VERSION` in `src/lib/db.ts` (v1 → v2 → v3 etc.)
  5. Restart preview server (stop + start)

### DB Path
- Database is at `{project-root}/dev.db`
- In code: `path.resolve(process.cwd(), 'dev.db')`
- In `.env`: `DATABASE_URL="file:./dev.db"`
- **Never use** `prisma/dev.db` — that path is wrong

### Shopify Payout Date Format
- Stored as `String` "YYYY-MM-DD" — NOT DateTime
- Enables simple string comparison for filtering: `date >= '2024-01-01'`
- Analytics API uses this for assignment-based filtering

### Meta Billing Filter
- Only `status = 'SETTLED'` records are returned by `db-billing` API
- All statuses are stored in DB; filtering happens at query time
- `billingDate` = `created_time.split('T')[0]` from Meta API

### Auto-label Logic (implemented in analytics)
- "Which staff is responsible for a payout?" is determined at query time:
  - Find staff assignments for the project where `assignment.startDate <= payout.date`
  - If `staffId` filter passed → use that assignment's date range
  - No permanent label stored on payout records (calculated dynamically)

---

## Upcoming Work (Phase 7)

The Overview page (`/`) currently shows a placeholder. Next step is to build it with:

```
Aggregate Stats (across all projects):
- Total Shopify Revenue (sum of paid payouts)
- Total Meta Spend (sum of SETTLED billings)
- Net Cashflow (Revenue - Spend)
- Active Projects count
- Staff count + total monthly cost

Recent Activity:
- Last 5-10 payouts
- Last 5-10 Meta billing transactions

Projects Summary:
- Card per project with: revenue, ad spend, net profit
- Link to project dashboard
```

**Suggested API for Overview**: `GET /api/overview` that returns all aggregate stats in one call.

---

## Dev Server Info

- **Port**: 3002
- **Launch config**: `C:\Users\TM PC\Desktop\Ecom manager\.claude\launch.json`
- **Command**: `npm --prefix ecommanager-claude-ecommerce-cashflow-tool-XsLzh run dev -- --port 3002`
- **Preview server ID**: changes on each restart (use `preview_list` to get current ID)

---

## Files NOT to Touch

| File/Dir | Reason |
|----------|--------|
| `src/generated/prisma/` | Auto-generated, overwritten by `prisma generate` |
| `prisma/migrations/` | Auto-managed by `prisma migrate dev` |
| `dev.db` | Runtime database, not source code |
| `.next/` | Build cache |
