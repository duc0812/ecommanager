import { listOrdersWithLines, type OrderFilter } from './orders'

export type PlSummary = {
  orderCount: number
  revenue: number
  cogs: number
  shipping: number
  profit: number
  margin: number
  avgProfit: number
  unmappedCount: number
}

export async function plSummary(filter: OrderFilter): Promise<PlSummary> {
  const orders = await listOrdersWithLines(filter)
  let revenue = 0, cogs = 0, shipping = 0, unmappedCount = 0
  for (const o of orders) {
    revenue += o.expectedPayout
    const totalQty = o.lines.reduce((s, l) => s + l.qty, 0)
    cogs += o.lines.reduce((s, l) => s + (l.resolvedBaseCost ?? 0) * l.qty, 0)
    if (o.defaultSupplier) {
      shipping += o.defaultSupplier.firstItemShipFee + o.defaultSupplier.additionalItemShipFee * Math.max(0, totalQty - 1)
    }
    if (o.lines.some(l => l.resolvedBaseCost == null)) unmappedCount++
  }
  const profit = revenue - cogs - shipping
  const margin = revenue === 0 ? 0 : (profit / revenue) * 100
  const avgProfit = orders.length === 0 ? 0 : profit / orders.length
  return { orderCount: orders.length, revenue, cogs, shipping, profit, margin, avgProfit, unmappedCount }
}

export type EnrichedOrder = Awaited<ReturnType<typeof listOrdersWithLines>>[number] & {
  computed: { totalQty: number; baseCost: number; shipping: number; profit: number; margin: number; hasUnmappedSku: boolean }
}

export async function ordersWithComputedPL(filter: OrderFilter): Promise<EnrichedOrder[]> {
  const orders = await listOrdersWithLines(filter)
  return orders.map(o => {
    const totalQty = o.lines.reduce((s, l) => s + l.qty, 0)
    const baseCost = o.lines.reduce((s, l) => s + (l.resolvedBaseCost ?? 0) * l.qty, 0)
    const shipping = o.defaultSupplier
      ? o.defaultSupplier.firstItemShipFee + o.defaultSupplier.additionalItemShipFee * Math.max(0, totalQty - 1)
      : 0
    const profit = o.expectedPayout - baseCost - shipping
    const margin = o.expectedPayout === 0 ? 0 : (profit / o.expectedPayout) * 100
    const hasUnmappedSku = o.lines.some(l => l.resolvedBaseCost == null)
    return { ...o, computed: { totalQty, baseCost, shipping, profit, margin, hasUnmappedSku } }
  })
}
