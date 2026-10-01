# Ecom Manager — Processing Notes

## Current Phase: Phase 6 Complete → Phase 13 Brainstorming (Fulfillment & POD)

Last updated: 2026-05-19

---

## 🔥 Active Work — Phase 13 Fulfillment & POD (BRAINSTORMING)

**Spec location:** [docs/superpowers/specs/2026-05-19-fulfillment-pod-design.md](docs/superpowers/specs/2026-05-19-fulfillment-pod-design.md) (all 9 sections drafted)

**Plan 1 location:** [docs/superpowers/plans/2026-05-19-fulfillment-pod-phase1-foundation-sync.md](docs/superpowers/plans/2026-05-19-fulfillment-pod-phase1-foundation-sync.md) — DONE. Phase 13.1+13.2 shipped.

**Plan 2 location:** [docs/superpowers/plans/2026-05-19-fulfillment-pod-phase2-supplier-csv-export.md](docs/superpowers/plans/2026-05-19-fulfillment-pod-phase2-supplier-csv-export.md) — DONE. Phase 13.3+13.4+13.5 shipped (Supplier UI, Product mapping, CSV templates, Export).

**Plan 3 location:** [docs/superpowers/plans/2026-05-19-fulfillment-pod-phase3-pipeline-statuses-pl.md](docs/superpowers/plans/2026-05-19-fulfillment-pod-phase3-pipeline-statuses-pl.md) — DONE. Phase 13.6+13.7 shipped (11-state pipeline + auto-detect + Project P&L).

**Plan 4 location:** [docs/superpowers/plans/2026-05-19-fulfillment-pod-phase4-zone-shipping-import.md](docs/superpowers/plans/2026-05-19-fulfillment-pod-phase4-zone-shipping-import.md) — DONE. Zone-aware shipping (US/EU/GB/CA/ROW) + real supplier sheet import + variant modal.

**Plan 4+ (Codex-added on top of Plan 4):**
- Auto-mapping lib (`src/lib/auto-mapping.ts`) — heuristic SKU matching (design 2D/3D detection, token matching), snapshots into `OrderLine.resolvedSupplierSku`
- Product Crawler (`/fulfillment/crawler` UI + `/api/fulfillment/crawler` API) — crawl public Shopify products for design SKU prep
- Unified `/fulfillment/*` route group (Dashboard, Crawler, Orders, Export, Suppliers, Products, Cost Register) — replaces scattered `/orders`, `/setup/suppliers` etc. with one Fulfillment section. Old paths kept as re-exports.
- `xlsx` dependency added for spreadsheet import
- Extra Shopify scope `read_customers` added

**Multi-tenancy architecture (decided 2026-05-19 round 2):**
- 1 Shopify store = 1 Project (`ShopifyStore.projectId UNIQUE`)
- Suppliers + SupplierProduct + CsvTemplate + Staff = SHARED (global, no projectId)
- Order, OrderLine = project-scoped (`projectId` required)
- Soft delete via `Project.archivedAt` (no hard delete)
- Repository pattern: routes go through `src/lib/repos/<domain>.ts`, never `prisma` directly. Cross-domain JOIN only in `repos/reports.ts`.
- Single SQLite DB (not multi-DB file) — chosen because cross-domain reports (P&L per project = orders + ad spend + staff cost) need JOIN.

**Git:** Initialized 2026-05-19, baseline commit `b8ce2d9`.

**Where we are:** ✅ Plan 1 + 2 + 3 + 4 COMPLETE — full Fulfillment & POD module shipped with zone-aware shipping, auto-mapping heuristics, and product crawler. 57 tests pass.

