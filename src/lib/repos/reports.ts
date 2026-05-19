import { listOrdersWithLines, type OrderFilter } from './orders'
import { prisma } from '@/lib/db'

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
    // Use line-level snapshot if available (zone-aware), else fall back to supplier-level
    const firstLine = o.lines[0]
    const useSnapshot = firstLine?.resolvedShipFirst != null || firstLine?.resolvedShipAdditional != null
    const shipFirst = useSnapshot
      ? (firstLine.resolvedShipFirst ?? 0)
      : (o.defaultSupplier?.firstItemShipFee ?? 0)
    const shipAdditional = useSnapshot
      ? (firstLine.resolvedShipAdditional ?? 0)
      : (o.defaultSupplier?.additionalItemShipFee ?? 0)
    const importTaxPerUnit = useSnapshot ? (firstLine.resolvedImportTax ?? 0) : 0
    if (o.defaultSupplier || useSnapshot) {
      shipping += shipFirst + shipAdditional * Math.max(0, totalQty - 1) + importTaxPerUnit * totalQty
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

  // Build SkuDesign lookup for Non-Custom design status
  const allSkus = Array.from(new Set(orders.flatMap(o => o.lines.map(l => l.sku).filter(Boolean) as string[])))
  const skuDesigns = allSkus.length > 0
    ? await prisma.skuDesign.findMany({ where: { sku: { in: allSkus } } })
    : []
  const skuDesignMap = new Map(skuDesigns.map(s => [s.sku, s]))

  return orders.map(o => {
    const totalQty = o.lines.reduce((s, l) => s + l.qty, 0)
    const baseCost = o.lines.reduce((s, l) => s + (l.resolvedBaseCost ?? 0) * l.qty, 0)
    // Use line-level snapshot if available (zone-aware), else fall back to supplier-level
    const firstLine = o.lines[0]
    const useSnapshot = firstLine?.resolvedShipFirst != null || firstLine?.resolvedShipAdditional != null
    const shipFirst = useSnapshot
      ? (firstLine.resolvedShipFirst ?? 0)
      : (o.defaultSupplier?.firstItemShipFee ?? 0)
    const shipAdditional = useSnapshot
      ? (firstLine.resolvedShipAdditional ?? 0)
      : (o.defaultSupplier?.additionalItemShipFee ?? 0)
    const importTaxPerUnit = useSnapshot ? (firstLine.resolvedImportTax ?? 0) : 0
    const shipping = (o.defaultSupplier || useSnapshot)
      ? shipFirst + shipAdditional * Math.max(0, totalQty - 1) + importTaxPerUnit * totalQty
      : 0
    const profit = o.expectedPayout - baseCost - shipping
    const margin = o.expectedPayout === 0 ? 0 : (profit / o.expectedPayout) * 100
    const hasUnmappedSku = o.lines.some(l => l.resolvedBaseCost == null)
    const orderSkus = o.lines.map(l => l.sku).filter(Boolean) as string[]
    const designReady = orderSkus.length > 0 && orderSkus.every(sku => skuDesignMap.get(sku)?.designReady === true)
    const driveLink = orderSkus.length > 0 ? (skuDesignMap.get(orderSkus[0])?.driveLink ?? null) : null
    return {
      ...o,
      computed: { totalQty, baseCost, shipping, profit, margin, hasUnmappedSku },
      designReady,
      driveLink,
    }
  })
}

export type CombinedProjectPL = {
  projectId: string
  projectName: string
  dateFrom: string | null
  dateTo: string | null

  fulfillmentRevenue: number   // Σ Order.expectedPayout for this project (excluding REFUNDED/CANCELLED)
  fulfillmentCogs: number      // base cost + supplier shipping
  fulfillmentProfit: number    // fulfillmentRevenue − fulfillmentCogs

  metaAdSpend: number          // Σ MetaBilling.amount for project's MetaAdAccounts (SETTLED)

  staffCost: number            // Σ Staff.monthlyCost × months active in date range

  netProfit: number            // fulfillmentProfit − metaAdSpend − staffCost
}

