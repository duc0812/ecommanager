import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getTemplateById, parseTemplateColumns } from '@/lib/repos/templates'
import { listOrdersWithLines } from '@/lib/repos/orders'
import { renderCsv, type CsvTemplate as RenderTemplate, type OrderForCsv } from '@/lib/csv-template'
import { isNonProductLine } from '@/lib/order-lines'
import { effectiveBaseCost } from '@/lib/order-profit'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || !body.templateId) {
    return NextResponse.json({ error: 'templateId required' }, { status: 400 })
  }

  const tmpl = await getTemplateById(body.templateId)
  if (!tmpl) return NextResponse.json({ error: 'Template not found' }, { status: 404 })

  const orders = await listOrdersWithLines({
    projectId: body.projectId || undefined,
    supplierId: tmpl.supplierId,
    pipelineStatus: body.pipelineStatus || undefined,
    dateFrom: body.dateFrom ? new Date(body.dateFrom + 'T00:00:00Z') : undefined,
    dateTo: body.dateTo ? new Date(body.dateTo + 'T23:59:59.999Z') : undefined,
    limit: 5000,
  })

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

  const ordersForCsv: OrderForCsv[] = orders
    .map(o => {
      const productLines = o.lines.filter(l => !isNonProductLine(l))
      const productLineNumberById = new Map(productLines.map((line, idx) => [line.id, idx + 1]))
      const exportableLines = o.lines.filter(l =>
        !isNonProductLine(l) &&
        l.resolvedSupplierId === tmpl.supplierId &&
        Boolean(l.resolvedSupplierSku)
      )
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
        designDriveLink: o.designDriveLink,
        trelloCardUrl: o.trelloCardUrl,
        placedAt: o.placedAt,
        lines: exportableLines.map(l => {
          const supplierProduct = l.resolvedSupplierSku ? supplierProductBySku.get(l.resolvedSupplierSku) : null
          const designDriveLink =
            l.designDriveLink ??
            (productLines.length === 1 ? o.designDriveLink : null) ??
            (o.orderType !== 'CUSTOM' && l.sku ? skuDesignBySku.get(l.sku)?.driveLink ?? null : null)
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
            crogsPrice: effectiveBaseCost(l),
            crogsTotal: effectiveBaseCost(l) == null ? null : effectiveBaseCost(l)! * l.qty,
          }
        }),
      }
    })
    .filter(o => o.lines.length > 0)

  const renderTmpl: RenderTemplate = {
    rowMode: tmpl.rowMode === 'PER_ORDER' ? 'PER_ORDER' : 'PER_LINE',
    columns: parseTemplateColumns(tmpl.columns),
  }
  const csv = renderCsv(renderTmpl, ordersForCsv)

  // Mark exported if requested
  if (body.markExported && ordersForCsv.length > 0) {
    const exportedOrderNumbers = new Set(ordersForCsv.map(o => o.shopifyOrderNumber))
    const orderIds = orders.filter(o => exportedOrderNumbers.has(o.shopifyOrderNumber)).map(o => o.id)
    if (orderIds.length > 0) {
      await prisma.order.updateMany({
        where: { id: { in: orderIds } },
        data: {
          exportedAt: new Date(),
          exportedToSupplierId: tmpl.supplierId,
          pipelineStatus: 'EXPORTED',
        },
      })
    }
  }

  // If preview mode, return JSON; otherwise CSV with attachment header
  if (body.preview) {
    return NextResponse.json({
      orderCount: ordersForCsv.length,
      csv,
      supplierCode: tmpl.supplier.code,
      supplierName: tmpl.supplier.name,
    })
  }

  const dateRange = `${body.dateFrom ?? 'all'}_to_${body.dateTo ?? 'all'}`
  const filename = `${tmpl.supplier.code}_${dateRange}.csv`
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
