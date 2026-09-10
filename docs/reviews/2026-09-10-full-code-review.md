# Full Code Review — 2026-09-10

Scope: toàn bộ `src/`, `prisma/`, `scripts/`, `tests/`, config. Baseline: `main` @ `ad59cc9` + diff chưa commit (spy media cache).
Phương pháp: tsc / lint / vitest + 7 lượt review theo mảng (auth, Shopify/orders, Meta/finance, spy, fulfillment, frontend, infra) + review riêng diff chưa commit. Các finding Critical đã được xác minh lại trực tiếp trong code.

## 0. Kiểm tra máy

| Check | Kết quả |
|---|---|
| `tsc --noEmit` | pass |
| `next lint` | 6 errors (`react/no-unescaped-entities` ở `fulfillment/auto-fulfill/page.tsx:139`, `fulfillment/tracking/page.tsx:449`), 10 warnings (unused vars, missing deps). Build không fail vì `eslint.ignoreDuringBuilds: true`. |
| `vitest run` | 487 pass / 2 fail (`order-profit.test.ts`, đã biết là pre-existing) |
| Diff chưa commit | `.gitignore`, `AdDetailModal.tsx`, `scan-ads.ts` + 2 script untracked; snapshot test chỉ khác CRLF |

---

## 1. CRITICAL (sửa ngay)

### C1. `/api/users` không kiểm tra role — bất kỳ user đăng nhập nào cũng đổi được mật khẩu SUPERADMIN
`src/app/api/users/route.ts:35-60`, `src/app/api/users/[id]/route.ts:5-13`. Middleware chỉ xác minh có JWT hợp lệ. SELLER có thể `PATCH /api/users/<superadmin-id> {password}` rồi đăng nhập làm admin, hoặc `POST /api/users {email:<superadmin email>, role:'ADMIN'}` để hạ cấp SUPERADMIN (nhánh `update` của upsert, dòng 47).
**Fix:** helper `requireRole(req, 'SUPERADMIN')` (đọc lại role/status từ DB, không tin JWT) gọi ở mọi handler; cấm đổi role/status của row SUPERADMIN.

### C2. `/api/trello/config` GET trả raw `apiKey` + `token` cho mọi user
`src/app/api/trello/config/route.ts:13-17`. **Fix:** trả `hasToken`/masked như `spy/config` và `parcelpanel-config` đang làm; POST chỉ cho SUPERADMIN.

### C3. Refund bị trừ hai lần → expectedPayout âm
`src/lib/shopify-orders.ts:172` lấy `grossAmount = currentTotalPriceSet` (Shopify: đã trừ refund), rồi `src/lib/pl-calculator.ts:52` trừ tiếp `refundedAmount`. DB thực tế: `#LIT2224` gross=0, refunded=106.97, expectedPayout=**-110.37**; 4 đơn tổng -207.49 chảy vào `plSummary`, `computeProjectCashflow`, `pendingPayout`. Cùng lỗi ở `sync-shopify-orders.ts:40`.
**Fix:** dùng `totalPriceSet` làm gross và giữ phép trừ refund (hoặc giữ `currentTotalPriceSet` và bỏ trừ). Thêm regression test cho payout âm.

### C4. `PARTIALLY_REFUNDED` bị coi là `REFUNDED` (terminal)
`src/lib/pipeline-status.ts:81` `fs.includes('REFUND')`. Refund tiền ship hoặc 1 line → cả đơn bị loại khỏi revenue, tasks, normalize, tab active; hàng còn lại không bao giờ được export/fulfill. 3 đơn trong DB đang bị vậy.
**Fix:** `fs === 'REFUNDED'`; PARTIALLY_REFUNDED xử lý như PAID (+ warning). Thêm test case.

---

## 2. HIGH

### Bảo mật / phân quyền
- **H1.** Phân quyền chỉ ở client: 104 API route, chỉ 11 đọc token, 0 route check `FeaturePermission`; `RoleGate` bọc 8/37 page. SELLER có thể `POST /api/auth/shopify-config`, `DELETE /api/auth/status`, `POST /api/spy/config` (ghi đè Apify token), `POST /api/tools/telegram`, `DELETE /api/meta/accounts` (xoá MetaBilling/DailyAdSpend), `POST /api/fulfillment/auto-fulfill/run?apply=1`, `POST /api/fulfillment/orders/bulk-status`. **Fix:** `src/lib/api-auth.ts` với `requireFeature(req, 'setup_meta')` map route → permission, áp lên mọi route mutating.
- **H2.** JWT 7 ngày, role/status không bao giờ re-check từ DB (`src/lib/auth.ts:22`, `middleware.ts:18`); deactivate/xoá user không có tác dụng tới khi token hết hạn; `/api/auth/me:20` trả payload cả khi user đã bị xoá. **Fix:** load user theo `payload.userId` trong helper auth; thêm `tokenVersion`/`passwordChangedAt`.
- **H3.** Cookie session thiếu `secure: true` (`api/auth/login/route.ts:34-39`); không rate-limit login; min password 6 ký tự.
- **H4.** `RoleGate.tsx:37`, `Sidebar.tsx:57`: `role = user?.role ?? 'SUPERADMIN'` — `/api/auth/me` lỗi thì client fail-open.
- **H5.** Secret lộ ra browser: Shopify API secret trong `localStorage` (`setup/page.tsx:58`), access token trong cookie 90 ngày không `secure` (`auth/shopify/callback:48-49`) và server tin cookie `shopify_shop`/`shopify_token` do client gửi để seed connection toàn app (`token-store.ts:74-81`); proxy `user:password` in plaintext ở `tools/resources/page.tsx:297-301`.

