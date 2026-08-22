# Spy Tool — Ad domains, domain keyword-scan, Domain→Fanpage→Ads report — Design Spec

**Date:** 2026-08-22
**Status:** Draft for user review
**Builds on:** Phase 1/2/3a + ad-product-match + ad-media (all shipped). This adds a **domain** layer above fanpages for ad scanning and restructures the Ads tab into a report.

---

## 1. Mục tiêu

- Thêm **domain** làm cấp trên fanpage cho phần Ads. 1 domain thường chạy nhiều fanpage; user gửi **domain trước** cho Apify quét (Ad Library keyword-search), thấy fanpage thì add sau để quét bổ sung.
- **Report** gom: `Domain → Fanpages → Ads`.
- Mục **New Ads** (ads FB vừa launch, `start_date ≤ 7d`) ở trên cùng.
- Keyword tự do để phase sau (bảng `SpyKeyword` đã có sẵn, không dùng lần này).

---

## 2. Quyết định đã chốt

| Vấn đề | Quyết định |
|---|---|
| Thực thể domain | Model **mới `SpyAdDomain`** (tách khỏi SpyStore product-spy) |
| Domain scan | **Ad Library keyword-search** theo `searchTerm` (mặc định suy từ domain, sửa được) |
| Quy ads về domain | qua `SpyAdvertiser.adDomainId` (ad → advertiser → domain) |
| New Ads | ads `signals.isNew` (start_date ≤7d) — tính khi đọc, không field mới |
| Layout Ads | report `Domain → Fanpages → Ads` + mục New Ads trên cùng |
| Apify | giữ actor `curious_coder/facebook-ads-library-scraper`, `activeStatus:'all'` |

---

## 3. Data model (migration)

**Model mới:**
```prisma
model SpyAdDomain {
  id         String    @id @default(cuid())
  domain     String    @unique
  searchTerm String
  label      String?
  country    String    @default("ALL")
  active     Boolean   @default(true)
  lastScanAt DateTime?
  createdAt  DateTime  @default(now())

  pages       SpyPageTarget[]
  advertisers SpyAdvertiser[]

  @@index([active])
}
```

**Thêm field:**
- `SpyPageTarget.adDomainId String?` + relation `adDomain SpyAdDomain? @relation(fields:[adDomainId],references:[id], onDelete: SetNull)` + `@@index([adDomainId])`.
- `SpyAdvertiser.adDomainId String?` + relation (SetNull) + `@@index([adDomainId])`.

`SpyScan.type` thêm giá trị `"DOMAIN_ADS"` (đã là String — không đổi schema).

Migration: `add_spy_ad_domain`; bump `SCHEMA_VERSION` v26→v27.

**`searchTerm` mặc định:** suy từ domain: `domain.replace(/^www\./,'').split('.')[0]` (vd `familystore.com` → `familystore`); user sửa được.

---

## 4. Scan

**`buildAdLibrarySearchUrl(searchTerm: string, country = 'ALL'): string`** (thuần, test):
`https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=<country>&q=<encodeURIComponent(searchTerm)>&search_type=keyword_unordered&media_type=all`

**`ingestAds` thêm option** `opts?: { adDomainId?: string | null }`:
- Khi `adDomainId` truyền vào (không null): set `SpyAdvertiser.adDomainId = adDomainId` ở cả create và update (last-scan-wins). Khi không truyền: không đụng field.

**`runDomainAdScan(domain: { id: string; searchTerm: string; country: string }): Promise<{scanId; status; stats?; error?}>`** (`src/lib/spy/scan-ads.ts`):
1. Tạo `SpyScan` `{ type:'DOMAIN_ADS', targetType:'DOMAIN', targetId: domain.id, status:'running' }`.
2. `startActorRun({ urls:[{url: buildAdLibrarySearchUrl(domain.searchTerm, domain.country)}], count: AD_SCAN_CAP })`; lưu apifyRunId/DatasetId.
3. poll → dataset → `map(mapApifyAd)` → `ingestAds(scan.id, null, ads, { adDomainId: domain.id })`.
4. success + stats + `SpyAdDomain.lastScanAt=now`; lỗi → failed + error (không rethrow).

**`runPageAdScan`** (đã có): truyền `{ adDomainId: pageTarget.adDomainId }` vào `ingestAds` → ads scan theo page cũng quy đúng domain. (pageTarget cần select `adDomainId`.)

---

## 5. API

