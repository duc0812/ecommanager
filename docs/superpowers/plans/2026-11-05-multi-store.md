# Đa store + Reminiso: kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tool quản lý nhiều store Shopify mà token, lịch chạy và quyền xem không lẫn nhau, rồi đưa Reminiso vào trước 05/12/2026.

**Architecture:** Thông tin kết nối chuyển sang bảng riêng theo store. Mọi lệnh gọi Shopify đi qua `getStoreConnection(storeId)`, mọi lịch chạy đi qua `forEachConnectedStore`. Quyền xem đi qua một hàm `storeScopeFor`, và seller bị từ chối mặc định ở mọi route chưa được khai là đã lọc store.

**Tech Stack:** Next.js 14, Prisma + SQLite, Vitest, node-cron.

**Spec:** `docs/superpowers/specs/2026-11-05-multi-store-design.md`

**Phạm vi:** Giai đoạn 1 đến 5 của spec. Giai đoạn 6 (CS theo store) sẽ có kế hoạch riêng khi owner có hộp thư Freshdesk của Reminiso.

## Global Constraints

- Code gốc: nhánh mới `feat/multi-store` cắt từ `origin/main` mới nhất, trong worktree riêng. `main` local đang chậm, không đọc ở đó.
- Litzzy phải chạy như cũ sau mỗi task. Không đổi URL hay kiểu trả về của API đang dùng; chỉ thêm trường.
- Mỗi lần đổi schema: dựng migration, chạy `npx prisma generate`, tăng `SCHEMA_VERSION` trong `src/lib/db.ts` thêm 1. Trên máy này `prisma migrate dev` có thể không tạo gì mà vẫn exit 0: kiểm tra `ls prisma/migrations`, tạo folder từ `npx prisma migrate diff` nếu trống.
- Không thêm `url` vào `datasource db`. Import Prisma từ `@/generated/prisma/client`, dùng `prisma` trong `@/lib/db`.
- Route mới phải có rule trong `API_ACCESS_RULES`. Route đổi secret phải gọi `requireSuperadmin`. GET chỉ trả secret dạng che (`maskApiKey`).
- Test chạy trên `test.db`, tự tạo fixture. Không bao giờ dùng `dev.db`.
- UI theo mẫu trong `CLAUDE.md`. Ngày hiển thị dạng MM/DD/YYYY, chữ giao diện tiếng Việt như các trang hiện có.
- Không comment trừ khi giải thích ràng buộc không hiển nhiên.
- Deploy chỉ khi owner đồng ý, ghi prod từ từ vì VPS yếu, báo phiên "Đẩy prod" trước và sau. Migrate prod cần `pm2 stop podmanager`.
- Mỗi commit kết thúc bằng dòng `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **Store mới có tiền tố số đơn trùng store cũ** (hoặc không có tiền tố, `#1001`): form từ chối, vì task key và sheet chỉ phân biệt store bằng số đơn. Test ở Task 11.
2. **Secret bị đổi hoặc lấy token thất bại giữa lịch chạy:** store đó được ghi lỗi, store sau vẫn chạy, và không bao giờ dùng token của store khác. Test ở Task 2 và 5.
3. **Seller chưa được giao store nào:** thấy danh sách rỗng, không phải toàn bộ. `?storeId=` của store khác trả 403. Test ở Task 7.
4. **Sheet có dòng số đơn không thuộc store nào hoặc store đang tắt:** báo lỗi, không fulfill. Test ở Task 13.
5. **OAuth trả về cho store khác store đã bắt đầu, hoặc cài lại app:** chỉ cập nhật đúng store trong state, không đụng store còn lại. Test ở Task 3.

---

## Phần A: kết nối theo store (giai đoạn 1)

### Task 1: Schema kết nối và quyền

**Files:**
- Modify: `prisma/schema.prisma`, `src/lib/db.ts`
- Create: `prisma/migrations/<stamp>_multi_store/migration.sql`
- Test: `tests/multi-store-schema.integration.test.ts`

**Interfaces:**
- Produces:
  - `model ShopifyStoreCredential { storeId String @id; store ShopifyStore @relation(onDelete: Cascade); authMode String; clientId String?; clientSecret String?; accessToken String?; tokenExpiresAt DateTime?; connectedAt DateTime @default(now()); updatedAt DateTime @updatedAt }`, với `authMode` là `TOKEN | OAUTH | CLIENT_CREDENTIALS`. Bảng riêng vì `include: { shopifyStore: true }` và `include: { store: true }` có sẵn trong code sẽ trả cả token ra API nếu để cột trên `ShopifyStore`.
  - `ShopifyStore` thêm: `enabled Boolean @default(true)`, `orderPrefix String?`, `trackingPageUrl String?`, `payoutStartDate String?`, `lastError String?`, `lastErrorAt DateTime?`.
  - `model UserStoreAccess { userId String; storeId String; @@id([userId, storeId]) }`, có relation `onDelete: Cascade` với `AppUser` và `ShopifyStore`.

- [ ] **Step 1: Viết test migration**

`copies the connection into the credential table`: sau migration, trong fixture có `AppSetting` `shopify.connection.shop/token`, `shopify.app.apiKey/apiSecret`, dòng credential của store đó có `authMode = 'OAUTH'`, `accessToken`, `clientId`, `clientSecret` đúng. Vì test.db đã qua migration, tách phần sao chép thành SQL file đọc lại trong test: chạy nội dung câu lệnh bằng `prisma.$executeRawUnsafe` trên fixture.

