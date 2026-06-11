export type LineForClassification = { sku: string | null; productTitle: string }

const SKULESS_NON_PRODUCT_TITLES = ['tip', 'shipping protection']
// Digital add-on products: no physical fulfillment, no supplier mapping, no design file
const DIGITAL_PRODUCT_TITLES = ['custom text']

export function isNonProductLine(line: LineForClassification): boolean {
  const title = line.productTitle.toLowerCase().trim()
  if (DIGITAL_PRODUCT_TITLES.includes(title)) return true
  if (line.sku) return false
  return SKULESS_NON_PRODUCT_TITLES.includes(title)
}

export function productLinesOnly<T extends LineForClassification>(lines: T[]): T[] {
  return lines.filter(l => !isNonProductLine(l))
}
