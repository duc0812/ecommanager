# Clone từ link (giai đoạn 1): kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seller dán link sản phẩm custom của đối thủ trong Ecom Manager, máy owner tự clone và QA, seller nhận link sản phẩm public kèm mã SKU do tool cấp.

**Architecture:** VPS giữ hàng chờ trong bảng `CloneJob` và cấp mã SKU. Một runner Python trên máy owner giữ một request mở tới `/api/clone-worker/claim` (tối đa 25 giây mỗi lần), nhận job, mở một phiên `claude` không giao diện làm theo skill clone sẵn có, rồi gửi kết quả. VPS tự hỏi Shopify trước khi đưa link cho seller.

**Tech Stack:** Next.js 14 app router, Prisma 7 + SQLite, Vitest; Python 3.12 chỉ dùng thư viện chuẩn + pytest; Claude Code CLI 2.1.260.

**Spec:** `docs/superpowers/specs/2026-11-06-clone-queue-design.md`

**Phạm vi:** Toàn bộ hàng chờ trên VPS, runner, và cặp đầu tiên của mục 8 trong spec (Customily → Litzzy). Ba bước bật còn lại (Customall → Litzzy, Teeinblue → Reminiso, ba tool Reminiso) có kế hoạch nối tiếp sau khi cặp đầu chạy thật, vì chúng phụ thuộc điều rút ra từ lần chạy thử và câu trả lời của owner cho điểm A, B trong spec.

## Global Constraints