- [ ] **Step 2: Chạy test, phải FAIL**

Run: `npx vitest run tests/multi-store-schema.integration.test.ts`
Expected: FAIL, bảng chưa có.

- [ ] **Step 3: Sửa schema, tạo migration, tăng `SCHEMA_VERSION`**

Migration kèm dữ liệu:
- `INSERT` credential từ `AppSetting` cho store có `shop = shopify.connection.shop`.
- `UPDATE` store `caramiaus-store.myshopify.com`: `orderPrefix = 'LIT'`, `trackingPageUrl = 'https://litzzy.com/apps/trackingorder?nums='`.
- `UPDATE ShopifyStore SET enabled = false` cho store không có credential (`test-store`, `mbc-test`).
- `INSERT` `UserStoreAccess` cho mọi `AppUser.role = 'SELLER'` với store Litzzy.
- Không xoá `AppSetting` cũ, để rollback được.

- [ ] **Step 4: Chạy test, phải PASS**

Run: `npx vitest run tests/multi-store-schema.integration.test.ts`

- [ ] **Step 5: Thử migration trên bản sao prod mới**

Run: `DATABASE_URL="file:<bản sao mới>" npx prisma migrate deploy`
Expected: thành công, `SELECT count(*) FROM "Order"` không đổi, Litzzy có một dòng credential.

- [ ] **Step 6: Commit** `feat(store): per-store credentials, store fields and user store access`

### Task 2: Thư viện kết nối

**Files:**
- Create: `src/lib/store-connections.ts`
- Test: `tests/store-connections.integration.test.ts`

**Interfaces:**
- Produces:
```ts
export type StoreConnection = { storeId: string; shop: string; token: string }
export type ConnectedStore = { id: string; shop: string; orderPrefix: string | null; ianaTimezone: string | null; projectId: string | null; projectName: string | null; payoutStartDate: string | null; trackingPageUrl: string | null }
export class StoreConnectionError extends Error { storeId: string; shop: string; code: 'NOT_CONNECTED' | 'DISABLED' | 'MINT_FAILED' }
export async function getStoreConnection(storeId: string): Promise<StoreConnection>
export async function getStoreConnectionByShop(shop: string): Promise<StoreConnection>
export async function listConnectedStores(): Promise<ConnectedStore[]>
export async function saveStoreCredential(storeId: string, input: { authMode: 'TOKEN' | 'OAUTH' | 'CLIENT_CREDENTIALS'; clientId?: string | null; clientSecret?: string | null; accessToken?: string | null; tokenExpiresAt?: Date | null }): Promise<void>
export async function mintClientCredentialsToken(shop: string, clientId: string, clientSecret: string): Promise<{ token: string; expiresAt: Date }>
export function maskCredential(value: string | null): string | null
```

- [ ] **Step 1: Viết test** (mock `global.fetch`)

- `returns the stored token for that store, never another store's`: hai store, hai token, mỗi `storeId` nhận đúng token của nó.
- `mints when a client-credentials token is missing or within 1 hour of expiry`: `tokenExpiresAt` còn 30 phút thì fetch được gọi với `grant_type=client_credentials`, token mới được lưu, `tokenExpiresAt` = now + `expires_in`.
- `does not mint when more than 1 hour remains`: fetch không được gọi.
- `two concurrent calls mint once`: `Promise.all` hai lần gọi, fetch chạy 1 lần.
- `a failed mint throws MINT_FAILED and keeps the old token`: fetch 400, lỗi mang `code = 'MINT_FAILED'` và đúng `shop`, không đọc token store khác.
- `disabled store throws DISABLED`, `store without credential throws NOT_CONNECTED`.
- `listConnectedStores skips disabled stores and stores with no credential`.

- [ ] **Step 2: Chạy test, phải FAIL**

Run: `npx vitest run tests/store-connections.integration.test.ts`

- [ ] **Step 3: Viết `src/lib/store-connections.ts`**

Đọc DB mỗi lần, không cache token trong biến global. Khoá mint trùng bằng `Map<storeId, Promise>` đặt trên `globalThis` như `job-lock.ts`.

- [ ] **Step 4: Chạy test, phải PASS**

- [ ] **Step 5: Commit** `feat(store): store connection library with client-credentials refresh`

### Task 3: OAuth và trạng thái theo store

**Files:**
- Modify: `src/lib/token-store.ts`, `src/app/api/auth/shopify/route.ts`, `src/app/api/auth/shopify/callback/route.ts`, `src/app/api/auth/shopify-config/route.ts`, `src/app/api/auth/status/route.ts`, `scripts/check-shopify-scopes.mjs`
- Test: `tests/shopify-oauth-store.integration.test.ts`

**Interfaces:**
- Consumes: `saveStoreCredential` (Task 2).
- Produces:
  - `saveOAuthState(state, shop)` giữ nguyên chữ ký.
  - `GET /api/auth/status` trả thêm `stores: Array<{ id, shop, projectName, enabled, connected, authMode, connectedAt, lastError, lastErrorAt }>`; `shopify` giữ nguyên, lấy từ store Litzzy.
  - `POST /api/auth/shopify-config` lưu vào credential của store có `shop` đó, tạo `ShopifyStore` nếu chưa có.
  - `GET /api/auth/shopify?shop=` lấy Client ID từ credential của đúng `shop`.

