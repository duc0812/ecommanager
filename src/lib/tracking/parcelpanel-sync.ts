import { prisma } from '@/lib/db'
import { fetchParcelPanelOrderTracking, mapParcelPanelShipment } from './parcelpanel'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export type ParcelPanelSyncResult = {
  ordersChecked: number
  shipmentsUpdated: number
  delivered: number
  errors: string[]
}

// Pull real carrier status from ParcelPanel for shipments that aren't delivered yet
// and write it onto our Shipment rows (status, carrier, last-mile, checkpoints).
export async function syncParcelPanelTracking(params: {
  apiKey: string
  storeId?: string
  includeDelivered?: boolean   // backfill: also re-fetch DELIVERED shipments (normally skipped)
  sinceDays?: number           // backfill: limit to orders placed within N days
  onProgress?: (done: number, total: number) => void
}): Promise<ParcelPanelSyncResult> {
  const errors: string[] = []
  const orderWhere: any = {}
  if (params.storeId) orderWhere.storeId = params.storeId
  if (params.sinceDays) orderWhere.placedAt = { gte: new Date(Date.now() - params.sinceDays * 86_400_000) }
  const where: any = { trackingNumber: { not: null } }
  if (!params.includeDelivered) where.status = { not: 'DELIVERED' }
  if (Object.keys(orderWhere).length > 0) where.order = orderWhere
  const shipments = await prisma.shipment.findMany({
    where,
    select: { id: true, trackingNumber: true, orderId: true, order: { select: { shopifyOrderNumber: true } } },
  })

  // One API call per order returns all of that order's shipments.
  type Row = (typeof shipments)[number]
  const byOrder = new Map<string, { orderNumber: string; rows: Row[] }>()
  for (const s of shipments) {
    const on = s.order?.shopifyOrderNumber
    if (!on) continue
    const g = byOrder.get(s.orderId) ?? { orderNumber: on, rows: [] }
    g.rows.push(s)
    byOrder.set(s.orderId, g)
  }

  const entries = Array.from(byOrder.values())
  let shipmentsUpdated = 0
  let delivered = 0
  let done = 0
  for (const { orderNumber, rows } of entries) {
    try {
      const pp = await fetchParcelPanelOrderTracking(params.apiKey, orderNumber)
      const ppByTn = new Map<string, (typeof pp)[number]>()
      for (const p of pp) if (p.tracking_number) ppByTn.set(p.tracking_number, p)
      for (const row of rows) {
        const match = (row.trackingNumber ? ppByTn.get(row.trackingNumber) : undefined)
          ?? (pp.length === 1 ? pp[0] : undefined)
        if (!match) continue
        const m = mapParcelPanelShipment(match)
        await prisma.shipment.update({
          where: { id: row.id },
          data: {
            status: m.status,
            detectedCarrier: m.detectedCarrier,
            detectedCarrierCode: m.detectedCarrierCode,
            lastMileCarrier: m.lastMileCarrier,
            lastMileTrackingNumber: m.lastMileTrackingNumber,
            checkpointsJson: m.checkpointsJson,
            ppTimingJson: m.ppTimingJson,
            lastCheckpointAt: m.lastCheckpointAt,
            crawlSource: 'parcelpanel',
            crawlError: null,
            crawledAt: new Date(),
          },
        })
        shipmentsUpdated++
        if (m.status === 'DELIVERED') delivered++
      }
    } catch (e: any) {
      errors.push(`${orderNumber}: ${e?.message ?? 'failed'}`)
    }
    done++
    params.onProgress?.(done, entries.length)
    await sleep(600) // ~100 orders/min, under ParcelPanel's 120/min limit
  }

  return { ordersChecked: entries.length, shipmentsUpdated, delivered, errors: errors.slice(0, 20) }
}