- Nhánh `feat/clone-queue`, cắt từ `origin/main` 88eb600. Không đụng `feat/multi-store`.
- Mỗi lần đổi schema: dựng migration, `npx prisma generate`, tăng `SCHEMA_VERSION` trong `src/lib/db.ts` từ `'v85'` lên `'v86'`. Trên máy này `prisma migrate dev` có thể không tạo gì mà vẫn exit 0: kiểm `ls prisma/migrations`, nếu thiếu thì dựng thư mục `20261107090000_clone_queue` từ `npx prisma migrate diff`. Không thêm `url` vào `datasource db`.
- Import Prisma từ `@/generated/prisma/client`, dùng `prisma` trong `@/lib/db`.
- Route mới có rule trong `API_ACCESS_RULES`; route seller gọi được nằm trong `SELLER_API_PREFIXES`; route tạo hoặc thu hồi token gọi thêm `requireSuperadmin`.
- Token `cqw_…` chỉ lưu sha256. Không token nào xuất hiện trong response (trừ lần tạo), payload job, log, hay test snapshot.
- Test chạy trên `test.db`, tự tạo fixture, không gọi Shopify thật, không gọi `claude` thật, không mở link đối thủ. Mọi lệnh gọi ngoài đi qua tham số `deps` để test thay bằng đồ giả.
- Giá trị của job không bao giờ được ghép vào chuỗi lệnh shell. Lệnh con chạy bằng danh sách tham số.
- UI theo mẫu trong `CLAUDE.md`: `'use client'`, `<Sidebar />`, class Tailwind theo token, icon `material-symbols-outlined`, ngày `MM/DD/YYYY` (en-US), chữ giao diện tiếng Việt.
- Không comment trừ khi giải thích ràng buộc không hiển nhiên.
- File ngoài repo (thư mục skill ở `C:\Users\TM PC\.claude\skills\`): chép bản gốc vào `.superpowers/sdd/<workspace>/tool-backups/` trước khi sửa; hành vi khi không truyền mã SKU phải y như cũ.
- Không chạy clone thật, không ghi lên store nào, không deploy, không đổi nginx/PM2/Task Scheduler khi chưa có lời của owner.
- Mỗi commit kết thúc bằng dòng `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **Cùng một link dán theo dạng khác** (thêm `?variant=…`, `#…`, dấu `/` cuối, host viết hoa): phải ra cùng `sourceKey` và không tạo job thứ hai. Test ở Task 3.
2. **Máy owner tắt giữa job, hoặc heartbeat đến sau khi job đã bị thu lại:** job quay lại hàng chờ một lần, lần hai `FAILED/WORKER_LOST`; heartbeat và kết quả của lần chạy cũ bị từ chối. Test ở Task 4.
3. **Runner báo PASS sai:** sản phẩm còn DRAFT, chưa lên Online Store, còn SKU của đối thủ, hoặc `productGid` không có trên store đích. Job phải `FAILED/VERIFY`, không bao giờ `DONE`. Test ở Task 4.
4. **Shopify không trả lời** lúc cấp mã hoặc lúc kiểm kết quả: cấp mã bỏ qua store đó; kiểm kết quả giữ job `RUNNING` và trả 502 để runner gửi lại. Test ở Task 2 và 4.
5. **Job mang giá trị lạ xuống runner** (`sourceUrl` có dấu nháy hay khoảng trắng, `orderPrefix` không biết, `skuCode` sai dạng): runner báo lỗi và không chạy lệnh nào. Test ở Task 7.

---

## Phần A: hàng chờ trên VPS

### Task 1: Schema, quyền và đường dẫn

**Files:**
- Modify: `prisma/schema.prisma`, `src/lib/db.ts`, `src/lib/roles.ts`, `src/lib/api-access.ts`, `src/components/Sidebar.tsx`
- Create: `prisma/migrations/20261107090000_clone_queue/migration.sql`
- Test: `src/lib/api-access.test.ts`, `src/lib/roles.test.ts` (tạo nếu chưa có)

**Interfaces:**
- Produces: model `CloneJob` (bảng đúng như spec 7.2: `id String @id @default(cuid())`, `storeId`, `sourceUrl`, `sourceKey`, `status String @default("QUEUED")`, `failKind String?`, `stage String?`, `platform String?`, `skuCode String @unique`, `requestedById`, `requestedByName`, `attempts Int @default(0)`, `lockedAt DateTime?`, `startedAt DateTime?`, `finishedAt DateTime?`, `productGid String?`, `handle String?`, `productUrl String?`, `productType String?`, `reused Boolean @default(false)`, `qaVerdict String?`, `qaNote String?`, `error String?`, `costUsd Float?`, `durationMs Int?`, `createdAt`, `updatedAt`; `@@index([status, createdAt])`, `@@index([storeId, sourceKey])`, `@@index([requestedById, createdAt])`; không khai quan hệ khoá ngoại, giống `ScaleJob`).
- Produces: `AppUser.skuPrefix String? @unique`.
- Produces: `FeaturePermission` có thêm `'fulfillment_clone'`, nhãn `'Clone từ link'`, đường dẫn `['/fulfillment/clone']`, nằm trong nhóm Fulfillment của `FEATURE_GROUPS`, có trong `HOME_PRIORITY` ngay sau `fulfillment_crawler`, có trong mặc định của ADMIN, không có trong mặc định của SELLER.

- [ ] **Step 1: Viết test cho rule (thất bại trước)**

```ts
// src/lib/api-access.test.ts
it('clone queue: người có quyền gọi được job, cài đặt chỉ SUPERADMIN, worker là PUBLIC', () => {
  expect(canCallApi('SELLER', ['fulfillment_clone'], '/api/fulfillment/clone/jobs', 'POST')).toBe('ok')
  expect(canCallApi('SELLER', ['fulfillment_crawler'], '/api/fulfillment/clone/jobs', 'GET')).toBe('forbidden')
  expect(canCallApi('SELLER', ['fulfillment_clone'], '/api/fulfillment/clone/settings', 'GET')).toBe('forbidden')
  expect(canCallApi('ADMIN', ['fulfillment_clone'], '/api/fulfillment/clone/settings', 'POST')).toBe('forbidden')
  expect(canCallApi(null, [], '/api/clone-worker/claim', 'POST')).toBe('ok')
  expect(canCallApi(null, [], '/api/fulfillment/clone/jobs', 'GET')).toBe('unauthenticated')
})
```

```ts
// roles
expect(canAccess('SELLER', '/fulfillment/clone', ['fulfillment_clone'])).toBe(true)
expect(canAccess('SELLER', '/fulfillment/clone', ['fulfillment_crawler'])).toBe(false)
```

- [ ] **Step 2:** Chạy `npx vitest run src/lib/api-access.test.ts` — phải FAIL.
- [ ] **Step 3:** Thêm model, trường, migration; `npx prisma generate`; `SCHEMA_VERSION = 'v86'`.
- [ ] **Step 4:** Thêm quyền vào `roles.ts`. Thêm rule vào `API_ACCESS_RULES`, theo thứ tự này và đặt TRƯỚC mọi rule `/api/fulfillment…` rộng hơn: `{ prefix: '/api/clone-worker/', access: 'PUBLIC' }`, `{ prefix: '/api/fulfillment/clone/settings', access: 'SUPERADMIN' }`, `{ prefix: '/api/fulfillment/clone', access: ['fulfillment_clone'] }`. Thêm `'/api/fulfillment/clone/jobs'` vào `SELLER_API_PREFIXES` (không thêm `/settings`).
- [ ] **Step 5:** Thêm mục Sidebar ngay dưới Product Crawler: `{ type: 'child', href: '/fulfillment/clone', icon: 'content_copy', label: 'Clone từ link' }`.
- [ ] **Step 6:** Chạy lại test — PASS. `npx tsc --noEmit` không có lỗi mới ngoài hai lỗi đã biết trong `tests/design-task-artwork-upload.integration.test.ts` và `tests/scale-jobs.integration.test.ts`.
- [ ] **Step 7:** Commit `feat(clone): schema, permission and access rules for the clone queue`.

### Task 2: Mã SKU

**Files:**
- Create: `src/lib/clone/sku-code.ts`
- Modify: `src/app/api/users/route.ts`, `src/app/setup/users/page.tsx`
- Test: `tests/clone-sku-code.integration.test.ts`, `tests/users-sku-prefix.integration.test.ts`

**Interfaces:**
- Produces:
  - `parseSkuPrefix(v: unknown): string | null` — đúng hai chữ A–Z sau khi trim và viết hoa, ngược lại `null`.
  - `SKU_CODE_RE = /^[A-Z]{2}\d{10}$/`.
  - `skuCodeFor(prefix: string, now: Date, n: number): string` — `prefix + YYMMDD (Asia/Ho_Chi_Minh) + n đệm đủ 4 chữ số`.
  - `type SkuCodeDeps = { random: () => number; shopifySkuExists: (storeId: string, code: string) => Promise<boolean>; storeIds: () => Promise<string[]>; log?: (m: string) => void }`
  - `isCodeTaken(code: string, deps: SkuCodeDeps): Promise<boolean>` — đúng thứ tự kiểm ở spec 7.5.
  - `issueSkuCode(prefix: string, now: Date, deps?: Partial<SkuCodeDeps>): Promise<string>` — tối đa 20 lần, hết thì ném `Error('Không cấp được mã SKU, thử lại sau.')`.
  - `skuBelongsTo(code: string, sku: string | null): boolean` — `sku === code || sku.startsWith(code + '-')`.
  - Mặc định của `shopifySkuExists` hỏi `productVariants(first: 1, query: "sku:<code>*")` qua `getStoreConnection(storeId)`; lỗi bất kỳ thì trả `false` và gọi `log`.
- Produces: API users nhận và trả `skuPrefix`.

- [ ] **Step 1: Test (thất bại trước)**

```ts
it('skuCodeFor dùng ngày theo giờ Việt Nam', () => {
  expect(skuCodeFor('DC', new Date('2026-11-05T18:30:00Z'), 7392)).toBe('DC2611067392')
  expect(skuCodeFor('DC', new Date('2026-11-05T03:00:00Z'), 5)).toBe('DC2611050005')
})
it('issueSkuCode bỏ qua mã đã có trong CloneJob, OrderLine, SkuSupplierDesign, SkuDesign, tiêu đề ArtworkEntry và ProductProfile, và trên Shopify', async () => {
  // fixture: mỗi nơi chứa một mã DC261105000<k>; random trả lần lượt 1..7 rồi 8
  // expect: 'DC2611050008'
})
it('store không hỏi được Shopify thì bỏ qua store đó', async () => {
  // shopifySkuExists ném lỗi → vẫn cấp mã, log được gọi một lần
})
it('hết 20 lần thì báo lỗi', async () => { /* random luôn trả số đã dùng → rejects */ })
it('skuBelongsTo', () => {
  expect(skuBelongsTo('DC2611057392', 'DC2611057392')).toBe(true)
  expect(skuBelongsTo('DC2611057392', 'DC2611057392-BLACK-XL')).toBe(true)
  expect(skuBelongsTo('DC2611057392', 'DC26110573920-BLACK')).toBe(false)
  expect(skuBelongsTo('DC2611057392', null)).toBe(false)
})
it('parseSkuPrefix', () => {
  expect(parseSkuPrefix(' dc ')).toBe('DC'); expect(parseSkuPrefix('D1')).toBeNull(); expect(parseSkuPrefix('DCA')).toBeNull()
})
```

```ts
// users API
it('POST /api/users lưu skuPrefix viết hoa, từ chối mã sai dạng (400) và mã đã thuộc người khác (409)', …)
it('GET /api/users trả skuPrefix', …)
```

- [ ] **Step 2:** Chạy test — FAIL.
- [ ] **Step 3:** Viết `sku-code.ts`. Kiểm trùng trong DB bằng `startsWith`/`contains` trên các cột nêu ở spec 7.5.
- [ ] **Step 4:** `POST /api/users`: đọc `body.skuPrefix` (bỏ trống = giữ nguyên, chuỗi rỗng = xoá); thêm vào `normalizeUser`. Trang Setup › Users: ô "Mã SKU (2 chữ cái)" trong form, cột trong bảng.
- [ ] **Step 5:** Test PASS; `npx tsc --noEmit`.
- [ ] **Step 6:** Commit `feat(clone): SKU code issuing and per-user two-letter prefix`.

### Task 3: Tạo, xem, huỷ, thử lại job

**Files:**
- Create: `src/lib/clone/jobs.ts`, `src/lib/clone/settings.ts`
- Test: `tests/clone-jobs.integration.test.ts`

**Interfaces:**
- Consumes: `issueSkuCode`, `parseSkuPrefix` (Task 2); `assertSafeExternalUrl`; `storeScopeFor`; `listConnectedStores`.
- Produces:
  - `CLONE_SETTINGS_KEY = 'clone.settings'`; `type CloneSettings = { paused: boolean; targets: string[] }`; `getCloneSettings(): Promise<CloneSettings>` (mặc định `{ paused: false, targets: [] }`); `saveCloneSettings(input: unknown): Promise<CloneSettings>` — `targets` chỉ nhận dạng `^(customily|customall|teeinblue|customix):[A-Z]+$`.
  - `sourceKeyOf(url: string): string` — host viết thường + path, bỏ query, hash, dấu `/` cuối.
  - `class CloneInputError extends Error { status: number; extra?: Record<string, unknown> }`.
  - `createCloneJob(user: AuthUser, input: { url: unknown; storeId: unknown; force?: unknown }, deps?): Promise<CloneJobRow>`.
  - `listCloneJobs(user: AuthUser): Promise<CloneJobView[]>` — 200 job mới nhất.
  - `getCloneJob(user: AuthUser, id: string): Promise<CloneJobView | null>`.
  - `cancelCloneJob(user, id)`, `retryCloneJob(user, id)` — trả `CloneJobView`, ném `CloneInputError`.
  - `cloneJobView(job, viewer: AuthUser): CloneJobView` — bỏ `costUsd`, `durationMs`, `lockedAt` khi người xem không phải SUPERADMIN.
  - `notifyCloneQueue(): void` và `waitForCloneQueue(ms: number): Promise<void>` — đánh thức trong bộ nhớ, giữ trên `globalThis`.

Luật của `createCloneJob`, theo đúng thứ tự:
1. `storeId` phải thuộc phạm vi của người gọi và là store đang kết nối, đang bật → nếu không: 403 `'Bạn không có quyền xem store này.'`.
2. Người gọi phải có `skuPrefix` → nếu không: 400 `'Tài khoản chưa có mã SKU 2 chữ cái. Nhờ quản trị điền ở Setup › Users.'`.
3. `url` qua `assertSafeExternalUrl` → nếu không: 400 `'Link không hợp lệ.'`.
4. Dò job cùng `storeId` + `sourceKey` có trạng thái `QUEUED`, `RUNNING`, `DONE`. Không dò khi `force` là true và người gọi là SUPERADMIN.
   - Của chính người gọi: 409 `'Bạn đã dán link này rồi.'`, `extra = { jobId }`.
   - Của người khác, đã `DONE`: 409 `'Link này đã có sản phẩm trên store.'`, `extra = { productUrl }`.
   - Của người khác, chưa xong: 409 `'Link này đang được clone.'`, không kèm gì.
5. Cấp mã, tạo job `QUEUED`, gọi `notifyCloneQueue()`.

Luật xem: SELLER chỉ thấy job có `requestedById` là mình và `storeId` trong phạm vi; vai trò khác thấy hết.
Huỷ: chỉ `QUEUED`; người tạo hoặc SUPERADMIN → `CANCELLED`.
Thử lại: chỉ `FAILED`; người tạo hoặc SUPERADMIN; `failKind` thuộc `TOOL_GAP`, `UNSUPPORTED`, `NOT_ENABLED` thì chỉ SUPERADMIN. Đặt `QUEUED`, `attempts = 0`, xoá `error`, `failKind`, `stage`, `lockedAt`, `finishedAt`; giữ `skuCode`.

- [ ] **Step 1: Test (thất bại trước)** — mỗi dòng luật trên một test, cộng:

```ts
it('sourceKeyOf gộp các dạng của cùng một link', () => {
  const k = sourceKeyOf('https://Shop.Example.com/products/abc/?variant=1#x')
  expect(k).toBe('shop.example.com/products/abc')
  expect(sourceKeyOf('https://shop.example.com/products/abc')).toBe(k)
})
it('seller A không thấy job của seller B cùng store', …)
it('seller không tạo được job cho store không được gán (403)', …)
it('cloneJobView giấu chi phí với người không phải SUPERADMIN', …)
it('link của người khác đã DONE: 409 kèm productUrl, không kèm skuCode, tên người dán, hay jobId', …)
```

- [ ] **Step 2:** Chạy — FAIL. **Step 3:** Viết `settings.ts`, `jobs.ts`. **Step 4:** Chạy — PASS; `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(clone): create, list, cancel and retry clone jobs`.

### Task 4: Phía runner: token, nhận việc, heartbeat, kết quả

**Files:**
- Create: `src/lib/clone/worker.ts`
- Test: `tests/clone-worker.integration.test.ts`

**Interfaces:**
- Consumes: `getCloneSettings`, `waitForCloneQueue`, `skuBelongsTo`, `getStoreConnection`.
- Produces:
  - `CLONE_WORKER_TOKEN_KEY = 'clone.worker.tokenHash'`, `CLONE_WORKER_SEEN_KEY = 'clone.worker.lastSeenAt'`, `CLONE_LEASE_MS = 10 * 60 * 1000`, `CLONE_MAX_ATTEMPTS = 2`, `CLONE_MAX_WAIT_S = 25`.
  - `generateCloneWorkerToken(): Promise<string>` (`cqw_` + 32 byte base64url), `revokeCloneWorkerToken()`, `cloneWorkerInfo(): Promise<{ configured: boolean; tokenUpdatedAt: string | null; lastSeenAt: string | null; online: boolean }>` (`online` = thấy trong 90 giây gần nhất), `verifyCloneWorkerRequest(req: NextRequest): Promise<boolean>` — cùng cách với `verifyWorkerToken` trong `src/lib/artwork-worker.ts`.
  - `type CloneClaim = { id: string; sourceUrl: string; skuCode: string; attempts: number; requestedByName: string; store: { id: string; orderPrefix: string; shop: string }; targets: string[] }`.
  - `claimCloneJob(now?: Date): Promise<{ job: CloneClaim | null; paused: boolean }>` — ghi `lastSeenAt`; `paused` thì không phát việc; job cũ nhất trước; so-và-đổi bằng `updateMany`; job `RUNNING` quá lease: `attempts < 2` thì nhận lại, ngược lại `FAILED/WORKER_LOST` với `error = 'Máy xử lý không trả kết quả.'`; chỉ một job `RUNNING` còn hạn tại một thời điểm (đang có thì trả `null`).
  - `claimWithWait(waitSeconds: number): Promise<{ job; paused }>` — kẹp `waitSeconds` vào `[0, 25]`; không có job thì `waitForCloneQueue` rồi thử đúng một lần nữa.
  - `heartbeatCloneJob(id: string, attempts: number, patch: { stage?: unknown; platform?: unknown }): Promise<{ ok: boolean; cancelled: boolean }>` — chỉ nhận khi job `RUNNING` và `attempts` khớp; gia hạn `lockedAt`; `stage`, `platform` cắt 60 ký tự.
  - `failCloneJob(id, attempts, input: { failKind: unknown; error: unknown; productGid?: unknown; retryable?: unknown }): Promise<{ status: string } | null>` — `failKind` ngoài `UNSUPPORTED|NOT_ENABLED|SOURCE|TOOL|TOOL_GAP|QA|TIMEOUT` thành `TOOL`; `retryable` và `attempts < 2` thì quay lại `QUEUED`; `error` cắt 2000 ký tự.
  - `type ProductState = { status: string; onlineStoreUrl: string | null; handle: string; productType: string | null; skus: (string | null)[] } | null`
  - `completeCloneJob(id, attempts, input: { productGid: unknown; handle?: unknown; qaVerdict: unknown; qaNote?: unknown; reused?: unknown; costUsd?: unknown; durationMs?: unknown }, deps?: { productState: (storeId: string, gid: string) => Promise<ProductState> }): Promise<{ status: 'DONE' | 'FAILED'; error?: string } | { retry: true; error: string } | null>` — luật ở spec 7.9; `productGid` phải khớp `^gid://shopify/Product/\d+$`; `qaVerdict` khác `'PASS'` thì `FAILED/QA`; `productState` ném lỗi thì trả `{ retry: true }` và job giữ `RUNNING`; `reused` thì bỏ điều kiện SKU và không ghi `skuCode` lên kết quả hiển thị.

Thông báo `VERIFY` (tiếng Việt, nêu đúng điều sai): `'Sản phẩm không có trên store.'`, `'Sản phẩm chưa ACTIVE.'`, `'Sản phẩm chưa lên Online Store.'`, `'Còn variant mang SKU khác mã đã cấp.'`.

- [ ] **Step 1: Test (thất bại trước)**

```ts
it('token: chỉ lưu hash, sai token và thiếu token đều false', …)
it('claim: job cũ nhất trước, hai lần gọi liền nhau chỉ một lần nhận được', …)
it('claim: đang có job RUNNING còn hạn thì trả null', …)
it('claim: paused thì trả { job: null, paused: true } và vẫn ghi lastSeenAt', …)
it('lease hết lần 1: job được nhận lại với attempts 2; hết lần 2: FAILED/WORKER_LOST', …)
it('heartbeat của lần chạy cũ (attempts lệch) bị từ chối; job đã CANCELLED trả cancelled: true', …)
it('complete: DRAFT → FAILED/VERIFY "Sản phẩm chưa ACTIVE."', …)
it('complete: onlineStoreUrl null → FAILED/VERIFY', …)
it('complete: một variant mang SKU đối thủ → FAILED/VERIFY', …)
it('complete: productState trả null → FAILED/VERIFY "Sản phẩm không có trên store."', …)
it('complete: productState ném lỗi → { retry: true }, job vẫn RUNNING', …)
it('complete: đủ điều kiện → DONE, productUrl = onlineStoreUrl, lưu handle và productType', …)
it('complete reused: bỏ qua điều kiện SKU', …)
it('fail retryable ở lần 1 → QUEUED; ở lần 2 → FAILED', …)
it('claimWithWait trả ngay khi notifyCloneQueue được gọi trong lúc chờ', async () => { /* waitSeconds 5, tạo job sau 50 ms, expect dưới 1500 ms */ })
```

- [ ] **Step 2:** Chạy — FAIL. **Step 3:** Viết `worker.ts`; `productState` mặc định hỏi `product(id:) { status onlineStoreUrl handle productType variants(first: 250) { nodes { sku } } }` theo cách gọi trong `src/lib/shopify.ts`. **Step 4:** Chạy — PASS; `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(clone): worker token, claim with lease, heartbeat, result verified on Shopify`.

### Task 5: Route

**Files:**
- Create: `src/app/api/fulfillment/clone/jobs/route.ts`, `…/jobs/[id]/route.ts`, `…/jobs/[id]/cancel/route.ts`, `…/jobs/[id]/retry/route.ts`, `src/app/api/fulfillment/clone/settings/route.ts`, `src/app/api/clone-worker/claim/route.ts`, `src/app/api/clone-worker/jobs/[id]/heartbeat/route.ts`, `…/result/route.ts`, `…/fail/route.ts`
- Test: `tests/clone-routes.integration.test.ts`

**Interfaces:**
- Consumes: mọi hàm của Task 3 và 4; `requireApiAccess`, `requireSuperadmin`.
- Produces (dạng JSON):
  - `GET jobs` → `{ jobs: CloneJobView[], worker: { online: boolean; lastSeenAt: string | null }, stores: { id, shop, orderPrefix }[], hasSkuPrefix: boolean, paused: boolean }` — `stores` là các store trong phạm vi của người gọi.
  - `POST jobs` → 201 `{ job }`; `CloneInputError` → `{ error, ...extra }` với `status` của nó.
  - `GET settings` → `{ paused, targets, worker: cloneWorkerInfo() }`; `POST settings` với `{ paused?, targets? }` hoặc `{ action: 'mint-token' }` → `{ token }` đúng một lần, hoặc `{ action: 'revoke-token' }`.
  - Route runner: thân `{ attempts, … }`; 401 `{ error: 'Unauthorized' }` khi token sai; 404 khi hàm lib trả `null`; `result` trả 502 `{ error }` khi `retry`.
  - Mọi route có `export const dynamic = 'force-dynamic'`.

- [ ] **Step 1: Test (thất bại trước)** — gọi thẳng handler với `NextRequest`:

```ts
it('không có Bearer hoặc sai Bearer: cả bốn route runner trả 401', …)
it('mint-token trả token một lần; GET settings sau đó không chứa chuỗi "cqw_"', …)
it('ADMIN gọi mint-token bị 403', …)
it('seller POST job cho store của mình: 201; cho store khác: 403', …)
it('GET jobs của seller không chứa job, tên, mã của seller khác', …)
it('claim → heartbeat → result với productState giả: job DONE và GET jobs của người dán thấy productUrl', …)
it('result khi Shopify lỗi: 502 và job vẫn RUNNING', …)
```

- [ ] **Step 2:** Chạy — FAIL. **Step 3:** Viết route (mỏng, chỉ gọi lib). **Step 4:** PASS; `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(clone): API routes for sellers and for the runner`.

### Task 6: Trang `/fulfillment/clone`

**Files:**
- Create: `src/app/fulfillment/clone/page.tsx`, component con trong `src/app/fulfillment/clone/components/` nếu file quá 300 dòng
- Test: thêm `/fulfillment/clone` vào phép kiểm trang–API hiện có nếu `tests/seller-page-walk.integration.test.ts` liệt kê trang theo quyền

**Interfaces:**
- Consumes: các route của Task 5.

Trang theo spec 7.4:
- Thẻ trên cùng: ô link, ô chọn store (ẩn khi `stores.length === 1`), nút "Clone". Khi `hasSkuPrefix` là false: ô bị khoá và hiện câu của luật 2 ở Task 3.
- Dòng trạng thái máy xử lý: "Máy xử lý đang kết nối" hoặc "Máy xử lý đang tắt từ MM/DD/YYYY HH:mm — link sẽ chạy khi máy bật"; "Hàng chờ đang tạm dừng" khi `paused`.
- Bảng job: Thời gian, Store, Link nguồn, Trạng thái (kèm `stage`), Mã SKU, Sản phẩm (link khi `DONE`; "Đã có sẵn" khi `reused`), Lỗi, nút Huỷ / Thử lại theo đúng luật của Task 3.
- Nhãn trạng thái: `QUEUED` "Đang chờ", `RUNNING` "Đang chạy", `DONE` "Xong", `FAILED` "Lỗi", `CANCELLED` "Đã huỷ". Nhãn `failKind`: `UNSUPPORTED` "Nền tảng chưa hỗ trợ", `NOT_ENABLED` "Nền tảng chưa bật cho store này", `SOURCE` "Link không mở được", `TOOL_GAP` "Cần nâng cấp tool, đang chờ owner", `QA` "QA không đạt", `VERIFY` "Kiểm tra trên Shopify không đạt", `TIMEOUT` "Quá thời gian", `WORKER_LOST` "Máy xử lý mất kết nối", `TOOL` "Tool báo lỗi".
- 409 khi dán: hiện `error`; có `productUrl` thì hiện link đó.
- Hỏi lại `GET jobs` 5 giây một lần khi còn job `QUEUED` hoặc `RUNNING`; lỗi mạng thì giãn gấp đôi, tối đa 60 giây.
- Khối chỉ SUPERADMIN thấy: công tắc tạm dừng; ô đánh dấu cho 8 cặp `customily|customall|teeinblue|customix` × các store đang kết nối; nút tạo token (hiện một lần kèm nút chép) và thu hồi; cột chi phí, thời gian chạy và product type trong bảng.

- [ ] **Step 1:** Viết trang. **Step 2:** `npx tsc --noEmit`; `npx eslint --no-eslintrc -c .eslintrc.json src/app/fulfillment/clone` (hoặc lệnh lint mà worktree này dùng được). **Step 3:** `npx vitest run tests/seller-page-walk.integration.test.ts src/lib/api-access.test.ts` — PASS.
- [ ] **Step 4:** Commit `feat(clone): Clone từ link page`.

---

## Phần B: runner trên máy owner

### Task 7: Lõi runner

**Files:**
- Create: `tools/clone-runner/api.py`, `tools/clone-runner/runner.py`, `tools/clone-runner/detect.py`, `tools/clone-runner/tests/test_api.py`, `tests/test_runner.py`, `tests/test_detect.py`, `tools/clone-runner/tests/fixtures/*.html`

**Interfaces:**
- Produces (Python):
  - `api.Client(base_url: str, token: str, opener=None)` với `claim(wait_seconds=25) -> dict`, `heartbeat(job_id, attempts, stage=None, platform=None) -> dict`, `result(job_id, attempts, payload: dict) -> tuple[int, dict]`, `fail(job_id, attempts, fail_kind, error, retryable=False, product_gid=None) -> dict`. Chỉ `urllib`. Token không bao giờ vào thông báo lỗi hay log.
  - `runner.KNOWN_STORES = {'LIT': 'litzzy', 'REMI': 'reminiso'}`.
  - `runner.validate_job(job: dict) -> str | None` — trả lý do khi: `sourceUrl` không khớp `SOURCE_URL_RE` (bên dưới), `skuCode` không khớp `^[A-Z]{2}\d{10}$`, `orderPrefix` không thuộc `KNOWN_STORES`, `id` không khớp `^[a-z0-9]{10,40}$`.

    ```python
    SOURCE_URL_RE = re.compile(r"^https://[A-Za-z0-9.-]+(/[^\s\"'<>\\^`{|}]*)?$")
    ```
  - `detect.PLATFORMS = ('customily', 'customall', 'teeinblue', 'customix')`; `detect.detect_platform(html: str) -> str` trả một trong bốn tên đó, `'unsupported:ymq'`, `'unsupported:globo'`, hoặc `'unknown'`. Customily chỉ nhận khi thấy host script của Customily (`cdn.customily.com`, `sh.customily.com`, `app.customily.com`), không nhận chữ `customily` trần.
  - `detect.fetch_html(url, opener=None, timeout=30) -> str | None` — `None` khi lỗi hoặc mã khác 200.
  - `runner.run_job(job: dict, deps) -> None` với `deps` có `client`, `fetch_html`, `find_existing`, `run_session`, `job_root`, `clock`. Thứ tự: `validate_job` → khoá → `find_existing` → nhận diện → kiểm `targets` → `run_session` → báo kết quả.
  - `runner.main(argv)`: `--once`, `--job-root` (mặc định `D:\Ecom manager\clone-queue`); đọc `ECOM_URL`, `CLONE_WORKER_TOKEN`; vòng `claim`; lùi 2, 4, 8 … tối đa 60 giây khi lỗi mạng; khoá file `<job-root>\runner.lock` chứa pid, từ chối chạy khi pid đó còn sống.

Luật của `run_job`:
- `validate_job` có lý do → `fail('TOOL', lý do)`, không chạy gì khác.
- `find_existing(job)` trả `{productGid, handle}` → gửi `result` với `reused: true`, `qaVerdict: 'PASS'`, `qaNote: 'Đã có sẵn trong sổ đăng ký'`.
- Nhận diện ra `unsupported:<tên>` → `fail('UNSUPPORTED', 'Nền tảng này chưa hỗ trợ (<tên>).')`.
- Nhận diện ra một nền tảng mà `<platform>:<orderPrefix>` không có trong `job['targets']` → `fail('NOT_ENABLED', …)`.
- `'unknown'` hoặc không tải được trang → vẫn mở phiên; phiên tự xác định.
- `result` trả 502 → gửi lại tối đa 5 lần, cách nhau 30 giây; vẫn lỗi thì `fail('TOOL', …, retryable=True)`.
- Trong lúc phiên chạy: một luồng gửi heartbeat 60 giây một lần; heartbeat trả `ok: false` thì dừng phiên.
- `stage` gửi kèm heartbeat: `'nhận diện'` trước khi mở phiên; trong phiên là dòng đầu của `<job_dir>\stage.txt` nếu nó thuộc `clone`, `qa`, `public` (phiên tự ghi file này, xem Task 8), mặc định `'clone'`. `platform` gửi ngay khi nhận diện xong.

- [ ] **Step 1: Test (thất bại trước)**

```python
def test_validate_job_rejects_hostile_values():  # dấu nháy, khoảng trắng, http://, prefix lạ, mã sai dạng → có lý do
def test_run_job_with_invalid_job_fails_without_spawning():  # run_session không được gọi
def test_detect_customily_needs_script_host():  # fixture globo có chữ "customily" trong CSS → 'unsupported:globo'
def test_detect_each_platform():  # 4 fixture → 4 tên
def test_unsupported_platform_fails_without_session():
def test_target_not_enabled_fails_without_session():
def test_existing_register_entry_reports_reused():
def test_result_502_is_retried_then_fails_retryable():
def test_heartbeat_not_ok_stops_session():
def test_client_never_puts_token_in_errors():
def test_second_runner_refuses_when_lock_pid_alive():
```

Fixture HTML viết tay, vài dòng mỗi file, chỉ chứa dấu hiệu cần thiết; không chép trang thật.

- [ ] **Step 2:** `python -m pytest tools/clone-runner/tests -q` — FAIL. **Step 3:** Viết code. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(clone-runner): claim loop, job validation and platform detection`.

