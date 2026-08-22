# Spy Tool — Phase D: persistent rail + configurable cron + per-domain scan with daily quota — Design Spec

**Date:** 2026-08-22
**Status:** Draft for user review
**Depends on:** Phase B (browse page, `SpyFilterSidebar`, Sources page, `Sidebar`), Phase C (best-seller runner). Auth: JWT in `auth_token` cookie → `verifyToken` (`@/lib/auth`) yields `{ userId, role }`; roles `SUPERADMIN|ADMIN|SELLER|SUPPORT` (`@/lib/roles`).

---

## 1. Mục tiêu

Ba cải tiến từ feedback thực tế:
- **② Sidebar trái cố định** across mọi trang spy (browse + Sources + Niche + Product type) — bấm Setup chỉ đổi nội dung bên phải.
- **③ Cron cấu hình được** — bật/tắt + đổi giờ chạy scan tự động (lưu DB, scheduler reload runtime).
- **④ Nút scan mỗi domain + quota/ngày** — non-admin tối đa 2 lượt/ngày (1 domain = 1 lượt), hiển thị số đã dùng, chặn khi hết để tránh IP bị lock.

---

## 2. Quyết định đã chốt

| Vấn đề | Quyết định |
|---|---|
| Sidebar trái | Đưa vào **layout dùng chung** `/tools/spy-idea/layout.tsx`, sticky; facet ở browse, Setup nav luôn hiện |
| Cron | **Cấu hình được** (enabled + giờ) lưu `AppSetting` JSON; scheduler đọc config + reload khi lưu |
| Quota tính | **1 domain scan = 1 lượt** ("Scan all" N domain = N lượt) |
| Ai bị giới hạn | non-admin = `SELLER`/`SUPPORT` (2/ngày); `SUPERADMIN`+`ADMIN` không giới hạn |
| Reset quota | theo **ngày (Asia/Ho_Chi_Minh)** — key `YYYY-MM-DD` |
| Vượt cap | chặn cả hành động nếu số domain > lượt còn lại (không chạy 1 phần) |

---

## 3. ② Persistent layout — `src/app/tools/spy-idea/layout.tsx`

- New **client** layout wrapping all `/tools/spy-idea/*` routes:
  ```
  <div className="flex min-h-screen bg-surface">
    <Sidebar />                      // app sidebar (280px) — moved here
    <main className="ml-[280px] flex-1 p-xl">
      <SpyChrome>{children}</SpyChrome>
    </main>
  </div>
  ```
