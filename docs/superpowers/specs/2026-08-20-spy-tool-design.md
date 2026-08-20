# Spy Tool — Design Spec

**Date:** 2026-08-20
**Status:** Draft for user review
**Module:** Product/Ad spy inside the Ecom Manager app (Prisma + Next.js)

---

## 1. Mục tiêu

Xây một module "Spy" trong app Ecom Manager để:

1. Quét sản phẩm của các store theo dõi **2 lần/ngày** → biết store thêm dòng sản phẩm / niche gì.
2. Quét **Facebook Ad Library** của từng store → ad nào đang running, ad nào mới, ad nào chạy lâu (winning), ad nào đang scale.
3. Quét Ad Library theo **keyword** → phát hiện POD đang trending.
4. **IDEA vault** — lưu lại ý tưởng hay để xem lại.

Ưu tiên của bản spec này là **mô hình database + thiết kế ID**; kiến trúc scan/UI mô tả đủ để justify schema và cho phase implement sau.

---

## 2. Quyết định nền tảng (đã chốt với user)

| Vấn đề | Quyết định |
|---|---|
| Vị trí | Module trong app Ecom Manager (thêm models vào `prisma/schema.prisma` + UI mới) |
| Nguồn Ad Library | Apify actor `curious_coder/facebook-ads-library-scraper` (API chính thức của Meta không có ads thương mại/POD ngoài EU) |
| Map store→ads | Cả hai: ưu tiên FB Page ID, fallback search theo brand/domain |
| Nguồn store products | Fetch trực tiếp `{domain}/products.json` (không cần Apify) |

Ghi chú Apify actor: input nhận `urls` (page URL **hoặc** Ad Library search URL), trả về `ad_archive_id`, `is_active`, `start_date`, `end_date`, `total_active_time`, `collation_count/collation_id`, `page_id/page_name`, page likes/category, và `snapshot` (creative: images/videos/cards, body, cta, link_url). Giá ~$0.75/1K ads (pay-per-event).

---

## 3. Triết lý mô hình

Tách 2 loại bảng:

- **Entity (ổn định):** dedup theo *natural key* của nguồn, giữ trạng thái mới nhất + `firstSeenAt`/`lastSeenAt`.
- **Observation (theo thời gian):** append-only, mỗi lần scan ghi 1 dòng, để dựng lại lịch sử (thời lượng chạy ad, ad tắt lúc nào, collation tăng = scaling).

### Nguyên tắc ID

1. **PK nội bộ luôn `cuid()`** — thống nhất convention hiện tại.
2. **ID gốc từ nguồn lưu thành field riêng, unique scope đúng:**
   - Shopify product id → `@@unique([storeId, externalProductId])` (chỉ unique trong 1 store).
   - FB page id → `fbPageId` unique toàn cục.
   - FB ad id → `adArchiveId` unique toàn cục (neo dedup + nối observation).
3. **Không dùng ID gốc làm PK.**
4. **Provenance:** mọi entity/observation mang `scanId`.
5. Prefix `Spy…` cho mọi model. SQLite: enum → `String` (allowed values ghi chú), JSON → `String` (theo convention `permissions`/`tags` hiện có).

---

## 4. Prisma schema (models mới)

> Thêm vào `prisma/schema.prisma`. Không sửa model hiện có, trừ việc thêm relation ngược nếu cần (không bắt buộc — các Spy model đứng độc lập).

