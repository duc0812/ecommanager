export type LineForClassification = {
  sku?: string | null
  productTitle: string
  shopifyProductType?: string | null
}

const SKULESS_NON_PRODUCT_TITLES = ['tip', 'shipping protection']
// Digital add-on products: no physical fulfillment, no supplier mapping, no design file.
// Matched by Shopify product type when available, falling back to product title.
const DIGITAL_PRODUCT_TYPES = ['custom text']
const DIGITAL_PRODUCT_TITLES = ['custom text']

function normalize(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().trim()
}

export function isNonProductLine(line: LineForClassification): boolean {
  const title = normalize(line.productTitle)
  const productType = normalize(line.shopifyProductType)
  if (DIGITAL_PRODUCT_TYPES.includes(productType)) return true
  if (DIGITAL_PRODUCT_TITLES.includes(title)) return true
  if (line.sku) return false
  return SKULESS_NON_PRODUCT_TITLES.includes(title)
}

export function productLinesOnly<T extends LineForClassification>(lines: T[]): T[] {
  return lines.filter(l => !isNonProductLine(l))
}