### Shopify / order pipeline
- **H6.** Rolling window sync lọc theo `created_at` (`orders/sync/route.ts:141`) nên refund/cancel trên đơn cũ hơn 3 ngày **không bao giờ** được sync lại. **Fix:** dùng `updated_at:>=` cho rolling window.
- **H7.** Pagination lỗi vẫn `syncSinceDate = now()` (`orders/sync/route.ts:179-186, 478-485`) → mất đơn; route trả 200 dù có errors nên `auto-sync` coi là thành công. **Fix:** chỉ stamp khi `errors.length === 0`; trả non-2xx.
- **H8.** Route legacy `/api/shopify/sync-orders` + `src/lib/sync-shopify-orders.ts` vẫn sống, `deleteMany + create` lines không giữ `resolvedBaseCost/manualBaseCost/designDriveLink` → 1 POST xoá sạch snapshot cost. **Fix:** xoá file + route.
- **H9.** `autoDetectStatus` trong sync không truyền `fulfillmentStatus` (`orders/sync/route.ts:301-309`) → 700 đơn FULFILLED vẫn ở PENDING_DESIGN/PENDING_MAPPING. Normalize cron 02:00 chưa từng chạy trên DB này.
- **H10.** Đơn chưa thanh toán (PENDING/AUTHORIZED/EXPIRED) vẫn thành READY_TO_PRODUCTION và tính revenue. **Fix:** map sang ON_HOLD, loại khỏi revenue.

### Meta / finance
- **H11.** Dedup billing theo `amount + currency + billingDate ±1 ngày` (`meta-billing-sync.ts:466-478`, `meta/import/route.ts:180-193`) bỏ rơi các charge threshold cùng số tiền ngày liên tiếp → under-count spend. **Fix:** dedup theo `id`/`referenceNumber`.
- **H12.** Lookup import-duplicate không lọc `status` → row import PENDING chặn row scrape PAID, kẹt PENDING mãi.
- **H13.** `repos/reports.ts:176` lọc `status: 'SETTLED'` nhưng không có gì ghi SETTLED (sync ghi PAID) → `metaAdSpend` luôn 0 ở `GET /api/projects/[id]/pl`. Danh sách `['PAID','SETTLED','COMPLETED']` đang copy ở 4 file — extract constant.

### Fulfillment / tracking
- **H14.** `tracking-sync.ts:40-50` + `repos/shipments.ts:29-47`: Shopify lỗi giữa chừng → `break` rồi upsert mọi đơn chưa fetch với `fulfillments: []` → **reset tracking về null** cho toàn bộ đơn ở các trang sau. **Fix:** abort khi có errors; không bao giờ downgrade row đã có tracking number.
- **H15.** Toggle Ready ở design-library gửi `{sku, supplierId, ready}` nhưng route coerce `designLink`/`note` thiếu thành `null` và repo ghi `null` → **xoá designLink/note**, ép `source='MANUAL'` (`api/fulfillment/design-library/route.ts:25-27`, `repos/design-library.ts:74-77`).
- **H16.** `push-lastmile.ts:97` `found.find(exact) ?? found[0]` → `#LIT249` không tồn tại thì ghi tracking vào `#LIT2490`.
- **H17.** Export không có filter status mặc định, mark-exported set `EXPORTED` cho cả PENDING_DESIGN/PENDING_MAPPING/ON_HOLD/FULFILLED/CANCELLED (`api/fulfillment/export/route.ts:19-26,126-138`) — bypass gate design/mapping vĩnh viễn.
- **H18.** `saveManualMapping` ghi `resolvedBaseCost` nhưng không ghi ship/import-tax snapshot; recalc chỉ visit line `resolvedBaseCost: null` → line manual-map không bao giờ có phí ship → P&L overstated (`repos/mapping.ts:217-224`).

