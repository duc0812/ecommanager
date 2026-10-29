import { prisma } from '@/lib/db'
import { autoDetectStatus, isValidPipelineStatus, type PipelineStatus } from '@/lib/pipeline-status'
import { profileKey, resolveByProductBase, supplierParentKey, swapToSizeSibling } from '@/lib/product-mapping'
import { loadProductBasesForResolver, loadProductProfilesForResolver, loadTypeAliasesForResolver, loadVariantManualMappingsForResolver } from '@/lib/repos/mapping'
import { isNonProductLine } from '@/lib/order-lines'
import { designReadyHolds } from '@/lib/design-library'

function parseVariantOptions(value: string | null): Record<string, string> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return {}
  }
}

type SupplierProductWithSupplier = Awaited<ReturnType<typeof prisma.supplierProduct.findMany<{
  include: { supplier: true }
}>>>[number]

export type ResolvableLine = {
  shopifyVariantId: string | null; shopifyProductType: string | null; variantOptions: string | null; shopifyProductId: string | null
  order: { storeId: string; shippingCountry: string | null }
}

/** The supplier product today's mapping picks for a line: product base / manual mapping / product profile, then the size sibling. */
export async function loadLineResolver(): Promise<(line: ResolvableLine) => SupplierProductWithSupplier | null> {
  const [productBases, manualMappings, productProfiles, supplierProducts, typeAliases] = await Promise.all([
    loadProductBasesForResolver(),
    loadVariantManualMappingsForResolver(),
    loadProductProfilesForResolver(),
    prisma.supplierProduct.findMany({ include: { supplier: true } }),
    loadTypeAliasesForResolver(),
  ])
  const activeSupplierProducts = supplierProducts.filter(p => p.supplier.isActive)
  const rawSupplierProductById = new Map(activeSupplierProducts.map(p => [p.id, p]))
  const supplierProductsByParent = new Map<string, SupplierProductWithSupplier[]>()
  for (const p of activeSupplierProducts) {
    const key = supplierParentKey(p)
    supplierProductsByParent.set(key, [...(supplierProductsByParent.get(key) ?? []), p])
  }
  return line => {
    const selectedOptions = parseVariantOptions(line.variantOptions)
    const result = resolveByProductBase(
      line.shopifyVariantId,
      line.shopifyProductType ?? null,
      selectedOptions,
      productBases,
      manualMappings,
      line.shopifyProductId ? productProfiles.get(profileKey(line.order.storeId, line.shopifyProductId)) ?? null : null,
      line.order.shippingCountry,
      typeAliases,
    )
    const supplierProductId = swapToSizeSibling(
      result.supplierProductId,
      selectedOptions,
      result.resolvedVia,
      rawSupplierProductById,
      supplierProductsByParent,
    )
    return supplierProductId ? rawSupplierProductById.get(supplierProductId) ?? null : null
  }
}