### Task 8: Phiên Claude của một job

**Files:**
- Create: `tools/clone-runner/session.py`, `tools/clone-runner/registers.py`, `tools/clone-runner/job_prompt.md`, `tools/clone-runner/tests/test_session.py`, `tests/test_registers.py`, `tools/clone-runner/tests/fake_claude.py`, `tools/clone-runner/set-token.ps1`, `tools/clone-runner/install-task.ps1`, `tools/clone-runner/README.md`

**Interfaces:**
- Consumes: `deps.run_session`, `deps.find_existing` của Task 7.
- Produces:
  - `session.SKILL_DIRS = {('customily', 'litzzy'): r'C:\Users\TM PC\.claude\skills\cloning-clipart-customizers-litzzy', …}` — đủ các cặp của spec mục 5; đường dẫn gốc đổi được bằng biến môi trường `CLONE_SKILLS_ROOT`.
  - `session.ALLOWED_TOOLS`, `session.DISALLOWED_TOOLS` — hai hằng; `DISALLOWED_TOOLS` phải có luật chặn `ssh`, `scp` và thư mục `.ssh`.
  - `session.build_argv(job_dir: str, prompt: str, env: dict) -> list[str]` — `claude` (đổi được bằng `CLONE_CLAUDE_BIN`), `-p`, lời nhắc, `--output-format json`, cờ công cụ, `--add-dir` cho thư mục skill và thư mục làm việc của tool, `--max-budget-usd` từ `CLONE_MAX_BUDGET_USD` (mặc định `8`), `--model` khi có `CLONE_CLAUDE_MODEL`. Người làm kiểm tên cờ với `claude --help` của bản 2.1.260.
  - `session.render_prompt(job: dict, platform: str) -> str` — `job_prompt.md` cộng khối JSON của job. Không dùng `str.format` trên dữ liệu của job.
  - `session.read_result(job_dir) -> dict` — đọc `result.json`; thiếu, không phải JSON, `verdict` ngoài `PASS|FAIL|UNSUPPORTED`, hoặc PASS mà `productGid` không khớp `^gid://shopify/Product/\d+$` → `{'verdict': 'FAIL', 'failKind': 'TOOL', 'error': …}`.
  - `session.run_session(job, platform, job_dir, should_stop, timeout_s=7200) -> dict` — ghi `job.json`, chạy tiến trình con bằng danh sách tham số với `cwd=job_dir`, stdout/stderr vào `session.log`, dừng khi quá giờ (`failKind: 'TIMEOUT'`) hoặc `should_stop()`; lấy `total_cost_usd` và `duration_ms` từ JSON của CLI nếu có.
  - `registers.find_existing(job, roots=None) -> dict | None` — với store `litzzy`: đọc mọi `clone.json` trong `D:\Ecom manager\clipart-clones\*\` và `D:\Ecom manager\customall-clones\*\`, so `source` với `sourceUrl` bằng cùng luật `sourceKey` của VPS, chỉ nhận mục có `status == 'ACTIVE'`; trả `{'productGid': …, 'handle': …}`. Store khác trả `None`.

`job_prompt.md` chứa đúng các điều của spec 7.7 (kể cả giới hạn phạm vi ở điểm A), cộng: slug của job là `skuCode` viết thường; biến môi trường của store đã được runner nạp sẵn; không in token; mỗi khi sang bước mới thì ghi một từ `clone`, `qa` hoặc `public` vào `stage.txt`; kết thúc bằng `result.json`.

Runner nạp biến môi trường của store cho phiên từ nguồn mà bộ tool đó đang dùng (với Litzzy: file `shopify.env` trong thư mục skill, các biến `SHOPIFY_STORE`, `SHOPIFY_ADMIN_TOKEN`). Giá trị không ghi vào log, `job.json`, hay lời nhắc.

`install-task.ps1` đăng ký một tác vụ Task Scheduler chạy `python runner.py` lúc đăng nhập; `set-token.ps1` lưu `CLONE_WORKER_TOKEN` và `ECOM_URL` vào biến môi trường của người dùng. Cả hai chỉ được VIẾT trong task này, không chạy.

- [ ] **Step 1: Test (thất bại trước)**

```python
def test_build_argv_is_a_list_and_blocks_ssh():  # không phần tử nào là chuỗi lệnh ghép; có luật chặn ssh, scp, .ssh
def test_prompt_treats_job_values_as_data():  # sourceUrl chứa "{0}" và "$(…)" xuất hiện nguyên văn trong khối JSON
def test_read_result_rejects_missing_bad_and_unknown_verdict():
def test_pass_without_product_gid_is_fail():
def test_run_session_with_fake_claude_pass():  # fake_claude.py ghi result.json PASS → dict PASS, có cost
def test_run_session_timeout():  # fake ngủ; timeout_s=1 → failKind TIMEOUT, tiến trình con đã dừng
def test_store_env_never_reaches_log_or_job_json():
def test_find_existing_matches_same_link_in_other_form_and_ignores_draft_and_deleted():
```

- [ ] **Step 2:** FAIL. **Step 3:** Viết code và tài liệu. **Step 4:** `python -m pytest tools/clone-runner/tests -q` PASS.
- [ ] **Step 5:** Commit `feat(clone-runner): headless Claude session per job, register lookup, setup scripts`.

### Task 9: Thao tác Shopify dùng chung cho mọi tool

**Files:**
- Create: `tools/clone-runner/shopify_ops.py`, `tools/clone-runner/tests/test_shopify_ops.py`

**Interfaces:**
- Produces:
  - `variant_suffix(option_values: list[str]) -> str` và `sku_plan(code: str, variants: list[dict]) -> dict[str, str]` (variant gid → SKU) theo đúng spec 7.5.
  - Dòng lệnh: `python shopify_ops.py set-skus --product <gid> --code <mã>`, `publish --product <gid>`, `state --product <gid>`; đọc `SHOPIFY_STORE`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_API_VERSION` (mặc định theo tool Litzzy) từ môi trường; in một dòng JSON; mã thoát 0 khi xong, 1 khi Shopify trả `userErrors`, 2 khi tham số sai.
  - `set-skus` từ chối `--code` không khớp `^[A-Z]{2}\d{10}$` và `--product` không khớp `^gid://shopify/Product/\d+$`.
  - `publish` đặt ACTIVE và đưa lên Online Store bằng REST `PUT products/<id>.json {"product":{"published":true}}`, rồi đọc lại và trả `onlineStoreUrl`; `onlineStoreUrl` vẫn null thì mã thoát 1.
  - Mọi lệnh gọi mạng đi qua một `opener` thay được trong test.