- [ ] **Step 1: Viết test**

- `callback saves the token only on the store in the state`: hai store, callback cho store B, token store A không đổi.
- `callback with a shop that differs from the state returns 400 and changes nothing`.
- `callback verifies HMAC with that store's secret`: HMAC ký bằng secret store A gọi cho store B thì 400.
- `reinstall replaces only that store's token`.
- `status never returns secrets`: JSON trả về không chứa token, clientSecret.

- [ ] **Step 2: Chạy test, phải FAIL**

- [ ] **Step 3: Sửa code**

Bỏ khỏi `token-store.ts`: `setShopifyConnection`, `clearShopifyConnection`, `setShopifyAppCredentials`, `getShopifyAppCredentials`. `getShopifyConnection` giữ tạm tới hết Task 4 và đọc credential của Litzzy. Bỏ điều kiện "shop không khớp shop đã cấu hình" trong `auth/shopify/route.ts`. `DELETE /api/auth/status?storeId=` xoá credential của đúng store, bắt buộc có `storeId`.

- [ ] **Step 4: Chạy test, phải PASS. Chạy `npx tsc --noEmit`**

- [ ] **Step 5: Commit** `feat(store): OAuth and connection status per store`

### Task 4: Thay `getShopifyConnection` ở mọi nơi gọi

**Files:** (Modify)

| File | Cách lấy store |
|---|---|
| `api/design-studio/orders/[id]/refresh` | `order.storeId`; bỏ lỗi "token đang nối store khác" |
| `api/fulfillment/orders/[id]/recheck` | store của đơn `params.id` |
| `api/fulfillment/task-fix/fix` | `order.storeId` |
| `api/trello/backfill-custom-info` | store Litzzy, Trello không dùng cho store khác |
| `lib/design-studio.ts` `refreshMissingLineProps` | nhóm đơn theo store, gọi từng store; một store lỗi ghi vào `error`, store khác vẫn chạy; bỏ `otherStore` khỏi logic nhưng giữ trường bằng 0 |
| `api/shopify/payouts/[id]` | `Payout.storeId` |
| `api/shopify/payouts`, `api/fulfillment/normalize`, `api/fulfillment/tracking/sync`, `api/fulfillment/tracking/parcelpanel-sync`, `api/fulfillment/supplier-performance/backfill`, `api/fulfillment/auto-fulfill/run` | Tạm thời Litzzy qua `getStoreConnectionByShop`; Task 5 chuyển sang lặp store |
| `lib/shopify-payouts-sync.ts`, `lib/order-normalize-scheduler.ts`, `lib/tracking/scheduler.ts`, `lib/tracking/parcelpanel-scheduler.ts`, `lib/fulfillment/auto-fulfill-scheduler.ts`, `api/shopify/orders/sync` | Như trên |

**Interfaces:**
- Consumes: `getStoreConnection`, `getStoreConnectionByShop` (Task 2).

- [ ] **Step 1: Viết test** `tests/store-connection-callers.integration.test.ts`

`refreshMissingLineProps calls Shopify once per store with that store's token`: hai store, mock `fetchOrderLinePropsByNames`, kiểm tra cặp `(shop, token)` và danh sách số đơn của từng lần gọi. `one store failing does not stop the other`.

- [ ] **Step 2: Chạy test, phải FAIL**

- [ ] **Step 3: Thay toàn bộ, xoá `getShopifyConnection` khỏi `token-store.ts`**

- [ ] **Step 4: Kiểm tra**

Run: `git grep -n "getShopifyConnection" -- src` → không còn kết quả.
Run: `npx tsc --noEmit && npx vitest run` → toàn bộ PASS.

- [ ] **Step 5: Commit** `refactor(store): every Shopify call names its store`

**Mốc deploy A:** owner đồng ý rồi deploy Task 1–4. Sau deploy, so tổng đơn, payout Litzzy trước và sau; bấm sync đơn trên prod một lần.

---

## Phần B: lịch chạy theo store (giai đoạn 2)

### Task 5: Lặp theo store và cô lập lỗi

**Files:**
- Create: `src/lib/store-jobs.ts`, `src/lib/shopify-order-sync.ts`
- Modify: `src/app/api/shopify/orders/sync/route.ts`, `src/lib/auto-sync.ts`, `src/lib/shopify-payouts-sync.ts`, `src/lib/shopify-payout-policy.ts`, `src/lib/daily-sync.ts`, `src/lib/tracking/scheduler.ts`, `src/lib/order-normalize-scheduler.ts`, `src/lib/tracking/parcelpanel-scheduler.ts`, `src/lib/fulfillment/auto-fulfill-scheduler.ts`, các route `shopify/payouts`, `shopify/sync`, `fulfillment/normalize`, `fulfillment/tracking/sync`, `fulfillment/tracking/parcelpanel-sync`, `fulfillment/supplier-performance/backfill`
- Test: `tests/store-jobs.integration.test.ts`, mở rộng `src/lib/daily-sync.test.ts`