### Spy / memory (liên quan OOM 3GB)
- **H19.** `/api/spy/ads` và `/trending` `include: { observations }` không `take` (`api/spy/ads/route.ts:44-52`); mỗi ad tích 1 observation/ngày, không bao giờ prune → sau D ngày, `limit=2000` load 2000×D row mỗi lần render. **Ứng viên số 1 cho leak.** **Fix:** chỉ lấy first/last observation (hoặc precompute cột trên SpyAd) + retention job.
- **H20.** `rawPayload` (full Apify item) load cho mọi row rồi strip ở JS (`ads/route.ts:44-61`, `trending:18-29`, `ads/[id]`). Hàng chục MB/request; chặn connection libsql → khớp `P1008 SocketTimeout` trên prod. **Fix:** `omit: { rawPayload: true }`.
- **H21.** `POST /api/spy/scan-ads` không `pageId` → `void runPageAdScan` cho **mọi** target song song, không giới hạn; quota tính 1. **Fix:** chạy tuần tự/p-limit, reject khi có scan `running`.
- **H22.** Domain scan auto-tạo `SpyPageTarget` `active: true` cho mọi advertiser (`scan-ads.ts:61-69`) → cron 09:00 chạy Apify 200-ad cho từng fanpage rác mỗi ngày. **Fix:** tạo `active: false`.
- **H23.** Cron spy không `noOverlap`, Apify fetch không timeout (`spy/scheduler.ts:53`, `apify.ts:15,26,33`) → sweep >24h chồng lên nhau.
- **H24.** Production bundle chứa **nhiều bản copy** của `spy/scheduler.ts` và `db.ts` (instrumentation chunk vs route chunk); `tasks`/`initialized` là module-local nên `reloadSpyScheduler()` từ `/api/spy/cron` không stop được task boot-time → nhân đôi scan; 2 PrismaClient/process. `db.ts` chỉ pin `globalThis` ở dev. **Fix:** pin scheduler state + Prisma lên `globalThis` mọi env (pattern có sẵn ở `meta-billing-sync.ts:74-78`).

### Infra / test
- **H25.** Integration test chạy thẳng vào `dev.db` thật và để lại data (`tests/shopify-orders-sync.integration.test.ts`, `tests/manual-base-cost.integration.test.ts`): `proj_test`, `proj_mbc`, 2 store test đang tồn tại trong DB, lọt vào snapshot/overview. Chạy `npm test` trên VPS sẽ seed vào prod. **Fix:** `globalSetup` set `DATABASE_URL` temp + `migrate deploy`; cleanup `afterAll`.

### Frontend
- **H26.** `finance/other-bills/page.tsx:201` `e.currentTarget.reset()` sau `await` → TypeError mỗi lần lưu thành công, `saving` kẹt true, form không clear.
- **H27.** `orders/export/page.tsx:529` key = header đang edit → mất focus sau mỗi ký tự.
- **H28.** `projects/page.tsx:205-219` fetch analytics không `res.ok`/catch/seq-guard → 4xx làm `analytics.dateRange.start` throw, cả page rơi vào `error.tsx`; loading kẹt khi network lỗi.
- **H29.** `fulfillment/page.tsx:31,37` link tới `/fulfillment/products` và `/fulfillment/costs` không tồn tại (404).

---

## 3. MEDIUM (chọn lọc)

**Bảo mật:** SSRF ở `fulfillment/crawler` (`shopify-crawler.ts:79-85`, echo body upstream) và `parse-sheet.ts:54`; Shopify OAuth `shop` không validate `*.myshopify.com` → open redirect, `timingSafeEqual` throw khi length lệch (`auth/shopify/route.ts:31,54`, `callback:8-32`); `shopify/debug` route lộ balance cho mọi user; XSS phản xạ trong HTML callback; Telegram webhook dead + không check secret; thiếu security headers.

**Shopify/orders:** lines bị delete/recreate mỗi sync → `OrderLine.id` đổi, recalc/PATCH line-cost/task-fix có thể P2025 (`repos/orders.ts:153-270`); không có lock sync đồng thời (Trello card tạo 2 lần); không xử lý 429/THROTTLED ở cả REST lẫn GraphQL; `lineItems(first:50)`/`refunds(first:10)` không paginate; ~8 query/order (N+1); `recalculateMissingOrderLineCosts` scan toàn lịch sử; normalize cron re-fetch toàn bộ order từ đơn open cũ nhất; filter ngày dùng UTC midnight dù có `shopTimezone`; `cancelledAt` không fetch nên đơn cancel-không-refund vẫn export; bank account id GID vs numeric không bao giờ khớp.

**Meta/finance:** `verify-spend` không follow `paging.next` (25 row default) + NaN → 500; insights sync không retry rate-limit và vẫn stamp `lastSyncAt`; `plSummary` bị cắt 500 đơn; overview mix payout floor 2026-02-02 với billing all-time, không loại REFUNDED/CANCELLED, bucket UTC vs tz; snapshot backfill ghi đè giá trị lịch sử bằng số hiện tại; `getVndCardLast4()` full-scan mỗi request; `DELETE /api/projects` hard-delete trái thiết kế soft-delete (FK error 500); coverage billing chỉ lưu khi cả range xong.

