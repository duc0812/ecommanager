# Cashflow Monthly Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chốt (snapshot) dòng tiền dự kiến tích lũy cuối mỗi tháng cho từng project để tính profit theo tháng, và mở rộng Projected Cashflow để trừ nợ Meta chưa charge (`balance`).

**Architecture:** Tách phép tính cashflow inline trong analytics route thành `computeProjectCashflow()` dùng chung cho cả route và job snapshot. Sync thêm `balance` ad account từ Meta API → `pendingInvoiceCharge` trừ vào Projected. Một scheduler node-cron chốt `CashflowSnapshot` cuối mỗi tháng; backfill các tháng đã qua bằng data hiện tại.

**Tech Stack:** Next.js 14 (App Router), Prisma 7 + SQLite (libsql adapter), node-cron, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-cashflow-monthly-snapshot-design.md`

## Global Constraints

- **Prisma:** KHÔNG thêm `url` vào block `datasource db {}` (breaks Prisma v7). Import client từ `@/generated/prisma/client`, dùng singleton `import { prisma } from '@/lib/db'`.
- **Sau mọi schema change:** `npx prisma migrate dev --name <desc>` → `npx prisma generate` → bump `SCHEMA_VERSION` trong `src/lib/db.ts` (hiện `v39` → `v40`) → restart dev.
- **Migration additive:** chỉ CREATE TABLE + ADD COLUMN nullable. Không sửa/xoá dữ liệu cũ.
- **Currency:** convert dùng `convertMetaAmountToUsdDated(amount, currency, dateKey, schedule)` từ `@/lib/meta-currency`; tỷ giá là "đơn vị nguồn / 1 USD"; trả `null` khi thiếu tỷ giá (không đoán).
- **Test runner:** `npm test` = `vitest run`. Test đặt cạnh source (`*.test.ts`) hoặc trong `tests/`. `fileParallelism: false` (integration dùng chung dev.db).
- **Date convention hiển thị:** US `MM/DD/YYYY` (en-US).
- **Actual vs Projected:** `actualCashflow` = tiền thực chi/thực nhận, KHÔNG đổi. `pendingInvoiceCharge` chỉ trừ ở `projectedCashflow`.
- **Không đổi cách tính COGS.**

---

## File Structure

**Tạo mới:**
- `src/lib/meta-balance.ts` — parser `balance` Meta (minor→major) + build update data
- `src/lib/repos/cashflow.ts` — `computeProjectCashflow()` (tách từ analytics route)
- `src/lib/cashflow-snapshot.ts` — helpers thuần: month boundary, list months, delta profit, build snapshot row
- `src/lib/cashflow-snapshot-scheduler.ts` — cron job + `initCashflowSnapshotScheduler`, `runMonthEndSnapshots`, `backfillProjectSnapshots`
- `src/app/api/projects/[id]/snapshots/route.ts` — GET danh sách + delta
- `src/app/api/projects/[id]/snapshot/route.ts` — POST chốt lại 1 tháng
- `src/app/api/projects/snapshot/backfill/route.ts` — POST backfill
- Test cạnh mỗi file.

**Sửa:**
- `prisma/schema.prisma` — model `CashflowSnapshot` + `Project.snapshots` + 3 cột `MetaAdAccount.balance*`
- `src/lib/meta-billing-sync.ts` — fetch + persist `balance`
- `src/app/api/projects/analytics/route.ts` — gọi `computeProjectCashflow`
- `src/instrumentation.ts` — gọi `initCashflowSnapshotScheduler()`
- `src/app/projects/page.tsx` — card `Pending Meta` + section "Profit theo tháng"
- `src/lib/db.ts` — bump `SCHEMA_VERSION`

---

## Task 1: Schema — CashflowSnapshot model + MetaAdAccount balance columns

**Files:**
- Modify: `prisma/schema.prisma` (model `Project` ~91-104, `MetaAdAccount` ~106-118; thêm model mới)
- Modify: `src/lib/db.ts:6`

**Interfaces:**
- Produces: Prisma models `CashflowSnapshot`, `MetaAdAccount.balance/balanceCurrency/balanceSyncedAt`, relation `Project.snapshots`.

- [ ] **Step 1: Thêm cột vào `MetaAdAccount`**

Trong `model MetaAdAccount`, thêm sau dòng `lastSyncAt DateTime?`:

```prisma
  balance         Float?
  balanceCurrency String?
  balanceSyncedAt DateTime?
```

- [ ] **Step 2: Thêm relation vào `Project`**

Trong `model Project`, thêm sau `orders Order[]`:

```prisma
  snapshots    CashflowSnapshot[]
```

- [ ] **Step 3: Thêm model `CashflowSnapshot`** (cuối file, cạnh các model khác)

```prisma
model CashflowSnapshot {
  id                   String   @id @default(cuid())
  projectId            String
  project              Project  @relation(fields: [projectId], references: [id])
  periodMonth          String   // 'YYYY-MM'
  asOfDate             String   // 'YYYY-MM-DD' cuối tháng theo tz store
  takenAt              DateTime @default(now())

  totalPayout          Float
  totalMetaBilling     Float
  metaFxFee            Float
  totalOrderCogs       Float
  totalOtherCosts      Float
  actualCashflow       Float
  shopifyBalance       Float
  inTransitPayout      Float
  pendingPayout        Float
  pendingInvoiceCharge Float
  projectedCashflow    Float

  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  @@unique([projectId, periodMonth])
  @@index([projectId])
}
```

- [ ] **Step 4: Chạy migration + generate**

Run:
```bash
npx prisma migrate dev --name add_cashflow_snapshot_and_meta_balance
npx prisma generate
```
Expected: migration mới tạo trong `prisma/migrations/`, generate thành công.

- [ ] **Step 5: Bump SCHEMA_VERSION**

Trong `src/lib/db.ts:6` đổi `const SCHEMA_VERSION = 'v39'` → `'v40'`.

- [ ] **Step 6: Verify build/test không vỡ**

Run: `npx prisma validate && npm test`
Expected: validate OK; test suite hiện có vẫn PASS.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/db.ts
git commit -m "feat(cashflow): add CashflowSnapshot model + MetaAdAccount balance columns"
```

