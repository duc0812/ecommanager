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

## Snapshot tháng: chốt 15:00 VN ngày 1, sửa tay được — 2026-10-01

Chốt tháng **không còn cron riêng**; nó là bước thứ 4 của daily sync 15:00 Asia/Ho_Chi_Minh (`monthToCloseOn` trong `daily-sync.ts`), chỉ chạy vào ngày 1 và khoá tháng vừa kết thúc — nhờ vậy snapshot ghi dữ liệu vừa sync xong mấy phút trước thay vì dữ liệu hôm qua.

Dashboard: thẻ "Vị thế tiền" đã bỏ (chủ không cần), thay bằng **Profit Dự kiến** = hiệu hai lần chốt gần nhất (`expectedProfit` của dòng mới nhất).

`CashflowSnapshot.expectedCashflowManual` = **số sửa tay**, thắng số tự tính (`effectiveExpectedCashflow`), và backfill **không** chạm vào nó — chỉ ghi lại `expectedCashflow`. Cần vì các tháng đóng trước khi tool ghi số dư thì tính ra thấp, mà Shopify không có API lịch sử số dư để dựng lại. Sửa qua `PATCH /api/projects/[id]/snapshots` (`{ periodMonth, expectedCashflowManual }`, `requireSuperadmin`; để trống = quay về số tự tính), hoặc bấm thẳng vào số trong danh sách "Profit theo tháng" khi đang ở chế độ **Dự kiến**. Dòng nào sửa tay có icon bút chì.

Danh sách tháng hiện cả **ngày chốt** (`snapshotCloseDateKey`: ngày 1 tháng sau) vì chủ gọi snapshot theo ngày chốt — "snapshot 1/9" là dòng `2026-08`.

**Đã set tay:** `2026-08` = 6300 (yêu cầu 2026-10-01).

## Tách "dòng tiền của kỳ" khỏi "vị thế tiền hiện tại" — 2026-10-01

`shopifyBalance`, `inTransitPayout`, `pendingInvoiceCharge` chỉ miêu tả **lúc này** — Shopify và Meta đều không có API lịch sử cho chúng. Trước đây cả ba bị cộng thẳng vào dòng tiền của kỳ đang xem, nên xem tháng 10 (0 order, 0 payout) vẫn ra "Projected Cashflow 5,575.69", và xem tháng 9 thì hai thẻ `Projected Cashflow` / `Cashflow Dự kiến` **trùng số** vì `pendingPayout` luôn bị kẹp về 0 (doanh thu order ≈ payout nhận trong tháng, trừ thêm ~6.5k ảnh chụp là âm).

`src/lib/cashflow-stock.ts` quyết định nguồn số: kỳ chạy tới hôm nay → `LIVE`; kỳ đã đóng → `CashflowSnapshot` có `asOfDate === endStr` → `SNAPSHOT`; không có → `NONE` (UI hiện "—", không hiện số bừa). `Vị thế tiền = balance + in-transit − nợ Meta`, **không** cộng `actualCashflow` nữa.

**Thẻ "Cashflow Dự kiến" giữ lại** (`src/lib/cashflow-expected.ts`) — nó là số chuỗi snapshot theo tháng dùng, nên không được bỏ:

```
expectedCashflow = actualCashflow (kỳ) + shopifyBalance + inTransitPayout − pendingInvoiceCharge
```

`pendingPayout` (`max(0, orderRevenue − payout − inTransit − balance)`) **đã bỏ hẳn, cột cũng bị drop** (migration `20261001070000`): nó ước lượng "order chưa vào balance", mà balance + in-transit **chính là** tiền đang về, nên cộng thêm là đếm hai lần. Doanh thu order cố tình không phải input của hàm này. Số dư không biết thì tính bằng 0 (tháng đã đóng chưa có snapshot) thay vì vay số dư hôm nay.

Đo bằng API 2026-10-01: `balance.json` = 1,386.53 **khớp tuyệt đối** tổng balance transaction có `payout_status=pending`, còn tx của payout in_transit mang `payout_status=in_transit` → **balance KHÔNG bao gồm in-transit**, tiền rời balance ngay khi Shopify tạo payout. Nên `balance + in-transit` không double count.

Cột snapshot `shopifyBalance` / `inTransitPayout` / `pendingInvoiceCharge` / `projectedCashflow` giờ **nullable**; `expectedCashflow` được ghi lại (nullable) để chuỗi snapshot tháng dùng; `pendingPayout` bị drop hẳn. `snapshotProjectMonth` chỉ ghi stock khi `asOfDate` cách hôm nay ≤ `SNAPSHOT_STOCK_GRACE_DAYS` (2) — cron chốt tháng chạy 00:00 ngày 1 nên vẫn ghi được, còn backfill tháng cũ thì ghi null. Migration `20261001020000` null hoá các dòng ghi muộn hơn 2 ngày: trên prod đúng 7 dòng (02→08/2026) đều mang balance 4,606.28 của ngày 13/09.

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

## Design Studio (2026-10-09, local only)

