import { prisma } from '@/lib/db'
import type { BuiltShipment } from '@/lib/tracking/build-shipments'

// Orders (with the line fields buildOrderShipments needs) for one store since a date.
export async function loadOrdersForShipmentSync(storeId: string, since: Date) {
  return prisma.order.findMany({
    where: { storeId, placedAt: { gte: since } },
    select: {
      id: true,
      projectId: true,
      shopifyOrderNumber: true,
      fulfillmentStatus: true,
      lines: {
        orderBy: { linePosition: 'asc' },
        select: {
          shopifyLineId: true,
          sku: true,
          productTitle: true,
          shopifyProductType: true,
          linePosition: true,
          resolvedSupplierId: true,
        },
      },
    },
  })
}

// Idempotent upsert by (orderId, lineKey) so re-syncs refresh tracking without duplicating rows.
// Line keys count product lines only (lineKeysOf), so a row keyed when add-ons still counted can name a key the order no
// longer has. Auto Fulfilled maps a sheet row to a Shopify line through that key, so such a row goes, unless it carries a
// tracking number or a fulfilment: that one is kept, and said once, for a person to check.
export async function upsertOrderShipments(orderId: string, projectId: string, rows: BuiltShipment[]) {
  const existing = await prisma.shipment.findMany({
    where: { orderId },
    select: { id: true, lineKey: true, shopifyFulfillmentId: true, trackingNumber: true },
  })
  const keys = new Set(rows.map(r => r.lineKey))
  const stale = existing.filter(e => !keys.has(e.lineKey))
  const staleUntracked = stale.filter(e => !e.trackingNumber && !e.shopifyFulfillmentId)
  if (staleUntracked.length > 0) await prisma.shipment.deleteMany({ where: { id: { in: staleUntracked.map(e => e.id) } } })
  const staleTracked = stale.filter(e => e.trackingNumber || e.shopifyFulfillmentId)
  if (staleTracked.length > 0) {
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { shopifyOrderNumber: true } })
    console.warn(`[shipments] ${order?.shopifyOrderNumber ?? orderId}: kept shipment rows whose key is no longer a line key of the order, they carry tracking or a fulfilment: ${staleTracked.map(e => e.lineKey).join(', ')}`)
  }
  const supplierTracked = new Set(existing.filter(e => !e.shopifyFulfillmentId && e.trackingNumber).map(e => e.lineKey))
  for (const r of rows) {
    // A tracking number the supplier pushed (PGprints webhook) has no Shopify fulfillment behind it yet;
    // it must survive re-syncs until Shopify reports its own fulfillment for the line.
    if (!r.shopifyFulfillmentId && supplierTracked.has(r.lineKey)) {
      await prisma.shipment.update({
        where: { orderId_lineKey: { orderId, lineKey: r.lineKey } },
        data: { shopifyLineId: r.shopifyLineId, sku: r.sku, productTitle: r.productTitle },
      })
      continue
    }
    const data = {
      shopifyLineId: r.shopifyLineId,
      sku: r.sku,
      productTitle: r.productTitle,
      shopifyFulfillmentId: r.shopifyFulfillmentId,
      trackingNumber: r.trackingNumber,
      carrier: r.carrier,
      trackingUrl: r.trackingUrl,
      supplierId: r.supplierId,
    }
    await prisma.shipment.upsert({
      where: { orderId_lineKey: { orderId, lineKey: r.lineKey } },
      create: { orderId, projectId, lineKey: r.lineKey, status: r.status, ...data },
      update: data,
    })
    // Shopify's coarse fulfillment status must not clobber the finer status a
    // tracking crawl (ParcelPanel) already wrote for this shipment.
    await prisma.shipment.updateMany({
      where: {
        orderId,
        lineKey: r.lineKey,
        OR: [{ crawlSource: null }, { crawlSource: { not: 'parcelpanel' } }],
      },
      data: { status: r.status },
    })
  }
}

export type ShipmentFilter = {
  projectId?: string
  supplierId?: string
  search?: string          // matches lineKey or trackingNumber
  hasTracking?: boolean     // true = only rows with a tracking number, false = only without
}

export async function listShipments(filter: ShipmentFilter) {
  const where: any = {}
  const and: any[] = []
  if (filter.projectId) where.projectId = filter.projectId
  if (filter.supplierId) where.supplierId = filter.supplierId
  if (filter.hasTracking === true) where.trackingNumber = { not: null }
  if (filter.hasTracking === false) where.trackingNumber = null
  if (filter.search) {
    and.push({
      OR: [
        { lineKey: { contains: filter.search } },
        { trackingNumber: { contains: filter.search } },
      ],
    })
  }
  if (and.length > 0) where.AND = and

  const shipments = await prisma.shipment.findMany({
    where,
    orderBy: [{ order: { placedAt: 'desc' } }, { lineKey: 'asc' }],
    include: {
      supplier: { select: { id: true, name: true } },
      order: {
        select: {
          id: true,
          shopifyOrderNumber: true,
          placedAt: true,
          shopTimezone: true,
          project: { select: { id: true, name: true } },
        },
      },
    },
  })

  return shipments
}