**What works now (full E2E):**
- Multi-tenant Shopify order sync (1 store = 1 project) with paginated, fees-aware, idempotent GraphQL
- 11-state pipeline taxonomy with auto-detect: REFUNDED/CANCELLED from Shopify, PENDING_DESIGN if unmapped SKU OR `requiresDesign` flag, else PENDING. Manual statuses preserved across re-sync.
- Supplier CRUD + SKU mapping + cost history + custom-design flag (`requiresDesign`)
- CSV template builder with live preview + Export Center (date range, supplier, template, preview, download, mark exported)
- Tab-based `/orders` UI (Printful-style): All + 11 status tabs with counts, search, More Filters panel, status dropdown per row, bulk action bar
- Combined Project P&L: Fulfillment Profit − Meta Ad Spend − Staff Cost = Net Profit per project, visible on `/projects`
- Design Library (`/fulfillment/design-library`): SKU × Supplier design tracking with per-supplier design requirement gate, Trello card fallback/populate, CSV import

### Design Library (2026-08-28)
- New Prisma model `SkuSupplierDesign` (per SKU × Supplier): `designLink`, `ready`, `source` (MANUAL|TRELLO), `trelloCardId`; unique constraint `(sku, supplierId)`
- `SkuDesign` repurposed as master artwork per SKU
- Order sync gate per supplier: line needs design only if resolved `SupplierProduct.requiresDesign=true`; order is design-ready ("đẩy thẳng") when all design-required lines have ready `SkuSupplierDesign` for their supplier
- `OrderLine.designDriveLink` filled from library on sync
- Fallback: missing (SKU×Supplier) still creates Trello card (describing supplier + template + master artwork); on Trello DONE + Drive link, `POST /api/trello/sync` sets library entry `ready=true` for reuse
- New page `/fulfillment/design-library` with Sidebar nav "Design Library"
- API: `GET/POST /api/fulfillment/design-library`, `DELETE /[id]`, `POST /import` (CSV `sku,supplierCode,designLink`)

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
- In code: `DATABASE_URL` is resolved to an absolute URL; fallback is `path.resolve(process.cwd(), 'dev.db')`
- In `.env`: `DATABASE_URL="file:./dev.db"`
- **Never use** `prisma/dev.db` — that path is wrong

### Shopify Payout Date Format
- Stored as `String` "YYYY-MM-DD" — NOT DateTime
- Enables simple string comparison for filtering: `date >= '2024-01-01'`
- Analytics API uses this for assignment-based filtering

### Non-product / Digital Order Lines
- Canonical classifier: `isNonProductLine()` / `productLinesOnly()` in `src/lib/order-lines.ts` — dùng helper này, KHÔNG copy logic inline
- Sku-less lines "Tip" / "Shipping protection" = non-product (như cũ)
- **"Custom Text"** (digital add-on, có SKU dạng `LIT2570_1`, variant "Add Text") = digital, KHÔNG cần supplier mapping, KHÔNG cần design file riêng, KHÔNG chặn Trello card / READY_TO_PRODUCTION
- Trello card vẫn hiển thị Custom Text trong mục "Add-ons (digital)" để designer thấy; "Drive attachment name: {order}_{n}" chỉ đánh số trên line vật lý
- Thêm sản phẩm digital mới → thêm title vào `DIGITAL_PRODUCT_TITLES` trong `order-lines.ts`

### Meta Insights Sync (DailyAdSpend)
- `src/lib/sync-meta-insights.ts` — PHẢI follow `paging.next` (Insights API mặc định trả 25 dòng/trang; sync 30 ngày sẽ mất các ngày gần nhất nếu không paginate)
- Graph API version: `v22.0` (v19.0 đã hết hạn ~02/2026 — gọi sẽ fail)
- Nightly cron 1:00am America/Denver chạy `syncMetaInsights(2)` để chốt số ngày hôm trước

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