```prisma
model SpyStore {
  id        String   @id @default(cuid())
  domain    String   @unique          // natural key, normalized (no trailing slash, no protocol)
  name      String?
  platform  String   @default("shopify")
  status    String   @default("active") // "active" | "paused"
  tags      String   @default("[]")     // JSON array
  notes     String?
  addedAt   DateTime @default(now())
  updatedAt DateTime @updatedAt

  products    SpyProduct[]
  advertisers SpyAdvertiser[]

  @@index([status])
}

model SpyProduct {
  id                String    @id @default(cuid())
  storeId           String
  store             SpyStore  @relation(fields: [storeId], references: [id], onDelete: Cascade)
  externalProductId String                      // Shopify product id (string)
  handle            String?
  title             String?
  productType       String?
  vendor            String?
  tags              String    @default("[]")    // JSON array
  imageUrl          String?
  priceMin          Float?
  priceMax          Float?
  variantCount        Int     @default(0)
  availableVariantCount Int   @default(0)
  niche             String?                     // classified later
  publishedAt       DateTime?                   // Shopify published_at ?? created_at
  dateSource        String?                     // "published_at" | "created_at"
  status            String    @default("active") // "active" | "removed"
  firstSeenAt       DateTime  @default(now())
  lastSeenAt        DateTime  @default(now())

  snapshots SpyProductSnapshot[]

  @@unique([storeId, externalProductId])
  @@index([firstSeenAt])
  @@index([productType])
  @@index([storeId])
}

// Optional price/title history — chỉ insert khi có thay đổi
model SpyProductSnapshot {
  id         String     @id @default(cuid())
  productId  String
  product    SpyProduct @relation(fields: [productId], references: [id], onDelete: Cascade)
  scanId     String
  scan       SpyScan    @relation(fields: [scanId], references: [id])
  title      String?
  priceMin   Float?
  priceMax   Float?
  available  Boolean?
  capturedAt DateTime   @default(now())

  @@index([productId])
  @@index([scanId])
}

model SpyAdvertiser {
  id             String    @id @default(cuid())
  fbPageId       String    @unique            // natural key
  pageName       String?
  pageCategory   String?
  pageProfileUri String?
  likes          Int?
  igUsername     String?
  igFollowers    Int?
  entityType     String?
  storeId        String?                        // link khi biết store
  store          SpyStore? @relation(fields: [storeId], references: [id], onDelete: SetNull)
  firstSeenAt    DateTime  @default(now())
  lastSeenAt     DateTime  @default(now())

  ads SpyAd[]

  @@index([storeId])
}

model SpyAd {
  id                 String        @id @default(cuid())
  adArchiveId        String        @unique     // THE stable natural key
  advertiserId       String
  advertiser         SpyAdvertiser @relation(fields: [advertiserId], references: [id], onDelete: Cascade)
  pageId             String                     // denormalized fbPageId
  startDate          DateTime?
  endDate            DateTime?
  isActive           Boolean       @default(true)  // latest known
  collationCount     Int?
  collationId        String?
  mediaType          String?                    // "image" | "video" | "carousel" | "dco"
  displayFormat      String?
  ctaType            String?
  ctaText            String?
  linkUrl            String?
  title              String?
  body               String?
  caption            String?
  publisherPlatforms String        @default("[]")  // JSON array
  currency           String?
  adLibraryUrl       String?
  rawPayload         String?                    // full actor item as JSON
  firstSeenAt        DateTime      @default(now())
  lastSeenAt         DateTime      @default(now())

  observations SpyAdObservation[]
  keywordHits  SpyKeywordHit[]

  @@index([advertiserId])
  @@index([startDate])
  @@index([isActive])
}

model SpyAdObservation {
  id              String   @id @default(cuid())
  adId            String
  ad              SpyAd    @relation(fields: [adId], references: [id], onDelete: Cascade)
  scanId          String
  scan            SpyScan  @relation(fields: [scanId], references: [id])
  isActive        Boolean
  collationCount  Int?
  impressionsIndex Int?
  observedAt      DateTime @default(now())

  @@unique([adId, scanId])
  @@index([adId])
  @@index([scanId])
}

model SpyKeyword {
  id        String   @id @default(cuid())
  term      String
  country   String   @default("ALL")
  note      String?
  active    Boolean  @default(true)
  createdAt DateTime @default(now())

  hits SpyKeywordHit[]

  @@unique([term, country])
}

model SpyKeywordHit {
  id         String     @id @default(cuid())
  keywordId  String
  keyword    SpyKeyword @relation(fields: [keywordId], references: [id], onDelete: Cascade)
  adId       String
  ad         SpyAd      @relation(fields: [adId], references: [id], onDelete: Cascade)
  scanId     String
  scan       SpyScan    @relation(fields: [scanId], references: [id])
  rank       Int?
  observedAt DateTime   @default(now())

  @@unique([keywordId, adId, scanId])
  @@index([keywordId])
  @@index([adId])
}

model SpyScan {
  id             String    @id @default(cuid())
  type           String                       // "STORE_PRODUCTS" | "STORE_ADS" | "KEYWORD_ADS"
  targetType     String                       // "STORE" | "KEYWORD"
  targetId       String
  status         String    @default("running") // "running" | "success" | "failed"
  apifyRunId     String?
  apifyDatasetId String?
  stats          String?                      // JSON: { found, new, updated }
  error          String?
  startedAt      DateTime  @default(now())
  finishedAt     DateTime?

  adObservations   SpyAdObservation[]
  productSnapshots SpyProductSnapshot[]
  keywordHits      SpyKeywordHit[]

  @@index([type])
  @@index([status])
  @@index([startedAt])
}

model SpyIdea {
  id            String   @id @default(cuid())
  title         String
  note          String?
  status        String   @default("NEW")      // "NEW" | "EXPLORING" | "TESTING" | "ARCHIVED"
  tags          String   @default("[]")       // JSON array
  refType       String   @default("NONE")     // "AD" | "PRODUCT" | "ADVERTISER" | "STORE" | "KEYWORD" | "NONE"
  refAdId       String?
  refProductId  String?
  refStoreId    String?
  refKeywordId  String?
  snapshotJson  String?                        // copy of the item at save time (durable)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([status])
  @@index([refType])
}
```

