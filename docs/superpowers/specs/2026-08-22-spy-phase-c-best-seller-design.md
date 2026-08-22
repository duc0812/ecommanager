# Spy Tool — Phase C: Best Seller (scheduled best-selling scrape + rank trend) — Design Spec

**Date:** 2026-08-22
**Status:** Draft for user review
**Part of:** brandsearch-style restructure (Phase A niche ✅ → Phase B nav/filter ✅ → **Phase C Best Seller**).
**Depends on:** Phase B (`ProductCard`, browse page Product Spy → Best Seller stub, `domain-filter.ts`, `niche.ts` helpers, `SpyProductType`, filter facets). Reuses the existing product-scan stack (`shopify.ts` `mapShopifyProduct`, `SpyProduct`, `SpyScan`, `scan-runner.ts`, `scheduler.ts`).

---

## 0. Research findings (spike trên store thật 2026-08-22)

Test trên `homesizy.com`, `familystore.com`, `homacus.com`:
- **`.json` bỏ qua `?sort_by=best-selling`** — thứ tự trả về y hệt khi không có param. ⇒ Không dùng được sort qua query; phải lấy 1 **collection** có sort mặc định = best-selling.
- **`/collections/{handle}/products.json` tôn trọng sort mặc định của collection** — thứ tự khác hẳn `/collections/all` (alphabet) ⇒ đó chính là thứ tự best-seller (rank = vị trí).
- **Handle khác nhau theo store:** `familystore.com` + `homacus.com` dùng `best-selling`; `homesizy.com` dùng `best-seller` (số ít), còn `best-selling` trả rỗng (n=0). ⇒ **Phải tự dò handle**, không hardcode.
- `/collections.json?limit=250` liệt kê đủ collection (homesizy: 146 collection, có `best-seller` / `trending-in`). Handle không tồn tại thường trả `200` với `products:[]` (ít khi 404).

⇒ Điều chỉnh: `fetchStoreBestSellers` **dò handle qua `/collections.json`** trước, rồi mới fetch products của collection đó (xem §4.2).

---

## 1. Mục tiêu

Điền dữ liệu cho view **Best Seller** (Product Spy): scrape collection `best-selling` của mỗi Shopify store **theo lịch 2×/ngày**, lưu snapshot **rank** vào DB, hiển thị sản phẩm best-seller kèm **xu hướng rank ▲▼** (sản phẩm đang leo = tín hiệu winning). Lọc được theo Domain × Niche × Product type như các view khác.

Ngoài phạm vi: AI; ad scan; store không có collection `best-selling` (xử lý mềm → rỗng).

---

## 2. Quyết định đã chốt

| Vấn đề | Quyết định |
|---|---|
| Cách lấy data | **Scrape theo lịch + lưu DB** (snapshot rank, có xu hướng) |
| Bảng | `SpyBestSeller` snapshot (rank + prevRank), không đụng `SpyProduct` |
| Nguồn | **Tự dò handle** qua `{origin}/collections.json` (handle best-seller khác nhau theo store) → `/collections/{handle}/products.json?limit=250` — thứ tự = rank |
| Cadence | ghép vào cron product hiện có (8h & 20h) + "Scan now" thủ công |
| Phạm vi view | Domain=All → nhóm theo store (top 12/store); chọn 1 domain → lưới phẳng (top 50); Niche/Product type lọc thêm |
| Trend | delta = prevRank − rank (>0 leo hạng); prevRank tính lúc ingest |
| 404 collection | coi như rỗng, scan vẫn success với 0 rows |

---

## 3. Data model (migration)

```prisma
model SpyBestSeller {
  id         String     @id @default(cuid())
  storeId    String
  store      SpyStore   @relation(fields: [storeId], references: [id], onDelete: Cascade)
  productId  String
  product    SpyProduct @relation(fields: [productId], references: [id], onDelete: Cascade)
  scanId     String
  scan       SpyScan    @relation(fields: [scanId], references: [id])
  rank       Int
  prevRank   Int?
  capturedAt DateTime   @default(now())

  @@index([storeId, capturedAt])
  @@index([productId])
  @@index([scanId])
}
```

Back-relations (Prisma-level only, no column on existing tables — additive): add `bestSellers SpyBestSeller[]` to `SpyStore`, `SpyProduct`, and `SpyScan`.

Migration: `add_spy_best_seller` (CREATE TABLE + indexes, non-destructive). Bump `SCHEMA_VERSION` v29→v30.

