import { prisma } from '@/lib/db'
import { autoDetectStatus, isValidPipelineStatus, type PipelineStatus } from '@/lib/pipeline-status'
import { profileKey, resolveByProductBase, supplierParentKey, swapToSizeSibling } from '@/lib/product-mapping'
import { loadProductBasesForResolver, loadProductProfilesForResolver, loadVariantManualMappingsForResolver } from '@/lib/repos/mapping'
import { isNonProductLine } from '@/lib/order-lines'

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

export async function recalculateMissingOrderLineCosts(filter: {
  dateFrom?: Date
  dateTo?: Date
  refreshExisting?: boolean
  orderIds?: string[]
  shopifyProductId?: string
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
  const [productBases, manualMappings, productProfiles, supplierProducts, lines] = await Promise.all([
    loadProductBasesForResolver(),
    loadVariantManualMappingsForResolver(),
    loadProductProfilesForResolver(),
    prisma.supplierProduct.findMany({ include: { supplier: true } }),
    prisma.orderLine.findMany({
      where: {
        ...(!filter.refreshExisting ? { resolvedBaseCost: null } : {}),
        ...(filter.shopifyProductId ? { shopifyProductId: filter.shopifyProductId } : {}),
        order: Object.keys(orderScope).length > 0 ? orderScope : undefined,
      },
      include: {
        order: { select: { id: true, shippingZone: true, storeId: true } },
      },
    }),
  ])

  const activeSupplierProducts = supplierProducts.filter(p => p.supplier.isActive)
  const rawSupplierProductById = new Map(activeSupplierProducts.map(p => [p.id, p]))
  const supplierProductsByParent = new Map<string, SupplierProductWithSupplier[]>()
  for (const p of activeSupplierProducts) {
    const key = supplierParentKey(p)
    supplierProductsByParent.set(key, [...(supplierProductsByParent.get(key) ?? []), p])
  }

  const now = new Date()
  let updatedLines = 0
  let unresolvedLines = 0
  const touchedOrderIds = new Set<string>()

  for (const line of lines) {
    if (isNonProductLine(line)) continue
    const selectedOptions = parseVariantOptions(line.variantOptions)
    const result = resolveByProductBase(
      line.shopifyVariantId,
      line.shopifyProductType ?? null,
      selectedOptions,
      productBases,
      manualMappings,
      line.shopifyProductId ? productProfiles.get(profileKey(line.order.storeId, line.shopifyProductId)) ?? null : null,
    )
    const supplierProductId = swapToSizeSibling(
      result.supplierProductId,
      selectedOptions,
      result.resolvedVia,
      rawSupplierProductById,
      supplierProductsByParent,
    )
    const supplierProduct = supplierProductId ? rawSupplierProductById.get(supplierProductId) : null
    if (!supplierProduct) {
      if (filter.refreshExisting) {
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
      }
      unresolvedLines++
      continue
    }

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
        lines: {
          select: {
            sku: true,
            productTitle: true,
            shopifyProductType: true,
            resolvedSupplierId: true,
            resolvedBaseCost: true,
            qty: true,
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
    const pipelineStatus = autoDetectStatus({
      financialStatus: order.financialStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      hasUnmappedSku: hasPendingMapping,
      hasPendingMapping,
      hasCustomDesignLine: order.orderType === 'CUSTOM',
      hasDesignLine,
      hasDesignReady: order.designReady,
      currentStatus,
    })

    await prisma.order.update({
      where: { id: orderId },
      data: { defaultSupplierId, pipelineStatus },
    })
  }

  return {
    scannedLines: lines.length,
    updatedLines,
    unresolvedLines,
    updatedOrders: touchedOrderIds.size,
  }
}
