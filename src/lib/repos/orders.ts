import { prisma } from '@/lib/db'
import { PIPELINE_STATUSES, TERMINAL_PIPELINE_STATUSES, warningCutoffDate, type PipelineStatus } from '@/lib/pipeline-status'

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
  const and: any[] = []
  if (f.projectId) where.projectId = f.projectId
  if (f.supplierId) where.defaultSupplierId = f.supplierId
  if (f.pipelineStatus === 'WARNING') {
    and.push(warningWhere())
    and.push(unfulfilledWhere())
  } else if (f.pipelineStatus) {
    where.pipelineStatus = f.pipelineStatus
    if (!TERMINAL_PIPELINE_STATUSES.includes(f.pipelineStatus as PipelineStatus)) {
      and.push({ NOT: warningWhere(false) })
    }
    if (f.pipelineStatus !== 'FULFILLED') {
      and.push(unfulfilledWhere())
    }
  }
  if (f.dateFrom || f.dateTo) {
    const placedAt: any = {}
    if (f.dateFrom) placedAt.gte = f.dateFrom
    if (f.dateTo) placedAt.lte = f.dateTo
    and.push({ placedAt })
  }
  if (f.search) {
    and.push({ OR: [
      { shopifyOrderNumber: { contains: f.search } },
      { customerName: { contains: f.search } },
      { customerEmail: { contains: f.search } },
    ] })
  }
  if (and.length > 0) where.AND = and
  return where
}

function unfulfilledWhere() {
  return { OR: [{ fulfillmentStatus: null }, { fulfillmentStatus: { notIn: ['fulfilled', 'FULFILLED'] } }] }
}

function warningWhere(includeManual = true) {
  const dynamic = {
    placedAt: { lte: warningCutoffDate() },
    pipelineStatus: { notIn: TERMINAL_PIPELINE_STATUSES },
    OR: [
      { fulfillmentStatus: null },
      { fulfillmentStatus: { notIn: ['FULFILLED', 'fulfilled'] } },
    ],
  }
  return includeManual
    ? { OR: [{ pipelineStatus: 'WARNING' }, dynamic] }
    : dynamic
}

export async function listOrdersWithLines(filter: OrderFilter) {
  return prisma.order.findMany({
    where: buildWhere(filter),
    orderBy: { placedAt: 'desc' },
    take: filter.limit ?? 500,
    include: {
      lines: { orderBy: { linePosition: 'asc' } },
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
    linePosition?: number | null
    unitPrice: number
    resolvedSupplierId: string | null
    resolvedBaseCost: number | null
    resolvedShipFirst?: number | null
    resolvedShipAdditional?: number | null
    resolvedImportTax?: number | null
    previewCdnUrl?: string | null
    designDriveLink?: string | null
    shopifyVariantId?: string | null
    variantOptions?: string | null
  }>
}

export async function upsertOrderWithLines(input: UpsertOrderInput) {
  const now = new Date()

  // Preserve cost snapshots for lines that were already priced — re-sync must not overwrite
  // old costs when supplier prices change (only new orders get fresh prices)
  const existingLines = await prisma.orderLine.findMany({
    where: { orderId: input.id },
    select: {
      shopifyLineId: true,
      resolvedSupplierId: true,
      resolvedSupplierSku: true,
      resolvedBaseCost: true,
      costSnapshotAt: true,
      resolvedShipFirst: true,
      resolvedShipAdditional: true,
      resolvedImportTax: true,
      previewCdnUrl: true,
      designDriveLink: true,
    },
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
        pipelineStatus: input.pipelineStatus ?? 'READY_TO_PRODUCTION',
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
        const preserveSnapshot = !!l.resolvedSupplierId &&
          !!snap &&
          snap.resolvedSupplierId === l.resolvedSupplierId &&
          snap.resolvedSupplierSku === (l.resolvedSupplierSku ?? null)
        return {
          orderId: input.id,
          shopifyLineId: l.shopifyLineId,
          sku: l.sku,
          resolvedSupplierSku: l.resolvedSupplierSku ?? null,
          variantTitle: l.variantTitle,
          productTitle: l.productTitle,
          qty: l.qty,
          linePosition: l.linePosition ?? 0,
          unitPrice: l.unitPrice,
          resolvedSupplierId: l.resolvedSupplierId,
          resolvedBaseCost: preserveSnapshot ? snap.resolvedBaseCost : l.resolvedBaseCost,
          costSnapshotAt: preserveSnapshot ? snap.costSnapshotAt : (l.resolvedSupplierId ? now : null),
          resolvedShipFirst: preserveSnapshot ? snap.resolvedShipFirst : (l.resolvedShipFirst ?? null),
          resolvedShipAdditional: preserveSnapshot ? snap.resolvedShipAdditional : (l.resolvedShipAdditional ?? null),
          resolvedImportTax: preserveSnapshot ? snap.resolvedImportTax : (l.resolvedImportTax ?? null),
          previewCdnUrl: l.previewCdnUrl ?? snap?.previewCdnUrl ?? null,
          designDriveLink: l.designDriveLink ?? snap?.designDriveLink ?? null,
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
  const baseWhere: any = filter.projectId ? { projectId: filter.projectId } : {}
  const result = Object.fromEntries(PIPELINE_STATUSES.map(s => [s, 0])) as Record<PipelineStatus, number>
  for (const status of PIPELINE_STATUSES) {
    if (status === 'WARNING') {
      result[status] = await prisma.order.count({ where: { AND: [baseWhere, warningWhere(), unfulfilledWhere()] } })
      continue
    }
    result[status] = await prisma.order.count({
      where: {
        AND: [
          baseWhere,
          { pipelineStatus: status },
          ...(TERMINAL_PIPELINE_STATUSES.includes(status) ? [] : [{ NOT: warningWhere(false) }]),
          ...(status !== 'FULFILLED' ? [unfulfilledWhere()] : []),
        ],
      },
    })
  }
  return result
}
