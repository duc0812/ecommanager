import { prisma } from '@/lib/db'
import { getShopifyConnection } from '@/lib/token-store'
import { fetchOrdersPage } from '@/lib/shopify-orders'
import type { ShopifyTransaction } from '@/lib/shopify-orders'

function computeTotalFees(transactions: ShopifyTransaction[]): number {
  return transactions
    .filter(tx => ['CAPTURE', 'SALE'].includes(tx.kind) && tx.status === 'SUCCESS')
    .reduce((s, tx) => s + tx.fees, 0)
}

export async function syncShopifyOrders(): Promise<{ synced: number; skipped: number; failed?: number; error?: string }> {
  const conn = await getShopifyConnection()
  if (!conn) return { synced: 0, skipped: 0, error: 'No Shopify connection' }

  const store = await prisma.shopifyStore.findUnique({ where: { shop: conn.shop } })
  if (!store) return { synced: 0, skipped: 0, error: 'Store not found in DB' }
  if (!store.projectId) return { synced: 0, skipped: 0, error: 'Store has no projectId assigned' }

  const sinceDate = store.syncSinceDate
    ? store.syncSinceDate.toISOString().split('T')[0]
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  let cursor: string | null = null
  let synced = 0
  let skipped = 0
  let failed = 0
  let hasMore = true

  while (hasMore) {
    const page = await fetchOrdersPage(conn.shop, conn.token, cursor, sinceDate)

    for (const order of page.orders) {
      if (!['paid', 'partially_paid', 'partially_refunded'].includes(order.financialStatus.toLowerCase())) {
        skipped++
        continue
      }

      const totalFees = computeTotalFees(order.transactions)
      const expectedPayout = order.grossAmount - totalFees - order.refundedAmount

      try {
        await prisma.order.upsert({
          where: { id: order.id },
          create: {
            id: order.id,
            storeId: store.id,
            projectId: store.projectId!,
            shopifyOrderNumber: order.name,
            customerEmail: order.customerEmail,
            customerName: order.customerName,
            shippingCountry: order.shippingCountry,
            shippingState: order.shippingState,
            shippingName: order.shippingName,
            shippingAddress1: order.shippingAddress1,
            shippingAddress2: order.shippingAddress2,
            shippingCity: order.shippingCity,
            shippingZip: order.shippingZip,
            shippingPhone: order.shippingPhone,
            financialStatus: order.financialStatus.toLowerCase(),
            fulfillmentStatus: order.fulfillmentStatus?.toLowerCase() ?? null,
            currency: order.currency,
            grossAmount: order.grossAmount,
            subtotalAmount: order.subtotal,
            shippingAmount: order.shipping,
            taxAmount: order.tax,
            expectedPayout,
            totalFees,
            refundedAmount: order.refundedAmount,
            placedAt: new Date(order.processedAt ?? order.createdAt),
            shopTimezone: store.ianaTimezone ?? null,
            lines: {
              create: order.lines.map(l => ({
                shopifyLineId: l.id,
                shopifyVariantId: l.variantId,
                variantOptions: l.selectedOptions && Object.keys(l.selectedOptions).length > 0
                  ? JSON.stringify(l.selectedOptions)
                  : null,
                sku: l.sku,
                variantTitle: l.variantTitle,
                productTitle: l.title,
                qty: l.quantity,
                unitPrice: l.unitPrice,
              })),
            },
          },
          update: {
            financialStatus: order.financialStatus.toLowerCase(),
            fulfillmentStatus: order.fulfillmentStatus?.toLowerCase() ?? null,
            grossAmount: order.grossAmount,
            expectedPayout,
            totalFees,
            refundedAmount: order.refundedAmount,
            updatedAt: new Date(),
            lines: {
              deleteMany: {},
              create: order.lines.map(l => ({
                shopifyLineId: l.id,
                shopifyVariantId: l.variantId,
                variantOptions: l.selectedOptions && Object.keys(l.selectedOptions).length > 0
                  ? JSON.stringify(l.selectedOptions)
                  : null,
                sku: l.sku,
                variantTitle: l.variantTitle,
                productTitle: l.title,
                qty: l.quantity,
                unitPrice: l.unitPrice,
              })),
            },
          },
        })
        synced++
      } catch (err) {
        failed++
        console.error(`[sync-shopify-orders] Failed to upsert order ${order.id}:`, err)
      }
    }

    hasMore = page.hasNextPage
    cursor = page.endCursor
  }

  if (failed === 0) {
    await prisma.shopifyStore.update({
      where: { id: store.id },
      data: { syncSinceDate: new Date() },
    })
  }

  return { synced, skipped, failed }
}
