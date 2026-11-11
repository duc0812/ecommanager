import { printCutCheck } from '@/lib/print-cut'
import { loadTemplateContext, pickTemplate } from '@/lib/print-template-resolve'
import { prisma } from '@/lib/db'
import type { OrderForCsv } from '@/lib/csv-template'
import { DESIGN_AREA_SOURCE_PREFIX, MOCKUP_LINK_SOURCE } from '@/lib/csv-template'
import { lineKeysOf } from '@/lib/order-lines'
import { effectiveBaseCost } from '@/lib/order-profit'
import { pickExportDesignLink } from '@/lib/export-design'
import { resolveExportDesignLinks, type ExportLinkProblem } from '@/lib/export-design-links'
import type { listOrdersWithLines } from '@/lib/repos/orders'

const LINE_DESIGN_SOURCES = ['line.designDriveLink', 'line.designLinks']
const ORDER_DESIGN_SOURCE = 'order.designDriveLink'

type ExportOrder = Awaited<ReturnType<typeof listOrdersWithLines>>[number]

/** An order still in design has no order-level link yet; a line approved ahead of the others brings its own. */
function orderLinkOf(o: ExportOrder, lines: ExportOrder['lines']): string | null {
  return o.designDriveLink ?? lines[0]?.designDriveLink ?? null
}

/** The rows of a supplier's export: what the CSV file prints and what the sheet channel writes. Links are resolved only for the columns asked for. */
export async function buildOrdersForCsv({ orders, supplierId, columns, perOrder, linesOf }: {
  orders: ExportOrder[]; supplierId: string; columns: { source: string }[]; perOrder: boolean; linesOf: (o: ExportOrder) => ExportOrder['lines']
}): Promise<{ problems: ExportLinkProblem[]; ordersForCsv: OrderForCsv[] }> {
  const candidates = orders.flatMap(order => linesOf(order).map(line => ({ order, line })))
  const profiles = candidates.length ? await prisma.productProfile.findMany({ where: {
    storeId: { in: Array.from(new Set(orders.map(o => o.storeId))) },
    shopifyProductId: { in: Array.from(new Set(candidates.map(c => c.line.shopifyProductId).filter((p): p is string => !!p))) },
  }, select: { storeId: true, shopifyProductId: true, printTemplateId: true } }) : []
  const profileByKey = new Map(profiles.map(p => [`${p.storeId}~${p.shopifyProductId}`, p]))
  const templates = await loadTemplateContext(candidates.map(c => c.line), profiles.map(p => p.printTemplateId))
  const pairs = candidates.map(c => ({ ...c, template: pickTemplate(c.line, profileByKey.get(`${c.order.storeId}~${c.line.shopifyProductId}`) ?? null, templates) }))
    .filter(c => c.template?.areas.some(a => a.sizing))
  if (pairs.length) {
    const files = await prisma.designArtwork.findMany({ where: { orderId: { in: Array.from(new Set(pairs.map(c => c.order.id))) }, removedAt: null } })
    const pairProblems: ExportLinkProblem[] = []
    for (const { order, line, template } of pairs) {
      const check = printCutCheck(template, files.filter(f => f.orderId === order.id && f.shopifyLineId === line.shopifyLineId))
      if (check && !check.ok) pairProblems.push({ orderNumber: order.shopifyOrderNumber, reason: check.message })
    }
    if (pairProblems.length) return { problems: pairProblems, ordersForCsv: [] }
  }
  const supplierSkus = Array.from(new Set(
    orders.flatMap(o => o.lines.map(l => l.resolvedSupplierSku).filter((sku): sku is string => Boolean(sku))),
  ))
  const supplierProducts = supplierSkus.length > 0
    ? await prisma.supplierProduct.findMany({
      where: { supplierId: supplierId, sku: { in: supplierSkus } },
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

  const wantsOrderLink = columns.some(c => c.source === ORDER_DESIGN_SOURCE)
  const wantsJoinedLinks = !perOrder && columns.some(c => LINE_DESIGN_SOURCES.includes(c.source))
  const wantsAreaLinks = !perOrder && columns.some(c => c.source.startsWith(DESIGN_AREA_SOURCE_PREFIX))
  const wantsMockupLinks = !perOrder && columns.some(c => c.source === MOCKUP_LINK_SOURCE)
  const wantsLineLinks = wantsJoinedLinks || wantsAreaLinks
  // Links are resolved only for the columns the template prints, so a template without a design column never fails on one.
  const designLinks = await resolveExportDesignLinks(
    wantsOrderLink || wantsLineLinks || wantsMockupLinks
      ? orders.flatMap(o => {
        const lines = linesOf(o)
        if (lines.length === 0) return []
        // The order-level link is printed by its own column, or as the fallback of a line that has no link.
        const orderLinkUsed = wantsOrderLink || (wantsLineLinks && lines.some(l => !l.designDriveLink))
        return [{
          id: o.id, storeId: o.storeId, shopifyOrderNumber: o.shopifyOrderNumber,
          designDriveLink: orderLinkUsed ? orderLinkOf(o, lines) : null, lines: wantsLineLinks || wantsMockupLinks ? lines : [],
        }]
      })
      : [],
    { design: wantsJoinedLinks, areas: wantsAreaLinks, mockup: wantsMockupLinks },
  )
  if (designLinks.problems.length > 0) return { problems: designLinks.problems, ordersForCsv: [] }

  const ordersForCsv: OrderForCsv[] = orders
    .map(o => {
      const lineKeys = lineKeysOf(o.shopifyOrderNumber, o.lines)
      const exportableLines = linesOf(o)
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
        designDriveLink: designLinks.translate(orderLinkOf(o, exportableLines)),
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
          return {
            lineKey: lineKeys.get(l.shopifyLineId) ?? '',
            designNote: l.designNote,
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
  return { problems: [], ordersForCsv }
}
