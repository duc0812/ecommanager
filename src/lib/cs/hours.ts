export type CsMode = 'BUSINESS' | 'AFTER_HOURS'

export const BUSINESS_TZ = 'Asia/Ho_Chi_Minh'

type HoursSettings = { businessHoursStart: number; businessHoursEnd: number; weekendIsAfterHours: boolean }

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', weekday: 'short' })
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function vnClock(now: Date): { hour: number; minute: number; weekday: number } {
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]))
  return { hour: Number(parts.hour) % 24, minute: Number(parts.minute), weekday: WEEKDAYS.indexOf(parts.weekday) }
}

export function businessMode(now: Date, s: HoursSettings): CsMode {
  const { hour, weekday } = vnClock(now)
  if (s.weekendIsAfterHours && (weekday === 0 || weekday === 6)) return 'AFTER_HOURS'
  return hour >= s.businessHoursStart && hour < s.businessHoursEnd ? 'BUSINESS' : 'AFTER_HOURS'
}

export function effectiveMode(now: Date, s: HoursSettings & { afterHoursAutoReply: boolean }): CsMode {
  return s.afterHoursAutoReply && businessMode(now, s) === 'AFTER_HOURS' ? 'AFTER_HOURS' : 'BUSINESS'
}