Sau khi thêm: `npx prisma migrate dev --name add_spy_tool` → `npx prisma generate` → bump `SCHEMA_VERSION` trong `src/lib/db.ts` → restart dev server. (Theo Absolute Rules trong CLAUDE.md.)

---

## 5. Scanning architecture

### 5.1 Ba scanner

| Scanner | Nguồn | Chi phí | Tần suất |
|---|---|---|---|
| Store products | `{domain}/products.json?limit=250&page=1` | Free | 2×/ngày |
| Store ads | Apify actor, input = page URL | ~$0.75/1K ads | 1×/ngày |
| Keyword ads | Apify actor, input = Ad Library search URL | ~$0.75/1K ads | 1×/ngày |

### 5.2 Apify integration (`src/lib/spy/apify.ts`)

- Env `APIFY_TOKEN` (token riêng của app).
- Async: `POST https://api.apify.com/v2/acts/curious_coder~facebook-ads-library-scraper/runs?token=…` → nhận `runId`+`defaultDatasetId`, lưu vào `SpyScan` (status=`running`).
- Hoàn tất qua **webhook** `POST /api/spy/apify-webhook` (Apify gọi khi run xong) HOẶC poll `GET /v2/actor-runs/{runId}`. Khi `SUCCEEDED` → đọc `GET /v2/datasets/{datasetId}/items` → ingest.
- Input builders:
  - Store ads: `{ urls:[{url:"https://www.facebook.com/{pageAlias|pageId}"}], "scrapePageAds.activeStatus":"all", "scrapePageAds.sortBy":"impressions_desc", "scrapePageAds.countryCode":"ALL", count:N }`
  - Keyword ads: `{ urls:[{url: buildSearchUrl(term,country)}], count:N }`
    `buildSearchUrl = https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country={CC}&q={term}&search_type=keyword_unordered&media_type=all`

### 5.3 Ingest pipeline (`src/lib/spy/ingest.ts`) — idempotent

1. Tạo `SpyScan` (running).
2. Lấy data (products.json hoặc Apify dataset items).
3. Mỗi item:
   - Upsert entity theo natural key; `lastSeenAt=now`, nếu mới set `firstSeenAt`.
   - Insert observation kèm `scanId` (ad → `SpyAdObservation`; keyword → thêm `SpyKeywordHit`; product đổi giá → `SpyProductSnapshot`).
   - Ad: `isActive` lấy thẳng từ field actor.
