import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { fetchOrdersPage, fetchShopInfo } from '@/lib/shopify-orders'
import { computeOrderPL, type SupplierInput } from '@/lib/pl-calculator'
import { upsertOrderWithLines } from '@/lib/repos/orders'
import { autoDetectStatus, isValidPipelineStatus, type PipelineStatus } from '@/lib/pipeline-status'
import { resolveZone, type SupplierZoneOverrides } from '@/lib/regions'
import { getShopifyConnection } from '@/lib/token-store'
import { resolveByProductBase } from '@/lib/product-mapping'
import { loadProductBasesForResolver, loadVariantManualMappingsForResolver } from '@/lib/repos/mapping'
import { classifyOrderLines, buildTrelloCardContent } from '@/lib/order-classify'
import { isNonProductLine } from '@/lib/order-lines'
import { createTrelloCard, addAttachmentToCard, getTrelloConfig, shouldCreateCard } from '@/lib/trello'
import { extractPreviewCdnUrl } from '@/lib/order-line-assets'

type ResolvedSupplierProduct = SupplierInput & {
  sku: string
  requiresDesign: boolean
}

function safeParseShipping(json: string | null): SupplierInput['shippingByRegion'] {
  if (!json) return undefined
  try {
    const parsed = JSON.parse(json)
    if (typeof parsed === 'object' && parsed !== null) return parsed
  } catch {}
  return undefined
}

function supplierParentKey(product: { supplierId: string; productName: string | null; productType: string | null; baseSku: string | null }): string {
  return [
    product.supplierId,
    product.productName ?? '',
    product.productType ?? '',
    product.baseSku ?? '',
  ].join('|')
}

function normalize(v: string | null | undefined): string {
  return (v ?? '').toLowerCase().trim()
}