---

## Task 2: Meta balance parser (minor→major)

**Files:**
- Create: `src/lib/meta-balance.ts`
- Test: `src/lib/meta-balance.test.ts`

**Interfaces:**
- Produces:
  - `metaBalanceToMajor(raw: unknown, currency: string | null): number | null`
  - `ZERO_DECIMAL_CURRENCIES: Set<string>`

**Bối cảnh:** Meta Graph API trả `balance` là chuỗi số nguyên ở **đơn vị nhỏ nhất** của currency. USD → cents (chia 100). Currency zero-decimal (VND, JPY…) → không chia. Trả `null` nếu không parse được.

- [ ] **Step 1: Viết test thất bại**

`src/lib/meta-balance.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { metaBalanceToMajor } from './meta-balance'

describe('metaBalanceToMajor', () => {
  it('divides 2-decimal currencies by 100', () => {
    expect(metaBalanceToMajor('1050', 'USD')).toBe(10.5)
    expect(metaBalanceToMajor('0', 'USD')).toBe(0)
  })
  it('keeps zero-decimal currencies as-is', () => {
    expect(metaBalanceToMajor('263274537', 'VND')).toBe(263274537)
    expect(metaBalanceToMajor('5000', 'JPY')).toBe(5000)
  })
  it('normalizes currency casing/whitespace', () => {
    expect(metaBalanceToMajor('1050', ' usd ')).toBe(10.5)
  })
  it('returns null for missing/invalid input', () => {
    expect(metaBalanceToMajor(null, 'USD')).toBeNull()
    expect(metaBalanceToMajor(undefined, 'USD')).toBeNull()
    expect(metaBalanceToMajor('abc', 'USD')).toBeNull()
    expect(metaBalanceToMajor('', 'USD')).toBeNull()
  })
})
```

- [ ] **Step 2: Chạy test — verify fail**

Run: `npm test -- src/lib/meta-balance.test.ts`
Expected: FAIL ("Cannot find module './meta-balance'").

- [ ] **Step 3: Implement**

`src/lib/meta-balance.ts`:
```ts
// ISO 4217 zero-decimal currencies (Meta trả balance ở đơn vị nhỏ nhất; các currency này không có phần thập phân).
export const ZERO_DECIMAL_CURRENCIES = new Set([
  'VND', 'JPY', 'KRW', 'CLP', 'ISK', 'HUF', 'TWD', 'UGX', 'XOF', 'XAF', 'PYG', 'RWF', 'VUV',
])

function normalizeCurrency(currency: string | null): string {
  return (currency ?? '').trim().toUpperCase() || 'USD'
}

export function metaBalanceToMajor(raw: unknown, currency: string | null): number | null {
  if (raw === null || raw === undefined) return null
  const text = String(raw).trim()
  if (text === '') return null
  const minor = Number(text)
  if (!Number.isFinite(minor)) return null
  const code = normalizeCurrency(currency)
  const divisor = ZERO_DECIMAL_CURRENCIES.has(code) ? 1 : 100
  return minor / divisor
}
```

- [ ] **Step 4: Chạy test — verify pass**

Run: `npm test -- src/lib/meta-balance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/meta-balance.ts src/lib/meta-balance.test.ts
git commit -m "feat(cashflow): add Meta balance minor->major parser"
```

> **Lưu ý cho executor:** format `balance` của Meta cần verify với response thật. Khi làm Task 3, log giá trị `balance` thô cho account VND (Remi08) và đối chiếu với số dư thực trên Meta Ads Manager. Nếu Meta trả VND đã ở major (không nhân 100), giữ nguyên logic (VND thuộc zero-decimal). Nếu phát hiện khác, cập nhật `ZERO_DECIMAL_CURRENCIES`/divisor và test.

---

## Task 3: Persist Meta `balance` khi sync billing

**Files:**
- Modify: `src/lib/meta-balance.ts` (thêm builder)
- Modify: `src/lib/meta-billing-sync.ts` (fetch field `balance` ~359; persist ~655-661)
- Test: `src/lib/meta-balance.test.ts`

**Interfaces:**
- Consumes: `metaBalanceToMajor` (Task 2).
- Produces: `buildAccountBalanceUpdate(json: Record<string, unknown>, currency: string | null, now: Date): { balance: number | null; balanceCurrency: string | null; balanceSyncedAt: Date }`

- [ ] **Step 1: Viết test thất bại** (thêm vào `src/lib/meta-balance.test.ts`)

```ts
import { buildAccountBalanceUpdate } from './meta-balance'

describe('buildAccountBalanceUpdate', () => {
  const now = new Date('2026-09-04T00:00:00Z')
  it('parses balance and stamps currency + syncedAt', () => {
    const r = buildAccountBalanceUpdate({ balance: '263274537', currency: 'VND' }, 'VND', now)
    expect(r).toEqual({ balance: 263274537, balanceCurrency: 'VND', balanceSyncedAt: now })
  })
  it('prefers account currency arg over json currency', () => {
    const r = buildAccountBalanceUpdate({ balance: '1050' }, 'USD', now)
    expect(r).toEqual({ balance: 10.5, balanceCurrency: 'USD', balanceSyncedAt: now })
  })
  it('returns null balance when field absent', () => {
    const r = buildAccountBalanceUpdate({}, 'USD', now)
    expect(r).toEqual({ balance: null, balanceCurrency: 'USD', balanceSyncedAt: now })
  })
})
```

- [ ] **Step 2: Chạy test — verify fail**

Run: `npm test -- src/lib/meta-balance.test.ts`
Expected: FAIL ("buildAccountBalanceUpdate is not a function").

- [ ] **Step 3: Implement builder** (thêm vào `src/lib/meta-balance.ts`)

```ts
export function buildAccountBalanceUpdate(
  json: Record<string, unknown>,
  currency: string | null,
  now: Date,
): { balance: number | null; balanceCurrency: string | null; balanceSyncedAt: Date } {
  const code = (currency ?? (typeof json.currency === 'string' ? json.currency : null))
  return {
    balance: metaBalanceToMajor(json.balance, code),
    balanceCurrency: code ? code.trim().toUpperCase() : null,
    balanceSyncedAt: now,
  }
}
```

