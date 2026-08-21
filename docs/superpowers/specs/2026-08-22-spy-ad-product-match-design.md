# Spy Tool — Ad↔Product match, ad-focused dashboard, card enrich — Design Spec

**Date:** 2026-08-22
**Status:** Draft for user review
**Builds on:** Phase 1/2/3a (all shipped): Spy DB, product + Ad Library scanners, signals, IDEA vault, `/tools/spy-idea` (tabs) + `/tools/spy-idea/dashboard`.

---

## 1. Mục tiêu

1. **Khớp ad ↔ product listing:** gắn label **"New Product Launching"** cho ad chạy thẳng vào một product listing mới (store lên nhiều listing/ngày nhưng chỉ chạy ads một số → ad running vào listing mới = tín hiệu mạnh).
2. **Style Ads:** phân loại ad theo đích của `linkUrl`: Product / Collection / Homepage / Other.
3. **Link ID Ads:** trên card, hiện `adArchiveId` click ra đúng ad (Ad Library).
4. **Dashboard chỉ tập trung ads:** bỏ khu New Products & Trending niches; giữ stat cards (ads-focused) + Winning ads + Ads feed (mặc định chỉ active).
5. **UX:** feedback + tự refresh sau khi "Scan ads now"; nút xoá page target.

---

## 2. Quyết định đã chốt

| Vấn đề | Quyết định |
|---|---|
| Label New Product Launching | ad `linkUrl` → product; khớp `SpyProduct` theo `store.domain == host` + `handle`; `firstSeenAt ≤ 7 ngày` |
| Style Ads | Product (`/products/`) / Collection (`/collections/`) / Homepage (`/` hoặc rỗng) / Other |
| Ad ID link | hiện `adArchiveId`, click mở `adLibraryUrl` |
| Dashboard | giữ stat cards + Winning ads + Ads feed; bỏ New Products & Trending niches; ads feed mặc định **active** |
| Apify filter | **giữ 'all'** (không đổi) — chỉ lọc active ở UI; giữ lịch sử stopped |

---

## 3. `parseAdLink` — hàm thuần (`src/lib/spy/ad-link.ts`)

```ts
export type AdLinkKind = 'product' | 'collection' | 'homepage' | 'other'
export type ParsedAdLink = { host: string | null; kind: AdLinkKind | null; handle: string | null }
export function parseAdLink(linkUrl: string | null): ParsedAdLink
```
Logic:
- `linkUrl` rỗng/không parse được → `{ host: null, kind: null, handle: null }`.
- **Unwrap redirect Facebook:** nếu host là `l.facebook.com`/`lm.facebook.com` và có query `u` → `linkUrl = decodeURIComponent(u)` rồi parse lại (một lần).
- `host` = `hostname.toLowerCase().replace(/^www\./, '')`.
- `path` = `pathname`.
  - regex `/\/products\/([^/?#]+)/` khớp → `kind='product'`, `handle=match[1]`.
  - `/\/collections\//` → `kind='collection'`.
  - `path === '' || path === '/'` → `kind='homepage'`.
  - còn lại → `kind='other'`.

Unit test: product+handle, collection, homepage, other, FB redirect unwrap, www strip, null/invalid.

---

## 4. Khớp New Product Launching — trong `/api/spy/ads` (batch, không N+1)

Sau khi load ads (đã include advertiser + observations):
1. Mỗi ad: `parseAdLink(ad.linkUrl)`.
2. Gom các ad `kind==='product'` → tập `hosts` (distinct) + `handles` (distinct).
3. Một truy vấn:
   ```ts
   const now = Date.now(); const since = new Date(now - 7*864e5)
   const products = await prisma.spyProduct.findMany({
     where: { handle: { in: handles }, firstSeenAt: { gte: since }, store: { domain: { in: hosts } } },
     select: { handle: true, store: { select: { domain: true } } },
   })
   const recent = new Set(products.map(p => `${p.store?.domain}|${p.handle}`))
   ```
4. Mỗi ad: `newProductLaunching = parsed.kind==='product' && recent.has(`${parsed.host}|${parsed.handle}`)`.

*(Nếu `handles`/`hosts` rỗng → bỏ qua truy vấn, tất cả `false`.)*

---

## 5. Thay đổi `/api/spy/ads` response

Thêm vào khối `signals` của mỗi ad (giữ nguyên các field cũ):
```ts
signals: {
  isNew, activeDays, isLongRunning, isScaling, isStopped,   // cũ
  adStyle: 'product'|'collection'|'homepage'|'other'|null,  // mới (parseAdLink.kind)
  newProductLaunching: boolean,                             // mới (mục 4)
}
```
`adArchiveId` + `adLibraryUrl` đã có sẵn trên object ad (spread) → dùng cho Link ID Ads.

