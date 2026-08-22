# Spy Tool — Phase B: 2-area nav + left facet filter + Product-type taxonomy — Design Spec

**Date:** 2026-08-22
**Status:** Draft for user review
**Part of:** brandsearch-style restructure (Phase A niche ✅ → **Phase B nav/filter** → Phase C Best Seller).
**Depends on:** Phase A (`SpyNiche`, `src/lib/spy/niche.ts` generic helpers, `/api/spy/niches`, `nicheId` filter).

---

## 1. Mục tiêu

Gom tool spy thành **2 khu vực** browse (thay Dashboard), dùng chung **1 sidebar facet bên trái** để lọc theo **Domain × Niche × Product type**. Trong đó **Product type là taxonomy do user tự định nghĩa bằng keyword — giống hệt Niche** (không dùng `SpyProduct.productType` cũ của Shopify).

Ngoài phạm vi: scrape Best Seller (Phase C), tính năng AI, thay đổi logic scan/cron.

---

## 2. Quyết định đã chốt

| Vấn đề | Quyết định |
|---|---|
| Product type là gì | Taxonomy user tự định nghĩa (`name` + `keywords`), khớp title — **giống Niche** |
| Cách dựng Product type | **Model riêng `SpyProductType`** (mirror `SpyNiche`), **tái dùng helper `niche.ts`**. Phase A không đụng vào |
| Vị trí filter | **Sidebar facet dọc bên trái** (không phải dropdown ở trên) |
| Facet gồm | Domain · Niche · Product type — mỗi facet chọn 1 giá trị, có "All", kết hợp **AND** |
| Áp filter cho | **Cả 2 khu** (Ad Library + Product Spy) |
| Menu trên | Tầng 1: `Ad Library` · `Product Spy` (+ `Ideas`). Tầng 2: sub-view của khu đang chọn |
| Setup | Nhóm **Setup** ở đáy sidebar trái: **Sources** (store/ad-domain/fanpage) · **Niche** · **Product type** |
| Dashboard | **Bỏ**; view "Winning" chuyển vào Ad Library → Winning |
| State filter/view | Lưu trên **URL** query params, giữ khi đổi sub-view |
| Best Seller | **Stub "Coming in Phase C"** (chưa scrape) |

---

## 3. Data model (migration)

Thêm bảng song song với `SpyNiche` (không đổi `SpyNiche`):

```prisma
model SpyProductType {
  id        String   @id @default(cuid())
  name      String   @unique
  keywords  String   @default("[]")   // JSON array, khớp case-insensitive qua LIKE
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
}
```

Migration: `add_spy_product_type` (additive CREATE TABLE + unique index, non-destructive). Bump `SCHEMA_VERSION` v28→v29.

**Helper:** tái dùng `src/lib/spy/niche.ts` nguyên trạng (`parseKeywords`, `nicheOrWhere`, `nicheMatches` đều generic — nhận `keywords` + `fields`, không dính riêng niche). Không tạo helper mới.

---

## 4. Filtering — Domain × Niche × Product type (AND, áp cả 2 khu)

Tất cả kết hợp **AND**; facet để "All" nghĩa là bỏ lọc chiều đó.

### 4.1 Niche & Product type (keyword taxonomy)
- Dùng `nicheOrWhere(parseKeywords(kw), fields)`:
  - Ads: `fields = ['title','body']`
  - Products: `fields = ['title']`
- Merge vào `where` hiện có bằng `{ AND: [ base, nicheWhere?, productTypeWhere? ].filter(Boolean) }` — chỉ thêm phần nào có keyword (helper trả `undefined` khi rỗng → không narrow).