- [ ] **Step 4: Chạy test — verify pass**

Run: `npm test -- src/lib/meta-balance.test.ts`
Expected: PASS.

- [ ] **Step 5: Fetch field `balance` từ Meta**

Trong `src/lib/meta-billing-sync.ts`, `fetchPaymentMethod` (~358): thêm `balance` vào `fields`:
```ts
    fields: 'funding_source,funding_source_details,currency,timezone_name,balance',
```
Và mở rộng type `MetaPaymentMethod` (khai báo ~41-43, thêm field) + return của `fetchPaymentMethod` để chuyển tiếp raw json balance. Cách tối giản: trong `fetchPaymentMethod`, sau khi có `json`, tính:
```ts
    const balanceUpdate = buildAccountBalanceUpdate(json as Record<string, unknown>, account.currency ?? null, new Date())
```
và đưa `balanceUpdate` vào object trả về (thêm field `balance`, `balanceCurrency`, `balanceSyncedAt` vào `MetaPaymentMethod`). Import ở đầu file:
```ts
import { buildAccountBalanceUpdate } from '@/lib/meta-balance'
```
Trong nhánh `catch` của `fetchPaymentMethod` (payment method optional), trả `balance: null, balanceCurrency: account.currency ?? null, balanceSyncedAt: new Date()`.

- [ ] **Step 6: Persist balance vào account**

Tại `prisma.metaAdAccount.update` (~655-661), thêm vào `data`:
```ts
      balance: paymentMethod.balance,
      balanceCurrency: paymentMethod.balanceCurrency,
      balanceSyncedAt: paymentMethod.balanceSyncedAt,
```

- [ ] **Step 7: Verify toàn bộ test + typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, không lỗi type.

- [ ] **Step 8: Commit**

```bash
git add src/lib/meta-balance.ts src/lib/meta-balance.test.ts src/lib/meta-billing-sync.ts
git commit -m "feat(cashflow): sync Meta ad account balance during billing sync"
```

---

## Task 4: Characterization test — khoá output analytics route trước refactor

**Files:**
- Test: `tests/project-analytics.characterization.test.ts`

**Interfaces:**
- Consumes: `GET` từ `src/app/api/projects/analytics/route.ts`.

**Mục đích:** Chụp lại output route hiện tại (dùng dev.db, project LZ) làm snapshot để chứng minh refactor Task 5 không đổi số. Tại thời điểm này mọi `balance` = `null` nên chưa ảnh hưởng.

- [ ] **Step 1: Viết test snapshot**

`tests/project-analytics.characterization.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/projects/analytics/route'

const PID = 'cmp27ew310003hkv9sw0wnb2u' // LZ

describe('analytics route characterization', () => {
  it('matches snapshot for LZ 2026-03-01..2026-07-31', async () => {
    const url = `http://localhost/api/projects/analytics?projectId=${PID}&dateFrom=2026-03-01&dateTo=2026-07-31`
    const res = await GET(new NextRequest(url))
    const json = await res.json()
    // Loại field biến động theo lần chạy (không có timestamp động trong response; project.createdAt cố định).
    expect(json).toMatchSnapshot()
  })
})
```

- [ ] **Step 2: Chạy test — tạo snapshot**

Run: `npm test -- tests/project-analytics.characterization.test.ts`
Expected: PASS (tạo file `tests/__snapshots__/project-analytics.characterization.test.ts.snap`).

> Nếu FAIL vì project LZ không tồn tại trong dev.db của môi trường thực thi: đổi `PID` sang một project có dữ liệu (chạy `npx prisma studio` hoặc query `Project`), và ghi lại id đã dùng ở đầu test.

- [ ] **Step 3: Commit snapshot**

```bash
git add tests/project-analytics.characterization.test.ts tests/__snapshots__
git commit -m "test(cashflow): characterization snapshot of analytics route before refactor"
```

---

## Task 5: Tách `computeProjectCashflow()` (không đổi output)

**Files:**
- Create: `src/lib/repos/cashflow.ts`
- Modify: `src/app/api/projects/analytics/route.ts`
- Test: `tests/project-analytics.characterization.test.ts` (chạy lại, không sửa)

**Interfaces:**
- Produces:
```ts
export type ProjectCashflowInput = {
  project: any            // Project + shopifyStore (đã include như route hiện tại)
  timeZone: string
  startStr: string
  endStr: string
  payoutStartStr: string
  startDate: Date
  endDate: Date
  orderRangeStart: Date
  orderRangeEnd: Date
  periodIsValid: boolean
}
export type ProjectCashflowResult = { /* mọi field route trả hiện tại + pendingInvoiceCharge (Task 6) */ }
export async function computeProjectCashflow(input: ProjectCashflowInput): Promise<ProjectCashflowResult>
```

**Cách làm:** Đây là **refactor cơ học có test bảo vệ**. Di chuyển khối tính (hiện `analytics/route.ts` dòng ~128-353, từ `const paidMetaStatuses` đến hết `dataDiagnostics`) vào `computeProjectCashflow`, nhận các biến đã resolve (tz, các *Str, các Date range, project) làm tham số thay vì tính lại. Route giữ phần resolve (dòng ~71-126) và phần build `NextResponse.json({...})`.

- [ ] **Step 1: Tạo `src/lib/repos/cashflow.ts`**

- Copy nguyên khối logic ~128-353 vào hàm `computeProjectCashflow(input)`.
- Thay các biến trước đó lấy từ scope route (`project`, `timeZone`, `startStr`, `endStr`, `payoutStartStr`, `startDate`, `endDate`, `orderRangeStart`, `orderRangeEnd`, `periodIsValid`) bằng `input.*`.
- Giữ nguyên mọi import cần thiết (chuyển các import từ route: `prisma`, `estimateOrderCostAndProfit`, `productLinesOnly`, `convertMetaAmountToUsdDated`, `normalizeMetaCurrency`, `sumMetaAmountsUsdDated`, `getMetaRateSchedule`, `getVndCardLast4`, `sumBillingFxFeesUsd`, `summarizeProjectOrderFinancials`, `PROJECT_REVENUE_EXCLUDED_STATUSES`, các helper ngày `dateOnly/dateKeyInZone/addDays/zonedDayStartUtc`).
- Helper ngày dùng chung: chuyển `dateKeyInZone`, `addDays`, `zonedDayStartUtc`, `dateOnly` vào một module dùng chung `src/lib/cashflow-dates.ts` và import ở cả route lẫn cashflow repo (tránh trùng lặp). Export chúng.
- `return` object gồm **đúng các field** route đang trả trong `NextResponse.json` (trừ `project`, `labelAudit`, `dataDiagnostics` có thể trả kèm hoặc để route tự build — để đơn giản, trả tất cả trong result và route spread).

- [ ] **Step 2: Route gọi hàm mới**

Trong `analytics/route.ts`, sau khi resolve xong các biến (đến ~126), thay khối tính bằng:
```ts
  const computed = await computeProjectCashflow({
    project, timeZone, startStr, endStr, payoutStartStr,
    startDate, endDate, orderRangeStart, orderRangeEnd, periodIsValid,
  })
  return NextResponse.json({
    project,
    ...computed,
    payoutDateRange: { start: payoutStartStr, end: endStr },
  })
