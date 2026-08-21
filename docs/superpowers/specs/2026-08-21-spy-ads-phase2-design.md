# Spy Tool — Phase 2: Facebook Ad Library (store ads) — Design Spec

**Date:** 2026-08-21
**Status:** Draft for user review
**Builds on:** `docs/superpowers/specs/2026-08-20-spy-tool-design.md` (Phase 1 shipped: DB with all 10 Spy models, store-products scanner, IDEA vault). This spec details Phase 2 = Ad Library scanning per store.

---

## 1. Mục tiêu

Scan **Facebook Ad Library** cho từng store để biết: ad nào đang running, ad nào mới, ad nào chạy lâu (winning), ad nào đang scale. Lưu bền vững + theo dõi theo thời gian, hiển thị trong UI, cho phép lưu IDEA.

Ngoài phạm vi Phase 2: keyword trending (Phase 3), auto-discover page từ website store.

---

## 2. Quyết định đã chốt

| Vấn đề | Quyết định |
|---|---|
| Nguồn | Apify actor `curious_coder/facebook-ads-library-scraper` (research Phase 1) |
| Cơ chế run | **Async + poll trong background job** (không webhook, không cần public URL) |
| Map store→page | **Nhập FB page URL/ID thủ công** cho mỗi store (model `SpyPageTarget`) |
| Scope | Store ads + ad detail + signals |

Actor output (đã xác nhận): `ad_archive_id`, `is_active`, `start_date`/`end_date` (unix), `total_active_time`, `collation_count`/`collation_id`, `page_id`/`page_name`, `advertiser.ad_library_page_info.page_info` (likes, category, ig_username…), `snapshot` (images/videos/cards, body, caption, cta_type/cta_text, link_url, title, display_format), `publisher_platform[]`, `currency`, `ad_library_url`. Giá ~$0.75/1K ads (pay-per-event).

---

## 3. Schema — thêm 1 model (migration)

Các bảng `SpyAd`, `SpyAdvertiser`, `SpyAdObservation`, `SpyScan` đã có từ Phase 1. Chỉ thêm `SpyPageTarget` (đầu vào scan: page cần scrape trước khi biết numeric `fbPageId`).

```prisma
model SpyPageTarget {
  id         String    @id @default(cuid())
  storeId    String?
  store      SpyStore? @relation(fields: [storeId], references: [id], onDelete: SetNull)
  pageUrl    String    @unique          // e.g. https://www.facebook.com/BrandName
  fbPageId   String?                    // backfilled after first scrape
  label      String?
  active     Boolean   @default(true)
  lastScanAt DateTime?
  createdAt  DateTime  @default(now())

  @@index([storeId])
  @@index([active])
}
```

Thêm quan hệ ngược `pageTargets SpyPageTarget[]` vào `SpyStore`.

Migration: `npx prisma migrate dev --name add_spy_page_target` → `npx prisma generate` → bump `SCHEMA_VERSION` trong `src/lib/db.ts` (`v24`→`v25`) → restart server.

Ghi chú ID: `SpyPageTarget` keyed bởi `pageUrl` (natural key, có trước scrape); `SpyAdvertiser` vẫn keyed bởi `fbPageId` (có sau scrape). Ingest nối 2 cái qua `fbPageId` và backfill.

---

## 4. Tầng Apify — `src/lib/spy/apify.ts`

Env: `APIFY_TOKEN`. Actor id: `curious_coder~facebook-ads-library-scraper`.

- `startActorRun(input: object): Promise<{ runId: string; datasetId: string }>` — `POST https://api.apify.com/v2/acts/curious_coder~facebook-ads-library-scraper/runs?token=…`, đọc `data.id` + `data.defaultDatasetId`.
- `getRunStatus(runId: string): Promise<string>` — `GET /v2/actor-runs/{runId}?token=…` → `data.status` ("READY"|"RUNNING"|"SUCCEEDED"|"FAILED"|"TIMED-OUT"|"ABORTED").
- `getDatasetItems(datasetId: string): Promise<any[]>` — `GET /v2/datasets/{datasetId}/items?token=…&clean=true`.
- `pollRunUntilDone(runId, { intervalMs = 10_000, timeoutMs = 300_000 }): Promise<string>` — poll `getRunStatus` tới terminal state hoặc timeout; ném lỗi nếu FAILED/TIMED-OUT/ABORTED hoặc quá timeoutMs.

Tất cả đọc `APIFY_TOKEN` từ env; nếu thiếu → ném lỗi rõ ràng "APIFY_TOKEN not set".

---

## 5. Ad mapping — `src/lib/spy/ad-mapping.ts` (thuần, test được)