### 4.2 Domain (1 chuỗi domain → cả store + ad-domain)
- Domain là **1 chuỗi** (vd `familystore.com`). Chuẩn hoá bằng `normalizeDomain` (`@/lib/spy/shopify`) khi build danh sách và khi so khớp (strip `www.`, lowercase).
- **Products** (`/api/spy/products?domain=`): `where.store = { domain: <norm> }` (đồng thời cần match cả biến thể `www.` nếu dữ liệu lưu khác — so khớp trên tập `[bare, "www."+bare]`).
- **Ads** (`/api/spy/ads?domain=`): `where.advertiser = { OR: [ { store: { domain } }, { adDomain: { domain } } ] }` (SpyAdvertiser có sẵn relation `store` + `adDomain`). Cũng match cả biến thể `www.`.
- Nếu 1 domain chỉ có 1 phía (chỉ store, hoặc chỉ ad-domain) thì khu còn lại hiển thị rỗng cho domain đó — đúng kỳ vọng.

### 4.3 Sub-view signal filters (chỉ Ad Library)
Tính sau khi query (signals là derived), giữ nguyên cơ chế `flags` hiện có, **bổ sung**:
- `launching` → `x.signals.newProductLaunching`
- `winning` → `x.signals.isLongRunning || x.signals.isScaling`

---

## 5. Layout / Nav

App Sidebar chính (280px) giữ nguyên. Trong khu Spy:

```
TẦNG 1:  [Ad Library]   Product Spy   Ideas
TẦNG 2:  New Ads | New Launching Ads | Winning Ads (Long Ads)   (khi ở Ad Library)
         New Product Add | Best Seller                          (khi ở Product Spy)
┌ Facet sidebar (~220px) ┬ Lưới kết quả ─────────────┐
│ DOMAIN                 │  grid cards…               │
│  • All / homesizy / …  │                            │
│ NICHE                  │                            │
│  • All / Disney / …    │                            │
│ PRODUCT TYPE           │                            │
│  • All / …             │                            │
│ ──────────────         │                            │
│ SETUP                  │                            │
│  • Sources             │                            │
│  • Niche               │                            │
│  • Product type        │                            │
└────────────────────────┴────────────────────────────┘
```

- **Tầng 1** (`SpySectionNav` tái dùng): Ad Library · Product Spy · Ideas.
- **Tầng 2**: hàng sub-tab đổi theo khu.
- **Facet sidebar** (component mới `SpyFilterSidebar`): 3 nhóm facet (Domain/Niche/Product type) + nhóm **Setup** với 3 link điều hướng (Sources, Niche, Product type). Facet đang chọn được highlight; bấm "All" để bỏ lọc.
- **Ideas** là 1 area tầng 1 (không có sub-view tầng 2), giữ dạng list như hiện tại. Ở area này facet không tác động (có thể ẩn facet, chỉ chừa nhóm Setup).

### 5.1 URL state
`?area=ads|products|ideas & view=<subview> & domain=<str> & niche=<id> & type=<id>`. Đổi facet/sub-view cập nhật URL (không reload); F5 giữ nguyên trạng thái.

Mapping sub-view → fetch:
| Area | View | Fetch |
|---|---|---|
| ads | new | `/api/spy/ads?filter=new` + facets |
| ads | launching | `/api/spy/ads?filter=launching` + facets |
| ads | winning | `/api/spy/ads?filter=winning` + facets |
| products | new-add | `/api/spy/products?days=30` + facets |
| products | best-seller | *(stub, không fetch — hiện placeholder Phase C)* |

facets = `&domain=&nicheId=&productTypeId=` theo lựa chọn.

---

## 6. API

### Mới
- **`/api/spy/product-types`** — CRUD mirror `/api/spy/niches`:
  - `GET` list (order by name).
  - `POST {name, keywords}` — `keywords` nhận array hoặc chuỗi phân tách bởi `,`/newline; normalize → JSON string; `name` bắt buộc (400 nếu rỗng); **upsert theo name**.
  - `PATCH {id, name?, keywords?, active?}`.
  - `DELETE {id}`.
- **`/api/spy/filters`** — `GET` → `{ domains: string[], niches: {id,name}[], productTypes: {id,name}[] }`.
  - `domains` = union `SpyStore.domain` ∪ `SpyAdDomain.domain`, normalize + dedupe + sort.
  - `niches`/`productTypes` = list active, id+name, order by name.

