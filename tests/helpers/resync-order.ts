import { prisma } from '@/lib/db'
import { upsertOrderWithLines } from '@/lib/repos/orders'

/** What the order sync does to an order it reads again (upsertOrderWithLines): every OrderLine is made anew under a new id. */
export async function resyncOrder(orderId: string) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: { orderBy: { linePosition: 'asc' } } } })
  await upsertOrderWithLines({
    id: o.id, projectId: o.projectId, storeId: o.storeId, shopifyOrderNumber: o.shopifyOrderNumber,
    customerEmail: o.customerEmail, customerName: o.customerName, shippingCountry: o.shippingCountry, shippingState: o.shippingState,
    shippingStateCode: o.shippingStateCode, financialStatus: o.financialStatus, fulfillmentStatus: o.fulfillmentStatus, currency: o.currency,
    grossAmount: o.grossAmount, subtotalAmount: o.subtotalAmount, shippingAmount: o.shippingAmount, taxAmount: o.taxAmount,
    expectedPayout: o.expectedPayout, totalFees: o.totalFees, refundedAmount: o.refundedAmount, defaultSupplierId: o.defaultSupplierId,
    placedAt: o.placedAt, shopTimezone: o.shopTimezone, shippingZone: o.shippingZone, shippingName: o.shippingName,
    shippingAddress1: o.shippingAddress1, shippingAddress2: o.shippingAddress2, shippingCity: o.shippingCity, shippingZip: o.shippingZip,
    shippingPhone: o.shippingPhone,
    lines: o.lines.map(l => ({
      shopifyLineId: l.shopifyLineId, sku: l.sku, resolvedSupplierSku: l.resolvedSupplierSku, variantTitle: l.variantTitle, productTitle: l.productTitle,
      qty: l.qty, linePosition: l.linePosition, unitPrice: l.unitPrice, resolvedSupplierId: l.resolvedSupplierId, resolvedBaseCost: l.resolvedBaseCost,
      previewCdnUrl: l.previewCdnUrl, designDriveLink: l.designDriveLink, shopifyVariantId: l.shopifyVariantId, shopifyProductType: l.shopifyProductType,
      variantOptions: l.variantOptions, customized: l.customized, imageUrl: l.imageUrl, shopifyProductId: l.shopifyProductId,
    })),
  })
  const after = await prisma.orderLine.findMany({ where: { orderId }, select: { id: true } })
  if (after.some(l => o.lines.some(b => b.id === l.id))) throw new Error('resyncOrder: a line kept its id')
}
