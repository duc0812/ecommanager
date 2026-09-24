import { prisma } from '@/lib/db'
import type { ProductBaseData, VariantManualMappingData } from '@/lib/product-mapping'
import { isNonProductLine } from '@/lib/order-lines'
import { autoDetectStatus, isValidPipelineStatus, type PipelineStatus } from '@/lib/pipeline-status'

// ── ProductBase ───────────────────────────────────────────

export async function listProductBases() {
  return prisma.productBase.findMany({
    orderBy: { name: 'asc' },
    include: {
      supplierMappings: {
        orderBy: { preferenceRank: 'asc' },
        include: { supplierProduct: { include: { supplier: { select: { id: true, name: true, code: true } } } } },
      },
      overrides: {
        include: { supplierProduct: { include: { supplier: { select: { id: true, name: true, code: true } } } } },
      },
      _count: { select: { variantMappings: true } },
    },
  })
}

export async function getProductBaseById(id: string) {
  return prisma.productBase.findUnique({
    where: { id },
    include: {
      supplierMappings: {
        orderBy: { preferenceRank: 'asc' },
        include: { supplierProduct: { include: { supplier: { select: { id: true, name: true, code: true } } } } },
      },
      overrides: {
        include: { supplierProduct: { include: { supplier: { select: { id: true, name: true, code: true } } } } },
      },
    },
  })
}

export type ProductBaseInput = {
  name: string
  shopifyProductType: string
  variantConditions: string
  notes?: string | null
  supplierMappings: Array<{ supplierProductId: string; preferenceRank: number }>
  overrides: Array<{ supplierProductId: string; attributeCombo: string; notes?: string | null }>
}

export async function createProductBase(input: ProductBaseInput) {
  return prisma.productBase.create({
    data: {
      name: input.name,
      shopifyProductType: input.shopifyProductType,
      variantConditions: input.variantConditions,
      notes: input.notes ?? null,
      supplierMappings: {
        create: input.supplierMappings.map(m => ({
          supplierProductId: m.supplierProductId,
          preferenceRank: m.preferenceRank,
        })),
      },
      overrides: {
        create: input.overrides.map(o => ({
          supplierProductId: o.supplierProductId,
          attributeCombo: o.attributeCombo,
          notes: o.notes ?? null,
        })),
      },
    },
  })
}

export async function updateProductBase(id: string, input: ProductBaseInput) {
  return prisma.$transaction(async (tx) => {
    await tx.productBaseSupplierMapping.deleteMany({ where: { productBaseId: id } })
    await tx.productBaseOverride.deleteMany({ where: { productBaseId: id } })
    return tx.productBase.update({
      where: { id },
      data: {
        name: input.name,
        shopifyProductType: input.shopifyProductType,
        variantConditions: input.variantConditions,
        notes: input.notes ?? null,
        supplierMappings: {
          create: input.supplierMappings.map(m => ({
            supplierProductId: m.supplierProductId,
            preferenceRank: m.preferenceRank,
          })),
        },
        overrides: {
          create: input.overrides.map(o => ({
            supplierProductId: o.supplierProductId,
            attributeCombo: o.attributeCombo,
            notes: o.notes ?? null,
          })),
        },
      },
    })
  })
}

export async function deleteProductBase(id: string) {
  return prisma.productBase.delete({ where: { id } })
}

// ── Load all data for resolver (called during sync) ──────────────────────

export async function loadProductBasesForResolver(): Promise<ProductBaseData[]> {
  const bases = await prisma.productBase.findMany({
    // Unordered, two bases matching the same line resolved to whichever the database happened
    // to return first — so saving any base could silently re-map a different product. Oldest
    // first keeps the original, deliberate base ahead of a later catch-all.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: {
      supplierMappings: { orderBy: { preferenceRank: 'asc' } },
      overrides: { orderBy: { id: 'asc' } },
    },
  })
  return bases.map(b => ({
    id: b.id,
    shopifyProductType: b.shopifyProductType,
    variantConditions: b.variantConditions,
    supplierMappings: b.supplierMappings.map(m => ({
      preferenceRank: m.preferenceRank,
      supplierProductId: m.supplierProductId,
    })),
    overrides: b.overrides.map(o => ({
      attributeCombo: o.attributeCombo,
      supplierProductId: o.supplierProductId,
    })),
  }))
}

export async function loadVariantManualMappingsForResolver(): Promise<VariantManualMappingData[]> {
  const mappings = await prisma.variantManualMapping.findMany()
  return mappings.map(m => ({
    shopifyVariantId: m.shopifyVariantId,
    supplierProductId: m.supplierProductId,
  }))
}

// ── Manual Mapping ────────────────────────────────────────

