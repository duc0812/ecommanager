export type LineForClassification = {
  sku?: string | null
  productTitle: string
  shopifyProductType?: string | null
}

// Digital add-on products: no physical fulfillment, no supplier mapping, no design file.
// Matched by Shopify product type when available, falling back to product title.
const DIGITAL_PRODUCT_TYPES = ['custom text']
const DIGITAL_PRODUCT_TITLES = ['custom text']
// Checkout add-ons. Matched by title alone: a store can sell them as ordinary products, so they
// may carry a SKU and inherit an unrelated product type (Package Protection ships as 'Jewelry').
const ADD_ON_TITLES = ['tip', 'shipping protection', 'package protection']

function normalize(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().trim()
}

export function isNonProductLine(line: LineForClassification): boolean {
  const title = normalize(line.productTitle)
  const productType = normalize(line.shopifyProductType)
  if (DIGITAL_PRODUCT_TYPES.includes(productType)) return true
  if (DIGITAL_PRODUCT_TITLES.includes(title)) return true
  return ADD_ON_TITLES.includes(title)
}

export function productLinesOnly<T extends LineForClassification>(lines: T[]): T[] {
  return lines.filter(l => !isNonProductLine(l))
}

type KeyedLine = LineForClassification & { shopifyLineId: string; linePosition: number }

/**
 * The one numbering of an order's lines: "<order>_<n>" with n counting product lines only, in Shopify order
 * (owner 2026-10-29, LIT5092: a Custom Text add-on on line 1 made the design task _2 while the order page,
 * the supplier CSV and the tracking sheets said _1). Design tasks, Drive folders, CSV exports, shipments and
 * supplier API refs all use it. Add-on lines get no key.
 */
export function lineKeysOf(orderNumber: string, lines: KeyedLine[]): Map<string, string> {
  const orderNo = orderNumber.replace(/^#/, '')
  const keys = new Map<string, string>()
  const products = lines.filter(l => !isNonProductLine(l)).sort((a, b) => a.linePosition - b.linePosition)
  products.forEach((l, i) => keys.set(l.shopifyLineId, `${orderNo}_${i + 1}`))
  return keys
}

export function lineKeyOf(orderNumber: string, lines: KeyedLine[], line: Pick<KeyedLine, 'shopifyLineId'>): string | null {
  return lineKeysOf(orderNumber, lines).get(line.shopifyLineId) ?? null
}
