export const AD_SCAN_CAP = 200
const DAY = 24 * 60 * 60 * 1000

export function isNewAd(startDate: Date | null, now: Date = new Date(), windowDays = 7): boolean {
  if (!startDate) return false
  return startDate.getTime() >= now.getTime() - windowDays * DAY
}

export function activeDays(startDate: Date | null, endDate: Date | null, now: Date = new Date()): number {
  if (!startDate) return 0
  const end = endDate ?? now
  return Math.max(0, Math.floor((end.getTime() - startDate.getTime()) / DAY))
}

export function isLongRunning(
  a: { isActive: boolean; startDate: Date | null; endDate: Date | null }, now: Date = new Date(), minDays = 21,
): boolean {
  return a.isActive && activeDays(a.startDate, a.endDate, now) >= minDays
}

export function isScaling(obs: { collationCount: number | null; observedAt: Date }[]): boolean {
  if (obs.length < 2) return false
  const sorted = [...obs].sort((x, y) => x.observedAt.getTime() - y.observedAt.getTime())
  const first = sorted[0].collationCount
  const last = sorted[sorted.length - 1].collationCount
  if (first === null || last === null) return false
  return last > first
}

export function isStopped(obs: { isActive: boolean; observedAt: Date }[]): boolean {
  if (obs.length < 2) return false
  const sorted = [...obs].sort((x, y) => x.observedAt.getTime() - y.observedAt.getTime())
  return sorted.some(o => o.isActive) && sorted[sorted.length - 1].isActive === false
}
