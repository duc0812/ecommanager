import { prisma } from '@/lib/db'
import { autoDetectStatus, isValidPipelineStatus, type PipelineStatus } from '@/lib/pipeline-status'
import { resolveByProductBase } from '@/lib/product-mapping'
import { loadProductBasesForResolver, loadVariantManualMappingsForResolver } from '@/lib/repos/mapping'

function normalize(v: string | null | undefined): string {
  return (v ?? '').toLowerCase().trim()
}

function supplierParentKey(product: {
  supplierId: string
  productName: string | null
  productType: string | null
  baseSku: string | null
}) {
  return [
    product.supplierId,
    product.productName ?? '',
    product.productType ?? '',
    product.baseSku ?? '',
  ].join('|')
}

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

function resolveSupplierProductIdForLine(
  supplierProductId: string | null,
  selectedOptions: Record<string, string>,
  resolvedVia: ReturnType<typeof resolveByProductBase>['resolvedVia'],
  rawSupplierProductById: Map<string, SupplierProductWithSupplier>,
  supplierProductsByParent: Map<string, SupplierProductWithSupplier[]>,
) {
  if (!supplierProductId) return null
  if (resolvedVia === 'variant_manual' || resolvedVia === 'product_base_override') {
    return supplierProductId
  }
  const mapped = rawSupplierProductById.get(supplierProductId)
  if (!mapped) return supplierProductId
  const optionValues = Object.entries(selectedOptions)
    .filter(([key]) => ['size'].includes(normalize(key)))
    .map(([, value]) => normalize(value))
    .filter(Boolean)
  if (optionValues.length === 0) return supplierProductId
  const siblings = supplierProductsByParent.get(supplierParentKey(mapped)) ?? []
  const exact = siblings.find(p =>
    optionValues.includes(normalize(p.variant1Value)) ||
    optionValues.includes(normalize(p.variant2Value))
  )
  return exact?.id ?? null
}

export async function recalculateMissingOrderLineCosts(filter: { dateFrom?: Date; dateTo?: Date } = {}) {
  const [productBases, manualMappings, supplierProducts, lines] = await Promise.all([
    loadProductBasesForResolver(),
    loadVariantManualMappingsForResolver(),
    prisma.supplierProduct.findMany({ include: { supplier: true } }),
    prisma.orderLine.findMany({
      where: {
        resolvedBaseCost: null,
        order: filter.dateFrom || filter.dateTo
          ? {
              placedAt: {
                ...(filter.dateFrom ? { gte: filter.dateFrom } : {}),
                ...(filter.dateTo ? { lte: filter.dateTo } : {}),
              },
            }
          : undefined,
      },
      include: {
        order: { select: { id: true, shippingZone: true } },
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
    const selectedOptions = parseVariantOptions(line.variantOptions)
    const result = resolveByProductBase(
      line.shopifyVariantId,
      line.shopifyProductType ?? null,
      selectedOptions,
      productBases,
      manualMappings,
    )
    const supplierProductId = resolveSupplierProductIdForLine(
      result.supplierProductId,
      selectedOptions,
      result.resolvedVia,
      rawSupplierProductById,
      supplierProductsByParent,
    )
    const supplierProduct = supplierProductId ? rawSupplierProductById.get(supplierProductId) : null
    if (!supplierProduct) {
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
      ...(filter.dateFrom || filter.dateTo
        ? {
            placedAt: {
              ...(filter.dateFrom ? { gte: filter.dateFrom } : {}),
              ...(filter.dateTo ? { lte: filter.dateTo } : {}),
            },
          }
        : {}),
    },
    select: {
      id: true,
      lines: { select: { sku: true, resolvedSupplierId: true, resolvedBaseCost: true } },
    },
  })
  for (const order of mappedPendingOrders) {
    const skuLines = order.lines.filter(l => l.sku)
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
    const skuLines = order.lines.filter(l => l.sku)
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
      hasDesignReady: order.designReady,
      currentStatus,
    })

    if (defaultSupplierId) {
      await prisma.order.update({
        where: { id: orderId },
        data: { defaultSupplierId, pipelineStatus },
      })
    }
  }

  return {
    scannedLines: lines.length,
    updatedLines,
    unresolvedLines,
    updatedOrders: touchedOrderIds.size,
  }
}
