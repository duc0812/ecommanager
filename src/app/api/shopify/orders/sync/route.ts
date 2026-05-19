import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { fetchOrdersPage } from '@/lib/shopify-orders'
import { computeOrderPL } from '@/lib/pl-calculator'
import { buildSkuPriceMap } from '@/lib/repos/suppliers'
import { upsertOrderWithLines } from '@/lib/repos/orders'
import { autoDetectStatus, isValidPipelineStatus, type PipelineStatus } from '@/lib/pipeline-status'
import { resolveZone, type SupplierZoneOverrides } from '@/lib/regions'

export async function POST(req: NextRequest) {
  const shop = req.headers.get('x-shopify-shop-domain')
  const accessToken = req.headers.get('x-shopify-access-token')
  if (!shop || !accessToken) {
    return NextResponse.json({ error: 'Missing shop domain or access token headers' }, { status: 400 })
  }

  const store = await prisma.shopifyStore.findUnique({
    where: { shop },
    include: { project: true },
  })
  if (!store) {
    return NextResponse.json({ error: 'Store not found in DB. Connect via /setup first.' }, { status: 404 })
  }
  if (!store.projectId || !store.project) {
    return NextResponse.json({
      error: 'Store not linked to a project. Go to /setup/projects and assign this store to a project.',
    }, { status: 400 })
  }
  if (store.project.archivedAt) {
    return NextResponse.json({ error: 'Project is archived; un-archive before syncing.' }, { status: 400 })
  }

  const sinceDate = store.syncSinceDate
    ?? new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
  const sinceIso = sinceDate.toISOString().split('T')[0]

  const priceMap = await buildSkuPriceMap()

  const allOverrides = await prisma.supplierZoneOverride.findMany()
  const overridesBySupplier: Record<string, SupplierZoneOverrides> = {}
  for (const o of allOverrides) {
    if (!overridesBySupplier[o.supplierId]) overridesBySupplier[o.supplierId] = {}
    try {
      const codes = JSON.parse(o.countryCodes)
      if (Array.isArray(codes)) overridesBySupplier[o.supplierId][o.zoneCode] = codes
    } catch {}
  }

  let cursor: string | null = null
  let totalSynced = 0
  let withUnmappedSku = 0
  const errors: string[] = []

  do {
    let page
    try {
      page = await fetchOrdersPage(shop, accessToken, cursor, sinceIso)
    } catch (e: any) {
      errors.push(e.message)
      break
    }

    for (const o of page.orders) {
      const totalFees = o.transactions
        .filter(t => t.kind !== 'REFUND' && t.status === 'SUCCESS')
        .reduce((sum, t) => sum + t.fees, 0)
      const grossExcludingMarketplaceTax = o.grossAmount - o.taxMarketplaceCollected

      // Determine shipping zone via majority supplier overrides
      let supplierIdForZone: string | undefined
      for (const l of o.lines) {
        if (l.sku && priceMap[l.sku]) { supplierIdForZone = priceMap[l.sku].supplierId; break }
      }
      const overrides = supplierIdForZone ? overridesBySupplier[supplierIdForZone] : undefined
      const shippingZone = resolveZone(o.shippingCountry, overrides)

      const pl = computeOrderPL(
        {
          grossAmount: grossExcludingMarketplaceTax,
          totalFees,
          refundedAmount: o.refundedAmount,
          shippingZone,
          lines: o.lines.map(l => ({ sku: l.sku, qty: l.quantity, unitPrice: l.unitPrice })),
        },
        priceMap,
      )
      if (pl.hasUnmappedSku) withUnmappedSku++

      // Read existing order to preserve manual status
      const existing = await prisma.order.findUnique({ where: { id: o.id }, select: { pipelineStatus: true } })
      const currentStatus = existing && isValidPipelineStatus(existing.pipelineStatus)
        ? existing.pipelineStatus as PipelineStatus
        : null

      // Check if any line maps to a product requiring custom design
      const hasCustomDesignLine = o.lines.some(l => {
        if (!l.sku) return false
        const sup = priceMap[l.sku]
        return !!sup?.requiresDesign
      })

      const detected = autoDetectStatus({
        financialStatus: o.financialStatus,
        hasUnmappedSku: pl.hasUnmappedSku,
        hasCustomDesignLine,
        currentStatus,
      })

      await upsertOrderWithLines({
        id: o.id,
        projectId: store.projectId,
        storeId: store.id,
        shopifyOrderNumber: o.name,
        customerEmail: o.customerEmail,
        customerName: o.customerName,
        shippingCountry: o.shippingCountry,
        shippingState: o.shippingState,
        financialStatus: o.financialStatus,
        fulfillmentStatus: o.fulfillmentStatus,
        currency: o.currency,
        grossAmount: grossExcludingMarketplaceTax,
        expectedPayout: pl.expectedPayout,
        totalFees,
        refundedAmount: o.refundedAmount,
        defaultSupplierId: pl.defaultSupplierId,
        placedAt: new Date(o.processedAt ?? o.createdAt),
        pipelineStatus: detected,
        shippingZone,
        lines: o.lines.map((l, idx) => {
          const resolved = pl.perLineCost[idx]
          return {
            shopifyLineId: l.id,
            sku: l.sku,
            variantTitle: l.variantTitle,
            productTitle: l.title,
            qty: l.quantity,
            unitPrice: l.unitPrice,
            resolvedSupplierId: resolved.resolvedSupplierId,
            resolvedBaseCost: resolved.resolvedBaseCost,
            // Snapshot the order-level shipping breakdown on each line for reporting flexibility
            resolvedShipFirst: pl.resolvedShipFirst,
            resolvedShipAdditional: pl.resolvedShipAdditional,
            resolvedImportTax: pl.resolvedImportTaxPerUnit,
          }
        }),
      })
      totalSynced++
    }
    cursor = page.hasNextPage ? page.endCursor : null
  } while (cursor)

  await prisma.shopifyStore.update({
    where: { id: store.id },
    data: { lastSyncAt: new Date() },
  })

  return NextResponse.json({
    totalSynced,
    withUnmappedSku,
    errors,
    projectId: store.projectId,
    projectName: store.project.name,
  })
}
