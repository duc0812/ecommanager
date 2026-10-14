import { prisma } from '@/lib/db'
import { PIPELINE_STATUSES, TERMINAL_PIPELINE_STATUSES, type PipelineStatus } from '@/lib/pipeline-status'
import { WARNING_TYPES, type WarningType } from '@/lib/order-warnings'
import { isLineExported, legacyMarks, supplierLines } from '@/lib/line-export'

export type OrderFilter = {
  projectId?: string
  dateFrom?: Date
  dateTo?: Date
  supplierId?: string
  lineSupplierId?: string  // orders with at least one line resolved to this supplier (mixed orders included)
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
  if (f.lineSupplierId) where.lines = { some: { resolvedSupplierId: f.lineSupplierId } }
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
  shippingStateCode?: string | null
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
    customized?: boolean
    customAttributesJson?: string | null
    imageUrl?: string | null
    shopifyProductId?: string | null
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
      customAttributesJson: true,
      imageUrl: true,
      shopifyProductId: true,
      designNote: true,
      exportedAt: true,
      exportedToSupplierId: true,
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
        shippingStateCode: input.shippingStateCode ?? null,
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
        ...(input.shippingStateCode !== undefined ? { shippingStateCode: input.shippingStateCode } : {}),
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
          customAttributesJson: l.customAttributesJson !== undefined ? l.customAttributesJson : (snap?.customAttributesJson ?? null),
          imageUrl: l.imageUrl !== undefined ? l.imageUrl : (snap?.imageUrl ?? null),
          shopifyProductId: l.shopifyProductId !== undefined ? l.shopifyProductId : (snap?.shopifyProductId ?? null),
          designNote: snap?.designNote ?? null,
          exportedAt: snap?.exportedAt ?? null,
          exportedToSupplierId: snap?.exportedToSupplierId ?? null,
          shopifyVariantId: l.shopifyVariantId ?? null,
          shopifyProductType: l.shopifyProductType ?? null,
          variantOptions: l.variantOptions ?? null,
          customized: l.customized ?? false,
        }
      }),
    }),
  ])
}

export const EXPORTABLE_PIPELINE_STATUSES: PipelineStatus[] = ['READY_TO_PRODUCTION', 'EXPORTED']

const EXPORT_LINE_SELECT = {
  id: true, sku: true, productTitle: true, shopifyProductType: true, linePosition: true,
  resolvedSupplierId: true, exportedAt: true, exportedToSupplierId: true,
} as const

export type MarkExportedResult = {
  /** Orders this call changed: lines marked, or the order (re)marked Exported. */
  count: number
  /** Lines newly marked as sent to the supplier. */
  lines: number
  /** Orders that are now Exported because every production line with a supplier has been sent. */
  completed: string[]
}

/**
 * Marks the lines of `supplierId` in these orders as sent (only lines not sent yet; `lineIds` narrows it to the lines
 * that were actually in the file). An order moves to EXPORTED — with exportedAt / exportedToSupplierId = this supplier
 * and the optional handoff — only once every production line with a supplier has been sent; until then it keeps its
 * status (READY_TO_PRODUCTION) and the order-level export fields are left alone.
 * Only production-ready orders are touched; pending design/mapping, on-hold, fulfilled and terminal orders keep their state.
 */
export async function markOrdersExported(
  orderIds: string[], supplierId: string, exportedAt: Date = new Date(),
  handoff?: { mode: 'API' | 'CSV'; byId: string | null },
  opts: { lineIds?: string[] } = {},
): Promise<MarkExportedResult> {
  const result: MarkExportedResult = { count: 0, lines: 0, completed: [] }
  if (orderIds.length === 0) return result
  const only = opts.lineIds ? new Set(opts.lineIds) : null
  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds }, pipelineStatus: { in: EXPORTABLE_PIPELINE_STATUSES } },
    select: { id: true, pipelineStatus: true, exportedAt: true, exportedToSupplierId: true, lines: { select: EXPORT_LINE_SELECT } },
  })
  for (const o of orders) {
    const lines = supplierLines(o.lines)
    const own = lines.filter(l => l.resolvedSupplierId === supplierId)
    if (own.length === 0) continue
    const legacy = legacyMarks(o)
    const legacyIds = new Set(legacy.map(m => m.line.id))
    const targets = own.filter(l => !isLineExported(o, l) && (!only || only.has(l.id)))
    const sent = new Set([...Array.from(legacyIds), ...targets.map(l => l.id), ...lines.filter(l => l.exportedAt != null).map(l => l.id)])
    const full = lines.every(l => sent.has(l.id))
    if (targets.length === 0 && !full) continue

    const ops: any[] = []
    // An order exported before lines were tracked first gets the marks its old export implies, so the new mark does not undo them.
    const legacyBySupplier = new Map<string, string[]>()
    for (const m of legacy) legacyBySupplier.set(m.supplierId, [...(legacyBySupplier.get(m.supplierId) ?? []), m.line.id])
    for (const [sid, ids] of Array.from(legacyBySupplier.entries())) {
      ops.push(prisma.orderLine.updateMany({ where: { id: { in: ids }, exportedAt: null }, data: { exportedAt: o.exportedAt, exportedToSupplierId: sid } }))
    }
    if (targets.length > 0) {
      ops.push(prisma.orderLine.updateMany({
        where: { id: { in: targets.map(l => l.id) }, exportedAt: null },
        data: { exportedAt, exportedToSupplierId: supplierId },
      }))
    }
    if (full) {
      ops.push(prisma.order.updateMany({
        where: { id: o.id, pipelineStatus: { in: EXPORTABLE_PIPELINE_STATUSES } },
        data: {
          exportedAt,
          exportedToSupplierId: supplierId,
          pipelineStatus: 'EXPORTED',
          ...(handoff ? { supplierHandoffAt: exportedAt, supplierHandoffMode: handoff.mode, supplierHandoffById: handoff.byId } : {}),
        },
      }))
    }
    await prisma.$transaction(ops)
    result.count++
    result.lines += targets.length
    if (full) result.completed.push(o.id)
  }
  return result
}

