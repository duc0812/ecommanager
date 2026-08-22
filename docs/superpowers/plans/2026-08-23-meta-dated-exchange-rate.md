# Meta dated exchange rate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Replace the single per-account Meta exchange rate with a global effective-dated rate schedule (entered in a dedicated Setup page); every Meta amount converts to USD using the rate effective on its own date.

**Spec:** `docs/superpowers/specs/2026-08-23-meta-dated-exchange-rate-design.md`

**Tech Stack:** Next.js 14.2, Prisma v7 + SQLite, Vitest, Tailwind tokens.

## Global Constraints
- Prisma: no `url` in `datasource db {}`. After schema change: `npx prisma migrate dev --name add_meta_exchange_rate` → `npx prisma generate` → bump `SCHEMA_VERSION` in `src/lib/db.ts` **v32 → v33**. Import client via `@/lib/db` only.
- New DB-backed GET routes → `export const dynamic = 'force-dynamic'`.
- **Preserve money semantics:** rate = VND per USD (units of source currency per 1 USD); conversion for non-USD = `amount / rate`; USD passes through unchanged. `convertMetaAmountToUsd(amount, currency, rate)` stays as-is.
- `MetaBilling.billingDate` and `DailyAdSpend.date` are both `"YYYY-MM-DD"` strings → string comparison == date comparison.
- No code comments. Dates displayed en-US. The 2 `order-profit.test.ts` failures are pre-existing — ignore. **Run the affected module's tests + full suite, not only new tests.**

---

## Task 1: Model + helpers + rate-schedule API

**Files:** `prisma/schema.prisma`, `src/lib/db.ts`, migration, `src/lib/meta-currency.ts` (+ `meta-currency.test.ts`), `src/lib/meta-exchange-rates.ts`, `src/app/api/meta/exchange-rates/route.ts`.

**Interfaces:** Produces `DatedRate`, `rateForDate`, `convertMetaAmountToUsdDated`, `sumMetaAmountsUsdDated` (`@/lib/meta-currency`); `getMetaRateSchedule`, `addMetaRate`, `deleteMetaRate` (`@/lib/meta-exchange-rates`); `GET/POST/DELETE /api/meta/exchange-rates`.

- [ ] **Step 1: Model.** Add to `prisma/schema.prisma`:
```prisma
model MetaExchangeRate {
  id            String   @id @default(cuid())
  effectiveDate String   @unique
  rate          Float
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}
```

- [ ] **Step 2: Migrate + generate + bump.** `npx prisma migrate dev --name add_meta_exchange_rate` → `npx prisma generate` → `SCHEMA_VERSION` `'v32'`→`'v33'`. Additive CREATE TABLE only. If it prompts to reset the DB, STOP → BLOCKED.

- [ ] **Step 3: Failing tests for pure helpers.** Add to `src/lib/meta-currency.test.ts` (keep existing tests):
```ts
import { rateForDate, convertMetaAmountToUsdDated, sumMetaAmountsUsdDated } from './meta-currency'

const sched = [{ effectiveDate: '2026-06-22', rate: 26000 }, { effectiveDate: '2026-07-22', rate: 25500 }]
describe('rateForDate', () => {
  it('picks the latest entry <= date', () => {
    expect(rateForDate(sched, '2026-06-22')).toBe(26000)
    expect(rateForDate(sched, '2026-07-01')).toBe(26000)
    expect(rateForDate(sched, '2026-07-22')).toBe(25500)
    expect(rateForDate(sched, '2026-08-01')).toBe(25500)
  })
  it('uses earliest rate before the first entry', () => { expect(rateForDate(sched, '2026-06-10')).toBe(26000) })
  it('returns null for an empty schedule', () => { expect(rateForDate([], '2026-06-10')).toBeNull() })
})
describe('convertMetaAmountToUsdDated', () => {
  it('USD passes through', () => { expect(convertMetaAmountToUsdDated(19.99, 'USD', '2026-07-01', sched)).toBe(19.99) })
  it('VND uses the dated rate', () => { expect(convertMetaAmountToUsdDated(255000, 'VND', '2026-07-22', sched)).toBe(10) })
  it('null when no rate', () => { expect(convertMetaAmountToUsdDated(255000, 'VND', '2026-07-01', [])).toBeNull() })
})
describe('sumMetaAmountsUsdDated', () => {
  it('sums per-row by date and counts missing', () => {
    const r = sumMetaAmountsUsdDated([
      { amount: 255000, currency: 'VND', billingDate: '2026-07-22' },
      { amount: 5, currency: 'USD', billingDate: '2026-07-22' },
    ], sched)
    expect(r.totalUsd).toBe(15)
    expect(r.missingCount).toBe(0)
  })
})
```