**Interfaces:**
- Consumes: `listConnectedStores`, `getStoreConnection` (Task 2), `runExclusive` (`job-lock.ts`).
- Produces:
```ts
export type StoreRunResult<T> =
  | { storeId: string; shop: string; ok: true; result: T }
  | { storeId: string; shop: string; ok: false; error: string; skipped?: boolean }
export async function forEachConnectedStore<T>(job: string, fn: (conn: StoreConnection, store: ConnectedStore) => Promise<T>, opts?: { storeIds?: string[] }): Promise<StoreRunResult<T>[]>
export async function syncStoreOrders(storeId: string, opts?: { fromOrderName?: string | null }): Promise<StoreOrderSyncResult>
export function payoutStartFor(store: { payoutStartDate: string | null }): string
export async function syncShopifyPayouts(opts: { storeId: string; requestedDateMin?: string; dateMax?: string }): Promise<...>
```
`StoreOrderSyncResult` là đúng các trường route đang trả: `totalSynced, withUnmappedSku, errors, projectId, projectName, fromOrderName, skippedBeforeFromOrder`.

- [ ] **Step 1: Viết test**

- `runs stores one at a time, in order`: hàm ghi thời điểm bắt đầu và kết thúc, không chồng nhau.
- `an error on one store is recorded and the next store still runs`: store A throw, `results[0].ok === false`, `results[1].ok === true`, `ShopifyStore.lastError` của A có nội dung, của B null.
- `a connection failure (MINT_FAILED) counts as that store's error, not a crash`.
- `success clears lastError`.
- `same job on the same store is skipped while running`, dùng khoá `${job}:${storeId}`.
- `payoutStartFor uses the store date, else SHOPIFY_PAYOUT_START_DATE`.

- [ ] **Step 2: Chạy test, phải FAIL**

- [ ] **Step 3: Viết `store-jobs.ts`, tách `syncStoreOrders` khỏi route**

Chuyển nguyên logic route sang lib, thêm:
- Tra `fromOrderName` chỉ trong đúng store.
- Nhánh Trello chỉ chạy khi `store.orderPrefix === 'LIT'`.
- `loadProductBasesForResolver` dùng chung, `loadLegacyTypesForResolver` và `loadProductProfilesForResolver` giữ tham số `store.id`.

Route `POST /api/shopify/orders/sync` nhận thêm `storeId` trong body. Có `fromOrderName` mà không có `storeId` thì suy store từ tiền tố, không suy được trả 400. Không có `storeId` thì chạy mọi store. Trả các trường cũ là tổng cộng, thêm `stores: StoreRunResult[]`. Status 502 chỉ khi mọi store lỗi; một store lỗi thì trả 200 kèm lỗi trong `stores` và `errors`.

- [ ] **Step 4: Chuyển các lịch và route sang `forEachConnectedStore`**

Tracking, normalize, auto-fulfill, ParcelPanel, payout trong `daily-sync`. Kết quả lưu `AppSetting` giữ trường cũ là tổng cộng và thêm `stores`. Thay `SHOPIFY_PAYOUT_START_DATE` bằng `payoutStartFor(store)` ở `api/projects/analytics`, `api/shopify/db-payouts`, `api/shopify/payouts`, `cashflow-snapshot-scheduler`, `shopify-payouts-sync`; `api/overview` lọc payout theo từng store. `app/shopify/page.tsx` lấy ngày từ `payout_start_date` API trả về.

- [ ] **Step 5: Chạy `npx tsc --noEmit && npx vitest run`, toàn bộ PASS**

- [ ] **Step 6: Commit** `feat(store): schedules and order sync run per store with isolated failures`

### Task 6: Đối chiếu Litzzy không đổi

**Files:** Create: `scripts/multistore-baseline.mjs`

- [ ] **Step 1: Viết script chỉ đọc**

`node scripts/multistore-baseline.mjs <db> [--compare <file.json>]` xuất theo store: số đơn, tổng `grossAmount`, số payout, tổng `amount` payout, số `DesignTask` theo status, số `Shipment`. Với `--compare`, in khác biệt và exit 1 nếu số Litzzy lệch, trừ khi lệch chỉ do đơn mới hơn mốc baseline.

- [ ] **Step 2: Chạy trên bản sao prod**

Run: `node scripts/multistore-baseline.mjs <bản sao> > baseline.json`, rồi `--compare baseline.json`.
Expected: exit 0.

- [ ] **Step 3: Commit** `chore(store): read-only baseline to prove Litzzy numbers do not move`

**Mốc deploy B:** owner đồng ý rồi deploy Task 5–6. Để qua một đêm, xem `lastError` và các `last_*_result` sáng hôm sau.

---

## Phần C: quyền và bộ chọn (giai đoạn 3)

### Task 7: Hàm lọc quyền và danh sách cho phép của seller

**Files:**
- Create: `src/lib/store-scope.ts`, `src/app/api/stores/route.ts`
- Modify: `src/lib/api-access.ts`, `src/lib/api-access.test.ts`
- Test: `tests/store-scope.integration.test.ts`

