import { isNonProductLine } from '@/lib/order-lines'

// Pure mapping from an order's product lines + Shopify fulfillments to per-sub-order
// shipment rows. Kept side-effect free so it can be unit tested without a DB.

export type ShipmentSourceLine = {
  shopifyLineId: string
  sku: string | null
  productTitle: string
  shopifyProductType: string | null
  linePosition: number
  resolvedSupplierId: string | null
}

export type ShipmentSourceFulfillment = {
  id: string
  displayStatus: string | null
  deliveredAt: string | null
  trackingNumber: string | null
  carrier: string | null
  trackingUrl: string | null
  lineItemIds: string[]
}

export type BuiltShipment = {
  lineKey: string
  shopifyLineId: string
  sku: string | null
  productTitle: string
  supplierId: string | null
  shopifyFulfillmentId: string | null
  trackingNumber: string | null
  carrier: string | null
  trackingUrl: string | null
  status: string
}

export const SHIPMENT_STATUS_PENDING = 'PENDING'
export const SHIPMENT_STATUS_DELIVERED = 'DELIVERED'
export const SHIPMENT_STATUS_FULFILLED = 'FULFILLED'

// One row per product sub-order (matches order management's lineKey coding: "<orderNumber>_<n>").
export function buildOrderShipments(input: {
  shopifyOrderNumber: string
  lines: ShipmentSourceLine[]
  fulfillments: ShipmentSourceFulfillment[]
}): BuiltShipment[] {
  const orderNo = input.shopifyOrderNumber.replace(/^#/, '')

  // Product lines only, ordered by linePosition — same rule as reports.ts lineKey numbering.
  const productLines = input.lines
    .filter(l => !isNonProductLine({ sku: l.sku, productTitle: l.productTitle, shopifyProductType: l.shopifyProductType }))
    .sort((a, b) => a.linePosition - b.linePosition)

  // Map each Shopify line id -> the fulfillment covering it (last one wins if re-shipped).
  const fulfillmentByLineId = new Map<string, ShipmentSourceFulfillment>()
  for (const f of input.fulfillments) {
    for (const lineId of f.lineItemIds) {
      fulfillmentByLineId.set(lineId, f)
    }
  }

  return productLines.map((line, idx) => {
    const f = fulfillmentByLineId.get(line.shopifyLineId) ?? null
    return {
      lineKey: `${orderNo}_${idx + 1}`,
      shopifyLineId: line.shopifyLineId,
      sku: line.sku,
      productTitle: line.productTitle,
      supplierId: line.resolvedSupplierId,
      shopifyFulfillmentId: f?.id ?? null,
      trackingNumber: f?.trackingNumber ?? null,
      carrier: f?.carrier ?? null,
      trackingUrl: f?.trackingUrl ?? null,
      status: mapStatus(f),
    }
  })
}

function mapStatus(f: ShipmentSourceFulfillment | null): string {
  if (!f) return SHIPMENT_STATUS_PENDING
  if (f.deliveredAt) return SHIPMENT_STATUS_DELIVERED
  if (f.displayStatus) return f.displayStatus            // Shopify enum, e.g. IN_TRANSIT, OUT_FOR_DELIVERY
  if (f.trackingNumber) return SHIPMENT_STATUS_FULFILLED
  return SHIPMENT_STATUS_PENDING
}
