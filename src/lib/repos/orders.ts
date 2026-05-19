import { prisma } from '@/lib/db'
import { PIPELINE_STATUSES, type PipelineStatus } from '@/lib/pipeline-status'

export type OrderFilter = {
  projectId?: string
  dateFrom?: Date
  dateTo?: Date
  supplierId?: string
  pipelineStatus?: string
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
  return where
}

export async function listOrdersWithLines(filter: OrderFilter) {
  return prisma.order.findMany({
    where: buildWhere(filter),
    orderBy: { placedAt: 'desc' },
    take: filter.limit ?? 500,
    include: {
      lines: true,
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
  expectedPayout: number
  totalFees: number
  refundedAmount: number
  defaultSupplierId: string | null
  placedAt: Date
  pipelineStatus?: PipelineStatus
  lines: Array<{
    shopifyLineId: string
    sku: string | null
    variantTitle: string | null
    productTitle: string
    qty: number
    unitPrice: number
    resolvedSupplierId: string | null
    resolvedBaseCost: number | null
  }>
}

export async function upsertOrderWithLines(input: UpsertOrderInput) {
  const now = new Date()
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
        expectedPayout: input.expectedPayout,
        totalFees: input.totalFees,
        refundedAmount: input.refundedAmount,
        defaultSupplierId: input.defaultSupplierId,
        placedAt: input.placedAt,
        pipelineStatus: input.pipelineStatus ?? 'PENDING',
      },
      update: {
        financialStatus: input.financialStatus,
        fulfillmentStatus: input.fulfillmentStatus,
        grossAmount: input.grossAmount,
        expectedPayout: input.expectedPayout,
        totalFees: input.totalFees,
        refundedAmount: input.refundedAmount,
        defaultSupplierId: input.defaultSupplierId,
        placedAt: input.placedAt,
        ...(input.pipelineStatus !== undefined ? { pipelineStatus: input.pipelineStatus } : {}),
      },
    }),
    prisma.orderLine.createMany({
      data: input.lines.map(l => ({
        orderId: input.id,
        shopifyLineId: l.shopifyLineId,
        sku: l.sku,
        variantTitle: l.variantTitle,
        productTitle: l.productTitle,
        qty: l.qty,
        unitPrice: l.unitPrice,
        resolvedSupplierId: l.resolvedSupplierId,
        resolvedBaseCost: l.resolvedBaseCost,
        costSnapshotAt: l.resolvedSupplierId ? now : null,
      })),
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