**Interfaces:**
- Consumes: `AuthUser`, `requireApiAccess` (`api-auth.ts`), bảng `UserStoreAccess`.
- Produces:
```ts
export type StoreScope = { all: true } | { all: false; storeIds: string[] }
export async function storeScopeFor(user: AuthUser, feature?: FeaturePermission): Promise<StoreScope>
export async function requireStoreFilter(req: NextRequest, feature?: FeaturePermission): Promise<{ user: AuthUser; storeIds: string[] | null } | { error: NextResponse }>
export async function requireOrderInScope(req: NextRequest, orderId: string): Promise<{ user: AuthUser } | { error: NextResponse }>
export async function requireStoreInScope(req: NextRequest, storeId: string): Promise<{ user: AuthUser } | { error: NextResponse }>
export function storeWhere(storeIds: string[] | null): { storeId?: { in: string[] } }
export async function projectIdsOf(storeIds: string[]): Promise<string[]>
export const SELLER_API_PREFIXES: string[]   // trong api-access.ts
```
`storeIds = null` nghĩa là không lọc. `GET /api/stores` (access `ANY`) trả các store user được xem: `{ id, shop, name, orderPrefix }`, không có secret.

Quy tắc của `storeScopeFor`: Super Admin, Admin → all. Seller → danh sách. Support → all, kể cả `cs` cho tới giai đoạn 6.

- [ ] **Step 1: Viết test**

- `seller scope is exactly the assigned stores`, `admin and superadmin see all`, `support sees all`.
- `seller with no store gets an empty list`: `storeWhere([])` trả `{ storeId: { in: [] } }`, và `prisma.order.findMany` với nó trả rỗng.
- `?storeId of an unassigned store is 403`, `?storeId of an assigned store narrows to it`, `?storeId=all for admin gives null`.
- `requireOrderInScope rejects another store's order with 403 and a missing order with 404`.
- `GET /api/stores never returns credential fields`.
- Trong `api-access.test.ts`: `seller is denied a store-data route that is not in SELLER_API_PREFIXES even with the feature`; `seller allowed on a listed route with the feature`; `admin unaffected`.

- [ ] **Step 2: Chạy test, phải FAIL**

- [ ] **Step 3: Viết code**

Trong `canCallApi`: `role === 'SELLER'` và đường dẫn không khớp `SELLER_API_PREFIXES` thì `forbidden`. Middleware và `requireApiAccess` tự được hưởng vì cùng gọi `canCallApi`. Danh sách ban đầu chỉ gồm route không chứa dữ liệu store: `/api/auth/`, `/api/spy`, `/api/tools/spy-idea`, `/api/tools/creative`, `/api/fulfillment/crawler`, `/api/stores`. Các task sau mới thêm route đã lọc. Vì vậy phải deploy Task 7–10 cùng lúc để seller không bị chặn nhầm.

- [ ] **Step 4: Chạy test, phải PASS**

- [ ] **Step 5: Commit** `feat(store): store scope helpers and deny-by-default API list for sellers`

### Task 8: Lọc store ở nhóm số liệu

**Files:** (Modify) `api/overview`, `api/projects`, `api/projects/analytics`, `api/projects/profit-chart`, `api/projects/snapshot`, `api/projects/[id]/*`, `api/shopify/db-payouts`, `api/shopify/payouts`, `api/shopify/payouts/[id]`, `api/meta/db-billing`, `api/meta/accounts` (GET), `api/meta/reserve`, `api/meta/exchange-rates` (GET), `api/finance/other-bills`, `api/finance/other-bills/[id]`, `api/marketing/*`, `api/sync/daily` (GET), `api/staff` (GET).
- Test: `tests/store-scope-finance.integration.test.ts`

**Interfaces:**
- Consumes: `requireStoreFilter`, `storeWhere`, `projectIdsOf`, `requireStoreInScope` (Task 7).

- [ ] **Step 1: Viết test**

Fixture: store Litzzy + Reminiso, mỗi store một Project, payout, Meta billing, other bill. Gọi trực tiếp handler với cookie từ `signToken`:
- `seller on Litzzy sees only Litzzy totals on /api/overview`, số khớp từng đồng, `netCashflow` không gồm Reminiso.
- `admin overview with no filter sums both and returns stores: [names]`, `admin with ?storeId= returns that store only`.
- `seller gets 403 on /api/projects/<reminiso>/pl and on a Reminiso other bill`.
- `GET /api/projects lists only the seller's projects`.

- [ ] **Step 2: Chạy test, phải FAIL**

- [ ] **Step 3: Sửa từng route, thêm vào `SELLER_API_PREFIXES`**

Bỏ `shopifyStore.findFirst` ở `api/overview` và `api/shopify/db-payouts`; số liệu tính theo từng store với múi giờ của store đó. Response gộp có thêm `stores: string[]`.

- [ ] **Step 4: Chạy test, phải PASS. Chạy `npx tsc --noEmit`**

- [ ] **Step 5: Commit** `feat(store): overview, P&L, payouts and bills respect store scope`

### Task 9: Lọc store ở nhóm đơn và design

**Files:** (Modify) `src/lib/repos/orders.ts` (`OrderFilter` thêm `storeIds?: string[] | null`; `countByStatus`, `countWarnings`, `countPartiallyExported` nhận cùng tham số), `api/fulfillment/orders` và route con, `api/fulfillment/pl-summary`, `api/fulfillment/status-counts`, `api/fulfillment/task-fix/*`, `api/fulfillment/normalize`, `api/shopify/orders`, `api/shopify/orders/sync`, `api/fulfillment/design-*`, `api/design-studio/tasks` và route con, `api/design-studio/lines/*`, `api/design-studio/orders/*`, `api/design-studio/file/*`, `api/design-studio/artwork/*`, `api/trello/*`.
- Test: `tests/store-scope-orders.integration.test.ts`