export async function recalculateMissingOrderLineCosts(filter: {
  dateFrom?: Date
  dateTo?: Date
  refreshExisting?: boolean
  orderIds?: string[]
  shopifyProductId?: string
  preserveUnchangedSnapshot?: boolean
} = {}) {
  const placedAt = filter.dateFrom || filter.dateTo
    ? {
        ...(filter.dateFrom ? { gte: filter.dateFrom } : {}),
        ...(filter.dateTo ? { lte: filter.dateTo } : {}),
      }
    : undefined
  const orderScope = {
    ...(placedAt ? { placedAt } : {}),
    ...(filter.orderIds ? { id: { in: filter.orderIds } } : {}),
  }
  const [resolveLine, lines] = await Promise.all([
    loadLineResolver(),
    prisma.orderLine.findMany({
      where: {
        ...(!filter.refreshExisting ? { resolvedBaseCost: null } : {}),
        ...(filter.shopifyProductId ? { shopifyProductId: filter.shopifyProductId } : {}),
        order: Object.keys(orderScope).length > 0 ? orderScope : undefined,
      },
      include: {
        order: { select: { id: true, shippingZone: true, storeId: true, shippingCountry: true } },
      },
    }),
  ])

  const now = new Date()
  let updatedLines = 0
  let unresolvedLines = 0
  const touchedOrderIds = new Set<string>()
  const changedOrderIds = new Set<string>()

  for (const line of lines) {
    if (isNonProductLine(line)) continue
    const supplierProduct = resolveLine(line)
    if (!supplierProduct) {
      if (filter.refreshExisting && !(filter.preserveUnchangedSnapshot && !line.resolvedSupplierId)) {
        await prisma.orderLine.update({
          where: { id: line.id },
          data: {
            resolvedSupplierId: null,
            resolvedSupplierSku: null,
            resolvedBaseCost: null,
            resolvedShipFirst: null,
            resolvedShipAdditional: null,
            resolvedImportTax: null,
            costSnapshotAt: null,
          },
        })
        touchedOrderIds.add(line.orderId)
        changedOrderIds.add(line.orderId)
      }
      unresolvedLines++
      continue
    }

    // Same supplier and SKU keep the price the order was costed at, as the order sync does.
    if (
      filter.preserveUnchangedSnapshot &&
      line.resolvedSupplierId === supplierProduct.supplierId &&
      line.resolvedSupplierSku === supplierProduct.sku &&
      line.resolvedBaseCost != null
    ) continue

    const zone = line.order.shippingZone ?? 'ROW'
    const shippingByRegion = supplierProduct.shippingByRegion
      ? JSON.parse(supplierProduct.shippingByRegion) as Record<string, { first?: number; additional?: number; importTax?: number }>
      : {}
    const zoneRate = shippingByRegion[zone]

    await prisma.orderLine.update({
      where: { id: line.id },
      data: {
        resolvedSupplierId: supplierProduct.supplierId,
        resolvedSupplierSku: supplierProduct.sku,
        resolvedBaseCost: supplierProduct.baseCost,
        resolvedShipFirst: zoneRate?.first ?? supplierProduct.supplier.firstItemShipFee,
        resolvedShipAdditional: zoneRate?.additional ?? supplierProduct.supplier.additionalItemShipFee,
        resolvedImportTax: zoneRate?.importTax ?? 0,
        costSnapshotAt: now,
      },
    })
    touchedOrderIds.add(line.orderId)
    changedOrderIds.add(line.orderId)
    updatedLines++
  }

  const mappedPendingOrders = await prisma.order.findMany({
    where: {
      pipelineStatus: { in: ['PENDING_MAPPING', 'PENDING_DESIGN', 'PENDING', 'WARNING', 'READY_TO_PRODUCTION'] },
      ...orderScope,
    },
    select: {
      id: true,
      lines: {
        select: {
          sku: true,
          productTitle: true,
          shopifyProductType: true,
          resolvedSupplierId: true,
          resolvedBaseCost: true,
        },
      },
    },
  })
  for (const order of mappedPendingOrders) {
    const skuLines = order.lines.filter(l => l.sku && !isNonProductLine(l))
    if (skuLines.length > 0 && skuLines.every(l => l.resolvedSupplierId && l.resolvedBaseCost != null)) {
      touchedOrderIds.add(order.id)
    }
  }

  for (const orderId of Array.from(touchedOrderIds)) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        financialStatus: true,
        fulfillmentStatus: true,
        pipelineStatus: true,
        orderType: true,
        designReady: true,
        trelloCardId: true,
        lines: {
          select: {
            sku: true,
            productTitle: true,
            shopifyProductType: true,
            resolvedSupplierId: true,
            resolvedBaseCost: true,
            qty: true,
            designDriveLink: true,
          },
        },
      },
    })
    if (!order) continue

    const linesForOrder = order.lines.filter(l => l.resolvedSupplierId)
    const qtyBySupplier = new Map<string, number>()
    for (const line of linesForOrder) {
      if (!line.resolvedSupplierId) continue
      qtyBySupplier.set(line.resolvedSupplierId, (qtyBySupplier.get(line.resolvedSupplierId) ?? 0) + line.qty)
    }
    const defaultSupplierId = Array.from(qtyBySupplier.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    const skuLines = order.lines.filter(l => l.sku && !isNonProductLine(l))
    const hasDesignLine = skuLines.some(l => l.resolvedSupplierId)
    const hasPendingMapping = skuLines.some(l => !l.resolvedSupplierId || l.resolvedBaseCost == null)
    const currentStatus = isValidPipelineStatus(order.pipelineStatus)
      ? order.pipelineStatus as PipelineStatus
      : null
    const designReady = designReadyHolds(order)
    const pipelineStatus = autoDetectStatus({
      financialStatus: order.financialStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      hasUnmappedSku: hasPendingMapping,
      hasPendingMapping,
      hasCustomDesignLine: order.orderType === 'CUSTOM',
      hasDesignLine,
      hasDesignReady: designReady,
      currentStatus,
    })

    await prisma.order.update({
      where: { id: orderId },
      data: { defaultSupplierId, pipelineStatus, designReady },
    })
  }

  return {
    scannedLines: lines.length,
    updatedLines,
    unresolvedLines,
    updatedOrders: touchedOrderIds.size,
    changedOrders: changedOrderIds.size,
  }
}
