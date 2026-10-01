import { zonedDayStartUtc, addDays, dateKeyInZone } from '@/lib/cashflow-dates'

export function monthEndDateKey(periodMonth: string, _timeZone: string): string {
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

export function monthlyProfit(current: number | null, prev: number | null): number | null {
  if (current === null) return null
  return prev === null ? current : Math.round((current - prev) * 100) / 100
}

// The month is closed on the 1st of the following month, and that close date is how the owner
// refers to a snapshot ("snapshot 1/9" is the August row).
export function snapshotCloseDateKey(periodMonth: string): string {
  const [y, m] = periodMonth.split('-').map(Number)
  const firstOfNext = new Date(Date.UTC(y, m, 1))
  return firstOfNext.toISOString().slice(0, 10)
}

// A hand-entered figure wins over the computed one. Months that closed before any balance was
// recorded compute too low, so the owner corrects them; a backfill rewrites the computed column
// and must leave the correction alone.
export function effectiveExpectedCashflow(
  row: { expectedCashflow: number | null; expectedCashflowManual: number | null },
): number | null {
  return row.expectedCashflowManual ?? row.expectedCashflow
}
