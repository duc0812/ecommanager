# Revenue Goal Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken ProjectPLCard P&L section with a Revenue Goal Tracker showing current-month revenue progress against configurable daily/monthly targets.

**Architecture:** Pure frontend change — a new `RevenueGoalTracker` component in `projects/page.tsx` that fetches from the existing `/api/projects/profit-chart?period=this-month` endpoint. Targets stored in `localStorage`. No new API routes or DB changes needed.

**Tech Stack:** Next.js 'use client' React, Tailwind CSS design tokens, Vitest for unit tests, localStorage for target persistence.

---

## File Structure

| File | Action | Purpose |
|---|---|---|
| `src/app/projects/page.tsx` | Modify | Remove `ProjectPLCard`, add `RevenueGoalTracker` |
| `src/lib/goal-tracker.ts` | Create | Pure calculation functions (testable) |
| `src/lib/goal-tracker.test.ts` | Create | Unit tests for calculations |

---

### Task 1: Write and verify the calculation logic (TDD)

**Files:**
- Create: `src/lib/goal-tracker.ts`
- Create: `src/lib/goal-tracker.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Create `src/lib/goal-tracker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { calcGoalMetrics } from './goal-tracker'

describe('calcGoalMetrics', () => {
  it('calculates avgDaily and projected correctly', () => {
    const result = calcGoalMetrics({
      totalRevenue: 10000,
      daysElapsed: 10,
      daysInMonth: 31,
      monthlyTarget: 30000,
      dailyTarget: 1000,
    })
    expect(result.avgDaily).toBe(1000)
    expect(result.daysRemaining).toBe(21)
    expect(result.projected).toBe(10000 + 1000 * 21)
    expect(result.shortfall).toBe(20000)
    expect(result.neededPerDay).toBeCloseTo(20000 / 21)
    expect(result.paceOk).toBe(true)
    expect(result.monthPct).toBeCloseTo(33.33, 1)
  })

  it('marks paceOk false when avgDaily is below dailyTarget', () => {
    const result = calcGoalMetrics({
      totalRevenue: 5000,
      daysElapsed: 10,
      daysInMonth: 31,
      monthlyTarget: 30000,
      dailyTarget: 1000,
    })
    expect(result.paceOk).toBe(false)
    expect(result.avgDaily).toBe(500)
  })

  it('caps monthPct at 100 when target exceeded', () => {
    const result = calcGoalMetrics({
      totalRevenue: 35000,
      daysElapsed: 25,
      daysInMonth: 31,
      monthlyTarget: 30000,
      dailyTarget: 1000,
    })
    expect(result.monthPct).toBe(100)
    expect(result.shortfall).toBe(0)
  })

  it('handles daysElapsed=0 without dividing by zero', () => {
    const result = calcGoalMetrics({
      totalRevenue: 0,
      daysElapsed: 0,
      daysInMonth: 31,
      monthlyTarget: 30000,
      dailyTarget: 1000,
    })
    expect(result.avgDaily).toBe(0)
    expect(result.projected).toBe(0)
  })

  it('sets neededPerDay to 0 when no days remaining', () => {
    const result = calcGoalMetrics({
      totalRevenue: 10000,
      daysElapsed: 31,
      daysInMonth: 31,
      monthlyTarget: 30000,
      dailyTarget: 1000,
    })
    expect(result.daysRemaining).toBe(0)
    expect(result.neededPerDay).toBe(0)
  })
})
```

- [ ] **Step 1.2: Run tests to verify they fail**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npm test -- goal-tracker
```

Expected: FAIL — `Cannot find module './goal-tracker'`

- [ ] **Step 1.3: Implement the calculation function**

Create `src/lib/goal-tracker.ts`:

```typescript
export type GoalMetricsInput = {
  totalRevenue: number
  daysElapsed: number
  daysInMonth: number
  monthlyTarget: number
  dailyTarget: number
}

export type GoalMetrics = {
  avgDaily: number
  daysRemaining: number
  projected: number
  shortfall: number
  neededPerDay: number
  paceOk: boolean
  monthPct: number
}

export function calcGoalMetrics(input: GoalMetricsInput): GoalMetrics {
  const { totalRevenue, daysElapsed, daysInMonth, monthlyTarget, dailyTarget } = input
  const avgDaily = daysElapsed > 0 ? totalRevenue / daysElapsed : 0
  const daysRemaining = Math.max(0, daysInMonth - daysElapsed)
  const projected = totalRevenue + avgDaily * daysRemaining
  const shortfall = Math.max(0, monthlyTarget - totalRevenue)
  const neededPerDay = daysRemaining > 0 ? shortfall / daysRemaining : 0
  const paceOk = avgDaily >= dailyTarget
  const monthPct = monthlyTarget > 0 ? Math.min(100, (totalRevenue / monthlyTarget) * 100) : 0
  return { avgDaily, daysRemaining, projected, shortfall, neededPerDay, paceOk, monthPct }
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

```bash
npm test -- goal-tracker
```

Expected: All 5 tests PASS

- [ ] **Step 1.5: Commit**

```bash
git add src/lib/goal-tracker.ts src/lib/goal-tracker.test.ts
git commit -m "feat: add goal-tracker calculation utility with tests"
```

---

### Task 2: Remove ProjectPLCard from projects/page.tsx

**Files:**
- Modify: `src/app/projects/page.tsx`

- [ ] **Step 2.1: Remove the section block that renders ProjectPLCard**

In `src/app/projects/page.tsx`, find and remove this block (around lines 350–359):

```tsx
{selectedProject && (
  <section>
    <div className="flex items-center gap-sm mb-lg">
      <span className="material-symbols-outlined text-secondary">calculate</span>
      <h3 className="text-headline-sm text-primary">P&amp;L (Fulfillment + Meta + Staff)</h3>
      <span className="text-label-sm text-on-surface-variant">fulfillment profit âˆ' meta ad spend âˆ' staff cost</span>
    </div>
    <ProjectPLCard projectId={selectedProject} />
  </section>
)}
```

Replace with an empty placeholder comment for now (will fill in Task 3):

```tsx
{/* Revenue Goal Tracker — added in Task 3 */}
```

- [ ] **Step 2.2: Remove the ProjectPLCard function**

Find and delete the entire `ProjectPLCard` function (around lines 555–583):

```tsx
function ProjectPLCard({ projectId }: { projectId: string }) {
  const [pl, setPl] = useState<any>(null)
  useEffect(() => {
    setPl(null)
    fetch(`/api/projects/${projectId}/pl`).then(r => r.json()).then(setPl).catch(() => {})
  }, [projectId])
  if (!pl || pl.error) return null
  const fmtMoney = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-md">
      <div className="bg-surface-container-lowest rounded-xl p-md shadow-card border border-outline-variant/20">
        <p className="text-label-sm text-on-surface-variant">Fulfillment Profit</p>
        <p className="text-stats-lg">{fmtMoney(pl.fulfillmentProfit)}</p>
      </div>
      <div className="bg-surface-container-lowest rounded-xl p-md shadow-card border border-outline-variant/20">
        <p className="text-label-sm text-on-surface-variant">Meta Ad Spend</p>
        <p className="text-stats-lg">{fmtMoney(pl.metaAdSpend)}</p>
      </div>
      <div className="bg-surface-container-lowest rounded-xl p-md shadow-card border border-outline-variant/20">
        <p className="text-label-sm text-on-surface-variant">Staff Cost</p>
        <p className="text-stats-lg">{fmtMoney(pl.staffCost)}</p>
      </div>
      <div className="bg-surface-container-lowest rounded-xl p-md shadow-card border border-outline-variant/20">
        <p className="text-label-sm text-on-surface-variant">Net Profit</p>
        <p className={`text-stats-lg ${pl.netProfit >= 0 ? 'text-on-tertiary-container' : 'text-error'}`}>{fmtMoney(pl.netProfit)}</p>
      </div>
    </div>
  )
}
```

- [ ] **Step 2.3: Verify the page compiles without errors**

```bash
cd "C:/Users/TM PC/Desktop/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh"
npx tsc --noEmit
```

Expected: No errors related to `ProjectPLCard`.

- [ ] **Step 2.4: Commit**

```bash
git add src/app/projects/page.tsx
git commit -m "remove ProjectPLCard P&L section from project dashboard"
```

---

### Task 3: Add RevenueGoalTracker component

**Files:**
- Modify: `src/app/projects/page.tsx`

- [ ] **Step 3.1: Add the import for calcGoalMetrics**

At the top of `src/app/projects/page.tsx`, add after the existing imports:

```tsx
import { calcGoalMetrics } from '@/lib/goal-tracker'
```

- [ ] **Step 3.2: Add the RevenueGoalTracker function**

Add this function at the end of `src/app/projects/page.tsx` (before the final closing):

```tsx
function RevenueGoalTracker({ projectId }: { projectId: string }) {
  const [monthlyTarget, setMonthlyTarget] = useState<number>(() => {
    if (typeof window === 'undefined') return 30000
    return Number(localStorage.getItem('goal_monthly') || '30000')
  })
  const [dailyTarget, setDailyTarget] = useState<number>(() => {
    if (typeof window === 'undefined') return 1000
    return Number(localStorage.getItem('goal_daily') || '1000')
  })
  const [data, setData] = useState<ProfitChartData | null>(null)

  useEffect(() => {
    fetch(`/api/projects/profit-chart?projectId=${projectId}&period=this-month`)
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
  }, [projectId])

  function handleMonthlyTarget(val: string) {
    const n = Number(val)
    if (!Number.isFinite(n) || n <= 0) return
    setMonthlyTarget(n)
    localStorage.setItem('goal_monthly', String(n))
  }

  function handleDailyTarget(val: string) {
    const n = Number(val)
    if (!Number.isFinite(n) || n <= 0) return
    setDailyTarget(n)
    localStorage.setItem('goal_daily', String(n))
  }

  const now = new Date()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const totalRevenue = data?.summary.totalRevenue ?? 0
  const daysElapsed = data?.dailyData.length ?? 0

  const metrics = calcGoalMetrics({ totalRevenue, daysElapsed, daysInMonth, monthlyTarget, dailyTarget })
  const { avgDaily, daysRemaining, projected, shortfall, neededPerDay, paceOk, monthPct } = metrics

  return (
    <div className="space-y-lg">
      <div className="flex items-center gap-sm mb-lg flex-wrap">
        <span className="material-symbols-outlined text-secondary">track_changes</span>
        <h3 className="text-headline-sm text-primary">Revenue Goals</h3>
        <div className="flex items-center gap-md ml-auto flex-wrap">
          <label className="flex items-center gap-xs text-label-sm text-on-surface-variant">
            Tháng $
            <input
              type="number"
              defaultValue={monthlyTarget}
              onBlur={e => handleMonthlyTarget(e.target.value)}
              className="w-24 bg-surface-container border border-outline-variant/30 rounded-lg px-sm py-xs text-body-sm focus:ring-2 focus:ring-secondary outline-none"
            />
          </label>
          <label className="flex items-center gap-xs text-label-sm text-on-surface-variant">
            Ngày $
            <input
              type="number"
              defaultValue={dailyTarget}
              onBlur={e => handleDailyTarget(e.target.value)}
              className="w-20 bg-surface-container border border-outline-variant/30 rounded-lg px-sm py-xs text-body-sm focus:ring-2 focus:ring-secondary outline-none"
            />
          </label>
        </div>
      </div>

      {!data ? (
        <div className="flex items-center justify-center py-xl">
          <span className="material-symbols-outlined animate-spin text-secondary text-[24px]">sync</span>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-lg">
          <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg">
            <div className="flex items-center gap-sm mb-sm">
              <span className="material-symbols-outlined text-[18px] text-secondary">calendar_month</span>
              <span className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tháng này</span>
            </div>
            <p className="text-stats-lg text-primary">{fmtUSD(totalRevenue)}</p>
            <p className="text-label-sm text-on-surface-variant mt-xs">{monthPct.toFixed(1)}% · {daysElapsed} ngày đã qua</p>
            <div className="mt-md h-1 rounded-full bg-secondary/20">
              <div className="h-1 rounded-full bg-secondary transition-all duration-500" style={{ width: `${monthPct}%` }} />
            </div>
            <p className="text-label-sm text-on-surface-variant mt-xs">mục tiêu {fmtUSD(monthlyTarget)}</p>
          </div>

          <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg">
            <div className="flex items-center gap-sm mb-sm">
              <span className="material-symbols-outlined text-[18px] text-secondary">speed</span>
              <span className="text-label-sm uppercase tracking-wider text-on-surface-variant">Pace hiện tại</span>
            </div>
            <p className={`text-stats-lg ${paceOk ? 'text-on-tertiary-container' : 'text-error'}`}>
              {fmtUSD(avgDaily)}<span className="text-body-md font-normal">/ngày</span>
            </p>
            <p className={`text-label-sm mt-xs ${paceOk ? 'text-on-tertiary-container' : 'text-error'}`}>
              {paceOk ? '▲ Đang vượt target' : '▼ Dưới target'} {fmtUSD(dailyTarget)}/ngày
            </p>
          </div>

          <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg">
            <div className="flex items-center gap-sm mb-sm">
              <span className="material-symbols-outlined text-[18px] text-secondary">trending_up</span>
              <span className="text-label-sm uppercase tracking-wider text-on-surface-variant">Dự báo cuối tháng</span>
            </div>
            <p className={`text-stats-lg ${projected >= monthlyTarget ? 'text-on-tertiary-container' : 'text-primary'}`}>
              {fmtUSD(projected)}
            </p>
            <p className="text-label-sm text-on-surface-variant mt-xs">Dựa trên pace hiện tại</p>
          </div>

          <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg">
            <div className="flex items-center gap-sm mb-sm">
              <span className="material-symbols-outlined text-[18px] text-secondary">flag</span>
              <span className="text-label-sm uppercase tracking-wider text-on-surface-variant">Còn thiếu</span>
            </div>
            {shortfall <= 0 ? (
              <p className="text-stats-lg text-on-tertiary-container">Đạt target!</p>
            ) : (
              <>
                <p className="text-stats-lg text-primary">{fmtUSD(shortfall)}</p>
                <p className="text-label-sm text-on-surface-variant mt-xs">
                  Cần {fmtUSD(neededPerDay)}/ngày · {daysRemaining} ngày còn lại
                </p>
                <div className="mt-md h-1 rounded-full bg-secondary/20">
                  <div className="h-1 rounded-full bg-secondary transition-all duration-500" style={{ width: `${monthPct}%` }} />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3.3: Replace the placeholder comment with the new section**

Find in `src/app/projects/page.tsx`:

```tsx
{/* Revenue Goal Tracker — added in Task 3 */}
```

Replace with:

```tsx
{selectedProject && (
  <section>
    <RevenueGoalTracker projectId={selectedProject} />
  </section>
)}
```

- [ ] **Step 3.4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3.5: Run all tests to confirm nothing broken**

```bash
npm test
```

Expected: All tests pass including the new goal-tracker tests.

- [ ] **Step 3.6: Commit**

```bash
git add src/app/projects/page.tsx
git commit -m "feat: add RevenueGoalTracker with configurable monthly/daily targets"
```

---

### Task 4: Manual verification in browser

**Files:** None (verification only)

- [ ] **Step 4.1: Start the dev server**

```bash
npm run dev -- --port 3002
```

Open: `http://localhost:3002/projects`

- [ ] **Step 4.2: Verify the 4 cards appear correctly**

Check:
- "Tháng này" card shows current month revenue with a progress bar
- "Pace hiện tại" card shows avg daily revenue, green if above target, red if below
- "Dự báo cuối tháng" shows projected revenue
- "Còn thiếu" shows shortfall with days remaining

- [ ] **Step 4.3: Test target editing**

- Change "Tháng $" input to a very low number (e.g. 100) — "Còn thiếu" should show "Đạt target!" and go green
- Change "Tháng $" input to a very high number (e.g. 999999) — "Còn thiếu" should show a large shortfall
- Reload the page — the edited targets should persist (loaded from localStorage)

- [ ] **Step 4.4: Confirm old P&L section is gone**

Scroll through the dashboard — the old "P&L (Fulfillment + Meta + Staff)" section with $0.00 values should no longer appear anywhere.