function orderNumberValue(orderName: string | null | undefined) {
  const raw = orderName?.match(/\d+/)?.[0]
  return raw ? Number(raw) : null
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const fromOrderName = typeof body.fromOrderName === 'string' && body.fromOrderName.trim()
    ? body.fromOrderName.trim()
    : null
  const fromOrderNumber = orderNumberValue(fromOrderName)

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

  // Always re-scan a short rolling window. Shopify order updates can arrive
  // after the first import, and using only the last sync timestamp can miss
  // newly created orders around timezone/payment-status boundaries.
  const rollingLookbackDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  const fromOrder = fromOrderName
    ? await prisma.order.findFirst({
        where: { shopifyOrderNumber: fromOrderName },
        select: { placedAt: true },
      })
    : null
  const sinceDate = fromOrderName
    ? (fromOrder?.placedAt ?? new Date(Date.now() - 120 * 24 * 60 * 60 * 1000))
    : store.syncSinceDate
      ? new Date(Math.min(store.syncSinceDate.getTime(), rollingLookbackDate.getTime()))
      : new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
  const sinceIso = sinceDate.toISOString().split('T')[0]
  const shopInfo = await fetchShopInfo(shop, accessToken).catch(() => ({
    ianaTimezone: store.ianaTimezone ?? null,
    timezoneAbbreviation: null,
  }))
  const shopTimezone = shopInfo.ianaTimezone ?? store.ianaTimezone ?? null

  const productBases = await loadProductBasesForResolver()
  const manualMappings = await loadVariantManualMappingsForResolver()
  const supplierProducts = await prisma.supplierProduct.findMany({
    include: { supplier: true },
  })
  const supplierProductById = new Map<string, ResolvedSupplierProduct>(
    supplierProducts.filter(p => p.supplier.isActive).map(p => [p.id, {
      supplierId: p.supplierId,
      sku: p.sku,
      baseCost: p.baseCost,
      firstItemShipFee: p.supplier.firstItemShipFee,
      additionalItemShipFee: p.supplier.additionalItemShipFee,
      requiresDesign: p.requiresDesign,
      shippingByRegion: safeParseShipping(p.shippingByRegion),
    }]),
  )
  const rawSupplierProductById = new Map(supplierProducts.map(p => [p.id, p]))
  const supplierProductsByParent = new Map<string, typeof supplierProducts>()
  for (const p of supplierProducts.filter(p => p.supplier.isActive)) {
    const key = supplierParentKey(p)
    const existing = supplierProductsByParent.get(key) ?? []
    existing.push(p)
    supplierProductsByParent.set(key, existing)
  }

  function resolveSupplierProductIdForLine(
    supplierProductId: string | null,
    selectedOptions: Record<string, string>,
    resolvedVia: ReturnType<typeof resolveByProductBase>['resolvedVia'],
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
  let skippedBeforeFromOrder = 0
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
      const currentOrderNumber = orderNumberValue(o.name)
      if (fromOrderNumber != null && (currentOrderNumber == null || currentOrderNumber < fromOrderNumber)) {
        skippedBeforeFromOrder++
        continue
      }

      const totalFees = o.transactions
        .filter(t => t.kind !== 'REFUND' && t.status === 'SUCCESS')
        .reduce((sum, t) => sum + t.fees, 0)
      const grossExcludingMarketplaceTax = o.grossAmount - o.taxMarketplaceCollected
      const resolvedLines = o.lines.map(l => ({
        line: l,
        pbResolve: (() => {
          if (isNonProductLine({ sku: l.sku, productTitle: l.title, shopifyProductType: l.productType })) {
            return { supplierProductId: null, resolvedVia: 'unresolved' as const }
          }
          const result = resolveByProductBase(
            l.variantId,
            l.productType,
            l.selectedOptions,
            productBases,
            manualMappings,
          )
          return {
            ...result,
            supplierProductId: resolveSupplierProductIdForLine(
              result.supplierProductId,
              l.selectedOptions,
              result.resolvedVia,
            ),
          }
        })(),
      }))

      const productLines = resolvedLines.filter(r => !isNonProductLine({
        sku: r.line.sku,
        productTitle: r.line.title,
        shopifyProductType: r.line.productType,
      }))
      const hasPendingMapping = productLines.some(r => r.pbResolve.resolvedVia === 'unresolved')
      const allProductLinesMapped = productLines.length > 0 &&
        productLines.every(r => !!r.pbResolve.supplierProductId)

      // Determine shipping zone via Product Mapping result only.
      let supplierIdForZone: string | undefined
      for (const r of resolvedLines) {
        const supplier = r.pbResolve.supplierProductId ? supplierProductById.get(r.pbResolve.supplierProductId) : null
        if (supplier) { supplierIdForZone = supplier.supplierId; break }
      }
      const overrides = supplierIdForZone ? overridesBySupplier[supplierIdForZone] : undefined
      const shippingZone = resolveZone(o.shippingCountry, overrides)

      const pl = computeOrderPL(
        {
          grossAmount: grossExcludingMarketplaceTax,
          totalFees,
          refundedAmount: o.refundedAmount,
          shippingZone,
          lines: resolvedLines.map(({ line, pbResolve }) => ({
            sku: line.sku,
            qty: line.quantity,
            unitPrice: line.unitPrice,
            isNonProductLine: isNonProductLine({
              sku: line.sku,
              productTitle: line.title,
              shopifyProductType: line.productType,
            }),
            resolvedSupplier: pbResolve.supplierProductId
              ? supplierProductById.get(pbResolve.supplierProductId) ?? null
              : null,
          })),
        },
        {},
      )
      if (pl.hasUnmappedSku) withUnmappedSku++

      // Read existing order to preserve manual status
      const existing = await prisma.order.findUnique({ where: { id: o.id }, select: { pipelineStatus: true, designReady: true } })
      const currentStatus = existing && isValidPipelineStatus(existing.pipelineStatus)
        ? existing.pipelineStatus as PipelineStatus
        : null

      // Check if any line maps to a product requiring custom design
      const hasCustomDesignLine = resolvedLines.some(r => {
        const resolved = r.pbResolve.supplierProductId ? supplierProductById.get(r.pbResolve.supplierProductId) : null
        return !!resolved?.requiresDesign
      })

      const detected = autoDetectStatus({
        financialStatus: o.financialStatus,
        hasUnmappedSku: pl.hasUnmappedSku,
        hasPendingMapping,
        hasCustomDesignLine,
        hasDesignReady: existing?.designReady ?? false,
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
        subtotalAmount: o.subtotal,
        shippingAmount: o.shipping,
        taxAmount: o.tax,
        expectedPayout: pl.expectedPayout,
        totalFees,
        refundedAmount: o.refundedAmount,
        defaultSupplierId: pl.hasUnmappedSku ? null : pl.defaultSupplierId,
        placedAt: new Date(o.createdAt),
        shopTimezone,
        pipelineStatus: detected,
        shippingZone,
        shippingName: o.shippingName,
        shippingAddress1: o.shippingAddress1,
        shippingAddress2: o.shippingAddress2,
        shippingCity: o.shippingCity,
        shippingZip: o.shippingZip,
        shippingPhone: o.shippingPhone,
        lines: o.lines.map((l, idx) => {
          const resolved = pl.perLineCost[idx]
          if (!resolved) throw new Error(`perLineCost[${idx}] missing for order ${o.id}`)
          return {
            shopifyLineId: l.id,
            sku: l.sku,
            variantTitle: l.variantTitle,
            productTitle: l.title,
            qty: l.quantity,
            linePosition: idx + 1,
            unitPrice: l.unitPrice,
            resolvedSupplierId: resolved.resolvedSupplierId,
            resolvedBaseCost: resolved.resolvedBaseCost,
            // Snapshot the order-level shipping breakdown on each line for reporting flexibility
            resolvedShipFirst: pl.resolvedShipFirst,
            resolvedShipAdditional: pl.resolvedShipAdditional,
            resolvedImportTax: pl.resolvedImportTaxPerUnit,
            previewCdnUrl: extractPreviewCdnUrl(l.customAttributes),
            shopifyVariantId: l.variantId,
            shopifyProductType: l.productType,
            variantOptions: Object.keys(l.selectedOptions).length > 0 ? JSON.stringify(l.selectedOptions) : null,
            resolvedSupplierSku: resolved.resolvedSupplierId
              ? (resolvedLines[idx]?.pbResolve.supplierProductId
                ? supplierProductById.get(resolvedLines[idx].pbResolve.supplierProductId!)?.sku ?? null
                : null)
              : null,
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
      if (!allProductLinesMapped && existingOrder?.trelloCardId) {
        await prisma.order.update({
          where: { id: o.id },
          data: {
            trelloCardId: null,
            trelloCardUrl: null,
            designReady: false,
            designDriveLink: null,
          },
        })
      }

      // Create Trello card if needed
      if (
        trelloConfig &&
        allProductLinesMapped &&
        existingOrder?.trelloCardId == null &&
        shouldCreateCard(o.name, trelloConfig.syncFromOrderName)
      ) {
        let needsCard = false

        if (orderType === 'CUSTOM') {
          needsCard = true
        } else if (orderType === 'NON_CUSTOM') {
          const skus = o.lines
            .filter(l => !isNonProductLine({ sku: l.sku, productTitle: l.title, shopifyProductType: l.productType }))
            .map(l => l.sku).filter(Boolean) as string[]
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
              shopifyProductType: l.productType,
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

            // Attach preview images for CUSTOM orders so designers see mockups directly on the card
            if (orderType === 'CUSTOM') {
              const orderToken = o.name.replace(/^#/, '')
              const productCardLines = cardLines.filter(l => l.sku)
              for (let idx = 0; idx < productCardLines.length; idx += 1) {
                const l = productCardLines[idx]
                const preview = l.customAttributes.find(a => a.key === '_customall_preview')?.value
                if (preview) {
                  await addAttachmentToCard(trelloConfig, card.id, preview, `🖼 Preview – ${l.sku ?? 'N/A'}`)
                    .catch(e => errors.push(`Trello attach preview failed for ${o.name}: ${e.message}`))
                }
              }
            }

            // For NON_CUSTOM: upsert SkuDesign records with trelloCardId
            if (orderType === 'NON_CUSTOM') {
              const skus = o.lines
                .filter(l => !isNonProductLine({ sku: l.sku, productTitle: l.title, shopifyProductType: l.productType }))
                .map(l => l.sku).filter(Boolean) as string[]
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
    data: {
      lastSyncAt: new Date(),
      syncSinceDate: new Date(),
      ...(shopTimezone ? { ianaTimezone: shopTimezone } : {}),
    },
  })

  if (errors.length > 0 && totalSynced === 0) {
    return NextResponse.json({
      error: errors[0],
      totalSynced,
      withUnmappedSku,
      errors,
      projectId: store.projectId,
      projectName: store.project.name,
      fromOrderName,
      skippedBeforeFromOrder,
    }, { status: 502 })
  }

  return NextResponse.json({
    totalSynced,
    withUnmappedSku,
    errors,
    projectId: store.projectId,
    projectName: store.project.name,
    fromOrderName,
    skippedBeforeFromOrder,
  })
}