**Interfaces:**
- Consumes: `requireStoreFilter`, `requireOrderInScope` (Task 7).

- [ ] **Step 1: Viết test**

- `seller order list has no Reminiso orders, status counts match`.
- `seller gets 403 on status change, recheck, line cost and bulk status when any id is another store's`: bulk có một id ngoài phạm vi thì từ chối toàn bộ, không đổi đơn nào.
- `seller gets 403 opening a Reminiso design task key and its file`.
- `seller sync only runs the assigned stores`.
- `support and admin see both stores' tasks in the same list, each row has storeName`.

- [ ] **Step 2: Chạy test, phải FAIL**

- [ ] **Step 3: Sửa route, thêm vào `SELLER_API_PREFIXES`, thêm `storeName` vào payload danh sách đơn và task**

Route tải file nằm ngoài middleware phải tự gọi `requireOrderInScope`.

- [ ] **Step 4: Chạy test, phải PASS**

- [ ] **Step 5: Đăng nhập thử bằng seller trên bản local**

Mở từng trang seller có quyền theo danh sách trên prod: projects, overview, meta billing, other bills, orders, spy, crawler, need to fix, niche, creative. Xem `read_network_requests`, không có 403 ngoài ý muốn. Route nào cần thì lọc store rồi thêm vào danh sách, không thêm khi chưa lọc.

- [ ] **Step 6: Commit** `feat(store): orders and design tasks respect store scope`

### Task 10: Bộ chọn store, nhãn store, gán store cho user

**Files:**
- Create: `src/components/StoreFilter.tsx`, `src/lib/use-store-filter.ts`
- Modify: `src/app/page.tsx`, `src/app/shopify/page.tsx`, `src/app/orders/page.tsx`, `src/app/fulfillment/orders/page.tsx`, `src/app/design-studio/page.tsx`, `src/app/setup/users/page.tsx`, `src/app/api/users/route.ts`, `src/app/api/users/[id]/route.ts`
- Test: `tests/users-store-access.integration.test.ts`

**Interfaces:**
- Consumes: `GET /api/stores` (Task 7).
- Produces: `useStoreFilter(): { stores, storeId: string | null, setStoreId, query: string }`, lưu lựa chọn trong `localStorage` có `try/catch`. `GET/POST/PATCH /api/users` có thêm `storeIds: string[]`.

- [ ] **Step 1: Viết test**

`PATCH /api/users/<id> with storeIds replaces the seller's access`; `a storeId that does not exist is 400`; `GET returns storeIds`.

- [ ] **Step 2: Chạy test, phải FAIL**

- [ ] **Step 3: Viết code**

`StoreFilter` ẩn khi user chỉ có một store. Mặc định "Tất cả store". Khi đang gộp, Overview ghi rõ "Tổng của: Litzzy, Reminiso". Danh sách đơn và Design Studio có nhãn store khi có từ 2 store trở lên. Trang Users có ô chọn store, chỉ hiện cho role Seller.

- [ ] **Step 4: Chạy test, PASS. Kiểm tra trên trình duyệt local**

Theo quy trình `preview_start`: đổi bộ chọn, số Overview đổi theo, không lỗi console. Chụp ảnh gửi owner.

- [ ] **Step 5: Commit** `feat(store): store filter, store labels and per-user store access UI`

**Mốc deploy C:** owner đồng ý rồi deploy Task 7–10 cùng lúc. Chạy `multistore-baseline --compare`. Đăng nhập thử tài khoản seller thật cùng owner.

---

## Phần D: thêm store, cấu hình riêng và Reminiso (giai đoạn 4 và 5)

### Task 11: Form "Thêm store"

**Files:**
- Create: `src/app/api/stores/connect/route.ts`, `src/components/StoreConnectionsCard.tsx`
- Modify: `src/app/setup/page.tsx`, `src/lib/api-access.ts`
- Test: `tests/stores-connect.integration.test.ts`

**Interfaces:**
- Consumes: `mintClientCredentialsToken`, `saveStoreCredential` (Task 2), luồng OAuth (Task 3).
- Produces: `POST /api/stores/connect` (`SUPERADMIN`, gọi `requireSuperadmin`), body `{ shop, clientId?, clientSecret?, accessToken?, projectId?, projectName?, startDate?, payoutStartDate?, trackingPageUrl? }`. Kết quả `{ status: 'CONNECTED', storeId, shopName, timezone, orderPrefix, scopes, readAllOrders } | { status: 'NEEDS_OAUTH', storeId, oauthUrl } | { error }`.

- [ ] **Step 1: Viết test** (mock `fetch`)

- `client credentials success saves the token, timezone, prefix and links the project`.
- `shop_not_permitted falls back to NEEDS_OAUTH with the store's OAuth url`.
- `accessToken mode verifies by calling shop before saving`, token sai thì 400 và không lưu gì.
- `refuses an order prefix already used by another store`: đơn mới nhất `#LIT9` khi Litzzy đã có `LIT` → 409, không tạo store.
- `refuses a store with no prefix (#1001)` → 409 kèm hướng dẫn đặt prefix trong Shopify.
- `store with no orders yet stays connected with prefix null, and is refused by order sync until a prefix is set`.
- `adding a store does not change another store's credential`.
- `invalid shop domain 400`, `non-superadmin 403`.

- [ ] **Step 2: Chạy test, phải FAIL**

