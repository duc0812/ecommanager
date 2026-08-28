import { prisma } from '@/lib/db'
import { fetchOrderFulfillmentsPage, type ShopifyOrderFulfillments } from '@/lib/shopify-orders'
import { buildOrderShipments } from '@/lib/tracking/build-shipments'
import { loadOrdersForShipmentSync, upsertOrderShipments } from '@/lib/repos/shipments'

export type TrackingSyncResult = {
  days: number
  since: string
  ordersProcessed: number
  shipmentCount: number
  withTracking: number
  withoutTracking: number
  fulfillmentStatusUpdated: number
  errors: string[]
}

export function clampTrackingDays(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 30
  return Math.min(120, Math.max(1, Math.floor(n)))
}

// Core tracking sync used by both the API route and the daily cron.
// Pulls Shopify fulfillment tracking into the Shipment table AND refreshes the
// order's fulfillmentStatus (which order sync leaves stale for older orders).
export async function syncStoreTracking(params: {
  shop: string
  accessToken: string
  storeId: string
  days?: number
}): Promise<TrackingSyncResult> {
  const days = clampTrackingDays(params.days ?? 30)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const sinceIso = since.toISOString().split('T')[0]

  // 1) Pull fulfillment tracking + order-level status from Shopify.
  const byOrderId = new Map<string, ShopifyOrderFulfillments>()
  const errors: string[] = []
  let cursor: string | null = null
  do {
    let page
    try {
      page = await fetchOrderFulfillmentsPage(params.shop, params.accessToken, cursor, sinceIso)
    } catch (e: any) {
      errors.push(e.message)
      break
    }
    for (const o of page.orders) byOrderId.set(o.id, o)
    cursor = page.hasNextPage ? page.endCursor : null
  } while (cursor)

  // 2) Join with DB orders and upsert shipments + refresh fulfillment status.
  const orders = await loadOrdersForShipmentSync(params.storeId, since)
  let ordersProcessed = 0
  let shipmentCount = 0
  let withTracking = 0
  let fulfillmentStatusUpdated = 0
  for (const o of orders) {
    const shopifyData = byOrderId.get(o.id)
    const rows = buildOrderShipments({
      shopifyOrderNumber: o.shopifyOrderNumber,
      lines: o.lines,
      fulfillments: shopifyData?.fulfillments ?? [],
    })
    if (rows.length > 0) {
      await upsertOrderShipments(o.id, o.projectId, rows)
      ordersProcessed++
      shipmentCount += rows.length
      withTracking += rows.filter(r => r.trackingNumber).length
    }
    // Refresh the order's fulfillment status from Shopify's authoritative value.
    const fresh = shopifyData?.fulfillmentStatus ?? null
    if (fresh && fresh !== o.fulfillmentStatus) {
      await prisma.order.update({ where: { id: o.id }, data: { fulfillmentStatus: fresh } })
      fulfillmentStatusUpdated++
    }
  }

  return {
    days,
    since: sinceIso,
    ordersProcessed,
    shipmentCount,
    withTracking,
    withoutTracking: shipmentCount - withTracking,
    fulfillmentStatusUpdated,
    errors,
  }
}