### Sửa
- **`/api/spy/ads`**: thêm param `productTypeId` + `domain`; merge AND như `nicheId`; thêm cờ `launching`/`winning` vào `flags`.
- **`/api/spy/products`**: thêm param `productTypeId` + `domain`; merge AND.

---

## 7. Pages / Components

### Trang
- **`/tools/spy-idea`** (viết lại): trang browse 2 khu — tầng1/tầng2 + `SpyFilterSidebar` + grid. Đọc/ghi URL state.
- **`/tools/spy-idea/sources`** (mới): gom quản lý — thêm/scan/xoá **store Shopify** (từ tab Stores cũ) + thêm/scan/xoá **ad-domain & fanpage** (`DomainBlock` từ report Ad Library cũ).
- **`/tools/spy-idea/product-types`** (mới): setup Product type — mirror trang `/niches` (form add + row inline edit + delete), tái dùng component row/editor chung với Niche.
- **`/tools/spy-idea/niches`**: giữ nguyên (Phase A).
- **`/tools/spy-idea/dashboard`**: **xoá** (redirect về `/tools/spy-idea?area=ads&view=winning` nếu cần giữ link cũ).

### Component
- **`SpyFilterSidebar`** (mới, `src/components/spy/`): props `{ filters: {domains,niches,productTypes}, selected: {domain,niche,type}, onSelect(dim,value) }` + render nhóm Setup (link tĩnh). Client component.
- **`AdCard`** (extract, `src/components/spy/AdCard.tsx`): hiện `AdCard` đang bị **lặp** ở `page.tsx` và `dashboard/page.tsx` → extract 1 chỗ, dùng lại. (Xoá bản lặp.)
- **`ProductCard`** (extract, `src/components/spy/ProductCard.tsx`): extract từ block product hiện tại.
- **`TaxonomyEditor`** (extract dùng chung Niche + Product type): form add + row (chip keyword, inline edit, delete). Trang niches có thể refactor để dùng lại — **không đổi API/URL Phase A**.

### Sidebar app chính
- Cập nhật `src/components/Sidebar.tsx`: link vào tool spy trỏ `/tools/spy-idea` (browse). Bỏ mọi link trỏ `/dashboard` cũ.

---

## 8. Non-goals (Phase B)
- Best Seller scrape (Phase C) — chỉ stub.
- Multi-select facet (Phase B: single-select mỗi facet).
- Không đổi `SpyNiche`, `/api/spy/niches`, trang `/niches` (chỉ có thể refactor nội bộ để share `TaxonomyEditor`).
- Không dùng `SpyProduct.productType`/`SpyProduct.niche` legacy cho filter mới.
- Không đụng scan/cron/ingest.

---

## 9. Testing
- `product-types` route: tsc/lint (runtime qua UI) — hành vi giống `niches` đã có test helper.
- ads/products `productTypeId`+`domain`: tsc/lint; unit cho phần build where nếu tách hàm thuần.
- `/api/spy/filters`: tsc/lint.
- `SpyFilterSidebar` / browse page: tsc/lint + manual (facet chọn/bỏ, URL state, đổi area/sub-view).
- Regression: `niche.ts` unit, order-profit 2 fail cũ (không liên quan) vẫn như cũ.

---

## 10. Phân phase implement (cho writing-plans)
1. `SpyProductType` model + migration (v28→v29) + `/api/spy/product-types` CRUD (tái dùng `niche.ts`).
2. `/api/spy/filters`; thêm `productTypeId`+`domain` vào ads/products; thêm cờ `launching`/`winning` cho ads.
3. Extract shared components: `AdCard`, `ProductCard`, `TaxonomyEditor`.
4. `SpyFilterSidebar` + viết lại trang browse `/tools/spy-idea` (2 khu, tầng1/2, URL state); xoá dashboard.
5. Trang `/tools/spy-idea/sources` (gom quản lý store + ad-domain/fanpage) + trang `/tools/spy-idea/product-types`; wire link Setup; cập nhật Sidebar app.