- [ ] **Step 4: Run → FAIL.** `npx vitest run src/lib/meta-currency.test.ts`

- [ ] **Step 5: Implement helpers.** Append to `src/lib/meta-currency.ts` (reuse the existing private `roundUsd` + `normalizeMetaCurrency` + `convertMetaAmountToUsd`):
```ts
export type DatedRate = { effectiveDate: string; rate: number }

export function rateForDate(schedule: DatedRate[], date: string): number | null {
  if (schedule.length === 0) return null
  let chosen: number | null = null
  for (const e of schedule) {
    if (e.effectiveDate <= date) chosen = e.rate
    else break
  }
  return chosen ?? schedule[0].rate
}

export function convertMetaAmountToUsdDated(
  amount: number, currency: string | null | undefined, billingDate: string, schedule: DatedRate[],
): number | null {
  if (normalizeMetaCurrency(currency) === 'USD') return convertMetaAmountToUsd(amount, currency)
  return convertMetaAmountToUsd(amount, currency, rateForDate(schedule, billingDate))
}

export function sumMetaAmountsUsdDated(
  rows: { amount: number; currency: string | null; billingDate: string }[], schedule: DatedRate[],
): { totalUsd: number; missingCount: number } {
  let totalUsd = 0, missingCount = 0
  for (const r of rows) {
    const usd = convertMetaAmountToUsdDated(r.amount, r.currency, r.billingDate, schedule)
    if (usd === null) { missingCount++; continue }
    totalUsd += usd
  }
  return { totalUsd: roundUsd(totalUsd), missingCount }
}
```
(`rateForDate` assumes `schedule` sorted ascending by `effectiveDate` — `getMetaRateSchedule` guarantees that.)

- [ ] **Step 6: Run → PASS.**

- [ ] **Step 7: DB helpers.** Append to `src/lib/meta-exchange-rates.ts`:
```ts
import type { DatedRate } from '@/lib/meta-currency'

export async function getMetaRateSchedule(): Promise<DatedRate[]> {
  const rows = await prisma.metaExchangeRate.findMany({ orderBy: { effectiveDate: 'asc' }, select: { effectiveDate: true, rate: true } })
  return rows
}

export async function addMetaRate(effectiveDate: string, rate: number): Promise<void> {
  await prisma.metaExchangeRate.upsert({ where: { effectiveDate }, create: { effectiveDate, rate }, update: { rate } })
}

export async function deleteMetaRate(id: string): Promise<void> {
  await prisma.metaExchangeRate.delete({ where: { id } })
}
```
(Keep the existing `getMetaExchangeRates`/`saveMetaExchangeRate` for now — removed in Task 3.)

- [ ] **Step 8: API CRUD.** Create `src/app/api/meta/exchange-rates/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { addMetaRate, deleteMetaRate } from '@/lib/meta-exchange-rates'

export const dynamic = 'force-dynamic'

export async function GET() {
  const rows = await prisma.metaExchangeRate.findMany({ orderBy: { effectiveDate: 'desc' } })
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  const effectiveDate = String(b.effectiveDate ?? '').trim()
  const rate = Number(b.rate)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return NextResponse.json({ error: 'effectiveDate must be YYYY-MM-DD' }, { status: 400 })
  if (!Number.isFinite(rate) || rate <= 0) return NextResponse.json({ error: 'rate must be a positive number' }, { status: 400 })
  await addMetaRate(effectiveDate, rate)
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await deleteMetaRate(String(b.id))
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 9: tsc + tests + build + commit.** `npx tsc --noEmit` (0); `npx vitest run src/lib/meta-currency.test.ts` (pass); `npm run build` (success, `/api/meta/exchange-rates` in list).
```bash
git add prisma/schema.prisma prisma/migrations src/lib/db.ts src/lib/meta-currency.ts src/lib/meta-currency.test.ts src/lib/meta-exchange-rates.ts src/app/api/meta/exchange-rates/route.ts
git commit -m "feat(meta): dated exchange-rate model + helpers + /api/meta/exchange-rates (v33)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Rewire reporting call-sites to dated conversion