export async function combinedProjectPL(filter: {
  projectId: string
  dateFrom?: Date
  dateTo?: Date
}): Promise<CombinedProjectPL> {
  const project = await prisma.project.findUnique({
    where: { id: filter.projectId },
    include: {
      metaAccounts: true,
      assignments: { include: { staff: true } },
    },
  })
  if (!project) throw new Error('Project not found')

  // Fulfillment side — reuse listOrdersWithLines but exclude REFUNDED/CANCELLED orders by filtering after
  const orders = await listOrdersWithLines({
    projectId: filter.projectId,
    dateFrom: filter.dateFrom,
    dateTo: filter.dateTo,
    limit: 10000,
  })
  let fulfillmentRevenue = 0
  let fulfillmentCogs = 0
  for (const o of orders) {
    if (o.pipelineStatus === 'REFUNDED' || o.pipelineStatus === 'CANCELLED') continue
    fulfillmentRevenue += o.expectedPayout
    const totalQty = o.lines.reduce((s, l) => s + l.qty, 0)
    fulfillmentCogs += o.lines.reduce((s, l) => s + (l.resolvedBaseCost ?? 0) * l.qty, 0)
    // Use line-level snapshot if available (zone-aware), else fall back to supplier-level
    const firstLine = o.lines[0]
    const useSnapshot = firstLine?.resolvedShipFirst != null || firstLine?.resolvedShipAdditional != null
    const shipFirst = useSnapshot
      ? (firstLine.resolvedShipFirst ?? 0)
      : (o.defaultSupplier?.firstItemShipFee ?? 0)
    const shipAdditional = useSnapshot
      ? (firstLine.resolvedShipAdditional ?? 0)
      : (o.defaultSupplier?.additionalItemShipFee ?? 0)
    const importTaxPerUnit = useSnapshot ? (firstLine.resolvedImportTax ?? 0) : 0
    if (o.defaultSupplier || useSnapshot) {
      fulfillmentCogs += shipFirst + shipAdditional * Math.max(0, totalQty - 1) + importTaxPerUnit * totalQty
    }
  }
  const fulfillmentProfit = fulfillmentRevenue - fulfillmentCogs

  // Meta ad spend — filter MetaBilling by linked accounts + date range (SETTLED only)
  const accountIds = project.metaAccounts.map(a => a.id)
  let metaAdSpend = 0
  if (accountIds.length > 0) {
    const billingWhere: any = {
      adAccountId: { in: accountIds },
      status: 'SETTLED',
    }
    if (filter.dateFrom || filter.dateTo) {
      const fromIso = filter.dateFrom ? filter.dateFrom.toISOString().split('T')[0] : '0000-01-01'
      const toIso = filter.dateTo ? filter.dateTo.toISOString().split('T')[0] : '9999-12-31'
      billingWhere.billingDate = { gte: fromIso, lte: toIso }
    }
    const billings = await prisma.metaBilling.findMany({ where: billingWhere })
    metaAdSpend = billings.reduce((sum, b) => sum + b.amount, 0)
  }

  // Staff cost — for each assignment, compute active months in date range
  const rangeStart = filter.dateFrom ?? project.startDate
  const rangeEnd = filter.dateTo ?? new Date()
  let staffCost = 0
  for (const a of project.assignments) {
    const aStart = a.startDate > rangeStart ? a.startDate : rangeStart
    const aEnd = a.endDate && a.endDate < rangeEnd ? a.endDate : rangeEnd
    if (aEnd <= aStart) continue
    const months = (aEnd.getTime() - aStart.getTime()) / (1000 * 60 * 60 * 24 * 30.44)
    staffCost += a.staff.monthlyCost * months
  }

  const netProfit = fulfillmentProfit - metaAdSpend - staffCost

  return {
    projectId: project.id,
    projectName: project.name,
    dateFrom: filter.dateFrom?.toISOString().split('T')[0] ?? null,
    dateTo: filter.dateTo?.toISOString().split('T')[0] ?? null,
    fulfillmentRevenue,
    fulfillmentCogs,
    fulfillmentProfit,
    metaAdSpend,
    staffCost,
    netProfit,
  }
}
