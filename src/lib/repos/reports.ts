import { listOrdersWithLines, type OrderFilter } from './orders'
import { prisma } from '@/lib/db'
import { estimateOrderCostAndProfit } from '@/lib/order-profit'

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

function isNonProductLine(line: { sku: string | null; productTitle: string }) {
  if (line.sku) return false
  const title = line.productTitle.toLowerCase().trim()
  return title === 'tip' || title === 'shipping protection'
}

function productLines<T extends { sku: string | null; productTitle: string }>(lines: T[]) {
  return lines.filter(l => !isNonProductLine(l))
}

export async function plSummary(filter: OrderFilter): Promise<PlSummary> {
  const orders = await listOrdersWithLines(filter)
  let revenue = 0, cogs = 0, unmappedCount = 0
  const shipping = 0
  for (const o of orders) {
    revenue += o.expectedPayout
    const estimate = estimateOrderCostAndProfit(o.expectedPayout, productLines(o.lines))
    cogs += estimate?.estimatedCogs ?? 0
    if (estimate?.hasUnmapped) unmappedCount++
  }
  const profit = revenue - cogs - shipping
  const margin = revenue === 0 ? 0 : (profit / revenue) * 100
  const avgProfit = orders.length === 0 ? 0 : profit / orders.length
  return { orderCount: orders.length, revenue, cogs, shipping, profit, margin, avgProfit, unmappedCount }
}

export type EnrichedOrder = Awaited<ReturnType<typeof listOrdersWithLines>>[number] & {
  computed: {
    totalQty: number
    baseCost: number
    knownCogs: number
    estimatedCogs: number
    shipping: number
    profit: number
    margin: number
    hasUnmappedSku: boolean
    isEstimated: boolean
  }
  mappingSummary: { mapped: number; total: number; complete: boolean }
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
    const mappableLines = productLines(o.lines)
    const totalQty = mappableLines.reduce((s, l) => s + l.qty, 0)
    const estimate = estimateOrderCostAndProfit(o.expectedPayout, mappableLines)
    const baseCost = estimate?.estimatedCogs ?? 0
    const knownCogs = estimate?.knownCogs ?? 0
    const shipping = 0
    const profit = estimate?.profit ?? 0
    const margin = o.expectedPayout === 0 ? 0 : (profit / o.expectedPayout) * 100
    const hasUnmappedSku = estimate?.hasUnmapped ?? false
    const productLineNumberById = new Map(mappableLines.map((line, idx) => [line.id, idx + 1]))
    const mappedLineCount = mappableLines.filter(l => l.resolvedSupplierId && l.resolvedBaseCost != null).length
    const orderSkus = o.lines.map(l => l.sku).filter(Boolean) as string[]
    const skuDesignReady = orderSkus.length > 0 && orderSkus.every(sku => skuDesignMap.get(sku)?.designReady === true)
    const designReady = o.orderType === 'CUSTOM'
      ? o.designReady
      : o.designReady || skuDesignReady
    const driveLink = o.designDriveLink ?? (
      o.orderType === 'CUSTOM'
        ? null
        : orderSkus.length > 0 ? (skuDesignMap.get(orderSkus[0])?.driveLink ?? null) : null
    )
    return {
      ...o,
      lines: o.lines.map(l => ({
        ...l,
        lineKey: productLineNumberById.has(l.id)
          ? `${o.shopifyOrderNumber.replace(/^#/, '')}_${productLineNumberById.get(l.id)}`
          : '',
      })),
      computed: {
        totalQty,
        baseCost,
        knownCogs,
        estimatedCogs: baseCost,
        shipping,
        profit,
        margin,
        hasUnmappedSku,
        isEstimated: hasUnmappedSku,
      },
      mappingSummary: {
        mapped: mappedLineCount,
        total: mappableLines.length,
        complete: mappableLines.length > 0 && mappedLineCount === mappableLines.length,
      },
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
    fulfillmentCogs += estimateOrderCostAndProfit(o.expectedPayout, productLines(o.lines))?.estimatedCogs ?? 0
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