```ts
export type ParsedSpyAd = {
  adArchiveId: string
  pageId: string
  pageName: string | null
  pageCategory: string | null
  pageLikes: number | null
  igUsername: string | null
  igFollowers: number | null
  isActive: boolean
  startDate: Date | null
  endDate: Date | null
  collationCount: number | null
  collationId: string | null
  mediaType: 'video' | 'image' | 'carousel' | 'dco' | null
  displayFormat: string | null
  ctaType: string | null
  ctaText: string | null
  linkUrl: string | null
  title: string | null
  body: string | null
  caption: string | null
  publisherPlatforms: string[]
  currency: string | null
  adLibraryUrl: string | null
  rawPayload: any
}
export function mapApifyAd(raw: any): ParsedSpyAd
```

Logic:
- `startDate`/`endDate`: `raw.start_date`/`raw.end_date` là unix seconds → `new Date(n*1000)` (null nếu falsy).
- `mediaType`: có `snapshot.cards?.length` > 1 → `carousel`; else `snapshot.videos?.length` → `video`; else `snapshot.images?.length` → `image`; `display_format==='dco'`/`dpa` → `dco`; else null. (Rút gọn: ưu tiên cards→video→image.)
- Advertiser fields từ `raw.advertiser.ad_library_page_info.page_info` (likes, page_category, ig_username, ig_followers) với fallback null.
- `publisherPlatforms`: `raw.publisher_platform ?? []`.
- `body`: `snapshot.body` có thể là object `{text}` hoặc string → chuẩn hoá về string.
- `rawPayload`: giữ nguyên `raw` (ingest sẽ JSON.stringify).

---

## 6. Ad ingest — `src/lib/spy/ingest-ads.ts`

`ingestAds(scanId: string, storeId: string | null, ads: ParsedSpyAd[]): Promise<{ found: number; newAds: number; updated: number }>`

Mỗi ad:
1. **Upsert `SpyAdvertiser`** theo `fbPageId = ad.pageId`: create/update pageName/category/likes/ig…, set `lastSeenAt=now` (firstSeenAt khi mới); nếu `storeId` truyền vào và advertiser chưa có store → set `storeId`.
2. **Upsert `SpyAd`** theo `adArchiveId`: set `advertiserId`, `pageId`, các field mới nhất (isActive, start/end, collation, creative…), `rawPayload=JSON.stringify`, `lastSeenAt=now`, `firstSeenAt` khi mới. Đếm new vs updated qua `findUnique` trước (như pattern `ingest-products`).
3. **Insert `SpyAdObservation`** `{ adId, scanId, isActive, collationCount, observedAt }` — `@@unique([adId,scanId])` đảm bảo idempotent (dùng upsert/skipDuplicates).

`publisherPlatforms`/tags lưu JSON string. Trả về counts cho `SpyScan.stats`.

---

## 7. Scan flow — `src/lib/spy/scan-ads.ts`

`runPageAdScan(pageTarget: { id: string; storeId: string | null; pageUrl: string }): Promise<{ scanId; status; stats?; error? }>`:

1. Tạo `SpyScan` `{ type:'STORE_ADS', targetType:'STORE', targetId: pageTarget.storeId ?? pageTarget.id, status:'running' }`.
2. `startActorRun({ urls:[{url: pageTarget.pageUrl}], 'scrapePageAds.activeStatus':'all', 'scrapePageAds.sortBy':'impressions_desc', 'scrapePageAds.countryCode':'ALL', count: AD_SCAN_CAP })`; lưu `apifyRunId`/`apifyDatasetId` vào SpyScan.
3. `pollRunUntilDone(runId)` → `getDatasetItems(datasetId)`.
4. `ads = items.map(mapApifyAd)`; `ingestAds(scanId, pageTarget.storeId, ads)`.
5. Update `SpyScan` success + `stats` JSON; update `SpyPageTarget.lastScanAt=now` và `fbPageId` (từ ad đầu tiên nếu chưa có).
6. Bất kỳ lỗi (token thiếu, run FAILED/TIMED-OUT, fetch) → `SpyScan.failed` + error; không ném ra ngoài (giống `runStoreProductScan`).

`AD_SCAN_CAP` mặc định 200 (const trong `src/lib/spy/ad-signals.ts` hoặc `AppSetting` key `spy_ad_scan_cap`).

---

## 8. Signals — `src/lib/spy/ad-signals.ts` (thuần, test được)

```ts
export function isNewAd(startDate: Date | null, now?: Date, windowDays?: number): boolean   // default 7
export function activeDays(startDate: Date | null, endDate: Date | null, now?: Date): number
export function isLongRunning(a: { isActive: boolean; startDate: Date|null; endDate: Date|null }, now?: Date, minDays?: number): boolean  // default 21
export function isScaling(observations: { collationCount: number|null; observedAt: Date }[]): boolean  // latest collationCount > earliest, or > threshold
export function isStopped(observations: { isActive: boolean; observedAt: Date }[]): boolean  // was active earlier, now inactive
```

Ngưỡng (7, 21, scaling threshold) là tham số có default; có thể chỉnh qua `AppSetting` sau.

---

## 9. API routes

