import { detectLastMileCarrier } from '@/lib/tracking/lastmile-carrier'

export type ShipmentTrackingSource = {
  lineKey: string
  trackingNumber: string | null
  carrier: string | null
  trackingUrl: string | null
  detectedCarrier: string | null
  lastMileCarrier: string | null
  lastMileTrackingNumber: string | null
  status: string | null
}

export type OrderTracking = {
  number: string
  carrier: string | null
  url: string
  lineKeys: string[]
  lastMile: boolean
  status: string | null
}

const parcelsappUrl = (n: string) => `https://parcelsapp.com/en/tracking/${encodeURIComponent(n)}`
const norm = (n: string) => n.trim().toUpperCase()
const usable = (carrier: string | null | undefined) => {
  const c = carrier?.trim()
  return c && c.toLowerCase() !== 'other' ? c : null
}

// Every tracking number an order's shipments hold, one entry per distinct number: the Shopify number of each
// line plus the last-mile number when it differs (Bondre/Go3D first leg vs US last mile). Lines that share a
// parcel collapse into one entry that lists their line keys.
export function orderTrackingNumbers(shipments: ShipmentTrackingSource[]): OrderTracking[] {
  const byNumber = new Map<string, OrderTracking>()
  const add = (raw: string, entry: Omit<OrderTracking, 'number' | 'lineKeys'>, lineKey: string) => {
    const key = norm(raw)
    const found = byNumber.get(key)
    if (found) {
      if (!found.lineKeys.includes(lineKey)) found.lineKeys.push(lineKey)
      if (!found.carrier && entry.carrier) found.carrier = entry.carrier
      return
    }
    byNumber.set(key, { number: raw.trim(), lineKeys: [lineKey], ...entry })
  }
  const sorted = [...shipments].sort((a, b) => a.lineKey.localeCompare(b.lineKey, undefined, { numeric: true }))
  for (const s of sorted) {
    const main = s.trackingNumber?.trim()
    if (main) {
      const detected = detectLastMileCarrier(main)
      add(main, {
        carrier: usable(s.carrier) ?? usable(s.detectedCarrier) ?? usable(detected.company),
        url: s.trackingUrl?.trim() || detected.url || parcelsappUrl(main),
        lastMile: false,
        status: s.status,
      }, s.lineKey)
    }
    const last = s.lastMileTrackingNumber?.trim()
    if (last && (!main || norm(last) !== norm(main))) {
      const detected = detectLastMileCarrier(last)
      add(last, {
        carrier: usable(s.lastMileCarrier) ?? usable(detected.company),
        url: detected.url || parcelsappUrl(last),
        lastMile: true,
        status: s.status,
      }, s.lineKey)
    }
  }
  return Array.from(byNumber.values())
}
