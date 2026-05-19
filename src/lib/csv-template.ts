export type CsvColumn = {
  header: string
  source: string
}

export type CsvTemplate = {
  rowMode: 'PER_LINE' | 'PER_ORDER'
  columns: CsvColumn[]
}

export type OrderLineForCsv = {
  sku: string | null
  qty: number
  productTitle: string
  variantTitle: string | null
}

export type OrderForCsv = {
  shopifyOrderNumber: string
  customerName: string | null
  customerEmail: string | null
  shippingCountry: string | null
  shippingState: string | null
  placedAt: Date
  lines: OrderLineForCsv[]
}

function resolveSource(source: string, ctx: { order: OrderForCsv; line: OrderLineForCsv | null }): string {
  if (source.startsWith('literal:')) return source.slice('literal:'.length)
  const parts = source.split('.')
  const root = parts[0]
  if (root === 'order') {
    const key = parts[1] as keyof OrderForCsv
    const val = ctx.order[key]
    if (val instanceof Date) return val.toISOString()
    return val == null ? '' : String(val)
  }
  if (root === 'line' && ctx.line) {
    const key = parts[1] as keyof OrderLineForCsv
    const val = ctx.line[key]
    return val == null ? '' : String(val)
  }
  return ''
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function renderCsv(template: CsvTemplate, orders: OrderForCsv[]): string {
  const rows: string[][] = []
  rows.push(template.columns.map(c => c.header))
  for (const order of orders) {
    if (template.rowMode === 'PER_ORDER') {
      rows.push(template.columns.map(c => resolveSource(c.source, { order, line: null })))
    } else {
      for (const line of order.lines) {
        rows.push(template.columns.map(c => resolveSource(c.source, { order, line })))
      }
    }
  }
  return rows.map(r => r.map(csvEscape).join(',')).join('\n')
}
