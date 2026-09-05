// ParcelPanel (CWILL) tracking API v2 client — the store's real carrier status,
// which is more accurate than Shopify's fulfillment displayStatus.
// Docs: https://docs.parcelpanel.com/shopify/api-webhook/api-v2/

const BASE = 'https://open.parcelwill.com'

export type PPCheckpoint = {
  checkpoint_time?: string | null
  detail?: string | null
  status?: string | null
  status_label?: string | null
}

export type PPShipment = {
  status?: string | null
  status_label?: string | null
  substatus?: string | null
  tracking_number?: string | null
  carrier?: { name?: string | null; code?: string | null } | null
  last_mile?: { carrier_name?: string | null; carrier_code?: string | null; tracking_number?: string | null } | null
  checkpoints?: PPCheckpoint[] | null
  estimated_delivery_date?: string | null
  order_date?: string | null
  fulfillment_date?: string | null
  pickup_date?: string | null
  delivery_date?: string | null
  transit_time?: number | null
}

// ParcelPanel's own timing fields (its Analytics is built on these), persisted per
// Shipment as ppTimingJson. Dates are raw PP strings (mixed TZ / TZ-less); transitTime
// is PP's computed pickup→delivery days.
export type PpTiming = {
  orderDate: string | null
  fulfillmentDate: string | null
  pickupDate: string | null
  deliveryDate: string | null
  transitTime: number | null
}

export async function fetchParcelPanelOrderTracking(apiKey: string, orderNumber: string): Promise<PPShipment[]> {
  const url = `${BASE}/api/v2/tracking/order?order_number=${encodeURIComponent(orderNumber)}`
  const res = await fetch(url, { headers: { 'x-parcelpanel-api-key': apiKey } })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`ParcelPanel ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json().catch(() => null)
  return (json?.order?.shipments as PPShipment[]) ?? []
}

export type MappedShipment = {
  status: string
  detectedCarrier: string | null
  detectedCarrierCode: string | null
  lastMileCarrier: string | null
  lastMileTrackingNumber: string | null
  checkpointsJson: string | null
  ppTimingJson: string | null
  lastCheckpointAt: Date | null
}

export function ppTimingOf(pp: PPShipment): PpTiming {
  return {
    orderDate: pp.order_date ?? null,
    fulfillmentDate: pp.fulfillment_date ?? null,
    pickupDate: pp.pickup_date ?? null,
    deliveryDate: pp.delivery_date ?? null,
    transitTime: typeof pp.transit_time === 'number' ? pp.transit_time : null,
  }
}

export function mapParcelPanelShipment(pp: PPShipment): MappedShipment {
  const checkpoints = (pp.checkpoints ?? []).map(c => ({
    time: c.checkpoint_time ?? null,
    desc: c.detail ?? '',
    status: c.status ?? null,
  }))
  const latest = checkpoints.find(c => !!c.time)?.time ?? null
  const timing = ppTimingOf(pp)
  const hasTiming = Object.values(timing).some(v => v != null)
  return {
    status: (pp.status ?? 'PENDING').toUpperCase(),
    detectedCarrier: pp.carrier?.name ?? null,
    detectedCarrierCode: pp.carrier?.code ?? null,
    lastMileCarrier: pp.last_mile?.carrier_name ?? null,
    lastMileTrackingNumber: pp.last_mile?.tracking_number ?? null,
    checkpointsJson: checkpoints.length > 0 ? JSON.stringify(checkpoints) : null,
    ppTimingJson: hasTiming ? JSON.stringify(timing) : null,
    lastCheckpointAt: latest ? new Date(latest) : null,
  }
}
