export type CsMode = 'BUSINESS' | 'AFTER_HOURS'

export const BUSINESS_TZ = 'Asia/Ho_Chi_Minh'

type HoursSettings = { businessHoursStart: number; businessHoursEnd: number; weekendIsAfterHours: boolean; workSaturdayAnchor?: string | null }

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', weekday: 'short' })
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_MS = 86400_000

export function vnClock(now: Date): { hour: number; minute: number; weekday: number } {
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]))
  return { hour: Number(parts.hour) % 24, minute: Number(parts.minute), weekday: WEEKDAYS.indexOf(parts.weekday) }
}

// The team works every other Saturday; the anchor is any one of those Saturdays (YYYY-MM-DD) and the rota repeats every 14 days.
function isWorkSaturday(now: Date, anchor: string | null | undefined): boolean {
  if (!anchor) return false
  const days = Math.round((Date.parse(dateFmt.format(now)) - Date.parse(anchor)) / DAY_MS)
  return ((days % 14) + 14) % 14 === 0
}

export function businessMode(now: Date, s: HoursSettings): CsMode {
  const { hour, weekday } = vnClock(now)
  const offDay = weekday === 0 || (weekday === 6 && !isWorkSaturday(now, s.workSaturdayAnchor))
  if (s.weekendIsAfterHours && offDay) return 'AFTER_HOURS'
  return hour >= s.businessHoursStart && hour < s.businessHoursEnd ? 'BUSINESS' : 'AFTER_HOURS'
}

export function effectiveMode(now: Date, s: HoursSettings & { afterHoursAutoReply: boolean }): CsMode {
  return s.afterHoursAutoReply && businessMode(now, s) === 'AFTER_HOURS' ? 'AFTER_HOURS' : 'BUSINESS'
}