```
(Đảm bảo `labelAudit`, `dataDiagnostics`, `dateRange` nằm trong `computed`.)

- [ ] **Step 3: Chạy characterization — verify KHÔNG đổi**

Run: `npm test -- tests/project-analytics.characterization.test.ts`
Expected: PASS, snapshot khớp y hệt (không có `-u`). Nếu lệch → refactor sai, sửa cho khớp.

- [ ] **Step 4: Chạy full test + typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/repos/cashflow.ts src/lib/cashflow-dates.ts src/app/api/projects/analytics/route.ts
git commit -m "refactor(cashflow): extract computeProjectCashflow (no behavior change)"
```

---

## Task 6: `pendingInvoiceCharge` vào Projected Cashflow + UI card

**Files:**
- Modify: `src/lib/repos/cashflow.ts`
- Test: `src/lib/repos/cashflow.pending.test.ts`
- Modify: `src/app/projects/page.tsx` (type ~107-123; section Actual Cashflow ~362-369)
- Modify: `tests/project-analytics.characterization.test.ts` snapshot (cập nhật có chủ đích)

**Interfaces:**
- Consumes: `convertMetaAmountToUsdDated`, `getMetaRateSchedule`.
- Produces: field `pendingInvoiceCharge` trong `ProjectCashflowResult`; `projectedCashflow` đã trừ.

- [ ] **Step 1: Viết test thuần cho phần tính pending** (tách hàm thuần để test không cần DB)

Trong `src/lib/repos/cashflow.ts` export helper thuần:
```ts
export function sumPendingInvoiceChargeUsd(
  accounts: { balance: number | null; balanceCurrency: string | null }[],
  dateKey: string,
  schedule: { effectiveDate: string; rate: number }[],
): number
```

`src/lib/repos/cashflow.pending.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { sumPendingInvoiceChargeUsd } from './cashflow'

const sched = [{ effectiveDate: '2026-01-01', rate: 25500 }]

describe('sumPendingInvoiceChargeUsd', () => {
  it('sums USD balances directly', () => {
    expect(sumPendingInvoiceChargeUsd(
      [{ balance: 100, balanceCurrency: 'USD' }, { balance: 50, balanceCurrency: 'USD' }],
      '2026-08-31', sched,
    )).toBe(150)
  })
  it('converts VND balance via schedule', () => {
    expect(sumPendingInvoiceChargeUsd(
      [{ balance: 255000, balanceCurrency: 'VND' }], '2026-08-31', sched,
    )).toBe(10)
  })
  it('skips null balances and missing-rate accounts', () => {
    expect(sumPendingInvoiceChargeUsd(
      [{ balance: null, balanceCurrency: 'USD' }, { balance: 255000, balanceCurrency: 'VND' }],
      '2026-08-31', [],
    )).toBe(0)
  })
})
```

- [ ] **Step 2: Chạy test — verify fail**

Run: `npm test -- src/lib/repos/cashflow.pending.test.ts`
Expected: FAIL ("sumPendingInvoiceChargeUsd is not a function").

- [ ] **Step 3: Implement helper + wire vào computeProjectCashflow**

Thêm vào `src/lib/repos/cashflow.ts`:
```ts
import { convertMetaAmountToUsdDated } from '@/lib/meta-currency'

export function sumPendingInvoiceChargeUsd(accounts, dateKey, schedule) {
  let total = 0
  for (const a of accounts) {
    if (a.balance === null || a.balance === undefined) continue
    const usd = convertMetaAmountToUsdDated(a.balance, a.balanceCurrency, dateKey, schedule)
    if (usd === null) continue
    total += usd
  }
  return Math.round(total * 100) / 100
}
```
Trong `computeProjectCashflow`: `metaAccounts` query đã có — thêm `balance, balanceCurrency` vào `select`. Sau khi có `schedule` và `endStr`:
```ts
  const pendingInvoiceCharge = sumPendingInvoiceChargeUsd(metaAccounts, endStr, schedule)
```
Và đổi:
```ts
  const projectedCashflow = actualCashflow + shopifyBalance + inTransitPayout - pendingInvoiceCharge
```
Thêm `pendingInvoiceCharge` vào object return.

- [ ] **Step 4: Chạy test — verify pass**

Run: `npm test -- src/lib/repos/cashflow.pending.test.ts`
Expected: PASS.

- [ ] **Step 5: Cập nhật snapshot characterization (có chủ đích)**

Vì response thêm field `pendingInvoiceCharge` (=0 khi mọi balance null) và `projectedCashflow` trừ 0 (không đổi số), chạy:
Run: `npm test -- tests/project-analytics.characterization.test.ts -u`
Expected: snapshot cập nhật chỉ THÊM `pendingInvoiceCharge: 0`; các số khác không đổi. **Kiểm tra git diff của file `.snap`** để xác nhận đúng vậy.

