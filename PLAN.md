# Ecom Manager — Development Plan

## Project Overview
An internal e-commerce cashflow management tool for tracking Shopify payouts, Meta Ads spend, projects, and staff performance. Built with Next.js 14 App Router + SQLite (Prisma v7 + LibSQL).

---

## Phase Status

### ✅ Phase 1 — Design System & Shell (DONE)
- Custom Tailwind design tokens (colors, typography, spacing) matching DESIGN.md spec
- Deep navy primary `#091426`, indigo secondary `#4b41e1`
- Inter font + Material Symbols Outlined icons
- Shared `Sidebar` component with nested group navigation
- App shell: layout.tsx, globals.css

### ✅ Phase 2 — Shopify Integration (DONE)
- Shopify OAuth connect flow (`/setup` → `/api/auth/shopify`)
- Manual credentials fallback (localStorage)
- Fetch payouts from Shopify Payments API (`/api/shopify/payouts`)
- Fetch bank accounts, balance, payout transactions
- Finance page (`/shopify`) with stat cards, bank summary table, payouts table
- Auto-load from DB on page open; "Last synced: X" timestamp

### ✅ Phase 3 — Database Layer (DONE)
- Prisma v7 with LibSQL adapter (`@prisma/adapter-libsql`)
- SQLite at project root (`dev.db`)
- Schema: `ShopifyStore`, `Payout`, `BankAccount`, `PayoutTransaction`
- Sync endpoint: `POST /api/shopify/sync` — upserts all payouts + bank accounts + balance
- Read endpoint: `GET /api/shopify/db-payouts` — serves Finance page from DB
- Global singleton pattern with `SCHEMA_VERSION` for dev hot-reload safety

### ✅ Phase 4 — Project & Staff Setup (DONE)
- Schema: `Project`, `Staff`, `StaffAssignment`
- `GET/POST/DELETE /api/projects` — project CRUD
- `GET/POST/DELETE /api/staff` — staff CRUD
- `POST/DELETE /api/projects/assign` — assign staff to project with startDate/endDate
- Setup → Projects page (`/setup/projects`): create/delete projects
- Setup → HR page (`/setup/hr`): create/delete staff, assign to projects, remove assignments

### ✅ Phase 5 — Project Management Dashboard (DONE)
- `GET /api/projects/analytics?projectId=X&staffId=Y`
  - Filters payouts by project.startDate (or staffAssignment.startDate if staffId given)
  - Returns totalProfit, payoutCount, avgProfit, payout list
- Dashboard page (`/projects`): project tabs, seller filter dropdown, 3 stat cards
- Staff breakdown panel with "Xem riêng →" quick-filter
- Cashflow/Payouts table with footer total

### ✅ Phase 6 — Meta Ads Billing (DONE)
- Schema: `MetaAdAccount`, `MetaBilling`; `Project.metaAccounts[]` relation
- `GET/POST/DELETE/PATCH /api/meta/accounts` — CRUD + assign to project
- `POST /api/meta/sync` — fetches `/{accountId}/transactions` from Meta Graph API v19.0 with pagination; upserts to DB
- `GET /api/meta/db-billing?accountId=X` — returns SETTLED billing from DB with stats
- Finance → Meta Billing page (`/finance/meta`): auto-load from DB, filter by account, Total Spent/Transactions/Avg stats, billing table (SETTLED only)
- Setup → Meta page (`/setup/meta`): add ad account, assign to project, per-account sync button

---

## Phase Backlog (TODO)

### 🔲 Phase 7 — Overview Dashboard (`/`)
**Priority: High**
- Aggregate stats across all projects: Total Shopify Revenue, Total Meta Spend, Net Profit
- Recent payouts list (last 10)
- Quick links to each project dashboard
- Month-over-month comparison cards

### 🔲 Phase 8 — Profit / Loss per Project
**Priority: High**
- Combine Shopify payouts (revenue) with Meta billing (ad spend) per project
- Formula: `Net Profit = Shopify Payouts - Meta Spend - Staff Cost`
- Staff cost: `monthlyCost × months_active` for each StaffAssignment
- Show P&L breakdown in Project Management Dashboard
- Add P&L columns to project cards in `/projects`

### 🔲 Phase 9 — Date Range Filters on Finance Pages
**Priority: Medium**
- Finance → Shopify: FROM/TO date filter currently only filters API fetch, not DB read
- Fix `/api/shopify/db-payouts` to accept `dateFrom`/`dateTo` params
- Fix `/api/meta/db-billing` to accept date range params
- Sync both filter UIs

### 🔲 Phase 10 — Monthly Trend Charts
**Priority: Medium**
- Simple bar/line chart showing monthly cashflow
- Libraries: consider `recharts` (already in ecosystem) or lightweight canvas
- Show on: Overview dashboard + per-project dashboard
- Data: group DB payouts by month, group Meta billing by month

### 🔲 Phase 11 — Multi-Store Support
**Priority: Low**
- Currently assumes 1 Shopify store
- `ShopifyStore` table already supports multiple stores
- UI: store selector dropdown in Finance header
- Analytics: filter by store or show aggregated

### 🔲 Phase 12 — Export
**Priority: Low**
- Export payouts / billing to CSV
- Export P&L report per project to CSV or PDF

---

### 🟢 Phase 13.1 + 13.2 — Fulfillment Foundation & Sync (DONE)
**Spec:** [docs/superpowers/specs/2026-05-19-fulfillment-pod-design.md](docs/superpowers/specs/2026-05-19-fulfillment-pod-design.md)
**Plan:** [docs/superpowers/plans/2026-05-19-fulfillment-pod-phase1-foundation-sync.md](docs/superpowers/plans/2026-05-19-fulfillment-pod-phase1-foundation-sync.md)

Completed 2026-05-19 via subagent-driven development. 16 tasks, 13 tests passing.

**Shipped:**
- 6 new Prisma models (Supplier, SupplierProduct, SupplierCostHistory, Order, OrderLine, CsvTemplate) + multi-tenant projectId
- Repository layer (`src/lib/repos/`) with project-scope enforcement
- Pure libraries: `pl-calculator`, `csv-template`, `timezone` (12 unit tests)
- Shopify GraphQL orders sync (paginated, fees-aware, idempotent)
- `/orders` dashboard with project selector + sync button + P/L table

### 🔲 Phase 13.3 + 13.4 + 13.5 — Supplier Setup + CSV Export (TODO — Plan 2 not yet written)
- `/setup/suppliers` CRUD UI
- `/setup/products` SKU mapping table with CSV import
- Printful / Printify connectors
- CSV template builder UI
- `/orders/export` page

### 🔲 Phase 13.6 + 13.7 — Pipeline + Alerts + Project integration (TODO — Plan 3 not yet written)
- Kanban pipeline view
- Alert panel (unmapped SKU, mixed supplier, stale orders)
- Combined P&L per project (Fulfillment + Meta + Staff)

---

## Known Issues / Tech Debt

| Issue | Priority | Notes |
|-------|----------|-------|
| `bankAccountShopifyId` NULL for old synced payouts | Low | Fallback in db-payouts handles it; re-sync fixes permanently |
| `prisma generate` must run manually after schema changes + server restart needed | Medium | Schema version bump in db.ts helps but restart still required |
| Current Balance not persisted until first Save to DB after Fetch | Low | Resolved after first sync cycle |
| Meta Access Token stored in plain text in DB | Medium | Acceptable for local/internal tool; encrypt if deployed |
| `/projects` analytics uses ALL store payouts (not filtered by project's store) | Medium | Works for single-store; needs storeId link if multi-store |