4. `SpyScan` → success + `stats`. Lỗi → failed + `error`.

Idempotency: upsert theo natural key + observation `@@unique([adId,scanId])`. Products.json chỉ trả 250 sp mới nhất → KHÔNG auto-mark "removed" cho sp cũ vắng mặt.

### 5.4 Cron (`src/lib/spy/scheduler.ts`, gọi từ `instrumentation.ts`)

`node-cron`, timezone `Asia/Ho_Chi_Minh`:
- Products: `0 8,20 * * *`
- Store ads: `0 9 * * *`
- Keyword ads: `0 10 * * *`

Chạy tuần tự/stagger để không vượt concurrency Apify. Nút "Scan ngay" thủ công cho từng target.

### 5.5 API routes

- `POST/GET/DELETE /api/spy/stores` — CRUD store + trigger scan.
- `POST/GET/DELETE /api/spy/keywords` — CRUD keyword.
- `POST /api/spy/scan` — trigger scan thủ công `{ type, targetId }`.
- `POST /api/spy/apify-webhook` — nhận callback Apify, ingest.
- `GET /api/spy/dashboard` — feed sp mới + ads New/Winning + keyword trending.
- `GET /api/spy/ads`, `/api/spy/products` — list + filter.
- `GET/POST/PATCH/DELETE /api/spy/ideas` — IDEA vault.

---

## 6. Derived signals (tính khi đọc, không lưu cứng)

| Tín hiệu | Công thức |
|---|---|
| Ad NEW (theo FB) | `startDate ≥ now − 7d` |
| Ad NEW (do ta phát hiện) | `firstSeenAt` trong scan mới nhất |
| Ad LONG-RUNNING / winning | active AND `activeDays = (endDate‖now) − startDate ≥ 21d` |
| Ad SCALING | `collationCount` tăng qua observation, hoặc cao bất thường |
| Ad STOPPED | trước active, nay `isActive=false` |
| Store thêm dòng gì | `SpyProduct` group theo `productType`/`vendor`/`tags`, lọc `firstSeenAt` gần đây |
| Keyword TRENDING | mỗi keyword: đếm ad active + advertiser distinct qua thời gian; delta tăng |

Ngưỡng (7d, 21d…) lưu `AppSetting` key `spy_thresholds` hoặc const trong `src/lib/spy/signals.ts`.

---

## 7. UI (phác — DB-first)

- **Spy Dashboard** (`/spy`): feed sp mới · ads New/Winning · keyword trending.
- **Store detail** (`/spy/stores/[id]`): timeline sp + phân bố niche + ads của store.
- **Ad detail** (`/spy/ads/[id]`): creative + timeline chạy (từ observation) + nút "Lưu IDEA".
- **Keyword detail** (`/spy/keywords/[id]`): ads theo thời gian + top advertiser.
- **IDEA vault** (`/spy/ideas`): list/filter + kanban theo status.
- Thêm mục "Spy" vào `src/components/Sidebar.tsx`.
- Tuân design tokens + page pattern trong CLAUDE.md (`'use client'`, `<Sidebar/>`, layout `ml-[280px]`…).

---

## 8. Edge cases & constraints

- Apify run fail → `SpyScan.failed` + error; cron sau retry.
- Guard chi phí: cap `count`/`limitPerSource` mỗi run (mặc định ví dụ 500 ads/store, 1000/keyword).
- Data thiếu (page deleted, ad gated, không có snapshot) → lưu phần lấy được, không vỡ pipeline.
- Store products.json bị chặn/404 → `SpyScan.failed`, bỏ qua store đó.
- Cùng 1 ad xuất hiện ở nhiều keyword → nhiều `SpyKeywordHit`, 1 `SpyAd` (đúng dedup).
- Ad Library API chính thức KHÔNG dùng được cho POD → bắt buộc qua Apify (đã chốt).
- IDEA lưu `snapshotJson` → vẫn xem lại được dù ad gốc bị gỡ / product bị xoá.

---

