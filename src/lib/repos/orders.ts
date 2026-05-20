import { prisma } from '@/lib/db'
import { PIPELINE_STATUSES, type PipelineStatus } from '@/lib/pipeline-status'

export type OrderFilter = {
  projectId?: string
  dateFrom?: Date
  dateTo?: Date
  supplierId?: string
  pipelineStatus?: string
  search?: string  // filter by orderNumber / customerName / customerEmail
  limit?: number
}

function buildWhere(f: OrderFilter) {
  const where: any = {}
  if (f.projectId) where.projectId = f.projectId
  if (f.supplierId) where.defaultSupplierId = f.supplierId
  if (f.pipelineStatus) where.pipelineStatus = f.pipelineStatus
  if (f.dateFrom || f.dateTo) {
    where.placedAt = {}
    if (f.dateFrom) where.placedAt.gte = f.dateFrom
    if (f.dateTo) where.placedAt.lte = f.dateTo
  }
  if (f.search) {
    where.OR = [
      { shopifyOrderNumber: { contains: f.search } },
      { customerName: { contains: f.search } },
      { customerEmail: { contains: f.search } },
    ]
  }
  return where
}

export async function listOrdersWithLines(filter: OrderFilter) {
  return prisma.order.findMany({
    where: buildWhere(filter),
    orderBy: { placedAt: 'desc' },
    take: filter.limit ?? 500,
    include: {
      lines: true,
      store: { select: { id: true, shop: true, ianaTimezone: true } },
      defaultSupplier: { select: { id: true, name: true, code: true, firstItemShipFee: true, additionalItemShipFee: true } },
    },
  })
}

export type UpsertOrderInput = {
  id: string
  projectId: string
  storeId: string
  shopifyOrderNumber: string
  customerEmail: string | null
  customerName: string | null
  shippingCountry: string | null
  shippingState: string | null
  financialStatus: string
  fulfillmentStatus: string | null
  currency: string
  grossAmount: number
  subtotalAmount?: number
  shippingAmount?: number
  taxAmount?: number
  expectedPayout: number
  totalFees: number
  refundedAmount: number
  defaultSupplierId: string | null
  placedAt: Date
  shopTimezone?: string | null
  pipelineStatus?: PipelineStatus
  shippingZone?: string | null
  shippingName?: string | null
  shippingAddress1?: string | null
  shippingAddress2?: string | null
  shippingCity?: string | null
  shippingZip?: string | null
  shippingPhone?: string | null
  orderType?: string
  trelloCardId?: string | null
  trelloCardUrl?: string | null
  lines: Array<{
    shopifyLineId: string
    sku: string | null
    resolvedSupplierSku?: string | null
    variantTitle: string | null
    productTitle: string
    qty: number
    unitPrice: number
    resolvedSupplierId: string | null
    resolvedBaseCost: number | null
    resolvedShipFirst?: number | null
    resolvedShipAdditional?: number | null
    resolvedImportTax?: number | null
    shopifyVariantId?: string | null
    variantOptions?: string | null
  }>
}

