export function dateOnly(date: Date) {
  return date.toISOString().split('T')[0]
}

export function dateKeyInZone(date: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function zonedDayStartUtc(dateKey: string, timeZone: string) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const naiveUtc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0))
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(naiveUtc).map(p => [p.type, p.value]))
  const zoneAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '00' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return new Date(naiveUtc.getTime() - (zoneAsUtc - naiveUtc.getTime()))
}

export function addDays(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0, 0)).toISOString().split('T')[0]
}

export type PeriodRange = { from: Date; to: Date; fromKey: string; toKey: string }

export function getPeriodRange(period: string, timeZone: string, from?: string | null, to?: string | null): PeriodRange {
  const todayStr = dateKeyInZone(new Date(), timeZone)
  const buildRange = (fromKey: string, toKey: string): PeriodRange => ({
    from: zonedDayStartUtc(fromKey, timeZone),
    to: new Date(zonedDayStartUtc(addDays(toKey, 1), timeZone).getTime() - 1),
    fromKey,
    toKey,
  })

  if (period === 'custom' && from && to) return buildRange(from, to)
  if (period === 'today') return buildRange(todayStr, todayStr)
  if (period === 'this-week') {
    const dow = new Date(`${todayStr}T12:00:00.000Z`).getUTCDay()
    return buildRange(addDays(todayStr, -((dow + 6) % 7)), todayStr)
  }
  if (period === 'last-7') return buildRange(addDays(todayStr, -6), todayStr)
  if (period === 'last-30') return buildRange(addDays(todayStr, -29), todayStr)
  return buildRange(`${todayStr.slice(0, 7)}-01`, todayStr)
}
