# Spy Tool — Phase 3a: Dashboard (card feeds + trending) — Design Spec

**Date:** 2026-08-21
**Status:** Draft for user review
**Builds on:** Phase 1 (`2026-08-20-spy-tool-design.md`) + Phase 2 (`2026-08-21-spy-ads-phase2-design.md`). Both shipped: DB (all Spy models), store-products scanner, Ad Library scanner, signals, IDEA vault, `/tools/spy-idea` tabbed page.

---

## 1. Mục tiêu

Thêm một **Dashboard** (khu "xem") tổng hợp data spy đã thu thành **card feed có filter**, giúp lướt nhanh: sản phẩm mới launching, ads đáng chú ý, và **trending** (niche đang lên + winning/scaling ads). Mỗi card lưu được vào IDEA vault.

Phần **AI research** (Section 3 trong tầm nhìn của user) **KHÔNG thuộc phạm vi phase này** — sẽ là phase riêng. Đã chốt sơ bộ cho phase đó: AI provider **cho chọn trong Setup** (Claude/OpenAI), nhập key giống Apify token; thiết kế chi tiết để sau.

---

## 2. Quyết định đã chốt

| Vấn đề | Quyết định |
|---|---|
| Cách làm | **Aggregation thuần** trên bảng hiện có — không thêm model DB, không cron mới |
| Dashboard kiểu | **Feed card có filter theo từng loại** (không kanban kéo-thả) |
| Vị trí | Trang mới `/tools/spy-idea/dashboard`; trang `/tools/spy-idea` cũ giữ vai trò data/setup |
| Trending | Suy từ data hiện có: niche đang lên (đếm sp mới theo `productType`) + winning/scaling ads. Trending theo keyword để phase sau |

---

## 3. Ba feed & định nghĩa trending

**A. New Products** — `SpyProduct` lọc `firstSeenAt` gần đây. Filter: store, niche(`productType`), khoảng ngày. Card: ảnh, title, giá, store.domain, ngày, badge "New". Nguồn: `GET /api/spy/products` (đã có, trả `{products, niches}`).

**B. Ads** — `SpyAd` + signals. Filter chips: New / Long-running / Scaling / Stopped; + theo store. Card: creative/title/body, page, activeDays, badge. Nguồn: `GET /api/spy/ads?filter=&storeId=` (đã có, trả `{ads:[{...,signals}]}`).

**C. Trending** — suy từ data hiện có:
- **Niche đang lên:** group `SpyProduct` theo `productType`; đếm sp có `firstSeenAt` trong cửa sổ hiện tại (X ngày) vs kỳ trước (X ngày trước đó); tính `deltaPct`; kèm top store đóng góp. Card mỗi niche: tên niche, newCount, deltaPct, top stores.
- **Winning / Scaling ads:** ads `isLongRunning || isScaling`, xếp theo `activeDays` (và collation). Tái dùng signals đã có.

---

## 4. API

### 4.1 Dùng lại (không đổi)
- `GET /api/spy/products?storeId&days&limit` → `{ products, niches }`.
- `GET /api/spy/ads?storeId&filter&limit` → `{ ads: [{ ...spyAd, advertiser, observations, signals }] }`.

### 4.2 Mới — `GET /api/spy/trending?days=<X>`
Params: `days` (mặc định 7, clamp ≤90).
Response:
```ts
{
  niches: Array<{ niche: string; newCount: number; prevCount: number; deltaPct: number; topStores: string[] }>,
  winningAds: Array<{ id; title; body; pageId; adLibraryUrl; mediaType; startDate; advertiser: { pageName }; signals: { isNew; activeDays; isLongRunning; isScaling; isStopped } }>
}
```
- `niches`: từ `computeTrendingNiches` (mục 5), sort theo `deltaPct` desc rồi `newCount` desc.
- `winningAds`: query `SpyAd` (include advertiser + observations), lọc `isLongRunning || isScaling`, sort `activeDays` desc, `take` ≤ 100.

### 4.3 (Tuỳ chọn) `GET /api/spy/dashboard/summary`
`{ newProducts7d: number, activeAds: number, scalingAds: number, trendingNiches: number }` cho stat card đầu trang. Nếu bỏ thì UI tự tính từ 3 feed.

---

## 5. Logic trending — hàm thuần (test được)