**Thêm filter `active`:** mở rộng filter map để `?filter=active` → lọc `ad.isActive === true`. (Các filter cũ new/long-running/scaling/stopped giữ nguyên.)

---

## 6. Thay đổi `/api/spy/dashboard/summary` (ads-focused)

Trả `{ activeAds, newLaunchingAds, scalingAds, longRunningAds }` (bỏ `newProducts7d`, `trendingNiches`):
- `activeAds` = `prisma.spyAd.count({ where: { isActive: true } })`.
- Load ads (take 500, include observations + select linkUrl/startDate/endDate/isActive), tính:
  - `scalingAds` = số ad `isScaling(obs)`.
  - `longRunningAds` = số ad `isLongRunning(ad)`.
  - `newLaunchingAds` = số ad khớp New Product Launching (dùng cùng logic mục 4).

---

## 7. Dashboard UI (`src/app/tools/spy-idea/dashboard/page.tsx`)

- **Bỏ** khu "New Products" và "Trending niches" (+ fetch products/trending). Dashboard **không còn dùng `/api/spy/trending`**.
- **Nguồn ads dùng chung:** dashboard load `/api/spy/ads?limit=500` (đã enrich adStyle + newProductLaunching), dựng cả 2 khu từ data này:
  - **Winning/Scaling ads:** client lọc `signals.isLongRunning || signals.isScaling`, sort `activeDays` desc → đảm bảo card winning cũng có badge mới.
  - **Ads feed:** filter chips `Active`(default) / New / Long-running / Scaling / Stopped / All; default lọc `isActive` (client) hoặc gọi `/api/spy/ads?filter=active`.
- **Stat cards** (4): Active ads · New Product Launching · Scaling · Long-running (từ summary mới).
- **Card ads** (dùng cho cả winning + feed): badges
  - `🚀 New Product Launching` (khi `signals.newProductLaunching`).
  - **Style Ads**: chip `Product`/`Collection`/`Homepage`/`Other` (từ `signals.adStyle`).
  - Badges cũ New/Long-running/Scaling/Stopped.
  - **Ad ID:** dòng nhỏ `#<adArchiveId>` là link tới `adLibraryUrl` (target _blank).
  - Giữ Detail + Save IDEA.

---

## 8. UX — tab Ads trong `/tools/spy-idea` (`src/app/tools/spy-idea/page.tsx`)

- Sau khi bấm **"Scan ads now"**: set trạng thái "Đang quét… ads sẽ xuất hiện sau ~30s", và **tự reload** `loadAds()` sau 15s rồi 30s (2 lần) để hiện kết quả mà không cần refresh tay.
- Mỗi page target trong list: thêm nút **Xoá** → `DELETE /api/spy/pages` `{id}` → `loadPages()`.

---

## 9. Non-goals
- Không đổi Apify `activeStatus` (giữ 'all').
- Không thêm model DB / migration (thuần logic + query).
- Không matching fuzzy theo tên sản phẩm — chỉ khớp chính xác `host+handle`.
- Không đụng scanner/cron.

---

## 10. File changes

### Mới
- `src/lib/spy/ad-link.ts` — `parseAdLink` + types.
- `src/lib/spy/ad-link.test.ts` — unit test.

### Sửa
- `src/app/api/spy/ads/route.ts` — enrich `adStyle` + `newProductLaunching` (batch match) + filter `active`.
- `src/app/api/spy/dashboard/summary/route.ts` — ads-focused counts.
- `src/app/tools/spy-idea/dashboard/page.tsx` — restructure + card badges + Ad ID link + default active.
- `src/app/tools/spy-idea/page.tsx` — scan feedback/auto-refresh + nút xoá page target.

---

## 11. Testing
- `parseAdLink` — unit test (mọi kind + redirect unwrap + www + null).
- `/api/spy/ads`, `/api/spy/dashboard/summary` — `tsc --noEmit` + `npm run lint` (runtime qua UI).
- Dashboard + Ads tab UI — tsc/lint + kiểm thủ công (badges hiển thị, Ad ID click ra ad, scan feedback, xoá page).

---

## 12. Phân phase implement (cho writing-plans)
1. `parseAdLink` (+ test).
2. `/api/spy/ads` enrich (adStyle + newProductLaunching + filter active) + `/api/spy/dashboard/summary` ads-focused.
3. Dashboard restructure + card badges + Ad ID link.
4. UX tab Ads (scan feedback/auto-refresh + nút xoá page).