## Niche Performance (Marketing) — 2026-09-06
- Page `/marketing/niche-performance`, permission `marketing_niche` (SUPERADMIN + ADMIN by default).
- Campaign spend comes from `MetaCampaignDailySpend` (Meta insights `level=campaign`), synced by `syncMetaCampaignInsights()` right after the account-level sync in `runAutoSync` and the 01:00 America/Denver cron. Manual: `POST /api/meta/sync-campaign-insights?days=30`.
- Niche = `Niche` table (name + JSON keywords). Campaign → niche by keyword on `campaignName` (override table `MetaCampaignNicheOverride` wins); order line → niche by keyword on `productTitle`, computed at query time (no column on OrderLine).
- Spend converted to USD with the dated rate schedule; no 3% FX fee added. Revenue = line price × qty minus pro-rata order refund; excludes non-product lines and REFUNDED/CANCELLED pipeline statuses.
- Aggregation logic is pure: `src/lib/marketing/niche-performance.ts` (tested).
- Revenue basis differs from the Projects dashboard: niche revenue = line price × qty − pro-rata refund (product lines only), while Projects uses `order.grossAmount`, so the two pages will not tie exactly.

---

## Meta Billing Reserve (dự phòng nạp thẻ) — 2026-09-30

Panel "Dự phòng thanh toán Meta" trên `/finance/meta` trả lời: **cần có bao nhiêu tiền trên thẻ trong N ngày tới**.

**Graph API v22.0 KHÔNG trả ngưỡng billing.** Edge `adspaymentcycles` và mọi field `billing_threshold` / `threshold_amount` / `next_bill_date` đều lỗi 400 (đã probe trên act_31911697621754869). Ưu tiên: **nhập tay (`thresholdSource = MANUAL`) trước, suy đoán sau**.

Suy đoán = **charge lớn nhất trong 21 ngày**, KHÔNG phải cụm lặp nhiều nhất. Lý do đo được trên prod 2026-09-30: (1) sau một charge ngưỡng, Meta thu tiếp các charge lẻ nhỏ hơn — Remi03 ngày 29/09 có 29.32 / 29.32 / 19.55 / 11.17 sau charge ngưỡng 94.45 ngày 28/09, nên "cụm lặp mới nhất" chọn 29.32 (sai); (2) ngưỡng leo thang nhanh — Remi10 đi 224 → 402.38 → 656.41 → 901.72 trong một tuần, charge mới nhất thường chỉ xuất hiện 1 lần nên quy tắc "tối thiểu 2 lần" bỏ qua nó. Một charge không thể lớn hơn ngưỡng, nên max là ước lượng lệch về phía an toàn (thiếu tiền thẻ = tắt ads). `occurrences` giờ chỉ là mức tin cậy: bao nhiêu charge nằm trong 1% của max.

Field lấy được từ API: `balance`, `account_status`, `funding_source_details`, và `campaigns/adsets` với `budget_remaining,daily_budget,lifetime_budget,stop_time`.

**`budget_remaining` CÓ trừ số đã chi trong ngày** (đã kiểm chứng 2026-09-30: campaign daily=1500 remaining=1373 khi insights `date_preset=today` báo spend=1.27 → 1500−127=1373, khớp trên cả 28 campaign của Remi10+Remi08). Vì vậy `đã chi hôm nay = daily_budget − budget_remaining`, không cần gọi insights. Một account đang UNSETTLED thì không chi gì nên `remaining == daily` — đừng kết luận từ account đó rằng field không giảm.

Công thức panel: `dự kiến cuối ngày = balance + (ngân sách − đã chi hôm nay)`; vượt `ngưỡng` → Meta charge, thẻ phải có sẵn số tiền bằng ngưỡng.

**Số tiền cần trên thẻ** = ngưỡng, NHƯNG = toàn bộ balance khi account đã vượt ngưỡng hoặc `account_status ∈ {2,3,9}` (UNSETTLED / DISABLED / GRACE) — Meta sẽ thu cả cục nợ, không phải một ngưỡng. Gom theo **thẻ** (`fundingCardLast4`) vì 1 thẻ chạy nhiều account (7619 = Remi04 + Remi05 + Remi08) và một thẻ có thể bị charge cả USD lẫn VND.