**Fulfillment:** manual mapping set PENDING_DESIGN thay vì PENDING_MAPPING (mất khỏi queue); Trello `startsWith(orderNumber)` match `#LIT2500` cho `#LIT250`; `1023_1` match `1023_10`; CSV không chống formula injection; tracking sync 03:00 ghi đè status ParcelPanel; ParcelPanel sync không giới hạn ngày; auto-fulfill "first sheet wins" bỏ line; PARENT match `startsWith` không boundary; `preferenceRank` cao-hơn-thắng ở 2 chỗ, thấp-hơn-thắng ở 1 chỗ.

**Spy:** Apify timeout không abort run (tiền tiếp tục cháy); page excluded vẫn scan; `spy/config`, `spy/cron`, `tools/telegram` không check role; `downloadAndCache` không cap size/allowlist host; `spyCache.domains` không evict; `getDatasetItems` không paginate.

**Infra:** WAL không enforce (dev.db đang `journal_mode=delete`); `retryOnBusy` retry từng statement trong transaction (không thể clear `BUSY_SNAPSHOT`), batch `$transaction` không retry; thiếu index `OrderLine.orderId`, `Order.storeId`, `Order.shopifyOrderNumber`, `Order.trelloCardId`, `Payout(storeId,status,date)`, `MetaBilling(adAccountId,status,billingDate)`; thiếu `@@unique([orderId, shopifyLineId])`; characterization test phụ thuộc data live.

**Frontend:** filter client-side trên 1 trang server (`orders/page.tsx:171-177`); stale-response race ở 8 page; poll `/api/meta/sync` 2s mãi mãi; 2 template editor với `SOURCE_OPTIONS` khác nhau; destructive action không `confirm()` (xoá user, xoá design entry, select status đổi ngay); busy flag kẹt/lỗi nuốt ở nhiều form; responsive `w-[calc(100vw-280px)]` thiếu `lg:`; format ngày không thống nhất (raw ISO, "Sep 5, 2026", un-padded) trái rule MM/DD/YYYY; `fmtUSD` copy ở 5 page.

---

## 4. Diff chưa commit (spy media cache) — review riêng
- `media-cache.ts:52` `writeFileSync` không atomic + `isCached = size > 0` + route `Cache-Control: immutable` → file cụt khi PM2 kill sẽ được serve hỏng vĩnh viễn. **Fix:** tmp + rename, validate magic bytes.
- `scan-ads.ts:29,57` cap 80 < AD_SCAN_CAP 200; N scan song song → N×80 download trùng; await inline kéo dài scan trước khi mark success. Duplicate 4 dòng ở 2 hàm → `finalizeScan()` helper. Không có negative-cache → URL chết retry mãi.
- `tools/spy-idea/ads/[id]/page.tsx:46` vẫn render raw `mediaUrl` (consumer thứ 3 bị bỏ sót).
- `scan-ads.test.ts` không mock `media-cache` → in stack trace, wiring không được test.
- `scripts/cache-ad-media.py` là bản port Python của `media-cache.ts` (đã drift); `scripts/fix-sku-jeep-girl.mjs` one-off hard-code product + API `2024-04` + `products[0]` không xác nhận. `scripts/__pycache__/` chưa ignore.

---

## 5. Đề xuất thứ tự xử lý
1. **Tuần này:** C1, C2, H1–H4 (auth helper dùng chung + áp lên mọi route mutating; cookie `secure`), C3, C4, H6, H7.
2. **Tiếp theo (dữ liệu):** H9, H10, H11–H13, H14, H15, H17, H18, H25 (test DB riêng + dọn `proj_test`/`proj_mbc`).
3. **OOM/prod ổn định:** H19, H20, H21, H22, H23, H24, WAL enforce, index.
4. **UI:** H26–H29, race guard dùng chung, shared `format.ts`/`PageShell`, `confirm()`.

## 6. Điểm làm tốt
- `meta-billing-sync.ts`: adaptive range split, rate-limit backoff, job state persisted, restart detection.
- `build-fulfill-plan.ts` + `auto-fulfill.ts`: planner thuần, test dày, chỉ mark DB sau khi Shopify confirm.
- Cost-snapshot preservation theo `shopifyLineId` trong transaction; pure decision functions (`autoDetectStatus`, `computeWarnings`, `detectOrderTasks`) có unit test.
- Không có `$queryRaw`; `.env`/`dev.db`/credential scripts chưa từng commit; migration diff sạch; `normalizeStoreUrl` chặn private IP; `media-cache` sanitize adId; các config route spy/parcelpanel/telegram mask secret đúng cách.