/** Forgets which lines were sent, so the whole order goes out again with the next export. */
export async function clearLineExports(orderIds: string[]) {
  if (orderIds.length === 0) return { count: 0 }
  return prisma.orderLine.updateMany({
    where: { orderId: { in: orderIds }, OR: [{ exportedAt: { not: null } }, { exportedToSupplierId: { not: null } }] },
    data: { exportedAt: null, exportedToSupplierId: null },
  })
}

/** A hand-set EXPORTED means every supplier got its lines: each unsent line is marked for the supplier it resolves to. */
async function markAllLinesExported(orderIds: string[], at: Date) {
  const lines = await prisma.orderLine.findMany({
    where: { orderId: { in: orderIds }, exportedAt: null, resolvedSupplierId: { not: null } },
    select: EXPORT_LINE_SELECT,
  })
  const bySupplier = new Map<string, string[]>()
  for (const l of supplierLines(lines)) bySupplier.set(l.resolvedSupplierId as string, [...(bySupplier.get(l.resolvedSupplierId as string) ?? []), l.id])
  for (const [sid, ids] of Array.from(bySupplier.entries())) {
    await prisma.orderLine.updateMany({ where: { id: { in: ids }, exportedAt: null }, data: { exportedAt: at, exportedToSupplierId: sid } })
  }
}

// Hand-set statuses keep the line marks consistent: EXPORTED marks every line sent, moving an EXPORTED order back to
// READY_TO_PRODUCTION reopens it for every supplier (as before, when the order-level flag was all there was).
async function applyManualStatusToLines(orderIds: string[], status: PipelineStatus, at: Date) {
  if (orderIds.length === 0) return
  if (status === 'EXPORTED') {
    await markAllLinesExported(orderIds, at)
    return
  }
  if (status === 'READY_TO_PRODUCTION') {
    const reopened = await prisma.order.findMany({ where: { id: { in: orderIds }, pipelineStatus: 'EXPORTED' }, select: { id: true } })
    await clearLineExports(reopened.map(o => o.id))
  }
}

export async function updateOrderStatus(orderId: string, status: PipelineStatus) {
  const now = new Date()
  await applyManualStatusToLines([orderId], status, now)
  return prisma.order.update({
    where: { id: orderId },
    data: {
      pipelineStatus: status,
      ...(status === 'EXPORTED' && { exportedAt: now }),
    },
  })
}

export async function bulkUpdateOrderStatus(orderIds: string[], status: PipelineStatus) {
  if (orderIds.length === 0) return { count: 0 }
  const now = new Date()
  await applyManualStatusToLines(orderIds, status, now)
  return prisma.order.updateMany({
    where: { id: { in: orderIds } },
    data: {
      pipelineStatus: status,
      ...(status === 'EXPORTED' && { exportedAt: now }),
    },
  })
}

/** READY_TO_PRODUCTION orders some of whose lines were already sent to a supplier ("Đã xuất 1/2 xưởng"). */
export function partiallyExportedWhere() {
  return { pipelineStatus: 'READY_TO_PRODUCTION', lines: { some: { exportedAt: { not: null } } } }
}

export async function countPartiallyExported(filter: { projectId?: string } = {}): Promise<number> {
  const baseWhere: any = filter.projectId ? { projectId: filter.projectId } : {}
  return prisma.order.count({ where: { AND: [baseWhere, partiallyExportedWhere(), unfulfilledWhere()] } })
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