- [ ] **Step 6: UI — thêm field type + card**

`src/app/projects/page.tsx`:
- Trong type `Analytics` (sau `projectedCashflow: number`, ~111) thêm: `pendingInvoiceCharge: number`.
- Trong lưới "Actual Cashflow" (~348-377), thêm card trước "Net Cashflow":
```tsx
                    <StatCard label="Pending Meta" icon="pending_actions" value={fmtUSD(analytics.pendingInvoiceCharge)} hint="nợ ads chưa charge" />
```
- Cập nhật hint card "Projected Cashflow" (~366) thành:
```tsx
                      hint={`+ ${fmtUSD(analytics.shopifyBalance)} balance + ${fmtUSD(analytics.inTransitPayout)} in-transit − ${fmtUSD(analytics.pendingInvoiceCharge)} pending Meta`}
```

- [ ] **Step 7: Verify full test + typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/repos/cashflow.ts src/lib/repos/cashflow.pending.test.ts src/app/projects/page.tsx tests/__snapshots__
git commit -m "feat(cashflow): subtract pending Meta charge from projected cashflow"
```

---

## Task 7: Helpers thuần cho snapshot (month boundary, list, delta)

**Files:**
- Create: `src/lib/cashflow-snapshot.ts`
- Test: `src/lib/cashflow-snapshot.test.ts`

**Interfaces:**
- Consumes: `zonedDayStartUtc`, `addDays`, `dateKeyInZone` từ `@/lib/cashflow-dates` (Task 5).
- Produces:
  - `monthEndDateKey(periodMonth: string, timeZone: string): string` — 'YYYY-MM-DD' ngày cuối tháng.
  - `monthEndBoundaryUtc(periodMonth: string, timeZone: string): { asOfDate: string; endDate: Date }`
  - `listPeriodMonths(startDate: Date, upToMonth: string, timeZone: string): string[]` — các 'YYYY-MM' từ tháng của startDate đến `upToMonth` (bao gồm).
  - `previousMonth(periodMonth: string): string`
  - `monthlyProfit(current: number, prev: number | null): number`

- [ ] **Step 1: Viết test thất bại**

`src/lib/cashflow-snapshot.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { monthEndDateKey, listPeriodMonths, previousMonth, monthlyProfit } from './cashflow-snapshot'

describe('monthEndDateKey', () => {
  it('returns last calendar day of month', () => {
    expect(monthEndDateKey('2026-07', 'America/Denver')).toBe('2026-07-31')
    expect(monthEndDateKey('2026-02', 'America/Denver')).toBe('2026-02-28')
  })
})

describe('listPeriodMonths', () => {
  it('lists months from project start month through target inclusive', () => {
    expect(listPeriodMonths(new Date('2026-02-12T00:00:00Z'), '2026-05', 'America/Denver'))
      .toEqual(['2026-02', '2026-03', '2026-04', '2026-05'])
  })
})

describe('previousMonth', () => {
  it('rolls back across year', () => {
    expect(previousMonth('2026-01')).toBe('2025-12')
    expect(previousMonth('2026-08')).toBe('2026-07')
  })
})

describe('monthlyProfit', () => {
  it('is the delta vs previous, or the value itself for first month', () => {
    expect(monthlyProfit(3000, 1100)).toBe(1900)
    expect(monthlyProfit(1100, null)).toBe(1100)
  })
})
```

- [ ] **Step 2: Chạy test — verify fail**

Run: `npm test -- src/lib/cashflow-snapshot.test.ts`
Expected: FAIL (module không tồn tại).

- [ ] **Step 3: Implement**

`src/lib/cashflow-snapshot.ts`:
```ts
import { zonedDayStartUtc, addDays, dateKeyInZone } from '@/lib/cashflow-dates'

export function monthEndDateKey(periodMonth: string, timeZone: string): string {
  const [y, m] = periodMonth.split('-').map(Number)
  // ngày 0 của tháng kế = ngày cuối tháng này (theo lịch dương)
  const lastDayUtc = new Date(Date.UTC(y, m, 0))
  return `${periodMonth}-${String(lastDayUtc.getUTCDate()).padStart(2, '0')}`
}

export function monthEndBoundaryUtc(periodMonth: string, timeZone: string): { asOfDate: string; endDate: Date } {
  const asOfDate = monthEndDateKey(periodMonth, timeZone)
  const endDate = new Date(zonedDayStartUtc(addDays(asOfDate, 1), timeZone).getTime() - 1)
  return { asOfDate, endDate }
}