- `GET/POST/PATCH/DELETE /api/spy/pages` — CRUD `SpyPageTarget`. POST `{pageUrl, storeId?, label?}` (validate pageUrl là facebook.com host); PATCH `{id, active?, label?, storeId?}`; DELETE `{id}`.
- `POST /api/spy/scan-ads` `{pageId?}` hoặc `{storeId?}` — scan 1 page target, hoặc tất cả `active` khi bỏ trống. **Chạy nền:** trả `{scanId, status:'running'}` ngay, không await toàn bộ (fire-and-forget với ghi trạng thái vào SpyScan). *(Chi tiết: gọi `runPageAdScan` không await trong route, hoặc await nhưng route dài — chọn fire-and-forget để tránh timeout HTTP; cron dùng bản await.)*
- `GET /api/spy/ads?storeId&filter=new|long-running|scaling|stopped&limit` — list `SpyAd` (join advertiser), tính signals khi đọc, order `startDate desc` hoặc `lastSeenAt desc`.
- `GET /api/spy/ads/[id]` — ad detail + `observations` (timeline) + advertiser.

---

## 10. Cron — `src/lib/spy/scheduler.ts`

Thêm tick `0 9 * * *` `Asia/Ho_Chi_Minh` (9h VN): scan tuần tự tất cả `SpyPageTarget.active` qua `runPageAdScan` (await từng cái, per-page try/catch). Giữ nguyên product scan 8h/20h. Stagger tuần tự để không vượt concurrency Apify.

---

## 11. UI — tab "Ads" trong `/tools/spy-idea`

- **Quản lý page target:** ô nhập FB page URL + gán store (dropdown) + list page target (label, store, lastScanAt, active toggle) + nút "Scan ads now" (per-page hoặc all).
- **Ad grid:** card gồm thumbnail creative (ảnh/video preview), page name, ngày start, badge `activeDays`, tag **New / Long-running / Scaling / Stopped** (màu khác nhau), CTA + link Ad Library, nút **Save IDEA** (refType `AD`, refAdId, snapshotJson).
- **Ad detail** (`/tools/spy-idea/ads/[id]` hoặc modal): creative đầy đủ (carousel/video), body/caption/cta/link, timeline chạy từ `observations` (isActive + collationCount theo thời gian), nút Save IDEA.
- Tuân design tokens + `'use client'` + `<Sidebar/>` (roles `tools_spy_idea` bao phủ children qua `startsWith`).

---

## 12. Edge cases & constraints

- Thiếu `APIFY_TOKEN` → scan fail rõ ràng, không crash cron.
- Apify run FAILED/TIMED-OUT/ABORTED → `SpyScan.failed` + error; cron sau retry.
- Page URL sai/không có ads → dataset rỗng → scan success với 0 ads.
- `is_active` lấy thẳng từ actor (không suy từ vắng mặt); ad biến mất khỏi kết quả KHÔNG tự đánh dấu inactive (chỉ observation phản ánh những gì thấy).
- 1 ad thấy ở nhiều lần scan → nhiều `SpyAdObservation`, 1 `SpyAd` (dedup theo `adArchiveId`).
- `body` đôi khi là object `{text}` → chuẩn hoá string trong mapping.
- Cost guard: `AD_SCAN_CAP` (200) mỗi page/run; chỉnh được.
- IDEA từ ad lưu `snapshotJson` → vẫn xem lại được dù ad bị gỡ.

---

## 13. File changes

### Mới
- `prisma/schema.prisma` — thêm `SpyPageTarget` + quan hệ ngược ở `SpyStore`.
- `src/lib/spy/apify.ts` — Apify client (start/status/dataset/poll).
- `src/lib/spy/ad-mapping.ts` — `mapApifyAd`.
- `src/lib/spy/ingest-ads.ts` — `ingestAds`.
- `src/lib/spy/scan-ads.ts` — `runPageAdScan`.
- `src/lib/spy/ad-signals.ts` — signals + `AD_SCAN_CAP`.
- `src/app/api/spy/pages/route.ts` — CRUD page target.
- `src/app/api/spy/scan-ads/route.ts` — trigger.
- `src/app/api/spy/ads/route.ts` — list ads.
- `src/app/api/spy/ads/[id]/route.ts` — ad detail.
- (UI) ad detail page nếu chọn route thay modal.

### Sửa
- `src/lib/db.ts` — bump SCHEMA_VERSION v24→v25.
- `src/lib/spy/scheduler.ts` — thêm cron 9h VN scan ads.
- `src/app/tools/spy-idea/page.tsx` — thêm tab Ads + quản lý page target.
- `.env` — thêm `APIFY_TOKEN`.

---

## 14. Phân phase implement (cho writing-plans)

1. **Schema + Apify client + mapping** (SpyPageTarget migration; apify.ts; ad-mapping.ts + tests).
2. **Ingest + scan flow** (ingest-ads.ts; scan-ads.ts; ad-signals.ts + tests).
3. **API + cron** (pages CRUD, scan-ads, ads list/detail; scheduler tick).
4. **UI** (Ads tab: page targets, ad grid, ad detail, Save IDEA).