export async function getPendingMappingQueue() {
  const lines = await prisma.orderLine.findMany({
    where: {
      order: { pipelineStatus: 'PENDING_MAPPING' },
      resolvedSupplierId: null,
      shopifyVariantId: { not: null },
    },
    include: {
      order: {
        select: {
          id: true,
          shopifyOrderNumber: true,
          pipelineStatus: true,
          projectId: true,
        },
      },
    },
    orderBy: { order: { placedAt: 'desc' } },
    take: 500,
  })
  const seen = new Set<string>()
  return lines.filter(l => {
    if (isNonProductLine(l)) return false
    if (!l.shopifyVariantId || seen.has(l.shopifyVariantId)) return false
    seen.add(l.shopifyVariantId)
    return true
  })
}

export async function listVariantManualMappings() {
  return prisma.variantManualMapping.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      supplierProduct: {
        include: { supplier: { select: { id: true, name: true, code: true } } },
      },
    },
  })
}

export type SaveManualMappingInput = {
  shopifyVariantId: string
  shopifyProductTitle: string
  variantTitle?: string | null
  supplierProductId: string
  productBaseId?: string | null
  notes?: string | null
}

export async function saveManualMapping(input: SaveManualMappingInput) {
  return prisma.$transaction(async (tx) => {
    const mapping = await tx.variantManualMapping.upsert({
      where: { shopifyVariantId: input.shopifyVariantId },
      create: {
        shopifyVariantId: input.shopifyVariantId,
        shopifyProductTitle: input.shopifyProductTitle,
        variantTitle: input.variantTitle ?? null,
        supplierProductId: input.supplierProductId,
        productBaseId: input.productBaseId ?? null,
        notes: input.notes ?? null,
      },
      update: {
        supplierProductId: input.supplierProductId,
        productBaseId: input.productBaseId ?? null,
        notes: input.notes ?? null,
      },
      include: {
        supplierProduct: {
          include: { supplier: { select: { id: true, name: true, code: true } } },
        },
      },
    })

    // Immediately apply the resolved supplier to all unresolved lines with this variant
    const supplierProduct = await tx.supplierProduct.findUnique({
      where: { id: input.supplierProductId },
      select: { supplierId: true, sku: true },
    })
    if (supplierProduct) {
      // Base cost and shipping snapshot are filled by recalculateMissingOrderLineCosts
      // (it only visits lines with resolvedBaseCost = null), so leave cost fields untouched here.
      await tx.orderLine.updateMany({
        where: { shopifyVariantId: input.shopifyVariantId, resolvedSupplierId: null },
        data: {
          resolvedSupplierId: supplierProduct.supplierId,
          resolvedSupplierSku: supplierProduct.sku,
        },
      })
    }

    const affectedLines = await tx.orderLine.findMany({
      where: { shopifyVariantId: input.shopifyVariantId },
      select: { orderId: true },
    })
    const orderIds = Array.from(new Set(affectedLines.map(l => l.orderId)))
    if (orderIds.length > 0) {
      const orders = await tx.order.findMany({
        where: { id: { in: orderIds }, pipelineStatus: { in: ['PENDING_MAPPING', 'PENDING_DESIGN', 'AWAITING_PAYMENT', 'WARNING'] } },
        select: {
          id: true,
          designReady: true,
          financialStatus: true,
          fulfillmentStatus: true,
          pipelineStatus: true,
          orderType: true,
          lines: {
            select: {
              sku: true,
              productTitle: true,
              shopifyProductType: true,
              resolvedSupplierId: true,
              shopifyVariantId: true,
            },
          },
        },
      })
      for (const order of orders) {
        const skuLines = order.lines.filter(l => l.sku && !isNonProductLine(l))
        const willBeMapped = skuLines.length > 0 && skuLines.every(l => l.resolvedSupplierId)
        const currentStatus = isValidPipelineStatus(order.pipelineStatus) ? order.pipelineStatus as PipelineStatus : null
        const pipelineStatus = autoDetectStatus({
          financialStatus: order.financialStatus,
          fulfillmentStatus: order.fulfillmentStatus,
          hasUnmappedSku: !willBeMapped,
          hasPendingMapping: !willBeMapped,
          hasCustomDesignLine: order.orderType === 'CUSTOM',
          hasDesignLine: skuLines.some(l => l.resolvedSupplierId),
          hasDesignReady: order.designReady,
          currentStatus,
        })
        await tx.order.update({ where: { id: order.id }, data: { pipelineStatus } })
      }
    }

    return mapping
  })
}

export async function deleteManualMapping(id: string) {
  return prisma.variantManualMapping.delete({ where: { id } })
}
