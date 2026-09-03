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