---

## 4. Scrape + ingest (`src/lib/spy/`)

### 4.1 `best-seller.ts` — pure trend helper (test được)
```ts
export function rankDelta(rank: number, prevRank: number | null | undefined): number | null
// prevRank == null → null (NEW). else prevRank - rank (>0 leo hạng, <0 tụt, 0 giữ).
```

### 4.2 `scan-best-sellers.ts` — dò handle + fetch

**Pure helper (test được):**
```ts
export function pickBestSellerHandle(collections: { handle: string; title?: string | null }[]): string | null
```
- Ưu tiên khớp handle chính xác theo thứ tự: `best-selling`, `best-sellers`, `best-seller`, `bestsellers`, `bestseller`, `best-selling-products`.
- Nếu không có → collection đầu tiên mà **handle hoặc title (lowercase) chứa cả "best" và "sell"** (bắt "Best Seller"/"Best Sellers"/"Best Selling").
- Không có → `null`.

**Fetch:**
```ts
export async function fetchStoreBestSellers(domain: string): Promise<{ products: ParsedSpyProduct[]; totalScanned: number; handle: string | null }>
```
- `origin = normalizeStoreUrl(domain)` (headers UA `EcomManagerSpy/1.0`, `accept: application/json`, `cache: no-store`, timeout 20s cho mỗi request).
- GET `${origin}/collections.json?limit=250` → mảng `collections`. Nếu request lỗi (network/timeout, status ≥ 500) → **throw** (runner ghi failed). Nếu danh sách rỗng → trả `{ products: [], totalScanned: 0, handle: null }`.
- `handle = pickBestSellerHandle(collections)`. Nếu `null` → trả `{ products: [], totalScanned: 0, handle: null }` (store không có collection best-seller — known limitation).
- GET `${origin}/collections/${handle}/products.json?limit=250`. Nếu `404` hoặc `products` rỗng → trả `{ products: [], totalScanned: 0, handle }`.
- `products` giữ **nguyên thứ tự** trả về (rank = index + 1) qua `mapShopifyProduct(raw, origin)`.

> Không dùng `?sort_by=best-selling` (đã chứng minh `.json` bỏ qua). Chỉ dựa vào sort mặc định của collection.

### 4.3 `ingest-products.ts` — tách helper dùng chung
Refactor phần upsert của `ingestStoreProducts` thành:
```ts
export async function upsertStoreProduct(storeId: string, scanId: string, p: ParsedSpyProduct, now: Date): Promise<{ id: string; created: boolean }>
```
(giữ nguyên hành vi: upsert theo `(storeId, externalProductId)`, tạo `SpyProductSnapshot` khi giá/title đổi). `ingestStoreProducts` gọi lại helper này (không đổi kết quả/behaviour).

### 4.4 `ingest-best-sellers.ts` — ingest
```ts
export async function ingestStoreBestSellers(storeId: string, scanId: string, products: ParsedSpyProduct[]): Promise<{ found: number }>
```
- Với mỗi `p` (index i): `const { id } = await upsertStoreProduct(storeId, scanId, p, now)` (đảm bảo sản phẩm tồn tại + data mới, kể cả ngoài trang 1 của products.json).
- `prevRank` = rank của snapshot gần nhất trước đó: `prisma.spyBestSeller.findFirst({ where: { storeId, productId: id }, orderBy: { capturedAt: 'desc' }, select: { rank: true } })`.
- Tạo `SpyBestSeller { storeId, productId: id, scanId, rank: i+1, prevRank }`.

### 4.5 `scan-runner.ts` — runner
```ts
export async function runStoreBestSellerScan(store: { id: string; domain: string })
```
Mirror `runStoreProductScan`: tạo `SpyScan { type: 'STORE_BESTSELLER', targetType: 'STORE', targetId: store.id }`, fetch → ingest → cập nhật status/stats (`{ handle, totalScanned, found }`). Lỗi → status failed. (Handle=null / found=0 vẫn tính **success** — store không có best-seller là hợp lệ.)

---

## 5. Wiring cron + manual

Best-seller chạy **ngay sau** product scan ở **cả hai** call site (try/catch riêng cho best-seller):
- `scheduler.ts` `scanAllStores()`: sau `await runStoreProductScan(s)` → `try { await runStoreBestSellerScan(s) } catch …`. Cập nhật log.
- `src/app/api/spy/scan/route.ts` POST: trong vòng lặp, sau `runStoreProductScan(s)` → `runStoreBestSellerScan(s)` (đưa vào `results`).