- [ ] **Step 1: Test (thất bại trước)**

```python
def test_suffix_black_xl():  # ['Black', 'XL'] → 'BLACK-XL'
def test_suffix_strips_everything_but_letters_and_digits():  # ['3.5 inches', 'Navy/White'] → '35INCHES-NAVYWHITE'
def test_single_default_variant_gets_the_bare_code():  # 'Default Title' → 'DC2611057392'
def test_duplicate_suffix_gets_numbered():  # hai variant cùng đuôi → '-BLACK', '-BLACK-2'
def test_empty_value_becomes_v_index():  # ['★'] ở variant thứ 3 → 'V3'
def test_set_skus_rejects_bad_code_and_bad_gid():
def test_publish_fails_when_online_store_url_stays_null():
def test_token_never_printed():
```

- [ ] **Step 2:** FAIL. **Step 3:** Viết code. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(clone-runner): shared SKU and publish operations`.

---

## Phần C: cặp đầu tiên, Customily → Litzzy

### Task 10: Tool Customily của Litzzy chạy theo hàng chờ

**Files (ngoài repo, chép bản gốc trước):**
- Modify: `C:\Users\TM PC\.claude\skills\cloning-clipart-customizers-litzzy\tool\clone.py`, `…\scripts\qa_product.py`, `…\SKILL.md`, `…\tool\README.md`
- Test: bộ test sẵn có của tool nếu có; thêm test cho phần so SKU

**Interfaces:**
- Produces:
  - `clone.py … --sku-code <mã>`: tham số mới, không bắt buộc. Có mã thì bước QA kiểm "mọi SKU bằng mã hoặc bắt đầu bằng mã + `-`" thay cho "bằng SKU của nguồn". Không có mã thì mọi thứ y như cũ.
  - `SKILL.md` có mục "Chạy theo hàng chờ" nêu: không hỏi user; truyền `--rights` (owner đã bỏ câu hỏi quyền bán ngày 2026-11-06); slug = mã SKU viết thường; sau bước tạo sản phẩm chạy `python <repo>\tools\clone-runner\shopify_ops.py set-skus …`; sau khi `qa_report.py` in PASS chạy `shopify_ops.py publish …`; không sửa runtime, theme dùng chung, hay mã tool trong một job (dừng với `TOOL_GAP`); ghi `result.json`.
  - Sửa dòng tài liệu ghi `--only parity` thành tên bước đúng (`verify`).

- [ ] **Step 1:** Chép bản gốc bốn file vào thư mục backup; ghi danh sách vào báo cáo.
- [ ] **Step 2:** Viết test cho phần so SKU của `qa_product.py` (có mã: khớp và không khớp; không mã: như cũ) — FAIL.
- [ ] **Step 3:** Sửa tool. **Step 4:** Test PASS; chạy `python clone.py --help` thấy `--sku-code`.
- [ ] **Step 5:** Không chạy clone, không gọi store. Ghi vào báo cáo đúng những dòng đã đổi (diff so với backup).

### Task 11: Chạy thử có giám sát (cần owner)

Không giao cho trợ lý. Người điều phối làm cùng owner:

- [ ] Owner đồng ý deploy. Deploy theo quy trình đã dùng (giữ build cũ, dừng PM2, sao lưu DB, pull, `prisma migrate deploy`, build, chạy lại).
- [ ] Owner điền mã 2 chữ cái, cấp quyền, tạo token, chạy `set-token.ps1`.
- [ ] Chạy `python runner.py --once` bằng tay. Owner dán một link Customily cho Litzzy sau khi bật `customily:LIT`.
- [ ] Theo dõi trọn vòng; chỉnh `ALLOWED_TOOLS` nếu phiên bị chặn ở lệnh chính đáng; ghi chi phí và thời gian.
- [ ] Đối chiếu 10 điểm nghiệm thu của spec mục 11.
- [ ] Owner xem sản phẩm. Đạt thì chạy `install-task.ps1` khi owner đồng ý.
