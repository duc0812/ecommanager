export type LineForClassification = {
  sku?: string | null
  productTitle: string
  shopifyProductType?: string | null
}

// Digital add-on products: no physical fulfillment, no supplier mapping, no design file.
// Matched by Shopify product type when available, falling back to product title.
// Reminiso sells its add-ons (Worry-Free Protection, Custom Name Add-on) as product type "Add-on";
// their two titles stand in when the type is missing. Never matched by SKU prefix.
// PPLR_HIDDEN_PRODUCT is the personalisation app's hidden fee product: never a thing to print or to map.
const DIGITAL_PRODUCT_TYPES = ['custom text', 'add-on', 'pplr_hidden_product']
const DIGITAL_PRODUCT_TITLES = ['custom text']
// Checkout add-ons. Matched by title alone: a store can sell them as ordinary products, so they
// may carry a SKU and inherit an unrelated product type (Package Protection ships as 'Jewelry').
const ADD_ON_TITLES = ['tip', 'shipping protection', 'package protection', 'worry-free protection', 'custom name add-on']

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

/**
 * What keeps an order in PENDING_MAPPING: a product line (add-ons excluded, with or without a SKU) that has no supplier yet.
 * The order sync and every re-evaluation after a mapping change decide with this one rule. `isResolved` lets a caller
 * ask for more than a supplier (the cost refresh also wants a base cost).
 */
export function hasUnresolvedProductLine<T extends LineForClassification & { resolvedSupplierId: string | null }>(
  lines: T[],
  isResolved: (line: T) => boolean = l => !!l.resolvedSupplierId,
): boolean {
  return lines.some(l => !isNonProductLine(l) && !isResolved(l))
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

export type KeyedTask = { id: string; taskKey: string; shopifyLineId: string }
/** LINE_KEY: a product line's task takes its key. The other two move a task out of a key a product line needs. */
export type TaskKeyMove = { id: string; from: string; to: string; why: 'LINE_KEY' | 'NOT_A_PRODUCT' | 'LINE_GONE' }

/** Where a task moves when a product line needs its key. A line key ends in `_<n>`; these never do. */
const OUT_OF_THE_WAY = { NOT_A_PRODUCT: '-addon', LINE_GONE: '-removed' } as const

/**
 * What puts an order's design tasks back on its line keys (`keys` = lineKeysOf, `lineIds` = every line of the order) once a
 * line is reclassified after the order synced (2026-11: Reminiso add-ons and the hidden fee product became non-product lines,
 * which shifts the numbering). A task on a product line takes that line's key, whatever its status. A task on a line that is
 * not a product is removed when `untouched`, otherwise kept. A task whose line is not in the order (removed in Shopify, or
 * past the lines the sync fetches) is never removed. A kept task moves to "<key>-addon" / "<key>-removed" (made unique)
 * only when a product line needs its key.
 */
export function planTaskKeys(keys: Map<string, string>, lineIds: Set<string>, tasks: Array<KeyedTask & { untouched: boolean }>): { remove: string[]; moves: TaskKeyMove[] } {
  const needed = new Set(keys.values())
  const taken = new Set(needed)
  const remove: string[] = []
  const moves: TaskKeyMove[] = []
  const inTheWay: Array<{ task: KeyedTask; why: keyof typeof OUT_OF_THE_WAY }> = []
  for (const t of tasks) {
    const key = keys.get(t.shopifyLineId)
    const gone = !lineIds.has(t.shopifyLineId)
    if (key) {
      if (t.taskKey !== key) moves.push({ id: t.id, from: t.taskKey, to: key, why: 'LINE_KEY' })
    } else if (t.untouched && !gone) remove.push(t.id)
    else if (needed.has(t.taskKey)) inTheWay.push({ task: t, why: gone ? 'LINE_GONE' : 'NOT_A_PRODUCT' })
    else taken.add(t.taskKey)
  }
  for (const { task: t, why } of inTheWay) {
    let to = `${t.taskKey}${OUT_OF_THE_WAY[why]}`
    for (let n = 2; taken.has(to); n++) to = `${t.taskKey}${OUT_OF_THE_WAY[why]}-${n}`
    taken.add(to)
    moves.push({ id: t.id, from: t.taskKey, to, why })
  }
  return { remove, moves }
}