- `SpyChrome` (client) renders the **sticky left rail** (`SpyFilterSidebar`) + the page content to its right, so the rail persists across navigation and doesn't remount.
- The rail reads/writes filters via the **URL** (`useSearchParams`/`useRouter`) — no prop drilling. On browse routes it shows facets; on Setup routes (`/sources`, `/niches`, `/product-types`) facets are hidden (via `usePathname`), only the **Setup** group shows.
- **Refactor pages** under `/tools/spy-idea/*` to render ONLY their content (remove each page's own `<Sidebar/>` + outer `flex/ml-[280px]` wrapper + the in-page `SpyFilterSidebar`), since the layout now provides them. Affected: `page.tsx` (browse), `sources/page.tsx`, `niches/page.tsx`, `product-types/page.tsx`, `ads/[id]/page.tsx`.
- Browse page keeps its tier-1 (Ad Library/Product Spy/Ideas) + tier-2 sub-tabs + grid; it reads selected facets from the URL (already URL-based).
- `RoleGate` stays wrapping the layout content (once, in the layout).

---

## 4. ③ Configurable cron

### 4.1 Config storage
`AppSetting` key `spy.cron_config` (JSON):
```ts
type SpyCronConfig = {
  productBestSeller: { enabled: boolean; hours: number[] }  // default { true, [8,20] }
  ads:               { enabled: boolean; hours: number[] }  // default { true, [9] }
}
```
Timezone fixed `Asia/Ho_Chi_Minh`. Minute always `0`. Cron expr built as `0 ${hours.join(',')} * * *`.

### 4.2 Helper — `src/lib/spy/cron-config.ts` (pure, testable)
```ts
export const DEFAULT_CRON: SpyCronConfig
export function parseCronConfig(json: string | null | undefined): SpyCronConfig  // merge over DEFAULT, clamp hours 0-23, dedupe/sort
export function cronExpr(hours: number[]): string   // "0 8,20 * * *"; [] -> null (skip)
```

### 4.3 Scheduler — `src/lib/spy/scheduler.ts`
- Hold task refs at module scope: `let tasks: cron.ScheduledTask[] = []`.
- `applySchedule(cfg)`: `tasks.forEach(t => t.stop())`; `tasks = []`; for each enabled group with non-empty hours → `cron.schedule(cronExpr(hours), fn, { timezone })` and push.
- `initSpyScheduler`: load config from DB (`parseCronConfig`), `applySchedule`, log.
- `export async function reloadSpyScheduler()`: re-load config + `applySchedule` (called by the config API in-process).
- Keep `sweepStaleScans` on init. Keep `scanAllStores`/`scanAllPageTargets` (Phase C wiring intact).

### 4.4 API — `src/app/api/spy/cron/route.ts`
- `GET` → current `SpyCronConfig` (parsed; `force-dynamic`).
- `POST {productBestSeller, ads}` → validate/normalize, save `AppSetting` `spy.cron_config`, `await reloadSpyScheduler()`, return the saved config.

### 4.5 UI — "Scheduled scans" section on Sources
- Toggle enable + multi-select hours (0-23) for **Product + Best Seller** and **Ads**; Save → POST; show timezone note (VN). Read-only "last run" per group derived from latest `SpyScan` (`type` STORE_PRODUCTS / STORE_BESTSELLER / PAGE_ADS) `startedAt`.

---

## 5. ④ Per-domain scan + daily quota

### 5.1 Model (migration)
```prisma
model SpyScanQuota {
  id     String @id @default(cuid())
  userId String
  day    String            // YYYY-MM-DD in Asia/Ho_Chi_Minh
  count  Int    @default(0)
  @@unique([userId, day])
}
```
Migration `add_spy_scan_quota`; bump `SCHEMA_VERSION` v30→v31.

### 5.2 Helpers — `src/lib/spy/scan-quota.ts`
```ts
export const SCAN_DAILY_LIMIT = 2
export function isUnlimited(role: UserRole): boolean   // SUPERADMIN || ADMIN
export function vnDay(now = new Date()): string        // YYYY-MM-DD in Asia/Ho_Chi_Minh (Intl en-CA)
// DB (in route): getCount(userId, day), addCount(userId, day, n) via upsert increment
```
- `authFromReq(req)`: read `auth_token` cookie → `verifyToken` → payload (or null → 401).

### 5.3 Enforcement (scan routes)
- **`/api/spy/scan`** (stores) and **`/api/spy/scan-ads`** (ad-domain/page): before running, resolve `{ userId, role }`. Compute `n` = number of domains this call will scan (stores: `storeId`→1 else count active; scan-ads: 1).
  - If `isUnlimited(role)` → run, do NOT count.
  - Else: `used = getCount(userId, vnDay())`; if `used + n > SCAN_DAILY_LIMIT` → `429 { error, used, limit }` (no run). Else run, then `addCount(userId, vnDay(), n)`.
- Cron-triggered scans (scheduler) never touch quota (no user).

### 5.4 API — `src/app/api/spy/scan-quota/route.ts`
- `GET` → `{ isAdmin, used, limit, remaining }` for the current user (`force-dynamic`).

### 5.5 UI — Sources page
- Top: quota badge — admin: "Admin · không giới hạn"; else "Đã dùng {used}/{limit} lượt scan hôm nay".
- **Per-store Scan button** (store list) → POST `/api/spy/scan {storeId}` (1 lượt). Keep "Scan now" (all) → N lượt.
- Ad-domain "Scan domain" / page "Scan page" unchanged (each = 1 lượt via scan-ads).
- Non-admin with `remaining <= 0` → scan buttons disabled + tooltip "Hết lượt hôm nay". On `429` show a toast/message and refresh the quota badge.

---

## 6. Non-goals (Phase D)
- Không đổi logic scan/ingest/best-seller (chỉ thêm quota gate + per-domain trigger).
- Không rate-limit theo IP/Apify (chỉ theo user/ngày).
- Không đổi cron của module khác (auto-sync Meta giữ nguyên).
- Cron config: chỉ giờ (minute=0) + enable, timezone cố định VN (không cấu hình phút/tz trong Phase D).

---

## 7. Testing
- `cron-config.ts` — unit (parse defaults/merge/clamp; cronExpr join; [] → null).
- `scan-quota.ts` — unit (`isUnlimited` per role; `vnDay` format YYYY-MM-DD).
- `SpyScanQuota` delegate — schema smoke test.
- scheduler `applySchedule` — unit if extractable (task stop/reschedule count) else tsc/manual.
- Routes (cron, scan-quota, scan enforcement) — tsc/lint + manual.
- Layout/UI — tsc/lint + manual (rail persists across Sources/Niche/Product type; facets hidden on setup).
- Regression: full suite (2 order-profit fails unrelated).

---

## 8. Phân phase implement (cho writing-plans)
1. `SpyScanQuota` model + migration (v31) + `scan-quota.ts` helpers (+tests) + delegate smoke test.
2. Quota enforcement in `/api/spy/scan` + `/api/spy/scan-ads` (auth + count) + `GET /api/spy/scan-quota`.
3. `cron-config.ts` (+tests) + scheduler config-driven + `reloadSpyScheduler` + `GET/POST /api/spy/cron`.
4. Persistent layout `/tools/spy-idea/layout.tsx` + `SpyChrome` + refactor pages to content-only (remove per-page Sidebar/rail).
5. Sources UI: cron config section + quota badge + per-store Scan button + disable-on-limit.
