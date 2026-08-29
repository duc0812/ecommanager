import { prisma } from '@/lib/db'
import { PIPELINE_STATUSES, TERMINAL_PIPELINE_STATUSES, type PipelineStatus } from '@/lib/pipeline-status'
import { WARNING_TYPES, type WarningType } from '@/lib/order-warnings'

export type OrderFilter = {
  projectId?: string
  dateFrom?: Date
  dateTo?: Date
  supplierId?: string
  pipelineStatus?: string
  warningType?: WarningType  // filter by a computed warning dimension (separate from pipelineStatus)
  search?: string  // filter by orderNumber / customerName / customerEmail
  limit?: number
  page?: number      // 1-based page number for pagination
  pageSize?: number  // rows per page; when set, overrides `limit`
}

function buildWhere(f: OrderFilter) {
  const where: any = {}
  const and: any[] = []
  if (f.projectId) where.projectId = f.projectId
  if (f.supplierId) where.defaultSupplierId = f.supplierId
  if (f.warningType) {
    and.push(warningTypeWhere(f.warningType))
  } else if (f.pipelineStatus) {
    where.pipelineStatus = f.pipelineStatus
    if (f.pipelineStatus !== 'FULFILLED' && !TERMINAL_PIPELINE_STATUSES.includes(f.pipelineStatus as PipelineStatus)) {
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

const WARN_DAY_MS = 86400000
// DB-side mirror of computeWarnings() in @/lib/order-warnings — keep the two in sync.
function warningTypeWhere(type: WarningType): any {
  const now = Date.now()
  const cut7 = new Date(now - 7 * WARN_DAY_MS)
  const cut1 = new Date(now - 1 * WARN_DAY_MS)
  if (type === 'LATE_FULFILLMENT') {
    return {
      placedAt: { lte: cut7 },
      pipelineStatus: { notIn: ['FULFILLED', 'CANCELLED', 'REFUNDED'] },
      OR: [{ fulfillmentStatus: null }, { fulfillmentStatus: { notIn: ['FULFILLED', 'fulfilled'] } }],
    }
  }
  if (type === 'STUCK_DESIGN') return { placedAt: { lte: cut1 }, pipelineStatus: 'PENDING_DESIGN' }
  return { placedAt: { lte: cut1 }, pipelineStatus: 'READY_TO_PRODUCTION' } // NOT_EXPORTED
}

export async function listOrdersWithLines(filter: OrderFilter) {
  const usePaging = filter.pageSize != null && filter.pageSize > 0
  const take = usePaging ? filter.pageSize : (filter.limit ?? 500)
  const skip = usePaging ? Math.max(0, (Math.max(1, filter.page ?? 1) - 1) * (filter.pageSize as number)) : 0

  return prisma.order.findMany({
    where: buildWhere(filter),
    orderBy: { placedAt: 'desc' },
    take,
    skip,
    include: {
      lines: { orderBy: { linePosition: 'asc' } },
      store: { select: { id: true, shop: true, ianaTimezone: true } },
      defaultSupplier: { select: { id: true, name: true, code: true, firstItemShipFee: true, additionalItemShipFee: true } },
    },
  })
}

export async function countOrders(filter: OrderFilter) {
  return prisma.order.count({ where: buildWhere(filter) })
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
  designReady?: boolean
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
    shopifyProductType?: string | null
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
      manualBaseCost: true,
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
        designReady: input.designReady ?? false,
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
        ...(input.designReady !== undefined ? { designReady: input.designReady } : {}),
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
          manualBaseCost: snap?.manualBaseCost ?? null,
          costSnapshotAt: preserveSnapshot ? snap.costSnapshotAt : (l.resolvedSupplierId ? now : null),
          resolvedShipFirst: preserveSnapshot ? snap.resolvedShipFirst : (l.resolvedShipFirst ?? null),
          resolvedShipAdditional: preserveSnapshot ? snap.resolvedShipAdditional : (l.resolvedShipAdditional ?? null),
          resolvedImportTax: preserveSnapshot ? snap.resolvedImportTax : (l.resolvedImportTax ?? null),
          previewCdnUrl: l.previewCdnUrl ?? snap?.previewCdnUrl ?? null,
          designDriveLink: l.designDriveLink ?? snap?.designDriveLink ?? null,
          shopifyVariantId: l.shopifyVariantId ?? null,
          shopifyProductType: l.shopifyProductType ?? null,
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
    result[status] = await prisma.order.count({
      where: {
        AND: [
          baseWhere,
          { pipelineStatus: status },
          ...(status !== 'FULFILLED' && !TERMINAL_PIPELINE_STATUSES.includes(status) ? [unfulfilledWhere()] : []),
        ],
      },
    })
  }
  return result
}

export async function countWarnings(filter: { projectId?: string } = {}): Promise<Record<WarningType, number>> {
  const baseWhere: any = filter.projectId ? { projectId: filter.projectId } : {}
  const result = {} as Record<WarningType, number>
  for (const type of WARNING_TYPES) {
    result[type] = await prisma.order.count({ where: { AND: [baseWhere, warningTypeWhere(type)] } })
  }
  return result
}