- [ ] **Step 3: Viết route và thẻ giao diện**

`orderPrefix` đọc từ tên đơn mới nhất: phần chữ trước số. Thẻ liệt kê store: tên, shop, kiểu kết nối, lần sync cuối, lỗi cuối, nút bật/tắt và kết nối lại. Hiện `read_all_orders: chưa có` kèm dòng "đơn cũ hơn 60 ngày không đọc được".

- [ ] **Step 4: Chạy test, PASS. Kiểm tra trên trình duyệt local**

- [ ] **Step 5: Commit** `feat(store): add-store form with client credentials, OAuth and token paste`

### Task 12: (Huỷ) File in không dùng chéo giữa các store

Không làm. Owner quyết định ngày 05/11/2026: trùng SKU thì trùng file in, thư viện file in dùng chung giữa các store (spec mục 6, quyết định 11). `SkuSupplierDesign`, `SkuDesign` và các hàm trong `src/lib/repos/design-library.ts` giữ nguyên.

### Task 13: Sheet Jomall chung và tracking đọc về

**Files:**
- Modify: `src/lib/sheet-channel.ts`, `src/lib/repos/sheet-push.ts`, `src/components/GoogleSheetsSetupCard.tsx`, `src/app/api/setup/google-sheets/route.ts`, `src/lib/fulfillment/auto-fulfill.ts`, `src/lib/fulfillment/auto-fulfill-sheets.ts`, `src/lib/fulfillment/auto-fulfill-scheduler.ts`, `src/lib/fulfillment/build-fulfill-plan.ts`, `src/app/api/fulfillment/auto-fulfill/run/route.ts`, `src/app/fulfillment/auto-fulfill/page.tsx`
- Test: mở rộng `tests/sheet-push.integration.test.ts`, `src/lib/sheet-channel.test.ts`, `src/lib/fulfillment/auto-fulfill-sheets.test.ts`, `src/lib/fulfillment/build-fulfill-plan.test.ts`; thêm `tests/auto-fulfill-stores.integration.test.ts`

**Interfaces:**
- Consumes: `listConnectedStores`, `forEachConnectedStore` (Task 2, 5).
- Produces:
```ts
export function storeForOrderName(name: string, stores: ConnectedStore[]): ConnectedStore | null
export function trackingUrlFor(store: { trackingPageUrl: string | null }, tracking: string): string | undefined
export async function runAutoFulfillAllStores(opts: { sheets: SheetConfig[]; minAgeDays: number; apply: boolean; now?: Date; onProgress?: ...; onStage?: ... }): Promise<AutoFulfillSummary>
```
Bỏ `SheetChannel.storeShop` và `SheetConfig.storeBase`, `DEFAULT_STORE_BASE`. `parseSheetChannels` và `getSheets` phải chịu được dữ liệu cũ còn các trường này.

- [ ] **Step 1: Viết test**

- `a Reminiso order enters the shared Jomall channel`; `an order of a disabled store is BLOCKED`.
- `one sheet with LIT and REMI rows fulfills each order with its own store's token`: mock `createFulfillment`, kiểm tra `(shop, token)` theo từng đơn.
- `tracking url comes from the order's store; a store with no trackingPageUrl sends no url`: Reminiso hiện trả 404 ở `/apps/trackingorder`, nên không gửi link hỏng cho khách.
- `a row whose prefix matches no store is reported as an error and fulfills nothing`.
- `a row of a disabled store is reported and fulfills nothing`.
- `one store's token failing does not stop the other store's rows`.

- [ ] **Step 2: Chạy test, phải FAIL**

- [ ] **Step 3: Sửa code**

Đọc mọi sheet một lần, tách dòng theo `storeForOrderName`, chạy phần còn lại của `runAutoFulfill` theo từng store. `pushedShipmentRows` đã nhận `storeId` nên giữ nguyên. Trang Auto Fulfilled bỏ ô `storeBase`.

- [ ] **Step 4: Chạy test, PASS**

- [ ] **Step 5: Commit** `feat(store): shared Jomall sheet and per-store tracking read-back`

### Task 14: Dòng không có SKU và dữ liệu tuỳ chỉnh của Reminiso

**Files:**
- Modify (tuỳ kết quả test): `src/lib/shopify-order-sync.ts`, `src/lib/repos/mapping.ts`, `src/lib/design-tasks.ts`
- Test: `tests/reminiso-lines.integration.test.ts`, fixture `tests/fixtures/reminiso-order.json` dựng từ dữ liệu thật, đã bỏ tên, email, địa chỉ khách

**Interfaces:**
- Consumes: `syncStoreOrders` (Task 5).

- [ ] **Step 1: Viết test**

- `a line with no SKU and a VariantManualMapping resolves its supplier`.
- `a line with no SKU and no mapping is PENDING_MAPPING, has a design task, and does not throw`.
- `lines with Custom Name, Enter Name, _design and _tb_design keep their attributes and get a task`.
- `a line with only _tb_design is routed to manual design, not auto-render`.

- [ ] **Step 2: Chạy test. Sửa đúng chỗ FAIL, không làm thêm**

- [ ] **Step 3: Kiểm tra lại, chạy toàn bộ `npx vitest run`**

- [ ] **Step 4: Commit** `feat(store): Reminiso line shapes map and reach design`