Files: `src/lib/meta-reserve.ts` (pure + test), `meta-reserve-service.ts` (DB), `meta-reserve-sync.ts` (Meta API), `src/app/api/meta/reserve/route.ts` (GET/POST refresh/PATCH ngưỡng, `requireSuperadmin` cho PATCH), `src/components/MetaReservePanel.tsx`. Card parser dùng chung tách ra `src/lib/meta-card.ts`.

**Ngưỡng chỉ đúng khi billing history đã sync.** Verify bằng snapshot prod, không bằng `dev.db` (dev.db thường cũ hàng tuần → suy ra ngưỡng sai: Remi10 ra $224.92 thay vì $656.41, Remi03 ra $7.82 thay vì $93.23). Kéo snapshot: SSH `root@178.105.170.0` → `python3 -c` với `sqlite3` stdlib chạy `VACUUM INTO '/tmp/prod-snap.db'` (VPS **không** có sqlite3 CLI, node v20 nên **không** có `node:sqlite`; python3 3.14 có sẵn) → `scp` về `db-backups/` (đã gitignore, file chứa access token) → `DATABASE_URL="file:./db-backups/<snap>.db" npx prisma migrate deploy` rồi chạy verify script.

**`MetaAdAccount.excludedFromCashflow`** (2026-09-30): account Meta không thu được tiền nữa (Remi04, Remi05 — `account_status = 3`) bị loại khỏi **cả** tổng dự phòng **và** `pendingInvoiceCharge` ("Pending Meta" trên `/projects`, `sumPendingInvoiceChargeUsd` ở `repos/cashflow.ts`). Vẫn hiện trong bảng với badge "Bỏ qua" (mờ) và bật/tắt bằng icon 👁 trên hàng. Chi phí quảng cáo **đã chi** của chúng vẫn tính vào P&L như cũ — chỉ phần nợ chưa charge bị loại. Remi02 chưa được thêm vào tool.

Chưa làm: cron/alert Telegram, cộng phí FX 3% vào số cần nạp, lưu lịch sử ngưỡng.

## Tách "dòng tiền của kỳ" khỏi "vị thế tiền hiện tại" — 2026-10-01

`shopifyBalance`, `inTransitPayout`, `pendingInvoiceCharge` chỉ miêu tả **lúc này** — Shopify và Meta đều không có API lịch sử cho chúng. Trước đây cả ba bị cộng thẳng vào dòng tiền của kỳ đang xem, nên xem tháng 10 (0 order, 0 payout) vẫn ra "Projected Cashflow 5,575.69", và xem tháng 9 thì hai thẻ `Projected Cashflow` / `Cashflow Dự kiến` **trùng số** vì `pendingPayout` luôn bị kẹp về 0 (doanh thu order ≈ payout nhận trong tháng, trừ thêm ~6.5k ảnh chụp là âm).

`src/lib/cashflow-stock.ts` quyết định nguồn số: kỳ chạy tới hôm nay → `LIVE`; kỳ đã đóng → `CashflowSnapshot` có `asOfDate === endStr` → `SNAPSHOT`; không có → `NONE` (UI hiện "—", không hiện số bừa). `Vị thế tiền = balance + in-transit − nợ Meta`, **không** cộng `actualCashflow` nữa.

**Đã bỏ hẳn** `expectedCashflow` + `pendingPayout` (thẻ "Cashflow Dự kiến"): balance + in-transit đã là toàn bộ tiền Shopify đang giữ. Đo bằng API 2026-10-01: `balance.json` = 1,386.53 **khớp tuyệt đối** tổng balance transaction có `payout_status=pending`, còn tx của payout in_transit mang `payout_status=in_transit` → **balance KHÔNG bao gồm in-transit**, tiền rời balance ngay khi Shopify tạo payout. Nên `balance + in-transit` không double count.