`src/lib/spy/trending.ts`:
```ts
export type TrendingNiche = { niche: string; newCount: number; prevCount: number; deltaPct: number; topStores: string[] }

export function computeTrendingNiches(
  products: Array<{ productType: string | null; firstSeenAt: Date; store?: { domain: string } | null }>,
  opts?: { windowDays?: number; now?: Date; limit?: number },
): TrendingNiche[]
```
Logic:
- `windowDays` mặc định 7, `now` mặc định `new Date()`, `limit` mặc định 20.
- Cửa sổ hiện tại = `[now - windowDays, now]`; kỳ trước = `[now - 2*windowDays, now - windowDays]`.
- Group theo `productType || 'Uncategorized'`. `newCount` = số sp firstSeenAt trong cửa sổ hiện tại; `prevCount` = trong kỳ trước.
- `deltaPct` = `prevCount === 0 ? (newCount > 0 ? 100 : 0) : round((newCount - prevCount) / prevCount * 100)`.
- `topStores` = tối đa 3 domain đóng góp nhiều sp mới nhất trong cửa sổ hiện tại.
- Trả các niche có `newCount > 0`, sort `deltaPct` desc → `newCount` desc, cắt `limit`.

Winning/scaling ads dùng `isLongRunning`/`isScaling` từ `@/lib/spy/ad-signals` (đã có).

---

## 6. UI — `src/app/tools/spy-idea/dashboard/page.tsx`

- `'use client'`, `<RoleGate>` + `<Sidebar/>`, layout `ml-[280px] flex-1 p-xl`.
- **Header:** tiêu đề + hàng stat card (New products 7d · Active ads · Scaling ads · Trending niches) — từ `/api/spy/dashboard/summary` hoặc tính từ feed.
- **Khu New Products:** filter (store dropdown, niche dropdown, days) + grid card (dùng lại style card sản phẩm). Nút "Save IDEA".
- **Khu Ads:** filter chips (All/new/long-running/scaling/stopped) + grid ad card (dùng lại style Phase 2). Link Detail + "Save IDEA".
- **Khu Trending:** danh sách card niche (niche, newCount, `+deltaPct%` badge, top stores) + danh sách winning/scaling ads (card gọn).
- Ngày hiển thị `en-US` (MM/DD/YYYY). Icons `material-symbols-outlined`. Card pattern chuẩn.

---

## 7. Điều hướng

- Thêm mục **"Spy Dashboard"** vào `src/components/Sidebar.tsx` nhóm Tools (icon `space_dashboard`), href `/tools/spy-idea/dashboard`.
- Roles: `tools_spy_idea` đã bao phủ children qua `startsWith` (không sửa `roles.ts`).
- Trang `/tools/spy-idea` cũ giữ nguyên (data/setup: stores, pages, ideas, tabs products/ads dạng raw). Dashboard là nơi xem tuyển chọn + trending.

---

## 8. Non-goals (phase này)
- Không AI research (phase riêng).
- Không keyword-based trending (chờ keyword scanner / phase AI).
- Không kanban kéo-thả.
- Không matching sản phẩm trùng across stores (fuzzy) — YAGNI.
- Không model DB mới, không cron mới.

---

## 9. File changes

### Mới
- `src/lib/spy/trending.ts` — `computeTrendingNiches` + type.
- `src/lib/spy/trending.test.ts` — unit test.
- `src/app/api/spy/trending/route.ts` — GET niches + winningAds.
- `src/app/api/spy/dashboard/summary/route.ts` — (tuỳ chọn) stat summary.
- `src/app/tools/spy-idea/dashboard/page.tsx` — trang dashboard.

### Sửa
- `src/components/Sidebar.tsx` — thêm nav "Spy Dashboard".

---

## 10. Testing
- `computeTrendingNiches` — unit test (delta%, prev=0, top stores, window ranges, sort).
- Route `/api/spy/trending` + summary — verify `tsc --noEmit` + `npm run lint` (runtime exercised qua UI).
- UI dashboard — `tsc`/lint + kiểm tra thủ công (feed render, filter, Save IDEA).

---

## 11. Phân phase implement (cho writing-plans)
1. `computeTrendingNiches` (+ test).
2. `/api/spy/trending` (+ optional summary route).
3. Dashboard page UI (3 feed) + Sidebar nav.
