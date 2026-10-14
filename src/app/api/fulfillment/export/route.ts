import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getTemplateById, parseTemplateColumns } from '@/lib/repos/templates'
import { listOrdersWithLines, markOrdersExported } from '@/lib/repos/orders'
import { renderCsv, type CsvTemplate as RenderTemplate, type OrderForCsv } from '@/lib/csv-template'
import { isNonProductLine } from '@/lib/order-lines'
import { effectiveBaseCost } from '@/lib/order-profit'
import { pickExportDesignLink } from '@/lib/export-design'
import { DESIGN_AREA_SOURCE_PREFIX, MOCKUP_LINK_SOURCE } from '@/lib/csv-template'
import { exportLinkErrorMessage, resolveExportDesignLinks } from '@/lib/export-design-links'
import { exportProgress, exportProgressLabel, isLineExported, mixedSupplierNote } from '@/lib/line-export'

const LINE_DESIGN_SOURCES = ['line.designDriveLink', 'line.designLinks']
const ORDER_DESIGN_SOURCE = 'order.designDriveLink'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || !body.templateId) {
    return NextResponse.json({ error: 'templateId required' }, { status: 400 })
  }

  const tmpl = await getTemplateById(body.templateId)
  if (!tmpl) return NextResponse.json({ error: 'Template not found' }, { status: 404 })

  const reExport = body.reExport === true
  // Every order with a line of this supplier, also when another supplier holds most of it (defaultSupplierId).
  const matched = await listOrdersWithLines({
    projectId: body.projectId || undefined,
    lineSupplierId: tmpl.supplierId,
    pipelineStatus: body.pipelineStatus || undefined,
    dateFrom: body.dateFrom ? new Date(body.dateFrom + 'T00:00:00Z') : undefined,
    dateTo: body.dateTo ? new Date(body.dateTo + 'T23:59:59.999Z') : undefined,
    limit: 5000,
  })
  const handedOff = body.handoffOnly === true ? matched.filter(o => o.supplierHandoffAt != null) : matched

  const supplierLinesOf = (o: (typeof matched)[number]) => o.lines.filter(l =>
    !isNonProductLine(l) &&
    l.resolvedSupplierId === tmpl.supplierId &&
    Boolean(l.resolvedSupplierSku)
  )
  // Lines already sent to a supplier stay out of the file unless the operator asks to send them again.
  const includedIds = new Set<string>()
  let skippedExportedLines = 0
  for (const o of handedOff) {
    for (const l of supplierLinesOf(o)) {
      if (!reExport && isLineExported(o, l)) skippedExportedLines++
      else includedIds.add(l.id)
    }
  }
  const orders = handedOff.filter(o => o.lines.some(l => includedIds.has(l.id)))

  const supplierSkus = Array.from(new Set(
    orders.flatMap(o => o.lines.map(l => l.resolvedSupplierSku).filter((sku): sku is string => Boolean(sku))),
  ))
  const supplierProducts = supplierSkus.length > 0
    ? await prisma.supplierProduct.findMany({
      where: { supplierId: tmpl.supplierId, sku: { in: supplierSkus } },
      select: {
        sku: true,
        baseSku: true,
        productType: true,
        productName: true,
        variant1Name: true,
        variant1Value: true,
        variant2Name: true,
        variant2Value: true,
      },
    })
    : []
  const supplierProductBySku = new Map(supplierProducts.map(p => [p.sku, p]))
  const shopifySkus = Array.from(new Set(
    orders.flatMap(o => o.lines.map(l => l.sku).filter((sku): sku is string => Boolean(sku))),
  ))
  const skuDesigns = shopifySkus.length > 0
    ? await prisma.skuDesign.findMany({
      where: { sku: { in: shopifySkus } },
      select: { sku: true, driveLink: true },
    })
    : []
  const skuDesignBySku = new Map(skuDesigns.map(s => [s.sku, s]))

  const exportableLinesOf = (o: (typeof orders)[number]) => supplierLinesOf(o).filter(l => includedIds.has(l.id))
  const templateColumns = parseTemplateColumns(tmpl.columns)
  const perOrder = tmpl.rowMode === 'PER_ORDER'
  const wantsOrderLink = templateColumns.some(c => c.source === ORDER_DESIGN_SOURCE)
  const wantsJoinedLinks = !perOrder && templateColumns.some(c => LINE_DESIGN_SOURCES.includes(c.source))
  const wantsAreaLinks = !perOrder && templateColumns.some(c => c.source.startsWith(DESIGN_AREA_SOURCE_PREFIX))
  const wantsMockupLinks = !perOrder && templateColumns.some(c => c.source === MOCKUP_LINK_SOURCE)
  const wantsLineLinks = wantsJoinedLinks || wantsAreaLinks
  // Links are resolved only for the columns the template prints, so a template without a design column never fails on one.
  const designLinks = await resolveExportDesignLinks(
    wantsOrderLink || wantsLineLinks || wantsMockupLinks
      ? orders.flatMap(o => {
        const lines = exportableLinesOf(o)
        if (lines.length === 0) return []
        // The order-level link is printed by its own column, or as the fallback of a line that has no link.
        const orderLinkUsed = wantsOrderLink || (wantsLineLinks && lines.some(l => !l.designDriveLink))
        return [{
          id: o.id, storeId: o.storeId, shopifyOrderNumber: o.shopifyOrderNumber,
          designDriveLink: orderLinkUsed ? o.designDriveLink : null, lines: wantsLineLinks || wantsMockupLinks ? lines : [],
        }]
      })
      : [],
    { design: wantsJoinedLinks, areas: wantsAreaLinks, mockup: wantsMockupLinks },
  )
  if (designLinks.problems.length > 0) {
    return NextResponse.json({
      error: exportLinkErrorMessage(designLinks.problems),
      orders: Array.from(new Set(designLinks.problems.map(p => p.orderNumber))),
      problems: designLinks.problems,
    }, { status: 400 })
  }

  const ordersForCsv: OrderForCsv[] = orders
    .map(o => {
      const productLines = o.lines.filter(l => !isNonProductLine(l))
      const productLineNumberById = new Map(productLines.map((line, idx) => [line.id, idx + 1]))
      const exportableLines = exportableLinesOf(o)
      return {
        shopifyOrderNumber: o.shopifyOrderNumber,
        customerName: o.customerName,
        customerEmail: o.customerEmail,
        shippingCountry: o.shippingCountry,
        shippingState: o.shippingState,
        shippingName: o.shippingName,
        shippingAddress1: o.shippingAddress1,
        shippingAddress2: o.shippingAddress2,
        shippingCity: o.shippingCity,
        shippingZip: o.shippingZip,
        shippingPhone: o.shippingPhone,
        financialStatus: o.financialStatus,
        fulfillmentStatus: o.fulfillmentStatus,
        designDriveLink: designLinks.translate(o.designDriveLink),
        trelloCardUrl: o.trelloCardUrl,
        placedAt: o.placedAt,
        lines: exportableLines.map(l => {
          const supplierProduct = l.resolvedSupplierSku ? supplierProductBySku.get(l.resolvedSupplierSku) : null
          const studio = designLinks.byLineId.get(l.id)
          const designDriveLink = studio?.joined ?? designLinks.translate(pickExportDesignLink({
            lineDesignLink: l.designDriveLink,
            orderDesignLink: o.designDriveLink,
            orderType: o.orderType,
            sku: l.sku,
            skuDesignLink: l.sku ? skuDesignBySku.get(l.sku)?.driveLink ?? null : null,
          }))
          const lineNumber = productLineNumberById.get(l.id) ?? 1
          return {
            lineKey: `${o.shopifyOrderNumber.replace(/^#/, '')}_${lineNumber}`,
            sku: l.sku,
            supplierSku: l.resolvedSupplierSku,
            supplierBaseSku: supplierProduct?.baseSku ?? null,
            qty: l.qty,
            productTitle: l.productTitle,
            variantTitle: l.variantTitle,
            unitPrice: l.unitPrice,
            supplierProductType: supplierProduct?.productType ?? null,
            supplierProductName: supplierProduct?.productName ?? null,
            supplierVariant1Name: supplierProduct?.variant1Name ?? null,
            supplierVariant1Value: supplierProduct?.variant1Value ?? null,
            supplierVariant2Name: supplierProduct?.variant2Name ?? null,
            supplierVariant2Value: supplierProduct?.variant2Value ?? null,
            previewCdnUrl: l.previewCdnUrl,
            designDriveLink,
            designLinks: designDriveLink,
            designAreaLinks: studio?.byArea ?? null,
            mockupLink: designLinks.mockupByLineId.get(l.id) ?? l.previewCdnUrl ?? l.imageUrl ?? null,
            crogsPrice: effectiveBaseCost(l),
            crogsTotal: effectiveBaseCost(l) == null ? null : effectiveBaseCost(l)! * l.qty,
          }
        }),
      }
    })
    .filter(o => o.lines.length > 0)

  const renderTmpl: RenderTemplate = {
    rowMode: perOrder ? 'PER_ORDER' : 'PER_LINE',
    columns: templateColumns,
  }
  const csv = renderCsv(renderTmpl, ordersForCsv)

  const inCsv = new Set(ordersForCsv.map(o => o.shopifyOrderNumber))
  const csvOrders = orders.filter(o => inCsv.has(o.shopifyOrderNumber))

  let marked = { count: 0, lines: 0, completed: [] as string[] }
  if (body.markExported && csvOrders.length > 0) {
    const lineIds = csvOrders.flatMap(o => exportableLinesOf(o).map(l => l.id))
    marked = await markOrdersExported(csvOrders.map(o => o.id), tmpl.supplierId, new Date(), undefined, { lineIds })
  }

  if (body.preview) {
    const otherIds = Array.from(new Set(csvOrders.flatMap(o => o.lines.map(l => l.resolvedSupplierId).filter((x): x is string => !!x && x !== tmpl.supplierId))))
    const others = otherIds.length ? await prisma.supplier.findMany({ where: { id: { in: otherIds } }, select: { id: true, name: true } }) : []
    const nameById = new Map([[tmpl.supplierId, tmpl.supplier.name], ...others.map(s => [s.id, s.name] as [string, string])])
    const nameOf = (id: string) => nameById.get(id) ?? 'xưởng không rõ'
    const previewOrders = csvOrders.map(o => {
      const productLines = o.lines.filter(l => !isNonProductLine(l))
      const productLineNumberById = new Map(productLines.map((line, idx) => [line.id, idx + 1]))
      const progress = exportProgress(o)
      return {
        shopifyOrderNumber: o.shopifyOrderNumber,
        pipelineStatus: o.pipelineStatus,
        designHandedOff: o.supplierHandoffAt != null,
        handoffMode: o.supplierHandoffMode,
        lines: supplierLinesOf(o).map(l => ({
          linePosition: l.linePosition,
          lineKey: `${o.shopifyOrderNumber.replace(/^#/, '')}_${productLineNumberById.get(l.id) ?? 1}`,
          productTitle: l.productTitle,
          variantTitle: l.variantTitle,
          included: includedIds.has(l.id),
          alreadyExported: isLineExported(o, l),
        })),
        mixedNote: mixedSupplierNote(o, nameOf),
        exportProgress: progress.partial ? exportProgressLabel(progress) : null,
      }
    })
    return NextResponse.json({
      orderCount: ordersForCsv.length,
      csv,
      supplierCode: tmpl.supplier.code,
      supplierName: tmpl.supplier.name,
      orders: previewOrders,
      handoffCount: previewOrders.filter(o => o.designHandedOff).length,
      reExport,
      skippedExportedLines,
    })
  }

  const dateRange = `${body.dateFrom ?? 'all'}_to_${body.dateTo ?? 'all'}`
  const filename = `${tmpl.supplier.code}_${dateRange}.csv`
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Export-Lines-Marked': String(marked.lines),
      'X-Export-Orders-Completed': String(marked.completed.length),
      'X-Export-Orders-Partial': String(Math.max(0, marked.count - marked.completed.length)),
    },
  })
}