**Files:** `src/lib/repos/reports.ts`, `src/app/api/projects/profit-chart/route.ts`, `src/app/api/projects/analytics/route.ts`, `src/app/api/overview/route.ts`, `src/app/api/meta/db-billing/route.ts`.

**Interfaces:** Consumes `getMetaRateSchedule`, `rateForDate`, `convertMetaAmountToUsdDated`, `sumMetaAmountsUsdDated` (Task 1).

**READ each actual file first.** For EACH file, replace the flat per-account rate with the dated schedule:
- Replace `const exchangeRates = await getMetaExchangeRates(<ids>)` with `const schedule = await getMetaRateSchedule()`.
- Replace `sumMetaAmountsUsd(rows, exchangeRates)` → `sumMetaAmountsUsdDated(rows, schedule)` (rows must carry the date: `billingDate` for MetaBilling rows, or map `DailyAdSpend.date` → `billingDate`). Note the return field: dated version returns `missingCount` (number), not `missingAccountIds`; adjust any usage.
- Replace per-row `convertMetaAmountToUsd(amount, currency, exchangeRates.get(id))` → `convertMetaAmountToUsdDated(amount, currency, <dateStr>, schedule)` where `<dateStr>` is that row's `billingDate` (MetaBilling) or `date` (DailyAdSpend).
- Remove the now-unused `getMetaExchangeRates` import.

Known sites (verify with `grep -rn "getMetaExchangeRates\|sumMetaAmountsUsd\b" src/app src/lib/repos`):
- [ ] **`reports.ts`** (~L175-176): `combinedProjectPL` — billings have `billingDate`. Use `sumMetaAmountsUsdDated(billings, schedule)`.
- [ ] **`profit-chart/route.ts`** (~L116,126): per-row convert — use the billing row's `billingDate`.
- [ ] **`analytics/route.ts`** (~L203,206,249): sum (billings) + per-row (L249 is `DailyAdSpend` → use its `date`).
- [ ] **`overview/route.ts`** (~L103,111,119,160,217): `metaBillings` sum+per-row (use `billingDate`); `periodAdSpends`/DailyAdSpend sum (L160) + per-row (L217) → use `date` (map to `billingDate` for the dated sum).
- [ ] **Step: tsc + build + full suite.** `npx tsc --noEmit` (0); `npm run build` (success); `npx vitest run` (only the 2 pre-existing order-profit fails). Manually sanity-check one report response shape is unchanged (numbers still compute; USD unchanged).
- [ ] **Step: commit.**
```bash
git add src/lib/repos/reports.ts src/app/api/projects/profit-chart/route.ts src/app/api/projects/analytics/route.ts src/app/api/overview/route.ts src/app/api/meta/db-billing/route.ts
git commit -m "refactor(meta): reports/overview/projects convert Meta spend with dated rates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
(`db-billing/route.ts` ~L47,137: per-row convert by `billingDate`; include it in this task.)

---

## Task 3: Dedicated Setup page + remove per-account rate

**Files:** Create `src/app/setup/meta-rates/page.tsx`; modify `src/components/Sidebar.tsx`, `src/app/setup/meta/page.tsx`, `src/app/api/meta/accounts/route.ts`.

- [ ] **Step 1: Setup page.** Create `src/app/setup/meta-rates/page.tsx`:
```tsx
'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'