Không đổi cron schedule (vẫn 8h & 20h) — chỉ thêm việc best-seller vào cùng lượt.

---

## 6. API — `GET /api/spy/best-sellers`

Params: `domain`, `nicheId`, `productTypeId`, `limit`.
- Xác định store(s): `domain` → `SpyStore` có `domain ∈ domainVariants(domain)`; không có → tất cả store `status:'active'`.
- Với mỗi store: lấy `SpyScan` STORE_BESTSELLER mới nhất `status:'success'` (`orderBy startedAt desc`). Nếu không có → group rỗng (bỏ qua).
- Lấy `SpyBestSeller` `where: { scanId: latest, product: <niche/type where> }`, `orderBy: { rank: 'asc' }`, `take: limit`, `include product`.
  - `<niche/type where>`: build từ `nicheOrWhere(parseKeywords(niche.keywords), ['title'])` và cho product type, gộp `product: { AND: [nw, pw].filter(Boolean) }` (bỏ qua nếu rỗng → không narrow).
- Trả:
```ts
{ groups: Array<{ store: { domain: string }, items: Array<Product & { rank: number; prevRank: number|null; delta: number|null }> }> }
```
`limit` mặc định: 12 khi nhiều store (All), 50 khi 1 domain (client truyền limit tương ứng, server clamp ≤100).

---

## 7. View — Product Spy → Best Seller (thay stub)

Trong `src/app/tools/spy-idea/page.tsx`, nhánh `area==='products' && view==='best-seller'`:
- Fetch `/api/spy/best-sellers?domain=&nicheId=&productTypeId=&limit=` theo facet (limit 50 nếu có domain, 12 nếu không).
- Render theo `groups`:
  - Nhiều group (All) → mỗi store 1 mục có tiêu đề `store.domain`, lưới `ProductCard` top 12.
  - 1 group (chọn domain) → lưới phẳng top 50.
- `ProductCard` thêm props optional **`rank?: number`** (badge `#N` góc trái) + **`rankDelta?: number|null`** (badge `▲k`/`▼k`/`NEW`/`—`). Không ảnh hưởng chỗ dùng cũ (New Product Add không truyền → không hiện badge).
- Rỗng → "No best sellers yet — scan a store first."

---

## 8. Non-goals (Phase C)
- Không đổi ad scan/scheduler ads.
- Không AI.
- Store không có collection best-seller nào (dò handle ra `null`) → mục rỗng (known limitation; không fallback `sort_by` vì `.json` bỏ qua sort). Không đoán "trending"/"top" làm best-seller (tránh false positive).
- Không backfill lịch sử (trend bắt đầu tích luỹ từ lần scan đầu — lần đầu mọi sản phẩm là NEW).

---

## 9. Testing
- `best-seller.ts` `rankDelta` — unit (null khi prevRank null; dấu đúng).
- `scan-best-sellers.ts` `pickBestSellerHandle` — unit (ưu tiên `best-selling`; chọn `best-seller` số ít; khớp title "Best Seller"; không có → null).
- `scan-best-sellers.ts` `fetchStoreBestSellers` — unit với `fetch` mock (collections.json → dò handle → products.json giữ thứ tự→rank; handle null → rỗng; collection products rỗng/404 → rỗng; collections.json lỗi → throw). Mirror `scan-products.test.ts`.
- `SpyBestSeller` delegate — schema smoke test (mirror `product-type-schema.test.ts`).
- `upsertStoreProduct` refactor — chạy lại `ingest-products.test.ts` (không đổi kết quả).
- API + view — tsc/lint + manual.
- Regression: full suite (2 order-profit fail cũ, không liên quan).

---

## 10. Phân phase implement (cho writing-plans)
1. `SpyBestSeller` model + back-relations + migration (v30) + delegate smoke test.
2. `best-seller.ts` (rankDelta+test); `scan-best-sellers.ts` (`pickBestSellerHandle`+`fetchStoreBestSellers` dò handle qua `/collections.json`, +test); refactor `upsertStoreProduct` (ingest-products test xanh); `ingestStoreBestSellers`; `runStoreBestSellerScan`.
3. Wiring: `scanAllStores` + `/api/spy/scan` chạy best-seller sau product.
4. `GET /api/spy/best-sellers` (domain/niche/type, groups + rank/prevRank/delta).
5. View Best Seller (ProductCard rank/trend badge + grouped/flat) thay stub.
