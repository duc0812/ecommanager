export const US_EASTERN = 'America/New_York' as const
export const US_PACIFIC = 'America/Los_Angeles' as const
export const VN_ZONE = 'Asia/Ho_Chi_Minh' as const

export type UsZone = typeof US_EASTERN | typeof US_PACIFIC

function getZoneOffsetMs(zone: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const parts = Object.fromEntries(dtf.formatToParts(instant).map(p => [p.type, p.value]))
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour === '24' ? '00' : parts.hour),
    Number(parts.minute), Number(parts.second),
  )
  return asUtc - instant.getTime()
}

export function dayBoundaryUS(isoDate: string, zone: UsZone): { startUtc: Date; endUtc: Date } {
  const [y, m, d] = isoDate.split('-').map(Number)
  const naive = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0))
  const offsetMs = getZoneOffsetMs(zone, naive)
  const startUtc = new Date(naive.getTime() - offsetMs)
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000 - 1)
  return { startUtc, endUtc }
}

function formatInZone(d: Date, zone: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const parts = Object.fromEntries(dtf.formatToParts(d).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`
}

export function formatBothZones(d: Date): { vn: string; usEastern: string; usPacific: string } {
  return {
    vn: formatInZone(d, VN_ZONE),
    usEastern: formatInZone(d, US_EASTERN),
    usPacific: formatInZone(d, US_PACIFIC),
  }
}