Cột snapshot `shopifyBalance` / `inTransitPayout` / `pendingInvoiceCharge` / `projectedCashflow` giờ **nullable**; `pendingPayout` bị drop. `snapshotProjectMonth` chỉ ghi stock khi `asOfDate` cách hôm nay ≤ `SNAPSHOT_STOCK_GRACE_DAYS` (2) — cron chốt tháng chạy 00:00 ngày 1 nên vẫn ghi được, còn backfill tháng cũ thì ghi null. Migration `20261001020000` null hoá các dòng ghi muộn hơn 2 ngày: trên prod đúng 7 dòng (02→08/2026) đều mang balance 4,606.28 của ngày 13/09.

## Daily sync 15:00 giờ VN — 2026-09-30

`src/lib/daily-sync.ts` + `daily-sync-scheduler.ts`: cron `0 15 * * *` timezone `Asia/Ho_Chi_Minh`, đăng ký trong `instrumentation.ts`, chạy **tuần tự** trong `runExclusive('daily-sync')`:

1. `syncShopifyPayouts()` — payouts + balance + bank accounts
2. Meta billing — `startMetaBillingSync(null)` rồi **chờ** job xong (poll 5s, tối đa 15 phút)
3. `refreshReserveData()` — balance/budget/card cho panel dự phòng

Thứ tự bắt buộc: dự phòng đọc ngưỡng từ lịch sử billing, và cả hai đều gọi Meta API (rate limit) nên không được chạy song song. Một bước lỗi **không** chặn bước sau; kết quả ghi vào `AppSetting.last_daily_sync_result`, xem/chạy tay qua `GET|POST /api/sync/daily` và khối "Sync tự động" trên `/finance/meta`.

**Trước đó không có cron nào cho Meta billing lẫn Shopify** (kiểm 2026-09-30: `git log -S "0 12 * * *"` trống, VPS không có crontab/systemd timer). Cron `0 1 * * *` America/Denver chỉ chạy Meta **insights** (DailyAdSpend), không phải billing.

`syncShopifyPayouts` được tách khỏi `/api/shopify/sync` ra `src/lib/shopify-payouts-sync.ts` (route thành wrapper mỏng; `tests/shopify-payout-sync.test.ts` vẫn import `POST` nên nó là lưới an toàn của lần tách này).

### Nợ kỹ thuật đã biết: `runAutoSync` sync order bằng HTTP self-call
`src/lib/auto-sync.ts` gọi `fetch(APP_URL + '/api/shopify/orders/sync')` kèm cookie của request → từ cron không có cookie thì middleware trả 401, và `last_auto_sync_result` ngày 2026-09-30 ghi `orders: { error: "fetch failed" }`. **Shopify orders hiện chỉ sync khi bấm tay.** Sửa đúng = tách 521 dòng POST của `src/app/api/shopify/orders/sync/route.ts` ra lib rồi cho scheduler gọi in-process như mọi scheduler khác (chủ động chưa làm 2026-09-30, ngoài phạm vi yêu cầu).

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


## 2026-09-10 — Security hardening + data-correctness pass (full code review)

**Security model (server-side now):**
- `src/middleware.ts` verifies the JWT and enforces `API_ACCESS_RULES` (`src/lib/api-access.ts`) for every `/api/*` request and `canAccess` for pages (rewrite to `/no-access`). Unknown API paths are denied for non-SUPERADMIN.
- `src/lib/api-auth.ts` → `getAuthUser` / `requireSuperadmin` re-read role/status/`tokenVersion` from `AppUser`; used by users, config/token routes, Meta accounts, Shopify connect/disconnect.
- Sessions: 24h JWT with `tv` (tokenVersion) claim, refreshed on every `/api/auth/me`; password/role/status changes bump `tokenVersion` → old sessions die. Cookie `lax`, `secure` when `NEXT_PUBLIC_APP_URL` is https. Login rate limit 10 fails / 15 min per IP and per email. Min password 10.
- Shopify credentials only from DB: cookie fallback and `x-shopify-*` header overrides removed; manual-token mode on `/shopify` removed; `/api/shopify/debug` and legacy `/api/shopify/sync-orders` deleted. OAuth validates `*.myshopify.com`, binds callback to the `state` (10-min TTL), constant-time HMAC, HTML-escaped pages.
- Trello GET returns masked key/token. Crawler + Google Sheet fetches go through `assertSafeExternalUrl` (SSRF guard). Security headers in `next.config.mjs`.
- Client: `UserProvider` (root layout) fetches `/api/auth/me` once; `RoleGate`/`Sidebar` fail closed; no secrets in `localStorage`.