export function previousMonth(periodMonth: string): string {
  const [y, m] = periodMonth.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function listPeriodMonths(startDate: Date, upToMonth: string, timeZone: string): string[] {
  const startKey = dateKeyInZone(startDate, timeZone) // 'YYYY-MM-DD'
  let cursor = startKey.slice(0, 7)
  const out: string[] = []
  let guard = 0
  while (cursor <= upToMonth && guard++ < 600) {
    out.push(cursor)
    const [y, m] = cursor.split('-').map(Number)
    const next = new Date(Date.UTC(y, m, 1))
    cursor = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`
  }
  return out
}

export function monthlyProfit(current: number, prev: number | null): number {
  return prev === null ? current : Math.round((current - prev) * 100) / 100
}
```

- [ ] **Step 4: Chạy test — verify pass**

Run: `npm test -- src/lib/cashflow-snapshot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cashflow-snapshot.ts src/lib/cashflow-snapshot.test.ts
git commit -m "feat(cashflow): pure helpers for month-end snapshot boundaries and deltas"
```

---

## Task 8: `runMonthEndSnapshots` + upsert (job core)

**Files:**
- Modify: `src/lib/cashflow-snapshot.ts` (thêm `buildSnapshotData`) hoặc `src/lib/cashflow-snapshot-scheduler.ts`
- Create: `src/lib/cashflow-snapshot-scheduler.ts`
- Test: `tests/cashflow-snapshot.integration.test.ts`

**Interfaces:**
- Consumes: `computeProjectCashflow` (Task 5), `monthEndBoundaryUtc`, `listPeriodMonths` (Task 7).
- Produces:
  - `snapshotProjectMonth(projectId: string, periodMonth: string): Promise<CashflowSnapshot>` — tính & upsert 1 tháng cho 1 project.
  - `runMonthEndSnapshots(now?: Date): Promise<{ created: number; errors: string[] }>` — chốt tháng vừa kết thúc cho mọi project chưa archived.

- [ ] **Step 1: Viết integration test thất bại**

`tests/cashflow-snapshot.integration.test.ts`:
```ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { snapshotProjectMonth } from '@/lib/cashflow-snapshot-scheduler'

const PID = 'test_snap_proj'

describe('snapshotProjectMonth', () => {
  beforeAll(async () => {
    await prisma.project.upsert({
      where: { id: PID },
      create: { id: PID, name: 'Snap Test', startDate: new Date('2026-06-01T00:00:00Z') },
      update: {},
    })
  })
  afterAll(async () => {
    await prisma.cashflowSnapshot.deleteMany({ where: { projectId: PID } })
    await prisma.project.deleteMany({ where: { id: PID } })
  })

  it('creates a snapshot row with breakdown, idempotent on re-run', async () => {
    const first = await snapshotProjectMonth(PID, '2026-06')
    expect(first.periodMonth).toBe('2026-06')
    expect(first.asOfDate).toBe('2026-06-30')
    expect(typeof first.projectedCashflow).toBe('number')
    const second = await snapshotProjectMonth(PID, '2026-06')
    expect(second.id).toBe(first.id) // upsert, không tạo trùng
    const count = await prisma.cashflowSnapshot.count({ where: { projectId: PID, periodMonth: '2026-06' } })
    expect(count).toBe(1)
  })
})
```

- [ ] **Step 2: Chạy test — verify fail**

Run: `npm test -- tests/cashflow-snapshot.integration.test.ts`
Expected: FAIL (module scheduler chưa có).

- [ ] **Step 3: Implement `snapshotProjectMonth` + `runMonthEndSnapshots`**

`src/lib/cashflow-snapshot-scheduler.ts`:
```ts
import cron from 'node-cron'
import { prisma } from '@/lib/db'
import { computeProjectCashflow } from '@/lib/repos/cashflow'
import { monthEndBoundaryUtc, listPeriodMonths, previousMonth } from '@/lib/cashflow-snapshot'
import { zonedDayStartUtc, dateOnly } from '@/lib/cashflow-dates'

const SHOPIFY_PAYOUT_START_DATE = '2026-02-02'

export async function snapshotProjectMonth(projectId: string, periodMonth: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      assignments: { include: { staff: true } },
      shopifyStore: { select: { id: true, ianaTimezone: true, currentBalance: true, currentBalanceCurrency: true } },
    },
  })
  if (!project) throw new Error(`Project ${projectId} not found`)
  const timeZone = project.shopifyStore?.ianaTimezone ?? 'UTC'
  const { asOfDate, endDate } = monthEndBoundaryUtc(periodMonth, timeZone)
  const startDate = project.startDate
  const startStr = dateOnly(startDate)
  const endStr = asOfDate
  const payoutStartStr = startStr > SHOPIFY_PAYOUT_START_DATE ? startStr : SHOPIFY_PAYOUT_START_DATE
  const orderRangeStart = zonedDayStartUtc(startStr, timeZone)
  const orderRangeEnd = endDate

  const c = await computeProjectCashflow({
    project, timeZone, startStr, endStr, payoutStartStr,
    startDate, endDate, orderRangeStart, orderRangeEnd,
    periodIsValid: startDate <= endDate,
  })

  return prisma.cashflowSnapshot.upsert({
    where: { projectId_periodMonth: { projectId, periodMonth } },
    create: {
      projectId, periodMonth, asOfDate,
      totalPayout: c.totalPayout, totalMetaBilling: c.totalMetaBilling, metaFxFee: c.metaFxFee,
      totalOrderCogs: c.totalOrderCogs, totalOtherCosts: c.totalOtherCosts,
      actualCashflow: c.actualCashflow, shopifyBalance: c.shopifyBalance,
      inTransitPayout: c.inTransitPayout, pendingPayout: c.pendingPayout,
      pendingInvoiceCharge: c.pendingInvoiceCharge, projectedCashflow: c.projectedCashflow,
      takenAt: new Date(),
    },
    update: {
      asOfDate,
      totalPayout: c.totalPayout, totalMetaBilling: c.totalMetaBilling, metaFxFee: c.metaFxFee,
      totalOrderCogs: c.totalOrderCogs, totalOtherCosts: c.totalOtherCosts,
      actualCashflow: c.actualCashflow, shopifyBalance: c.shopifyBalance,
      inTransitPayout: c.inTransitPayout, pendingPayout: c.pendingPayout,
      pendingInvoiceCharge: c.pendingInvoiceCharge, projectedCashflow: c.projectedCashflow,
      takenAt: new Date(),
    },
  })
}

export async function runMonthEndSnapshots(now = new Date()) {
  // tháng vừa kết thúc = tháng của (ngày 1 tháng này − 1 ngày)
  const prevMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const periodMonth = `${prevMonthDate.getUTCFullYear()}-${String(prevMonthDate.getUTCMonth() + 1).padStart(2, '0')}`
  const projects = await prisma.project.findMany({ where: { archivedAt: null }, select: { id: true } })
  let created = 0
  const errors: string[] = []
  for (const p of projects) {
    try { await snapshotProjectMonth(p.id, periodMonth); created++ }
    catch (e: any) { errors.push(`${p.id}: ${e?.message ?? e}`) }
  }
  await prisma.appSetting.upsert({
    where: { key: 'last_cashflow_snapshot_result' },
    create: { key: 'last_cashflow_snapshot_result', value: JSON.stringify({ periodMonth, created, errors, ranAt: new Date().toISOString() }) },
    update: { value: JSON.stringify({ periodMonth, created, errors, ranAt: new Date().toISOString() }) },
  })
  return { created, errors }
}
```
> Kiểm tra tên composite unique trong client Prisma: `projectId_periodMonth`. Nếu Prisma đặt tên khác, dùng đúng tên generate.

- [ ] **Step 4: Chạy test — verify pass**

Run: `npm test -- tests/cashflow-snapshot.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cashflow-snapshot-scheduler.ts tests/cashflow-snapshot.integration.test.ts
git commit -m "feat(cashflow): snapshotProjectMonth + runMonthEndSnapshots with idempotent upsert"
```

---

## Task 9: Backfill + API routes

**Files:**
- Modify: `src/lib/cashflow-snapshot-scheduler.ts` (thêm `backfillProjectSnapshots`)
- Create: `src/app/api/projects/[id]/snapshots/route.ts`
- Create: `src/app/api/projects/[id]/snapshot/route.ts`
- Create: `src/app/api/projects/snapshot/backfill/route.ts`
- Test: `tests/cashflow-snapshot.integration.test.ts` (thêm case)

**Interfaces:**
- Consumes: `snapshotProjectMonth`, `listPeriodMonths`, `previousMonth`, `monthlyProfit`.
- Produces:
  - `backfillProjectSnapshots(projectId: string, now?: Date): Promise<{ months: string[] }>`
  - `GET /api/projects/[id]/snapshots` → `{ snapshots: [...], rows: [{ periodMonth, actualProfit, projectedProfit, ...snapshot }] }`
  - `POST /api/projects/[id]/snapshot` body `{ month: 'YYYY-MM' }`
  - `POST /api/projects/snapshot/backfill` body `{ projectId?: string }`

- [ ] **Step 1: Viết test thất bại cho backfill**

Thêm vào `tests/cashflow-snapshot.integration.test.ts`:
```ts
import { backfillProjectSnapshots } from '@/lib/cashflow-snapshot-scheduler'

it('backfills every month from project start through last completed month', async () => {
  const res = await backfillProjectSnapshots(PID, new Date('2026-09-04T00:00:00Z'))
  expect(res.months).toEqual(['2026-06', '2026-07', '2026-08'])
  const count = await prisma.cashflowSnapshot.count({ where: { projectId: PID } })
  expect(count).toBe(3)
})
```

- [ ] **Step 2: Chạy test — verify fail**

Run: `npm test -- tests/cashflow-snapshot.integration.test.ts`
Expected: FAIL ("backfillProjectSnapshots is not a function").

- [ ] **Step 3: Implement `backfillProjectSnapshots`**

Thêm vào `src/lib/cashflow-snapshot-scheduler.ts`:
```ts
import { listPeriodMonths } from '@/lib/cashflow-snapshot'

export async function backfillProjectSnapshots(projectId: string, now = new Date()) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { shopifyStore: { select: { ianaTimezone: true } } },
  })
  if (!project) throw new Error(`Project ${projectId} not found`)
  const timeZone = project.shopifyStore?.ianaTimezone ?? 'UTC'
  // tháng gần nhất đã kết thúc
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const lastMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`
  const months = listPeriodMonths(project.startDate, lastMonth, timeZone)
  for (const m of months) await snapshotProjectMonth(projectId, m)
  return { months }
}
```

- [ ] **Step 4: Chạy test — verify pass**

Run: `npm test -- tests/cashflow-snapshot.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Tạo GET snapshots route**

`src/app/api/projects/[id]/snapshots/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { previousMonth, monthlyProfit } from '@/lib/cashflow-snapshot'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const snapshots = await prisma.cashflowSnapshot.findMany({
    where: { projectId: params.id },
    orderBy: { periodMonth: 'asc' },
  })
  const byMonth = new Map(snapshots.map(s => [s.periodMonth, s]))
  const rows = snapshots.map(s => {
    const prev = byMonth.get(previousMonth(s.periodMonth)) ?? null
    return {
      ...s,
      actualProfit: monthlyProfit(s.actualCashflow, prev ? prev.actualCashflow : null),
      projectedProfit: monthlyProfit(s.projectedCashflow, prev ? prev.projectedCashflow : null),
    }
  }).reverse()
  return NextResponse.json({ rows })
}
```

- [ ] **Step 6: Tạo POST snapshot (chốt lại 1 tháng) + POST backfill**

`src/app/api/projects/[id]/snapshot/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server'
import { snapshotProjectMonth } from '@/lib/cashflow-snapshot-scheduler'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}))
  const month = typeof body.month === 'string' && /^\d{4}-\d{2}$/.test(body.month) ? body.month : null
  if (!month) return NextResponse.json({ error: 'month (YYYY-MM) required' }, { status: 400 })
  try {
    const snap = await snapshotProjectMonth(params.id, month)
    return NextResponse.json({ snapshot: snap })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
```

`src/app/api/projects/snapshot/backfill/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { backfillProjectSnapshots } from '@/lib/cashflow-snapshot-scheduler'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const projectId = typeof body.projectId === 'string' ? body.projectId : null
  const ids = projectId ? [projectId] : (await prisma.project.findMany({ where: { archivedAt: null }, select: { id: true } })).map(p => p.id)
  const results: Record<string, any> = {}
  for (const id of ids) {
    try { results[id] = await backfillProjectSnapshots(id) }
    catch (e: any) { results[id] = { error: e.message } }
  }
  return NextResponse.json({ results })
}
```

- [ ] **Step 7: Verify test + typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/cashflow-snapshot-scheduler.ts "src/app/api/projects/[id]/snapshots/route.ts" "src/app/api/projects/[id]/snapshot/route.ts" src/app/api/projects/snapshot/backfill/route.ts tests/cashflow-snapshot.integration.test.ts
git commit -m "feat(cashflow): backfill + snapshot API routes"
```

---

## Task 10: Scheduler init + instrumentation

**Files:**
- Modify: `src/lib/cashflow-snapshot-scheduler.ts` (thêm `initCashflowSnapshotScheduler`)
- Modify: `src/instrumentation.ts`

**Interfaces:**
- Produces: `initCashflowSnapshotScheduler(): void` (idempotent).

- [ ] **Step 1: Thêm init (theo pattern `auto-sync.ts`)**

Thêm vào cuối `src/lib/cashflow-snapshot-scheduler.ts`:
```ts
let initialized = false
export function initCashflowSnapshotScheduler() {
  if (initialized) return
  initialized = true
  // 00:00 ngày 1 mỗi tháng — chốt tháng vừa kết thúc
  cron.schedule('0 0 1 * *', () => {
    runMonthEndSnapshots().catch(err => console.error('[cashflow-snapshot] unhandled:', err))
  }, { timezone: 'America/Denver' })
  console.log('[cashflow-snapshot] Initialized — monthly snapshot at 00:00 (1st) America/Denver')
}
```

- [ ] **Step 2: Đăng ký trong instrumentation**

Trong `src/instrumentation.ts`, trong `register()` (sau `initTrackingScheduler()`):
```ts
    const { initCashflowSnapshotScheduler } = await import('./lib/cashflow-snapshot-scheduler')
    initCashflowSnapshotScheduler()
```

- [ ] **Step 3: Verify typecheck + test**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/cashflow-snapshot-scheduler.ts src/instrumentation.ts
git commit -m "feat(cashflow): register monthly snapshot cron in instrumentation"
```

---

## Task 11: UI — section "Profit theo tháng"

**Files:**
- Modify: `src/app/projects/page.tsx`

**Interfaces:**
- Consumes: `GET /api/projects/[id]/snapshots`.

**Mục đích:** Bảng profit theo tháng cho project đang chọn, toggle Actual/Projected, nút "Chốt lại tháng này" + "Backfill".

- [ ] **Step 1: Thêm state + fetch snapshots**

Trong component trang projects (nơi đã có `analytics`/`selectedProject`), thêm:
```tsx
  const [snapshotRows, setSnapshotRows] = useState<any[]>([])
  const [basis, setBasis] = useState<'actual' | 'projected'>('actual')
  useEffect(() => {
    if (!selectedProject?.id) return
    fetch(`/api/projects/${selectedProject.id}/snapshots`).then(r => r.json()).then(d => setSnapshotRows(d.rows ?? [])).catch(() => setSnapshotRows([]))
  }, [selectedProject?.id, refreshVersion])
```
(Dùng đúng tên biến project đang chọn trong file — kiểm tra tên thực tế; nếu là `selectedProjectId` string thì dùng nó.)

- [ ] **Step 2: Thêm section render** (đặt sau khối "Actual Cashflow" ~379)

```tsx
                <section>
                  <div className="flex items-center gap-sm mb-lg">
                    <span className="material-symbols-outlined text-secondary">calendar_month</span>
                    <h3 className="text-headline-sm text-primary">Profit theo tháng</h3>
                    <div className="ml-auto flex gap-xs">
                      <button onClick={() => setBasis('actual')} className={`px-md py-xs rounded-lg text-label-sm ${basis === 'actual' ? 'bg-secondary text-on-secondary' : 'bg-surface-container'}`}>Actual</button>
                      <button onClick={() => setBasis('projected')} className={`px-md py-xs rounded-lg text-label-sm ${basis === 'projected' ? 'bg-secondary text-on-secondary' : 'bg-surface-container'}`}>Projected</button>
                    </div>
                  </div>
                  <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
                    <div className="divide-y divide-outline-variant/10">
                      {snapshotRows.length === 0 && (
                        <div className="px-lg py-md text-body-sm text-on-surface-variant">Chưa có snapshot. Bấm Backfill để tạo.</div>
                      )}
                      {snapshotRows.map((r: any) => (
                        <div key={r.periodMonth} className="flex items-center justify-between px-lg py-md">
                          <span className="text-body-sm text-on-surface-variant">{r.periodMonth}</span>
                          <span className="text-label-md text-primary">{fmtUSD(basis === 'actual' ? r.actualCashflow : r.projectedCashflow)}</span>
                          <span className={`text-label-md font-semibold ${(basis === 'actual' ? r.actualProfit : r.projectedProfit) < 0 ? 'text-error' : 'text-primary'}`}>
                            {fmtUSD(basis === 'actual' ? r.actualProfit : r.projectedProfit)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-sm mt-md">
                    <button onClick={async () => { await fetch(`/api/projects/snapshot/backfill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: selectedProject?.id }) }); setRefreshVersion(v => v + 1) }} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md">Backfill</button>
                  </div>
                </section>