type Row = { id: string; effectiveDate: string; rate: number }
function fmt(v: string) { return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v)) }

export default function MetaRatesPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [date, setDate] = useState('')
  const [rate, setRate] = useState('')
  async function load() { setRows(await fetch('/api/meta/exchange-rates', { cache: 'no-store' }).then(r => r.json())) }
  useEffect(() => { load() }, [])
  async function add() {
    if (!date || !rate) return
    await fetch('/api/meta/exchange-rates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ effectiveDate: date, rate: Number(rate) }) })
    setDate(''); setRate(''); load()
  }
  async function remove(id: string) {
    await fetch('/api/meta/exchange-rates', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    load()
  }
  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <header className="mb-lg">
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Setup</p>
            <h2 className="text-display-md font-bold text-primary">Meta Exchange Rate</h2>
          </header>
          <section className="mb-xl rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg shadow-card">
            <div className="grid grid-cols-1 gap-md md:grid-cols-[1fr_1fr_auto]">
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                className="rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
              <input value={rate} onChange={e => setRate(e.target.value)} inputMode="decimal" placeholder="VND per USD, e.g. 25500"
                className="rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
              <button onClick={add} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Add rate</button>
            </div>
            <p className="mt-xs text-body-sm text-on-surface-variant">Applies to non-USD (VND) accounts. A billing uses the rate effective on its date; dates before the earliest entry use the earliest rate.</p>
          </section>
          <ul className="space-y-sm">
            {rows.map(r => (
              <li key={r.id} className="flex items-center justify-between rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
                <span className="text-label-md text-primary">{fmt(r.effectiveDate)} · <span className="text-on-surface-variant">{r.rate.toLocaleString('en-US')} VND/USD</span></span>
                <button onClick={() => remove(r.id)} className="text-error text-label-sm hover:underline">Remove</button>
              </li>
            ))}
            {rows.length === 0 && <p className="text-body-md text-on-surface-variant">No rates yet.</p>}
          </ul>
        </main>
      </div>
    </RoleGate>
  )
}
```

- [ ] **Step 2: Sidebar nav.** In `src/components/Sidebar.tsx`, in the Setup group, add a child entry: `{ type: 'child', href: '/setup/meta-rates', icon: 'currency_exchange', label: 'Meta Exchange Rate' }` (place near the `/setup/meta` entry). If a `FeaturePermission` gate applies, reuse `setup_meta`'s permission for the path (the middleware/roles `FEATURE_PATHS` for `setup_meta` uses `/setup/meta`; `/setup/meta-rates` starts with `/setup/meta` so it inherits — confirm `visibleFor` returns true for admins).

- [ ] **Step 3: Remove per-account rate from account setup.** In `src/app/setup/meta/page.tsx`, remove the exchange-rate input/column per account (and any save of it). In `src/app/api/meta/accounts/route.ts`, remove `getMetaExchangeRates`/`saveMetaExchangeRate` usage (the per-account rate is no longer used for conversion). Keep the rest of account CRUD intact. Add a small note/link on the page pointing to Setup → Meta Exchange Rate.

- [ ] **Step 4: tsc + build + commit.** `npx tsc --noEmit` (0); `npm run build` (success; `/setup/meta-rates` in route list).
```bash
git add src/app/setup/meta-rates/page.tsx src/components/Sidebar.tsx src/app/setup/meta/page.tsx src/app/api/meta/accounts/route.ts
git commit -m "feat(meta): dedicated Meta Exchange Rate setup page; drop per-account rate field

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes
- Money semantics preserved (`convertMetaAmountToUsd` unchanged; dated wrappers reuse it). USD passes through. Rewire swaps rate SOURCE (flat map → dated schedule by row date), not the math.
- `rateForDate` before-first → earliest (per decision); empty → null (missing). `sumMetaAmountsUsdDated` returns `missingCount` — Task 2 must adjust any `missingAccountIds` usage.
- Additive migration (v33). Seed from existing per-account VND rate is a DEPLOY step (not in code) so historical reports don't change.
- Task 2 is the money-critical one → full suite + build + manual sanity gate; final opus review.