## 9. File changes (dự kiến, cho implementation plan)

### Mới
- `prisma/schema.prisma` — thêm 10 Spy models (mục 4).
- `src/lib/spy/apify.ts` — gọi actor + đọc dataset.
- `src/lib/spy/ingest.ts` — pipeline upsert entity + observation.
- `src/lib/spy/scanners.ts` — 3 scanner (products/store-ads/keyword-ads).
- `src/lib/spy/signals.ts` — hàm tính derived signals + ngưỡng.
- `src/lib/spy/scheduler.ts` — cron, gọi từ `instrumentation.ts`.
- `src/app/api/spy/**` — routes (mục 5.5).
- `src/app/spy/**` — pages (mục 7).

### Sửa
- `instrumentation.ts` — gọi `initSpyScheduler()`.
- `src/lib/db.ts` — bump `SCHEMA_VERSION`.
- `src/components/Sidebar.tsx` — thêm nav "Spy".
- `.env` — thêm `APIFY_TOKEN`.

---

## 10. Phân phase (đề xuất cho writing-plans)

1. **Phase 1 — Database + store products** (ưu tiên user): schema + migration + scanner products.json 2×/ngày + list sp mới + IDEA vault cơ bản.
2. **Phase 2 — Ad Library qua Apify:** integration + store ads + ad detail + signals new/long-running/scaling.
3. **Phase 3 — Keyword trending:** keyword CRUD + keyword scanner + trending dashboard.
4. **Phase 4 — Đánh bóng:** niche classification, cost guard, alerts.

---

## 11. Reconciliation với `/tools/spy-idea` đã tồn tại (đã chốt: tiến hoá)

Codebase đã có tính năng on-demand [/api/tools/spy-idea/route.ts](../../../src/app/api/tools/spy-idea/route.ts) + trang [/tools/spy-idea](../../../src/app/tools/spy-idea/page.tsx): quét ≤10 domain qua `products.json`, parse rich fields, lọc 7 ngày, dedup cache RAM 24h, lưu domain ở localStorage. **Quyết định: tiến hoá cái này thành tool bền vững**, KHÔNG làm greenfield `/spy`.

Hệ quả áp dụng cho plan:

1. **Tái dùng (DRY):** tách các helper thuần từ route hiện tại ra `src/lib/spy/shopify.ts`:
   `normalizeStoreUrl` (đã chặn SSRF local/private IP), `parseDate`, `stripHtml`, `tagsToArray`, `priceSummary`, `productUrl`, `productCacheKey`, và hàm map `ShopifyProduct → parsed`. Route on-demand cũ import lại từ lib (không đổi hành vi). Scanner theo lịch cũng dùng chung.
2. **Routing:** giữ namespace `/tools/spy-idea` (khớp nav "Tools > Spy Idea" + roles `tools_spy_idea`). Trang này tiến hoá thành dashboard bền vững; các khu con: `/tools/spy-idea/ideas`, `/tools/spy-idea/ads`, `/tools/spy-idea/keywords`. KHÔNG dùng `/spy`. Các route API mới đặt dưới `/api/tools/spy/**` (hoặc mở rộng `/api/tools/spy-idea`).
3. **Domain nguồn:** chuyển từ localStorage → bảng `SpyStore` (vẫn có thể giữ localStorage như quick-scan tạm cho tới khi UI store list xong).
4. **Field mapping:** `SpyProduct` bổ sung `variantCount`, `availableVariantCount`, `dateSource`, `publishedAt = published_at ?? created_at`; `priceMin/priceMax` lấy từ `priceSummary` (min/max numeric), UI tự dựng chuỗi "min - max".
5. **`productCacheKey` hiện tại** (`id:` / `handle:` / `url:`) chính là `externalProductId` cho persistence; ưu tiên `product.id` làm `externalProductId`, fallback handle.

Roles: thêm quyền/allowlist cho các route con mới trong `src/lib/roles.ts` (`tools_spy_idea` map thêm `/tools/spy-idea/*`) để `visibleFor` không ẩn.