```
(Dùng đúng tên `fmtUSD`, `refreshVersion`, `setRefreshVersion`, `selectedProject` như trong file. `text-error` — nếu token khác, dùng class âm đang dùng cho card negative.)

- [ ] **Step 3: Verify typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS (build không lỗi).

- [ ] **Step 4: Manual verify (chạy app)**

Run: `npm run dev -- --port 3002`, mở `/projects`, chọn project LZ, bấm **Backfill** → bảng "Profit theo tháng" hiện các tháng; toggle Actual/Projected đổi cột Profit; card "Pending Meta" hiển thị ở khối Actual Cashflow.

- [ ] **Step 5: Commit**

```bash
git add src/app/projects/page.tsx
git commit -m "feat(cashflow): monthly profit section + backfill button on projects page"
```

---

## Deployment (sau khi merge)

- Production (VPS) chạy migration: `npx prisma migrate deploy` (KHÔNG `migrate dev`). Migration additive → an toàn.
- Chạy backfill 1 lần: `POST /api/projects/snapshot/backfill` (không body = mọi project).
- Ref: memory "VPS deploy process" — push origin main → SSH VPS chạy `deploy.sh`.

---

## Self-Review Notes

- **Spec coverage:** model + cột balance (T1) ✓; sync balance (T2,T3) ✓; refactor computeProjectCashflow không đổi số (T4,T5) ✓; pendingInvoiceCharge vào Projected (T6) ✓; snapshot helpers + tz store boundary (T7) ✓; job + upsert idempotent (T8) ✓; backfill từ project start + routes (T9) ✓; cron + instrumentation (T10) ✓; UI profit theo tháng + Pending Meta card (T11) ✓.
- **actualCashflow không đổi** khi thêm pendingInvoiceCharge: chỉ `projectedCashflow` trừ — đã tách test riêng (T6).
- **Backfill dùng data hiện tại** cho tháng cũ (point-in-time) — đã ghi rõ trong spec §4; chấp nhận.