**Data fixes:**
- Refund double-count: `grossAmount` = Shopify `currentTotalPriceSet` + refunds (pre-refund total); `expectedPayout = gross - fees - refunded`. `scripts/fix-refund-double-count.mjs --apply` repaired existing rows (run on prod too).
- `PARTIALLY_REFUNDED` no longer terminal; `cancelledAt` → CANCELLED; unpaid (PENDING/AUTHORIZED/EXPIRED) → new `AWAITING_PAYMENT` status (re-evaluated on sync, excluded from revenue).
- Order sync: rolling window uses `updated_at`; `syncSinceDate` only advances when Shopify fetch fully succeeded (502 otherwise); `fulfillmentStatus` passed to `autoDetectStatus`.
- Meta billing dedup: count-parity per amount/±1-day window (threshold charges with equal amounts are distinct); PENDING import rows upgraded to PAID by the scrape. Paid statuses centralised in `PAID_META_STATUSES` (`meta-fee.ts`); `combinedProjectPL` no longer filters on the never-written `SETTLED`.
- Tracking sync aborts on partial Shopify read (never resets tracking), skips orders missing from the response, and does not overwrite ParcelPanel shipment status.
- Design-library POST leaves `designLink`/`note`/`source` untouched when absent (Ready toggle no longer wipes links). Export only moves READY_TO_PRODUCTION/EXPORTED to EXPORTED. Manual mapping leaves cost fields to `recalculateMissingOrderLineCosts` and re-derives status via `autoDetectStatus`. Last-mile push requires an exact order-name match.

**Infra / OOM:**
- `db.ts` pins one Prisma client on `globalThis` in every env and applies `PRAGMA journal_mode=WAL` + `busy_timeout=5000`.
- `src/lib/job-lock.ts` (`initOnce`, `runExclusive`) — every scheduler is registered once per process and never overlaps itself; spy scheduler state lives on `globalThis` so `reloadSpyScheduler` really stops old tasks.
- Spy: list endpoints `omit rawPayload` and use per-ad summary columns (`firstCollationCount`, `everActive`, `observationCount`, maintained by `ingestAds`; backfill via `scripts/backfill-spy-ad-summary.mjs`); observations older than 120 days pruned; `scan-ads` runs targets sequentially under a lock, quota = 1 per target; domain scans create page targets `active: false`; Apify calls have timeouts, dataset is paged, timed-out runs are aborted; media cache writes atomically, caps 8 MB, allow-lists fbcdn hosts, remembers failed URLs, caches only the ads a scan ingested.
- Indexes added: Order(storeId,placedAt / shopifyOrderNumber / trelloCardId), OrderLine(orderId / orderId,shopifyLineId), Payout(storeId,status,date), MetaBilling(adAccountId,status,billingDate), PayoutTransaction(payoutId), StaffAssignment(projectId), SpyAd(lastSeenAt).
- Tests run against `test.db` (recreated from migrations in `tests/global-setup.ts`); the characterization test is opt-in via `RUN_CHARACTERIZATION=1`. Leaked fixtures (`proj_test`, `proj_mbc`, test stores/supplier) were removed from dev.db.
