# Revenue Goal Tracker — Design Spec

**Date:** 2026-05-21
**Status:** Approved

## Summary

Replace the broken `ProjectPLCard` (P&L section) at the bottom of the Project Management Dashboard (`/projects`) with a **Revenue Goal Tracker** that shows current-month revenue progress against configurable daily and monthly targets.

## Problem

The existing P&L section shows Meta Ad Spend as $0.00 (incorrect) and provides limited management value. The user wants actionable goal-tracking metrics instead.

## Requirements

- Show current-month revenue progress vs a configurable monthly target (default $30,000)
- Show daily revenue pace vs a configurable daily target (default $1,000/day)
- Targets must be editable directly on the UI (no code changes needed)
- Always reflects the **current month**, regardless of the month filter above
- Targets persist across page reloads via `localStorage`

## Component: `RevenueGoalTracker`

### Location

`src/app/projects/page.tsx` — replaces the `ProjectPLCard` component and the `ProjectPLCard` function entirely.

### Section header

```
[icon: track_changes]  Revenue Goals
[Monthly target input: $____]  [Daily target input: $____]
```

Two small inline inputs sit in the section header row. On change, values are saved to `localStorage` under keys `goal_monthly` and `goal_daily`.

### 4 Stat Cards

Cards 1 and 4 use a custom inline layout (not `StatCard`) to accommodate the progress bar. Cards 2 and 3 reuse `StatCard` directly.

| Card | Primary value | Hint |
|---|---|---|
| **Tháng này** | `$X,XXX / $30,000` + progress bar | `XX% · N ngày đã qua` |
| **Pace hiện tại** | `$X,XXX/ngày` | Green if ≥ daily target, red if below |
| **Dự báo cuối tháng** | `$XX,XXX` | `Dựa trên pace hiện tại` |
| **Còn thiếu** | `$X,XXX` + progress bar | `Cần $Y/ngày trong N ngày còn lại` |

Progress bar: a `<div>` with `bg-secondary/20` background and an inner `<div>` with `bg-secondary` at `width: min(pct, 100)%`, height `4px`, `rounded-full`.

### Data source

Reuses the existing `/api/projects/profit-chart?projectId=<id>&period=this-month` endpoint. No new API route needed. The endpoint returns:

```typescript
{
  dailyData: Array<{ date: string; revenue: number; ... }>,
  summary: { totalRevenue: number; totalOrders: number; ... }
}
```

### Calculations (all frontend)

```
daysElapsed   = dailyData.length  (API returns one entry per calendar day from month start to today)
avgDaily      = summary.totalRevenue / max(daysElapsed, 1)
daysInMonth   = total days in current month
daysRemaining = daysInMonth - daysElapsed
projected     = summary.totalRevenue + (avgDaily × daysRemaining)
shortfall     = max(0, monthlyTarget - summary.totalRevenue)
neededPerDay  = daysRemaining > 0 ? shortfall / daysRemaining : 0
paceOk        = avgDaily >= dailyTarget
```

### State

```typescript
const [monthlyTarget, setMonthlyTarget] = useState(() =>
  Number(localStorage.getItem('goal_monthly') ?? '30000'))
const [dailyTarget, setDailyTarget] = useState(() =>
  Number(localStorage.getItem('goal_daily') ?? '1000'))
```

The component fetches profit-chart data independently from the parent's analytics data (same endpoint, different caller) so it always reflects the current month.

## What is removed

- `ProjectPLCard` component function (lines 555–583 in `projects/page.tsx`)
- The section block that renders it (lines 350–359)
- The `/api/projects/[id]/pl` route is **not** removed (may be used elsewhere), but is no longer called from the dashboard

## What is NOT changed

- All other sections (Actual Cashflow, Gross Profit, Marketing Efficiency, etc.)
- The Profit Chart component and its API
- Any API routes
- The analytics data fetching logic

## Design tokens / patterns

Follows existing conventions in `projects/page.tsx`:
- Card: `bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-lg`
- Section header: `flex items-center gap-sm mb-lg`
- Icons: `material-symbols-outlined`
- Colors: green = `text-on-tertiary-container`, red = `text-error`, neutral = `text-primary`