- `/design-studio` lists PENDING_DESIGN + DESIGN_REJECTED orders; `/design-studio/[orderId]` is the per-order workspace.
- Line-item properties are now persisted on `OrderLine.customAttributesJson` at sync (with `_product_url` appended). Orders synced before this have `null` there — the "Nạp lại từ Shopify" button fills them via `fetchOrderLinePropsByNames` (60-day window, single-store token).
- Uploaded artwork lives under `storage/design/<order>/<line>/<area>/v<n>-<name>` (`DESIGN_STORAGE_DIR` overrides the root), tracked in `DesignArtwork`, served only via `/api/design-studio/file/<id>`.
- "Đánh dấu xong" writes `OrderLine.designDriveLink` = the app file URL and recomputes `Order.designReady` + `pipelineStatus` with `autoDetectStatus`. The supplier CSV therefore carries an app URL until Drive storage replaces local storage.
- Next phase: the auto-design agent (see the spec's "Next phase").

## Design Tasks v2 (2026-10-10, local)

Spec `docs/superpowers/specs/2026-10-10-design-tasks-v2-design.md`, plan `docs/superpowers/plans/2026-10-10-design-tasks-v2.md`. `/design-studio` is now the "Design Tasks" page (queue on the left, image-first workspace on the right); `/design-studio/[orderId]` only redirects to the order's first task.

**Task model.** One `DesignTask` per product line that has a supplier (non-product lines and unmapped lines get none). Key = order number without `#` + `_` + line position, e.g. `LIT4545_1` (`taskKeyFor`). Fields: status, readiness (`AUTO` / `LOW` = has `_print_files` / `MANUAL`), assignee, KPI points (from `kpiByType` on the product type), `slaHours` (24 custom / 48 non-custom), `dueAt` (placedAt + SLA at creation, reset on assign with "Hạn giờ"), reject reasons/note, `prevStatus` (for ASK_CUSTOMER), supplier snapshot. Every change writes a `DesignTaskEvent`.

**Lifecycle** (`canTransition` in `src/lib/design-tasks.ts`, mirrored in `src/app/design-studio/components/model.ts`):

| From → To | Who | Notes |
|---|---|---|
| NEW / DOING / REJECTED → ASSIGNED | Leader | assignee, KPI, due hours, note |
| ASSIGNED → NEW | assignee | "Từ chối" — clears the assignee |
| NEW / ASSIGNED / REJECTED / DONE → DOING | owner or unassigned | "Nhận việc" sets assignee = self when empty; DONE → DOING reopens and clears the line's design link |
| DOING / REJECTED → REVIEW | owner | "Gửi duyệt" — the server refuses `Chưa có artwork cho: <slots>` unless every required slot has an artwork (not checked on ASK_CUSTOMER → continue) |
| REVIEW → REJECTED | Leader, or any `design_tasks` holder while `designerCanApprove` is on (default) | ≥1 reason from `rejectReasons` |
| REVIEW → DONE | Leader, or any `design_tasks` holder while `designerCanApprove` is on (default) | "Duyệt design" — goes through `updateLine(done:true)` — except when the line already has a non-studio `designDriveLink` (Trello / Library) and the task was not reopened by the factory: then the task is marked DONE with SYSTEM "Design đã có từ ngoài studio — giữ link hiện tại" and the link/order are left alone |
| NEW / ASSIGNED / DOING → DONE | nobody | everything passes REVIEW; an auto render reaches REVIEW through `submitAutoRenderForReview` |
| any open → ASK_CUSTOMER | owner | saves `prevStatus`; "Tiếp tục" (`continue: true`) restores it |
| open / ASK_CUSTOMER → CANCELLED | Leader | |

Leader = SUPERADMIN or ADMIN (`isLeader`); everyone else is a Designer.

**Ownership.** A non-leader cannot move a task assigned to someone else to DOING, NEW, REVIEW or ASK_CUSTOMER — the server answers 400 `Task đang thuộc về <name>`, and the header/checklist hide those buttons. Leaders are exempt (they reassign with ASSIGNED).

**Slots (required files).** `requiredSlotsFor(line, template)`: the `PrintTemplate` area names when the line's supplier/SKU has a template, else `printAreasForLine` (the `_print_files` areas, or `Artwork`). `loadTask` returns them as `detail.slots`; the upload slots, checklist item 5, "Gửi duyệt"/DONE gating and the canvas all use that list, and `transitionTask(DONE)` passes the same list to `updateLine(done:true, requiredAreas)`, which refuses with `No artwork uploaded for: <missing>`. `designDriveLink` = the newest artwork of the first required slot.

**How tasks are created and closed.** `syncDesignTasks(orderId)` runs:
- at the end of every order in `POST /api/shopify/orders/sync`;
- after every order touched by `POST /api/trello/sync`, `PATCH /api/fulfillment/orders/[id]/status` and `POST /api/fulfillment/orders/bulk-status` (via `syncDesignTasksForOrders`, only for orders that have a task or sit in PENDING_DESIGN / DESIGN_REJECTED; errors come back as `designTaskErrors`, never fail the write);
- on demand via `POST /api/design-studio/tasks/sync` (body `{orderId}`, or `{}` for every PENDING_DESIGN / DESIGN_REJECTED order plus every order with a task not DONE/CANCELLED; the "Đồng bộ task" button; per-order errors in `errors`).

It is idempotent: existing tasks keep status/assignee; a cancelled/refunded order cancels open tasks; a line that already has `designDriveLink` (Trello / Design Library) marks its task DONE ("done outside").
**Factory rejection.** When the order is DESIGN_REJECTED, a DONE task goes to REJECTED with reason `Xưởng trả file` (SYSTEM "Xưởng trả file — mở lại task", counted as `reopened`); a line with a link but no task gets a new task in that state. While the reason `Xưởng trả file` is on the task, sync never auto-completes it from the old link, and studio approval rewrites the link through `updateLine` (a leader's later REJECTED keeps that reason; studio DONE clears the reasons).

**Permission / settings / templates.**
- Feature permission `design_tasks` (ADMIN + SUPPORT by default); `/api/design-studio` accepts `design_tasks`, `fulfillment_design_library` or `fulfillment_orders`.
- **Rollout (prod, after deploy):** `node scripts/backfill-design-tasks-permission.mjs` (dry run) then `--apply` with `DATABASE_URL` pointing at the prod DB. Default role permissions only apply to new users, so without it every existing ADMIN/SUPPORT is bounced from `/design-studio` to `/no-access`. It appends `design_tasks` to every user holding `fulfillment_design_library` (dev.db 2026-10-09: 3 of 4 users). `tokenVersion` is not bumped, so nobody is logged out and no re-login is needed: page access is checked by the middleware against the permissions inside the JWT cookie, and the Sidebar/`RoleGate` read `user.permissions` from `GET /api/auth/me`, which reads the DB and re-signs the cookie with the fresh list. So a user gets the page after loading any app page once after the backfill (any page except `/login` and `/no-access`, where `UserProvider` skips the call). Opening `/design-studio` directly with the old cookie still lands on `/no-access` until that happens.
- Settings live in `AppSetting` key `design.settings` (`src/lib/design-settings.ts`: SLA hours, `kpiByType`, `rejectReasons`), read via `GET /api/design-studio/settings`, saved via `PUT` (SUPERADMIN only).
- `PrintTemplate` (per supplier, optional `supplierSku`; exact SKU → longest prefix → supplier default). `scripts/seed-print-template-merchize.mjs` seeds the Merchize BAJE jersey template (6 areas). **The BAJE area coordinates are illustrative until the real PSD is measured** — replace `AREAS` then.
- Uploads record `widthPx/heightPx` for PNG/JPG (null for PSD/PDF/ZIP) for the "Yêu cầu xưởng ↔ file" table.

**Pinned by tests** (Review Focus of the plan):
1. Re-sync never duplicates or resets tasks — `syncDesignTasks` is idempotent and keeps status/assignee (`tests/design-tasks-sync.integration.test.ts`).
2. DONE goes through `updateLine(done:true)` so the order leaves PENDING_DESIGN exactly as v1 (`tests/design-tasks-transition.integration.test.ts`).
3. A Designer cannot approve a non-AUTO task or assign; a Leader can (`canTransition` matrix in `tests/design-tasks.test.ts`, route test in `tests/design-tasks-routes.integration.test.ts`).
4. ASK_CUSTOMER → continue restores the previous status, not NEW (`tests/design-tasks-transition.integration.test.ts`).
5. A PNG/JPG upload records `widthPx/heightPx`; PSD/PDF records null and does not fail — the probe is pinned in `tests/image-size.test.ts` (PNG, JPEG SOF0/SOF2, null for other bytes, never throws); the upload route writing the columns has no integration test of its own.
Also pinned since the fix wave: template-area slots gate DONE and the ownership rule (`tests/design-tasks-transition.integration.test.ts`, 400 at the route in `tests/design-tasks-routes.integration.test.ts`); `timeLeft` / `allSlotsFilled` (`tests/design-tasks-model.test.ts`). Fix wave 2: factory reopen + no auto-complete + status-PATCH cancel (`tests/design-tasks-sync.integration.test.ts`); REVIEW needs artwork, external-link DONE keeps the link, factory-reopened DONE rewrites it, continue → DOING logs "Tiếp tục làm" (`tests/design-tasks-transition.integration.test.ts`); sync-all visits READY orders with open tasks and `mine=1` (`tests/design-tasks-routes.integration.test.ts`).

Not done yet: no browser click-through of the page; `readinessFor` never yields `AUTO`, so "Duyệt nhanh" stays unused until something sets AUTO.

## Design approve + supplier handoff (2026-10-12, branch `feat/design-approve-handoff`)

Approving a design and handing it to the supplier are two steps.

- **Approve.** Setting `designerCanApprove` (in `design.settings`, default true, toggle on Design Studio → Settings). `canTransition(from, to, actor, canApprove)` stays pure; `transitionTask` computes the capability with `canApproveDesign` (`src/lib/roles.ts`). The approve event is `Duyệt design` / `Duyệt design (designer)` with the approver as actor. `me` in the task routes carries `canApprove` and `canHandoff`.
- **Handoff state** on `Order`: `supplierHandoffAt`, `supplierHandoffMode` (`API` | `CSV`), `supplierHandoffById`. "Chờ chuyển xưởng" = `READY_TO_PRODUCTION` + `designReady` + no open design task + `supplierHandoffAt` null + not fulfilled/refunded (`pendingHandoffWhere` in `src/lib/supplier-handoff.ts`).
- **UI.** Chip "Chuyển xưởng N" on Design Tasks → `HandoffGrid` (one card per order). `HandoffButton` is shared with the task header (shown once the task is DONE).
- **API mode** (every product line is PGprints, credentials set, every line has `apiSku`): the button opens `PgprintsPushModal`. `markPushExported` (`src/lib/repos/push-export.ts`) marks the order Exported and sets the handoff to API in one `updateMany`; `prevExportJson` keeps the previous export + handoff state and a cancel restores it.
- **CSV mode** (everything else): `POST /api/design-studio/orders/[id]/handoff {mode:'CSV'}` only writes the three fields — the order stays `READY_TO_PRODUCTION` for `/fulfillment/export`. `DELETE` on the same route = "Hoàn tác", refused once the order is EXPORTED/FULFILLED. Reopening a line (designReady → false) drops a saved handoff, and re-approving after a factory rejection (`DESIGN_REJECTED`) drops it in either mode, so the new design is handed over again. The export page shows a "Design đã chuyển" badge and has a "Chỉ đơn design đã chuyển" filter (`handoffOnly`); a handoff is never required to export.
- **Permission** for handoff: ADMIN/SUPERADMIN or `fulfillment_export` (`canHandoffToSupplier`), checked in the route (DB-backed) and by `API_ACCESS_RULES` (`{ adminOr: [...] }` + `suffix`). The PGprints **push** route uses the same rule — default SUPPORT holds `fulfillment_export`, so SUPPORT can now send real PGprints orders; cancel/refresh stay admin-only, `pgprints.pushEnabled` still gates everyone.
- **Reconcile.** An order pushed outside the app has a `CREATED` push with `exportMarked = false`. When it becomes fully approved, `recomputeOrderDesign` calls `reconcilePushedOrder` → marked Exported + API handoff, no PGprints call. Review and handoff cards show "Đã gửi PGprints <code>" while a push is live. For orders already `READY_TO_PRODUCTION`: `node scripts/reconcile-pushed-orders.mjs` (dry run) then `--apply`, with `DATABASE_URL` pointing at the target DB.
- **Destination guard.** `SupplierProduct.apiShipCountries` (comma-separated ISO codes, empty = anywhere), edited in the "Giao tới" column on the PGprints supplier page. The preview/push returns error `SHIP_COUNTRY` when the order ships elsewhere. Set `US` on `UT2-One_size`; the worldwide 20oz tumbler is `STU`.
- **File format per API SKU.** `SupplierProduct.apiFileFormat` (`PNG` default / `JPEG`), the "File in" select on the PGprints supplier page; the catalogue lookup fills it from the file note ("JPEG, 300 DPI, CMYK" → JPEG) when a variant is picked. The preview's `FILE_TYPE` check compares the print file against that format (PNG↔JPEG mismatch = warning, anything else = error) instead of always demanding PNG — `STU` (China 20oz) wants JPEG CMYK 3366×1819, `UT2` (US) PNG RGB 3270×1860. Set `JPEG` on `STU-20OZ` after deploy.
- **Rollout (prod):** `npx prisma migrate deploy` (migration `20261012090000_design_handoff`), then the reconcile script. Every existing `READY_TO_PRODUCTION` + design-ready order shows up under "Chuyển xưởng" the first time.

## Trello cutover (2026-10-13, branch `feat/trello-cutover`)

What Design Studio needed before it can replace Trello. No schema change. Where this section disagrees with the older Design Studio sections above, this section is the current behaviour.

- **Supplier CSV links** (`src/lib/export-design-links.ts`, `src/lib/design-links.ts`). `OrderLine.designDriveLink` is stored as before (app path `/api/design-studio/file/<id>` for a LOCAL artwork, the Drive link for a Drive one). The export translates: a line whose stored link is a Studio link gets the newest artwork of every required slot (`requiredSlotsFor`) — Drive link, or `publicArtworkUrl` for a LOCAL file — joined with `" | "`. Sources: `line.designDriveLink` and `line.designLinks` (same joined value), `line.designArea:<areaName>` (one area, case-insensitive), `order.designDriveLink` (app path translated). Trello / library / manual links are exported as stored, also when the line happens to have Studio files. The export answers **400** (`orders`, `problems` in the body, nothing marked exported) when a LOCAL link is needed and `NEXT_PUBLIC_APP_URL` is unusable, when the line is not approved (task not DONE — the public route would 404), or when the linked file was removed. Links are resolved only for the design columns the template has. Template editor: "Link design — mọi vùng in" and "Link design — một vùng in" (area names suggested from the supplier's print templates).
- **Task sync** (`runDesignTaskSync` in `src/lib/design-task-sync.ts`). Scope: every `PENDING_DESIGN` / `DESIGN_REJECTED` order + every order with an open task + the newest 100. Nothing is pruned (`pruneUntouchedTasksOutside` is gone). `FULFILLED` orders (pipeline or Shopify fulfillment status) get no task and their open tasks are cancelled ("Đơn đã fulfilled — task tự huỷ"), like cancelled / refunded ones. Shopify refresh of missing line props: batches of 25, at most 100 orders a run, newest first; a scheduled run re-asks about an order only after 6 hours (in-process memo), the button ignores the memo. Summary keys: `orders`, `scope`, `created/cancelled/completed/reopened`, `refresh {needing, attempted, deferred, refreshed, notFound, otherStore, error}`, `errors`.
- **Automatic intake.** `initDesignTaskSyncScheduler` (`src/lib/design-task-sync-scheduler.ts`, registered in `src/instrumentation.ts` after the `DISABLE_SCHEDULERS` return) runs the sync every 15 minutes. Job lock `design-task-sync` (`runExclusive`) is shared with the "Đồng bộ task" button — the button answers 409 while a run is active. Last result: `AppSetting` `last_design_task_sync_result`; `GET /api/design-studio/tasks` returns it as `lastSync` ("Đồng bộ lần cuối" next to the button), also `GET /api/design-studio/tasks/sync`.
- **`trelloMode`** in `design.settings` (Design Studio → Settings → Trello, SUPERADMIN saves): `BOTH` (default) / `READ_ONLY` (order sync creates no card, existing cards are still read) / `OFF` (no card created; `POST /api/trello/sync` returns `{skipped: true, message}`, the card backfill and `design-diagnose` answer 400). The library "task row" (`upsertTaskEntry`) is still written in every mode.
- **Trello never overwrites Studio work.** `studioOwnedLines(orderId)` = lines with a non-removed `DesignArtwork`, or whose task is DOING / REVIEW / REJECTED / DONE and has a STATUS or REJECT event by a person. `POST /api/trello/sync` skips those lines (`studioLinesKept` in the response); a system-only move (factory reopen, done outside) does not protect a line. `syncDesignTasks` auto-completes a task from an outside link only while it is NEW / ASSIGNED and the line has no Studio file.
- **Checklist.** A mapped line without a template: "Template in" and "Artwork gốc" are `na`, the next step is the print file. The "Thêm template" link is shown to leaders only.
- **Task info.** THÔNG TIN shows "Thẻ Trello" (when the order has `trelloCardUrl`) and "Add-on của đơn" (`addOnSummaries` in `src/lib/order-classify.ts`, the same function the Trello card description uses). "Ghi chú CS" is editable: `PATCH /api/design-studio/tasks/[key] {designNote}` — `design_tasks` holders and admins (`canEditDesignNote`), logged as a NOTE event. It is `OrderLine.designNote`, the same text the PGprints push shows as the production note.
- **Design library reuse** (`src/lib/studio-library.ts`). Studio DONE on a non-customized line (stored `customized` flag false and `isLineCustomized` false on its attributes) writes `SkuSupplierDesign` for SKU × supplier: `ready`, `source = 'STUDIO'`, link = Drive link or public URL, several areas joined with `" | "`. An existing row that matches (exact VARIANT or PARENT prefix) is updated, keeping `matchMode` / `designType` / `trelloCardId`. An unusable `NEXT_PUBLIC_APP_URL` skips the write and logs a SYSTEM event on the task; the approval stands. Not handled: reopening or a factory rejection does not un-ready the library row, and a public URL in the library stops working while its source task is not DONE.
- **Review bypass closed.** `PATCH /api/design-studio/lines/[lineId]` refuses `done` (400). It only edits the note, with the same permission as the task route.
- **Rollout.** Deploy, then keep `trelloMode = BOTH` until the in-flight cards are finished, switch to `READ_ONLY`, then `OFF`. The first sync after deploy creates tasks for every old `PENDING_DESIGN` / `DESIGN_REJECTED` order and cancels open tasks on fulfilled orders. `NEXT_PUBLIC_APP_URL` must be the public https domain on the server, or exports with LOCAL artwork fail and the library is not filled.

## Product profiles (2026-10-10)

- One `ProductProfile` per Shopify product (`storeId` + `shopifyProductId`): default supplier product, option overrides (`[{combo, supplierProductId}]`), print template, master artwork URL, layer map (`[{field, layer, font?, maxChars?, fit}]`). Edited at `/design-studio/products` (admins write, others read).
- `OrderLine.shopifyProductId` comes from the order sync; older lines get it when "Đồng bộ task" runs (it refetches lines missing custom attributes, image or product id from Shopify — 60-day token window).
- Supplier precedence: variant manual mapping > profile override > profile default > ProductBase rules. The size-sibling swap applies to profile defaults, not to overrides.
- Design precedence: profile template (only when its supplier prints the line, or the line has no supplier yet) > supplier-SKU template match; profile master > SkuDesign. Master artwork is link-only; upload is not built yet.
- Saving a profile re-resolves only lines of that product in orders not EXPORTED/FULFILLED/CANCELLED/REFUNDED, keeps the cost snapshot when supplier+SKU are unchanged, skips the cost step when supplier/overrides did not change, then re-syncs tasks.
- Status: NONE / NO_TEMPLATE / NO_MASTER / NO_LAYERS / READY. Observed fields (last 90 days, newest 200 lines) exclude non-printed keys (`Size`, "Yes or No" toggles — `src/lib/layer-fields.ts`).

## Design artwork on Google Drive (2026-10-10, upload and connection reworked 2026-10-13)

Where the 2026-10-13 section below disagrees with this one, the section below is the current behaviour.

- The designer uploads to the tool; the tool saves the file, pushes it to Drive in 8 MB resumable chunks, shares it "anyone with the link", records `driveFileId`/`driveWebViewLink`, then deletes the local copy. Folder: `Design Studio/<Store>/<YYYY-MM UTC>/<Order>/<TaskKey>/v<N>-<file>`.
- Drive not connected → the file stays on the server ("Server" badge). "Đẩy lên Drive" on a file retries by hand. A successful push also replaces the app URL on an already-approved line/order.
- Previews: images/PDF streamed from Drive through `/api/design-studio/file/<id>`; PSD/ZIP redirect to the Drive page. On approval the line's `designDriveLink` is the Drive link (what the supplier CSV exports).
- Connect once on `/setup` → "Google Drive (lưu artwork)" (SUPERADMIN):
  1. Google Cloud Console → new project → enable **Google Drive API**.
  2. OAuth consent screen: External, add scope `.../auth/drive.file` (plus `openid`, `email`), **Publish app** (In production) — `drive.file` is non-sensitive, so no verification and no 7-day token expiry.
  3. Credentials → OAuth client ID → Web application; redirect URIs `http://localhost:3002/api/auth/google/callback` and `https://pod.thecrafthousellc.com/api/auth/google/callback`.
  4. Paste Client ID/Secret on the Setup card, Save, then "Kết nối Google Drive" with the Google account that should own the files.
- `drive.file` limitation: the app only sees files it created — files dropped into Drive by hand are invisible to it; upload through the tool.
- Changing the Client ID clears the connection (reconnect).

## Drive connection by credential file, streamed upload, push queue (2026-10-13, branch `feat/trello-cutover`)

No schema change. New `AppSetting` keys: `google.drive.quota` (JSON `{limit, usage, checkedAt}`, `limit` null = unlimited), `google.drive.testFileId`, `last_drive_push_result`.

- **Connect with an existing credential** (`src/lib/google-drive-connect.ts`, `POST /api/setup/google-drive/connect-token`, SUPERADMIN). Body `{tokenJson}` (text of `google_drive_token.json`, the Google "authorized user" format) or `{clientId, clientSecret, refreshToken}`; an OAuth client file (`{installed|web: {...}}`) works with a separate `refreshToken`. Limit 16 KB. Before anything is stored the server exchanges the refresh token at Google's token endpoint (the file's `token_uri` is ignored), requires scope `drive.file` or `drive`, reads `about` (account + quota) and finds or creates the root folder "Design Studio". Errors are Vietnamese (`invalid_grant`, `invalid_client`, `unauthorized_client`, missing scope, what Drive answered). A desktop ("installed") client only works this way; the Google sign-in button needs a Web client. Both write the same settings, the last one wins.
- **`drive.file` and switching keys.** The app only sees files created by the same OAuth client. After connecting with a different client or account, artworks pushed earlier still open by their Drive link, but the in-tool preview of those files (streamed through the API) can fail; the connect response carries a `warning` when that applies.
- **Test file.** `POST /api/setup/google-drive/test` uploads a 1×1 PNG to the root folder, shares it anyone-reader and returns `{fileId, name, link}`; `DELETE` removes it (the id is kept in `google.drive.testFileId`, so the route can never delete an artwork). A failure returns `error` (wrapped) + `googleMessage` (verbatim).
- **Upload.** `PUT /api/design-studio/tasks/[key]/artwork?printArea=&fileName=` with the raw file as body. Streamed to `storage/tmp` with a running 200 MB cap, then hard-linked into the usual `design/<order>/<line>/<area>/v<N>-<file>` path (never in memory). The line is found by task key (`orderId` + `shopifyLineId`): `OrderLine.id` changes on every order sync, which is why uploads on a long-open task used to answer "Line not found". The path is excluded from the middleware matcher (Next 14.2 buffers the body for middleware); the route calls `requireApiAccess`. Types: png, jpg/jpeg, pdf, psd, zip, tif/tiff — by extension; a name with any other extension is refused whatever mime the browser sent. TIFF is treated like PSD/ZIP (no thumbnail, Drive page on click).
- The old multipart route `POST /api/design-studio/lines/[lineId]/artwork` still exists and still pushes inside the request; nothing in the UI calls it. It cannot recover from a stale line id (a deleted row id carries no order or line).
- **Background push.** The upload answers as soon as the file is stored (`storage: LOCAL`, "Server" badge). `enqueueDrivePush` (`src/lib/drive-push-queue.ts`) then pushes it; the task page re-reads the task a few times (4 s … 2 min) so the badge turns "Drive". AUTO renders use the same call. All queued pushes run on one in-process chain, so one 8 MB chunk is in memory at a time.
- **Queue.** `pushPendingArtworksToDrive({limit, force})`: non-removed `DesignArtwork` with `storage = LOCAL`, oldest first, one at a time. `pushArtworkToDrive` keeps its per-artwork in-process lock, so the queue, the per-upload push and the "Đẩy lên Drive" button never push the same file twice. A file whose push failed is skipped by scheduled runs for 30 min, doubling up to 6 h (in-process memo; `force` ignores it). A file missing on disk is counted as `missing` and skipped. Five failures in a row end the run (`too_many_failures`). A revoked token sets `google.drive.needsReconnect` and stops everything until reconnected.
- **After a push** the Drive link replaces: the app URL on the approved line and order; the public URL (`/api/public/artwork/<token>/…`) inside `SkuSupplierDesign.designLink` written by `studio-library.ts`; the same public URL on lines/orders that took their design from that library row.
- **Scheduler.** `initDrivePushScheduler` (`src/lib/drive-push-scheduler.ts`, registered after the `DISABLE_SCHEDULERS` return), cron `4-59/10 * * * *`, 20 files a run, only while connected and not `needsReconnect`. Lock `drive-push` (`runExclusive`), result in `last_drive_push_result`, quota snapshot refreshed in the same job.
- **Bulk push.** `POST /api/setup/google-drive/push-local` (ADMIN+, 202) starts a full forced run in the background, or queues one behind the run in flight; `GET` returns `{pending, running, queued, pushed, failed, missing, lastError, stopped, trigger, startedAt, finishedAt, uploadError}`.
- **Health banner.** `GET /api/design-studio/drive-health` → `{state, pending, quota, quotaWarning, canConnect, canPush}` from the database only (no Google call). The Design Tasks header shows: not connected (neutral, Setup link for SUPERADMIN), needs reconnect (error), quota above 90 % (warning), N files waiting (with "Đẩy ngay" for admins).
- **Not handled.** Background push failures are only visible through the banner count and the Setup card ("Lỗi gần nhất"); the designer gets no per-file warning. Locks and the back-off memo are per process (one PM2 instance). `pending` counts LOCAL rows, including ones whose file is missing on disk. `LibraryFile` (PSD/font) pushes are unchanged and not part of the queue.
- **Rollout.** nginx must allow 200 MB bodies on the new path (`client_max_body_size`) and should not buffer them to memory. After deploy: Setup → Google Drive → "Chọn file google_drive_token.json" → "Tạo file thử" and open the link in a private window → "Đẩy tất cả file còn trên server lên Drive".

## One task = one Drive folder (2026-10-14, branch `feat/task-folder`)

Where this section disagrees with the Design Studio / Drive sections above, this section is the current behaviour. Migration `20261013215236_task_folder` (three `ADD COLUMN` groups + the unique index swap, no table rebuild): `DesignArtwork.kind` (`PRINT` | `MOCKUP`, default `PRINT`), `DesignArtwork.drivePlace`, `DesignArtworkUpload.kind`, `DesignTask.driveFolderId` / `driveFolderUrl`; unique key is now `[orderId, shopifyLineId, kind, printArea, version]`. `SCHEMA_VERSION` `v67`.

- **Files of a task** (`src/lib/task-files.ts`, pure, shared by server and UI). A file is identified by `(kind, printArea)`; `printArea` is the "part". Any number of parts per task. The current file of a part = its newest non-removed version; older versions stay as history.
- **Upload** `PUT /api/design-studio/tasks/[key]/artwork?fileName=&kind=PRINT|MOCKUP[&printArea=]`. With `printArea` the file goes to that part as given (a template area, or "Thay file" on an existing part). Without it the part is the file name without extension (trimmed, max 60, `Artwork` when empty), matched case-insensitively to a template area first, then to a part the task already has. So `front.png` + `back.png` + `sleeve.png` are three files, a second `front.png` is v2 of `front` — and so is `front.psd` (same name, other extension). Mockups: PNG/JPG only; they live on disk under `…/<line>/_mockup/<part>/`.
- **Required files.** `requiredSlotsFor(template)` = the template's areas, `[]` without a template. A template task needs a print file for every area; a task without a template needs at least one print file (`printFilesReady`). `_print_files` areas of a no-template line are no longer required slots. Mockups never count. Messages: `Chưa có artwork cho: <areas>` / `Chưa có file in nào — upload ít nhất một file in`.
- **Rename** `PATCH /api/design-studio/tasks/[key]/parts {kind?, from, to}`: every version of the part (removed ones too) takes the new label; 409 when another part has that name (case-insensitive) or the task is DONE. The UI offers rename on extra parts and mockups, not on template areas.
- **Folder** (`src/lib/task-folder.ts`). `ensureTaskFolder`: path `Design Studio/<Store>/<YYYY-MM>/<Order>/<TaskKey>`, created at the first push of the task, shared anyone-reader once, then id + url are stored on `DesignTask` and reused (a later store rename does not move it). Files are no longer shared one by one (they inherit); a line without a task keeps the old behaviour (`v<N>-<file>`, file shared). Names in the folder: `<part>.<ext>`, mockups `MOCKUP_<part>.<ext>` (`driveFileName`; `\ / : * ? " < > |` become `_`). AUTO renders go to the same folder as `<area>.png`.
- **`drivePlace`**: `TASK` (in the folder under its current name), `OLD` (in `_old`), `STUCK` (Drive answered 404/403 — the app cannot move it), `null` (unknown: pushed before this change, renamed, or a move that failed). `tidyTaskFolder(orderId, shopifyLineId)` makes Drive match the task: current files → folder, superseded and removed files → `_old` as `v<N>_<name>` (created lazily), one run at a time per task. It runs before and after every push, after a delete and after a rename (`enqueueFolderTidy`). A superseded version still on the server is pushed straight into `_old`. Deleting the newest version brings the one before it back into the folder.
- **Reorganise** ("Sắp xếp lại thư mục"): `reorganiseTaskFolders` inside `pushPendingArtworksToDrive` visits tasks that have a Drive file with `drivePlace = null` — 20 tasks on a scheduled run, everything on the bulk button (which also retries `STUCK`). 404/403 → `STUCK` + one SYSTEM event on the task ("… — file giữ nguyên chỗ cũ"); other errors leave `null` for the next run. Summary/status gained `organized` and `stuck` (Setup card).
- **Design link.** `folderHoldsPrintFiles`: every current print file is `DRIVE` + `TASK` and no superseded/removed Drive file is outside `_old`. `updateLine(done:true)` stores the folder URL when that holds, else the single-file link of the first print file (template order, then by name) as before. `promoteFolderLink` (end of every tidy) turns app paths, Drive file links and public URLs of the task's files into the folder URL on the line, the order, `SkuSupplierDesign` and lines/orders that reused that row. `saveStudioDesignToLibrary` writes the folder URL when it holds. `isStudioLink` and the DONE "external link" check know the folder URL.
- **Export.** Stored link = task folder → `line.designDriveLink` / `line.designLinks` export it as is. Otherwise one link per print part, joined: template areas in template order, then the other parts by name (extra parts are now included). `line.designArea:<part>` = that part's own file. `line.mockupLink` = newest uploaded mockup (Drive link, or public URL — approved lines only, else 400), else `previewCdnUrl`, else `imageUrl`. Links are resolved per column kind (`ExportLinkNeeds`).
- **PGprints.** `fileUrls`: one public URL per print part in the same order; an extra part on a template line is a warning `EXTRA_FILE`; no print file at all is `NO_ARTWORK`. `mockupImages`: uploaded mockups (public URLs, newest first), else the preview/product image.
- **UI.** "File của task" card (was "Artwork theo panel"): folder link, print files, mockups, multi-file drop zones, per-file progress (`useArtworkUpload.uploadFiles`, sequential). The canvas takes several files at once; the "Mockup xưởng" pane has its own upload + drop zone and shows uploaded mockups first. Checklist: "File in" (no template: ≥ 1 print file), "Mockup xưởng" done with a mockup file or a preview/product image, optional — never "the next step".
- **Not handled.** No browser click-through yet. An upload on a DONE task is not refused (the old version leaves the folder at once). The folder is not renamed when the task key or store name changes. Locks are per process. A mockup still on the server does not hold the folder link back.
- **Rollout.** `npx prisma migrate deploy`, restart. The first scheduled runs move already-pushed files into place (they sit in the same folder path under `v<N>-…` names) and share each task folder; "Đẩy tất cả file lên Drive & sắp xếp lại thư mục" does it in one go.

## Export per line and per supplier (2026-10-14, branch `feat/line-export`)

Migration `20261014104355_line_export` (two `ADD COLUMN` + one index, no rebuild): `OrderLine.exportedAt`, `OrderLine.exportedToSupplierId` (plain column + index, like `resolvedSupplierId`). `SCHEMA_VERSION` `v68`. Order sync carries both by `shopifyLineId`.

- **Rules** (`src/lib/line-export.ts`, pure). Lines a supplier must receive = production lines (`isNonProductLine` false) with a resolved supplier. `markOrdersExported(orderIds, supplierId, at, handoff?, {lineIds?})` marks that supplier's unsent lines (the CSV route passes the lines that were in the file). The order turns `EXPORTED` (+ `exportedAt` / `exportedToSupplierId` = that supplier, + handoff when given) only when every such line is sent; until then it stays `READY_TO_PRODUCTION` and the order-level export fields are untouched — `Order.exportedAt` now means "fully sent at", no screen reads it otherwise.
- **Legacy.** An order with `exportedAt` and no line mark, not in `READY_TO_PRODUCTION` / `PENDING_DESIGN` / `DESIGN_REJECTED` / `PENDING_MAPPING`: lines of `exportedToSupplierId` count as sent; in an `EXPORTED` order the other suppliers' lines count as sent too (status quo). The first new mark on such an order writes those legacy marks first. `scripts/backfill-line-export.mjs` writes the same marks.
- **Export page.** Selection is by line supplier (`lineSupplierId`), no longer `defaultSupplierId`, so mixed orders reach every supplier. Sent lines are left out ("Bỏ qua N dòng đã xuất…") unless "Xuất lại cả dòng đã xuất" (`reExport`); re-sent lines keep their first export time. Preview per order: the supplier's lines (included / đã xuất / xuất lại), "Đã xuất 1/2 xưởng", "Đơn có 2 xưởng: Mangoshao (dòng 2) · Jomall (dòng 3)" (dòng = `linePosition`). Download answers `X-Export-Lines-Marked`, `X-Export-Orders-Completed`, `X-Export-Orders-Partial`.
- **Orders list.** A partly sent Ready order shows "Đã xuất 1/2 xưởng" (indigo) in the status select + one chip per supplier; the Ready tab shows "N đã xuất 1 phần" (`partiallyExported` in `/api/fulfillment/status-counts`; `EXPORTED` still counts only fully sent orders). Order detail has a "Xuất xưởng" column.
- **Hand-set status.** → `EXPORTED` marks every unsent line for its own supplier; `EXPORTED` → `READY_TO_PRODUCTION` clears every line mark (reopen for all suppliers). Re-approval after `DESIGN_REJECTED` clears every line mark (all tasks were reopened).
- **PGprints.** Push marks its lines at `pushedAt` (`prevExportJson.linesMarked`); the mixed-supplier block stays. Cancel unmarks lines with that supplier + `pushedAt`, except when the order was re-marked Exported since. Handoff "Hoàn tác" never touched exports and still does not. `reconcile-pushed-orders.mjs` marks the lines too.
- **Chuyển xưởng.** A partly sent order stays listed (it is still Ready); the card shows "Đã xuất 1/2 xưởng — còn chờ: Jomall" and "Đã xuất <xưởng>" on sent lines.
- **Not handled.** Profile re-resolve and order sync may re-map a sent line; it stays sent (to `exportedToSupplierId`). A hand-set reopen reopens every supplier — use `--reopen` for one order's other suppliers.
- **Rollout.** `npx prisma migrate deploy`, restart, then `DATABASE_URL=file:<db> node scripts/backfill-line-export.mjs` (dry run, read the "Cần kiểm tra" list), `--apply`, then for orders whose other-supplier lines were really never sent: `node scripts/backfill-line-export.mjs --apply --reopen LIT4628,LIT4528,…` and export those suppliers.

## Customall typed text in Design Studio (2026-10-16, branch `feat/line-export`)

Customall-app orders (vendor `customall`) carry no readable text, only `_customallcustomid` + an 800×800 mockup in `_customall_print_file`; designers read names off the picture (#LIT4156: "IANETTA" read as L). Migration `20261016143942_order_line_customall_fields` adds `OrderLine.customallFieldsJson` (`null` = not read yet, `[]` = nothing typed); `SCHEMA_VERSION` `v69`. New deps `lz-string`, `jsonpack` (deploy needs `npm install`).

- **Source** (`src/lib/customall-fields.ts`). `order-info/<hex({customization_id})>` on apis-v2.customall.io gives `{artworkId: {template, layerId: value}}`; the field names come from the product's campaign (`hash/<shop>/<pid>` → `<shop>/<pid>/<hash>`, lz-string + jsonpack). Text layers → value, Option layers → option label, picture layers left out, values trimmed, a layer missing from today's campaign shows as `Layer <id>`.
- **When it is read.** Order sync (after `upsertOrderWithLines`), the 15-minute design-task sync (open tasks + 100 newest orders), opening a task / order workspace — each only for lines still `null`, at most once per 6 h per customization id when Customall fails (it answers 500 for an unknown id). "Nạp lại từ Shopify" reads every Customall line of the order again. The value survives re-sync like `designNote`.
- **Shown** as normal personalization rows (task table, review, handoff) with a "Customall" pill; a line not read yet says so instead of "Khách không nhập gì" and the checklist asks for a reload.

## Customer Service agent (2026-10-23, branch `feat/cs-agent`)

Spec: `docs/superpowers/specs/2026-10-23-customer-service-agent-design.md`. Freshdesk (`litzzy.freshdesk.com`, Litzzy only) → `CsTicket`/`CsMessage` → Claude analysis (`CsAnalysis`) → Freshdesk write-back, Telegram, optional auto-reply. Pages `/cs`, `/cs/[id]`, `/cs/cases`, `/cs/settings`; permission `cs` (ADMIN + SUPPORT by default; existing users need it added in Setup → Users).

- **Settings** live in AppSetting `cs.settings` (JSON, `src/lib/cs/settings.ts`) + secrets `cs.freshdeskApiKey` / `cs.anthropicApiKey` / `cs.kieApiKey` (env fallbacks `FRESHDESK_API_KEY`, `ANTHROPIC_API_KEY`, `KIE_API_KEY`). `llmProvider` picks who serves Claude: `kie` (default; Anthropic Messages protocol at `https://api.kie.ai/claude`, bearer token, same model ids — `src/lib/llm/anthropic.ts` `claudeLlm`) or `anthropic`. No key for the selected provider = sync only, no analysis, nothing written to Freshdesk. 2026-10-24: the owner's Kie key answered 401 "not authorized to use this model" for every chat model (images work) — chat access must be enabled on the key at kie.ai/api-key; structured output (`output_config.format`) through Kie is still unverified, "Test kết nối" in Cài đặt CS is the check.
- **Loop** (`src/lib/cs/scheduler.ts`): every 2 min `runAgentCycle` = `syncTickets` (cursor `syncUpdatedSince`, first run 7 days back) → for each ticket with new customer text: `analyzeTicket` → Telegram (`notifyLevels`) → Freshdesk priority/tags (`em-*`)/`cf_order_id`/private note (only when summary+proposal+urgency changed, hash in `lastNoteHash`) → `autoReply` only when the policy gate (`src/lib/cs/policy.ts`) allows. Daily digest 09:00. Manual: "Đồng bộ ngay" (`POST /api/cs/sync`), "Phân tích lại" per ticket.
- **Freshdesk budget**: the plan allows ~40 req/min, the client stops at 25 per cycle (`FreshdeskBudgetExceeded` → `CsAgentRun.partial`, cursor advances to the last fully processed ticket, the rest come next cycle). Conversations are fetched before the ticket row is marked updated, so a failure never leaves a ticket without its thread. Freddy shadow agents `158024416092/3` are skipped; the human agent is `158024049112`.
- **Urgency** = max(model, rules in `src/lib/cs/triage.ts`): address change / cancel before factory handoff → URGENT; defects, wrong/missing items, refund asks, dispute threats → HIGH; +1 level after 24 h unanswered. Factory state comes from the local `Order` (`supplierHandoffAt`, `pipelineStatus`, `SupplierOrderPush`, `Shipment`).
- **Auto-reply gate**: enabled + category allowed (default `ORDER_STATUS` only) + customer's first message + no reply yet + order matched (EXACT or single BY_EMAIL) + sentiment not ANGRY/DISPUTE_THREAT + no refund/address/cancel wording + tracking or within production+shipping window + daily cap + (non-baseline category needs an active `CsCase`). Kill switch in settings. Replies go out from the support agent, status → 6, tag `em-auto-replied`.
- **Case library** (`CsCase`): the prompt lists active cases with ids; the model cites `citedCaseIds`. "Lưu thành case mẫu" after a staff reply creates an inactive `PROMOTED` draft to edit in `/cs/cases`.
- **Rollout**: deploy with poll on, auto-reply off; review a week of summaries; then enable `ORDER_STATUS` auto-reply; fill the library before widening. Tests: `tests/cs-*.test.ts` (fixtures in `tests/fixtures/cs`, anonymised copies of real tickets 119/194/195).