- **`GET/POST/PATCH/DELETE /api/spy/ad-domains`** — CRUD `SpyAdDomain`.
  - `GET`: list domains, mỗi domain kèm `{ pageCount, adCount, newAdCount }` (đếm qua advertiser.adDomainId; newAdCount = ads isNew).
  - `POST {domain, searchTerm?, label?, country?}` — normalize domain (bare host, lowercased); `searchTerm` mặc định suy từ domain nếu bỏ trống; upsert theo `domain`.
  - `PATCH {id, searchTerm?, label?, country?, active?}`; `DELETE {id}`.
- **`/api/spy/pages`** mở rộng: `POST` nhận `adDomainId?`; `GET ?adDomainId=` lọc theo domain.
- **`/api/spy/ads?domainId=`** — lọc `where: { advertiser: { adDomainId: domainId } }` (thêm cạnh `storeId`/`filter` hiện có).
- **`/api/spy/scan-ads`** mở rộng: `POST {domainId}` → `runDomainAdScan`; giữ `{pageId}` → `runPageAdScan`; giữ scan-all-active-pages khi rỗng. (Tùy chọn: `{scanAllDomains:true}` quét mọi domain active — hoặc để cron sau; phase này chỉ cần trigger tay theo domainId.)

---

## 6. UI — tab Ads thành report (`src/app/tools/spy-idea/page.tsx`)

- **New Ads** (trên cùng): gọi `/api/spy/ads?filter=new` → grid AdCard (dùng lại card giàu: media badge + Style + New Product Launching + #adArchiveId + Save IDEA), gom nhãn domain nếu tiện.
- **Add domain:** input domain + nút "Add domain" (searchTerm auto, sửa sau).
- **Mỗi domain block:**
  - Header: `domain` · searchTerm (input sửa nhanh + lưu) · **Scan domain** · lastScanAt.
  - **Fanpages:** input page URL + nút "Add fanpage" (gắn `adDomainId`), list fanpage (label/pageUrl, lastScanAt, **Scan page**, **Xoá**).
  - **Ads của domain:** `/api/spy/ads?domainId=<id>` → grid AdCard.
- Giữ các tab khác (Stores/Products/Ideas). Ad detail/dashboard không đổi ở phase này.

Card dùng lại component AdCard (đã có ở dashboard) — tách thành component chia sẻ nếu tiện, hoặc lặp gọn. Dates en-US; design tokens chuẩn.

---

## 7. Non-goals
- Keyword tự do (SpyKeyword) — phase sau.
- Cron tự động cho domain scan — phase này chỉ trigger tay (cron page-scan 9h hiện có giữ nguyên; có thể mở rộng domain sau).
- Không đổi Apify filter (giữ 'all').
- Auto-tạo SpyPageTarget từ ads domain-search — không (advertiser.adDomainId đủ để gom; user tự add fanpage muốn scan sâu).

---

## 8. File changes

### Mới
- `src/lib/spy/ad-search-url.ts` — `buildAdLibrarySearchUrl` + test.
- `src/app/api/spy/ad-domains/route.ts` — CRUD.

### Sửa
- `prisma/schema.prisma` — `SpyAdDomain` + `adDomainId` trên SpyPageTarget & SpyAdvertiser; `src/lib/db.ts` bump v26→v27.
- `src/lib/spy/ingest-ads.ts` — option `adDomainId`.
- `src/lib/spy/scan-ads.ts` — `runDomainAdScan`; runPageAdScan truyền adDomainId.
- `src/app/api/spy/scan-ads/route.ts` — nhận `domainId`.
- `src/app/api/spy/pages/route.ts` — adDomainId (create + filter).
- `src/app/api/spy/ads/route.ts` — filter `domainId`.
- `src/app/tools/spy-idea/page.tsx` — tab Ads report.

---

## 9. Testing
- `buildAdLibrarySearchUrl` — unit (encode, country, format).
- `ingestAds` adDomainId — unit (mock prisma: advertiser upsert sets adDomainId when provided, not when absent).
- `runDomainAdScan` — unit (mock apify/ingest/prisma: success sets stats + lastScanAt; failure marks failed).
- CRUD/report/scan routes — tsc/lint (runtime qua UI).
- UI report — tsc/lint + kiểm thủ công (add domain → scan domain → thấy ads; add fanpage → scan page; New Ads).

---

## 10. Phân phase (cho writing-plans)
1. Schema (`SpyAdDomain` + 2 field) + migration + `buildAdLibrarySearchUrl`.
2. `ingestAds` adDomainId + `runDomainAdScan` + runPageAdScan truyền adDomainId.
3. API: ad-domains CRUD + scan-ads domainId + pages adDomainId + ads domainId filter.
4. UI: tab Ads report (New Ads + domain blocks + fanpages + ads).