### Task 15: PGprints, Merchize, ParcelPanel theo store (giai đoạn 5, làm trước khi nối Reminiso)

Làm trước Task 16 dù spec xếp sau giai đoạn 4: nếu nối Reminiso trước, đơn Reminiso sẽ đẩy PGprints bằng khoá Litzzy và tốn tiền nhầm tài khoản.

**Files:**
- Create: `src/lib/store-settings.ts`, `src/app/api/stores/[id]/settings/route.ts`
- Modify: `src/lib/pgprints-settings.ts`, `src/lib/repos/pgprints-push.ts`, `src/app/api/public/pgprints/tracking/route.ts`, `src/app/api/fulfillment/pgprints/settings/route.ts`, `src/lib/merchize.ts`, `src/lib/repos/merchize-push.ts`, `src/lib/supplier-handoff.ts`, `src/lib/tracking/parcelpanel-config.ts`, `src/lib/tracking/parcelpanel-scheduler.ts`, `src/lib/repos/supplier-tracking-sync.ts`, `src/components/StoreConnectionsCard.tsx`, `tools/library/phase1.py`, `src/lib/api-access.ts`
- Test: `tests/store-settings.integration.test.ts`

**Interfaces:**
- Produces:
```ts
export async function getStoreSetting(storeId: string, key: StoreSettingKey): Promise<string | null>
export async function setStoreSetting(storeId: string, key: StoreSettingKey, value: string | null): Promise<void>
export async function getPgprintsSettings(storeId?: string): Promise<PgprintsSettings>
export async function merchizeCredentials(storeId?: string): Promise<MerchizeCredentials | null>
export async function getParcelPanelApiKey(storeId?: string): Promise<string | null>
```
Khoá lưu trong `AppSetting`: `store.<storeId>.<key>`. Quy tắc dự phòng:
- **PGprints:** Litzzy dùng khoá chung hiện tại. Store khác không có khoá riêng thì **không gửi được**, vì gửi nhầm tài khoản là mất tiền thật.
- **Merchize:** khoá riêng, không có thì dùng khoá server (spec 6.g).
- **ParcelPanel:** Litzzy dùng khoá chung. Store khác không có khoá thì bỏ qua và ghi log.

- [ ] **Step 1: Viết test**

- `a Reminiso order pushes with Reminiso's PGprints key, a Litzzy order with the global key`.
- `a store with no PGprints key is refused with a clear message and sends nothing`.
- `Merchize falls back to the server token only when the store has none`.
- `PGprints tracking webhook matches an order whichever store's key it was signed with, and rejects an unknown key`.
- `GET /api/stores/[id]/settings returns masked values; PUT needs superadmin`.

- [ ] **Step 2: Chạy test, phải FAIL**

- [ ] **Step 3: Viết code.** `tools/library/phase1.py`: `LINE_PREFIX_RE` nhận mọi tiền tố chữ, `^[A-Z]+\d+…`.

- [ ] **Step 4: Chạy test và toàn bộ, PASS**

- [ ] **Step 5: Commit** `feat(store): PGprints, Merchize and ParcelPanel settings per store`

### Task 16: Đưa Reminiso vào prod

Đây là việc vận hành, không có code. Mỗi bước ghi prod cần owner đồng ý trong phiên. **Hạn: trước 05/12/2026.**

- [ ] **Step 1: Diễn tập trên bản sao prod local:** thêm Reminiso qua form với `payoutStartDate = 2026-10-06`, Project "Reminiso" `startDate = 2026-10-06`. Sync đơn, payout. Kết quả mong đợi: khoảng 135 đơn trở lên khớp `ordersCount` của Shopify; `multistore-baseline --compare` báo Litzzy không đổi; RAM không vượt 1400 MB. Lấy Client ID, Secret từ `D:\POD GMC STORE 3\env`, không in ra màn hình.

- [ ] **Step 2: Deploy Task 11–15.** Sao lưu DB, `pm2 stop podmanager`, migrate, build, start.

- [ ] **Step 3: Owner tự nhập** Client ID, Secret vào form trên prod, và khoá PGprints của Reminiso nếu đã có. Tool không gửi các giá trị này qua chat.

- [ ] **Step 4: Bấm sync đơn và payout cho riêng Reminiso.** Đối chiếu `ordersCount`, tổng payout từ 06/10 với Shopify. Chạy `multistore-baseline --compare`.

- [ ] **Step 5: Owner làm:** giao store cho seller; gắn tài khoản Meta vào Project Reminiso; người fulfill đối chiếu đơn đã gửi trước đợt gửi đầu; chọn trang tracking cho Reminiso (điền `trackingPageUrl`), hiện chưa có nên email fulfill không kèm link.

- [ ] **Step 6: Theo dõi 48 giờ:** token tự làm mới, `lastError` trống. Nghiệm thu theo mục 10 của spec.

- [ ] **Step 7: Rà script chạy trên PC** ở nhánh `claude/peaceful-villani-d3d860`, không có trên `origin/main`: `scripts/process-new-orders.mjs`, `scripts/lib/print-index.mjs`, `pull-prod-orders`, `push-*`. Chỉ sửa chỗ ngầm hiểu một store (tiền tố `LIT`, một token). Print index vẫn tái sử dụng file in theo SKU giữa các store, theo quyết định của owner. Sửa nhỏ trên nhánh đó, báo phiên đang giữ nhánh trước khi commit.
