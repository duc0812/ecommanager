import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { fetchOrdersPage } from '@/lib/shopify-orders'
import { computeOrderPL } from '@/lib/pl-calculator'
import { buildSkuPriceMap, buildSupplierProductCandidates } from '@/lib/repos/suppliers'
import { upsertOrderWithLines } from '@/lib/repos/orders'
import { autoDetectStatus, isValidPipelineStatus, type PipelineStatus } from '@/lib/pipeline-status'
import { resolveZone, type SupplierZoneOverrides } from '@/lib/regions'
import { getShopifyConnection } from '@/lib/token-store'
import { resolveSupplierForOrderLine } from '@/lib/auto-mapping'
import { classifyOrderLines, buildTrelloCardContent } from '@/lib/order-classify'
import { createTrelloCard, getTrelloConfig, shouldCreateCard } from '@/lib/trello'

export async function POST(req: NextRequest) {
  const stored = await getShopifyConnection(req.headers.get('cookie') ?? undefined)
  const shop = req.headers.get('x-shopify-shop-domain') || stored?.shop
  const accessToken = req.headers.get('x-shopify-access-token') || stored?.token
  if (!shop || !accessToken) {
    return NextResponse.json({ error: 'Not connected to Shopify. Go to /setup and connect Shopify first.' }, { status: 401 })
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
  const mappingCandidates = await buildSupplierProductCandidates()

  const allOverrides = await prisma.supplierZoneOverride.findMany()
  const overridesBySupplier: Record<string, SupplierZoneOverrides> = {}
  for (const o of allOverrides) {
    if (!overridesBySupplier[o.supplierId]) overridesBySupplier[o.supplierId] = {}
    try {
      const codes = JSON.parse(o.countryCodes)
      if (Array.isArray(codes)) overridesBySupplier[o.supplierId][o.zoneCode] = codes
    } catch {}
  }

  const trelloConfig = await getTrelloConfig()

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
      const resolvedLines = o.lines.map(l => ({
        line: l,
        mapping: resolveSupplierForOrderLine({
          sku: l.sku,
          title: l.title,
          variantTitle: l.variantTitle,
          productTags: l.productTags,
          productType: l.productType,
        }, mappingCandidates),
      }))

      // Determine shipping zone via majority supplier overrides
      let supplierIdForZone: string | undefined
      for (const r of resolvedLines) {
        if (r.mapping.supplier) { supplierIdForZone = r.mapping.supplier.supplierId; break }
      }
      const overrides = supplierIdForZone ? overridesBySupplier[supplierIdForZone] : undefined
      const shippingZone = resolveZone(o.shippingCountry, overrides)

      const pl = computeOrderPL(
        {
          grossAmount: grossExcludingMarketplaceTax,
          totalFees,
          refundedAmount: o.refundedAmount,
          shippingZone,
          lines: resolvedLines.map(({ line, mapping }) => ({
            sku: line.sku,
            qty: line.quantity,
            unitPrice: line.unitPrice,
            resolvedSupplier: mapping.supplier,
          })),
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
        const resolved = resolvedLines.find(r => r.line.id === l.id)?.mapping.supplier
        return !!resolved?.requiresDesign
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
            resolvedSupplierSku: resolved.resolvedSupplierId
              ? resolvedLines[idx]?.mapping.supplier?.sku ?? null
              : null,
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

      // Classify order type
      const classifyLines = o.lines.map(l => ({
        sku: l.sku,
        productTitle: l.title,
        customAttributes: l.customAttributes,
        productTags: l.productTags,
      }))
      const orderType = classifyOrderLines(classifyLines)

      // Update orderType in DB if not yet classified
      const existingOrder = await prisma.order.findUnique({
        where: { id: o.id },
        select: { orderType: true, trelloCardId: true },
      })
      if (existingOrder && existingOrder.orderType === 'UNKNOWN') {
        await prisma.order.update({ where: { id: o.id }, data: { orderType } })
      }

      // Create Trello card if needed
      if (
        trelloConfig &&
        existingOrder?.trelloCardId == null &&
        shouldCreateCard(o.name, trelloConfig.syncFromOrderName)
      ) {
        let needsCard = false

        if (orderType === 'CUSTOM') {
          needsCard = true
        } else if (orderType === 'NON_CUSTOM') {
          const skus = o.lines.map(l => l.sku).filter(Boolean) as string[]
          if (skus.length > 0) {
            const skuDesigns = await prisma.skuDesign.findMany({
              where: { sku: { in: skus } },
              select: { sku: true, designReady: true },
            })
            const readySkus = new Set(skuDesigns.filter(s => s.designReady).map(s => s.sku))
            needsCard = skus.some(s => !readySkus.has(s))
          }
        }

        if (needsCard) {
          try {
            const cardLines = o.lines.map(l => ({
              sku: l.sku,
              productTitle: l.title,
              customAttributes: l.customAttributes,
              productTags: l.productTags,
              variantTitle: l.variantTitle,
              qty: l.quantity,
            }))
            const { name: cardName, desc } = buildTrelloCardContent(o.name, cardLines, orderType)
            const card = await createTrelloCard(trelloConfig, cardName, desc)
            await prisma.order.update({
              where: { id: o.id },
              data: { trelloCardId: card.id, trelloCardUrl: card.url },
            })

            // For NON_CUSTOM: upsert SkuDesign records with trelloCardId
            if (orderType === 'NON_CUSTOM') {
              const skus = o.lines.map(l => l.sku).filter(Boolean) as string[]
              for (const sku of skus) {
                await prisma.skuDesign.upsert({
                  where: { sku },
                  create: { sku, trelloCardId: card.id },
                  update: { trelloCardId: card.id },
                })
              }
            }
          } catch (e: any) {
            errors.push(`Trello card creation failed for ${o.name}: ${e.message}`)
          }
        }
      }

      totalSynced++
    }
    cursor = page.hasNextPage ? page.endCursor : null
  } while (cursor)

  await prisma.shopifyStore.update({
    where: { id: store.id },
    data: { lastSyncAt: new Date() },
  })

  if (errors.length > 0 && totalSynced === 0) {
    return NextResponse.json({
      error: errors[0],
      totalSynced,
      withUnmappedSku,
      errors,
      projectId: store.projectId,
      projectName: store.project.name,
    }, { status: 502 })
  }

  return NextResponse.json({
    totalSynced,
    withUnmappedSku,
    errors,
    projectId: store.projectId,
    projectName: store.project.name,
  })
}