export async function upsertOrderWithLines(input: UpsertOrderInput) {
  const now = new Date()

  // Preserve cost snapshots for lines that were already priced — re-sync must not overwrite
  // old costs when supplier prices change (only new orders get fresh prices)
  const existingLines = await prisma.orderLine.findMany({
    where: { orderId: input.id, costSnapshotAt: { not: null } },
    select: { shopifyLineId: true, resolvedBaseCost: true, costSnapshotAt: true, resolvedShipFirst: true, resolvedShipAdditional: true, resolvedImportTax: true },
  })
  const snapshots = new Map(existingLines.map(l => [l.shopifyLineId, l]))

  await prisma.$transaction([
    prisma.orderLine.deleteMany({ where: { orderId: input.id } }),
    prisma.order.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        projectId: input.projectId,
        storeId: input.storeId,
        shopifyOrderNumber: input.shopifyOrderNumber,
        customerEmail: input.customerEmail,
        customerName: input.customerName,
        shippingCountry: input.shippingCountry,
        shippingState: input.shippingState,
        financialStatus: input.financialStatus,
        fulfillmentStatus: input.fulfillmentStatus,
        currency: input.currency,
        grossAmount: input.grossAmount,
        subtotalAmount: input.subtotalAmount ?? 0,
        shippingAmount: input.shippingAmount ?? 0,
        taxAmount: input.taxAmount ?? 0,
        expectedPayout: input.expectedPayout,
        totalFees: input.totalFees,
        refundedAmount: input.refundedAmount,
        defaultSupplierId: input.defaultSupplierId,
        placedAt: input.placedAt,
        shopTimezone: input.shopTimezone ?? null,
        pipelineStatus: input.pipelineStatus ?? 'PENDING',
        shippingZone: input.shippingZone ?? null,
        shippingName: input.shippingName ?? null,
        shippingAddress1: input.shippingAddress1 ?? null,
        shippingAddress2: input.shippingAddress2 ?? null,
        shippingCity: input.shippingCity ?? null,
        shippingZip: input.shippingZip ?? null,
        shippingPhone: input.shippingPhone ?? null,
        orderType: input.orderType ?? 'UNKNOWN',
        trelloCardId: input.trelloCardId ?? null,
        trelloCardUrl: input.trelloCardUrl ?? null,
      },
      update: {
        financialStatus: input.financialStatus,
        fulfillmentStatus: input.fulfillmentStatus,
        grossAmount: input.grossAmount,
        subtotalAmount: input.subtotalAmount ?? 0,
        shippingAmount: input.shippingAmount ?? 0,
        taxAmount: input.taxAmount ?? 0,
        expectedPayout: input.expectedPayout,
        totalFees: input.totalFees,
        refundedAmount: input.refundedAmount,
        defaultSupplierId: input.defaultSupplierId,
        placedAt: input.placedAt,
        shopTimezone: input.shopTimezone ?? null,
        shippingZone: input.shippingZone ?? null,
        shippingName: input.shippingName ?? null,
        shippingAddress1: input.shippingAddress1 ?? null,
        shippingAddress2: input.shippingAddress2 ?? null,
        shippingCity: input.shippingCity ?? null,
        shippingZip: input.shippingZip ?? null,
        shippingPhone: input.shippingPhone ?? null,
        ...(input.pipelineStatus !== undefined ? { pipelineStatus: input.pipelineStatus } : {}),
        ...(input.orderType !== undefined ? { orderType: input.orderType } : {}),
        ...(input.trelloCardId !== undefined ? { trelloCardId: input.trelloCardId } : {}),
        ...(input.trelloCardUrl !== undefined ? { trelloCardUrl: input.trelloCardUrl } : {}),
      },
    }),
    prisma.orderLine.createMany({
      data: input.lines.map(l => {
        const snap = snapshots.get(l.shopifyLineId)
        return {
          orderId: input.id,
          shopifyLineId: l.shopifyLineId,
          sku: l.sku,
          resolvedSupplierSku: l.resolvedSupplierSku ?? null,
          variantTitle: l.variantTitle,
          productTitle: l.productTitle,
          qty: l.qty,
          unitPrice: l.unitPrice,
          resolvedSupplierId: l.resolvedSupplierId,
          resolvedBaseCost: snap ? snap.resolvedBaseCost : l.resolvedBaseCost,
          costSnapshotAt: snap ? snap.costSnapshotAt : (l.resolvedSupplierId ? now : null),
          resolvedShipFirst: snap ? snap.resolvedShipFirst : (l.resolvedShipFirst ?? null),
          resolvedShipAdditional: snap ? snap.resolvedShipAdditional : (l.resolvedShipAdditional ?? null),
          resolvedImportTax: snap ? snap.resolvedImportTax : (l.resolvedImportTax ?? null),
          shopifyVariantId: l.shopifyVariantId ?? null,
          variantOptions: l.variantOptions ?? null,
        }
      }),
    }),
  ])
}

export async function updateOrderStatus(orderId: string, status: PipelineStatus) {
  return prisma.order.update({
    where: { id: orderId },
    data: {
      pipelineStatus: status,
      ...(status === 'EXPORTED' && { exportedAt: new Date() }),
    },
  })
}

export async function bulkUpdateOrderStatus(orderIds: string[], status: PipelineStatus) {
  if (orderIds.length === 0) return { count: 0 }
  return prisma.order.updateMany({
    where: { id: { in: orderIds } },
    data: {
      pipelineStatus: status,
      ...(status === 'EXPORTED' && { exportedAt: new Date() }),
    },
  })
}

export async function countByStatus(filter: { projectId?: string } = {}): Promise<Record<PipelineStatus, number>> {
  const where: any = {}
  if (filter.projectId) where.projectId = filter.projectId
  const rows = await prisma.order.groupBy({
    by: ['pipelineStatus'],
    where,
    _count: { _all: true },
  })
  const result = Object.fromEntries(PIPELINE_STATUSES.map(s => [s, 0])) as Record<PipelineStatus, number>
  for (const r of rows) {
    if (PIPELINE_STATUSES.includes(r.pipelineStatus as PipelineStatus)) {
      result[r.pipelineStatus as PipelineStatus] = r._count._all
    }
  }
  return result
}
