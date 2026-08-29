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
export async function upsertOrderShipments(orderId: string, projectId: string, rows: BuiltShipment[]) {
  for (const r of rows) {
    const data = {
      shopifyLineId: r.shopifyLineId,
      sku: r.sku,
      productTitle: r.productTitle,
      shopifyFulfillmentId: r.shopifyFulfillmentId,
      trackingNumber: r.trackingNumber,
      carrier: r.carrier,
      trackingUrl: r.trackingUrl,
      supplierId: r.supplierId,
      status: r.status,
    }
    await prisma.shipment.upsert({
      where: { orderId_lineKey: { orderId, lineKey: r.lineKey } },
      create: { orderId, projectId, lineKey: r.lineKey, ...data },
      update: data,
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
