import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { SHOPIFY_PAYOUT_START_DATE } from '@/lib/shopify-payout-policy'
import { estimateOrderCostAndProfit } from '@/lib/order-profit'

type CostBuckets = {
  fulfillment: number
  appBilling: number
  toolsBilling: number
}

function getNumberParam(searchParams: URLSearchParams, key: string) {
  const value = searchParams.get(key)
  if (!value) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function dateOnly(date: Date) {
  return date.toISOString().split('T')[0]
}

function dateKeyInZone(date: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function zonedDayStartUtc(dateKey: string, timeZone: string) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const naiveUtc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0))
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(naiveUtc).map(p => [p.type, p.value]))
  const zoneAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '00' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return new Date(naiveUtc.getTime() - (zoneAsUtc - naiveUtc.getTime()))
}

function addDays(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0, 0)).toISOString().split('T')[0]
}

function getMonthRange(month: string | null, timeZone: string) {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return null
  const [year, monthIndex] = month.split('-').map(Number)
  const startKey = `${month}-01`
  const endKey = new Date(Date.UTC(year, monthIndex, 0)).toISOString().split('T')[0]
  return {
    start: zonedDayStartUtc(startKey, timeZone),
    end: new Date(zonedDayStartUtc(addDays(endKey, 1), timeZone).getTime() - 1),
  }
}

function graphUrl(path: string, params: Record<string, string>) {
  const url = new URL(`https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION ?? 'v19.0'}/${path}`)
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value))
  return url.toString()
}

async function fetchMetaInsightsSpend(accountId: string, accessToken: string, since: string, until: string) {
  const timeRange = JSON.stringify({ since, until })
  const url = graphUrl(`${accountId}/insights`, {
    fields: 'spend',
    level: 'account',
    time_range: timeRange,
    access_token: accessToken,
  })

  const res = await fetch(url)
  const json = await res.json()
  if (json.error) throw new Error(json.error.message)
  return (json.data ?? []).reduce((sum: number, row: any) => sum + Number(row.spend ?? 0), 0)
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get('projectId')
  const staffId = searchParams.get('staffId')
  const costs: CostBuckets = {
    fulfillment: getNumberParam(searchParams, 'fulfillment'),
    appBilling: getNumberParam(searchParams, 'appBilling'),
    toolsBilling: getNumberParam(searchParams, 'toolsBilling'),
  }

  if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 })

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      assignments: { include: { staff: true } },
      shopifyStore: { select: { ianaTimezone: true, currentBalance: true, currentBalanceCurrency: true } },
    },
  })

  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const timeZone = project.shopifyStore?.ianaTimezone ?? 'UTC'
  let startDate = project.startDate
  let endDate: Date | null = null
  const monthRange = getMonthRange(searchParams.get('month'), timeZone)

  if (staffId) {
    const assignment = project.assignments.find(a => a.staffId === staffId)
    if (assignment) {
      startDate = assignment.startDate
      endDate = assignment.endDate
    }
  } else if (project.assignments.length > 0) {
    startDate = new Date(Math.min(project.startDate.getTime(), ...project.assignments.map(a => a.startDate.getTime())))
  }

  if (monthRange) {
    startDate = startDate > monthRange.start ? startDate : monthRange.start
    endDate = endDate && endDate < monthRange.end ? endDate : monthRange.end
  }

  const todayKey = dateKeyInZone(new Date(), timeZone)
  const today = new Date(zonedDayStartUtc(addDays(todayKey, 1), timeZone).getTime() - 1)
  if (!endDate || endDate > today) endDate = today

  const startStr = dateOnly(startDate)
  const payoutStartStr = startStr > SHOPIFY_PAYOUT_START_DATE ? startStr : SHOPIFY_PAYOUT_START_DATE
  const endStr = dateKeyInZone(endDate, timeZone)
  const orderRangeStart = zonedDayStartUtc(startStr, timeZone)
  const orderRangeEnd = new Date(zonedDayStartUtc(addDays(endStr, 1), timeZone).getTime() - 1)
  const periodIsValid = startDate <= endDate

  const paidMetaStatuses = ['PAID', 'SETTLED', 'COMPLETED']
  const [payouts, metaAccounts, billings, orders] = await Promise.all([
    prisma.payout.findMany({
      where: {
        date: {
          gte: payoutStartStr,
          lte: endStr,
        },
        status: 'paid',
      },
      orderBy: { date: 'desc' },
    }),
    prisma.metaAdAccount.findMany({
      where: { projectId },
      select: { id: true, accountId: true, accountName: true, accessToken: true },
    }),
    prisma.metaBilling.findMany({
      where: {
        billingDate: {
          gte: startStr,
          lte: endStr,
        },
        status: { in: paidMetaStatuses },
        adAccount: { projectId },
      },
      select: { amount: true, billingDate: true },
    }),
    prisma.order.findMany({
      where: {
        projectId,
        placedAt: { gte: orderRangeStart, lte: orderRangeEnd },
        pipelineStatus: { notIn: ['REFUNDED', 'CANCELLED'] },
      },
      include: {
        lines: {
          select: {
            qty: true,
            sku: true,
            productTitle: true,
            resolvedSupplierId: true,
            resolvedBaseCost: true,
            resolvedShipFirst: true,
            resolvedShipAdditional: true,
            resolvedImportTax: true,
          },
        },
      },
    }),
  ])

  const totalPayout = payouts.reduce((sum, p) => sum + p.amount, 0)
  const totalMetaBilling = billings.reduce((sum, b) => sum + b.amount, 0)
  let totalRevenue = 0
  let totalPaymentFees = 0
  let totalOrderProfit = 0
  let totalOrderCogs = 0
  let mappedOrderCount = 0
  let unmappedOrderCount = 0
  for (const order of orders) {
    const productLines = order.lines.filter(line => {
      if (line.sku) return true
      const title = line.productTitle.toLowerCase().trim()
      return title !== 'tip' && title !== 'shipping protection'
    })
    const estimate = estimateOrderCostAndProfit(order.expectedPayout, productLines)
    if (!estimate) continue
    if (estimate.hasUnmapped) {
      unmappedOrderCount++
    } else {
      mappedOrderCount++
    }
    totalRevenue += order.grossAmount
    totalPaymentFees += order.totalFees
    totalOrderProfit += estimate.profit
    totalOrderCogs += estimate.estimatedCogs
  }
  const totalFulfillmentCost = totalOrderCogs
  const billingDates = billings.map(b => b.billingDate).sort()
  const untilStr = endStr
  const spendByAccount = periodIsValid ? await Promise.all(metaAccounts.map(async account => {
    try {
      const spend = await fetchMetaInsightsSpend(account.accountId, account.accessToken, startStr, untilStr)
      return { accountId: account.accountId, accountName: account.accountName, spend, source: 'facebook_insights' }
    } catch (err: any) {
      return { accountId: account.accountId, accountName: account.accountName, spend: 0, source: 'facebook_insights_error', error: err.message }
    }
  })) : metaAccounts.map(account => ({
    accountId: account.accountId,
    accountName: account.accountName,
    spend: 0,
    source: 'outside_selected_period',
  }))
  const totalAdSpend = spendByAccount.reduce((sum, item) => sum + item.spend, 0)
  const totalOtherCosts = costs.fulfillment + costs.appBilling + costs.toolsBilling
  const cashflowCosts = totalOrderCogs + totalOtherCosts
  const actualCashflow = totalPayout - totalMetaBilling - cashflowCosts
  const shopifyBalance = project.shopifyStore?.currentBalance ?? 0
  const projectedCashflow = actualCashflow + shopifyBalance
  const grossProfit = totalOrderProfit - costs.fulfillment - costs.appBilling - costs.toolsBilling - totalAdSpend
  const grossMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0
  const adSpendRatio = totalRevenue > 0 ? (totalAdSpend / totalRevenue) * 100 : 0
  const roas = totalAdSpend > 0 ? totalRevenue / totalAdSpend : 0
  const activeAssignments = project.assignments
    .filter(assignment => {
      const assignmentStart = assignment.startDate.toISOString().split('T')[0]
      const assignmentEnd = assignment.endDate ? assignment.endDate.toISOString().split('T')[0] : null
      return assignmentStart <= untilStr && (!assignmentEnd || assignmentEnd >= startStr)
    })
    .map(assignment => ({
      id: assignment.id,
      staffId: assignment.staffId,
      staffName: assignment.staff.name,
      role: assignment.staff.role,
      startDate: assignment.startDate,
      endDate: assignment.endDate,
      monthlyCost: assignment.staff.monthlyCost,
    }))
  const labelAudit = {
    project: { id: project.id, name: project.name, startDate: project.startDate },
    staff: activeAssignments,
    period: { start: startStr, end: endStr },
    metaAccounts: metaAccounts.map(account => ({
      id: account.id,
      accountId: account.accountId,
      accountName: account.accountName,
    })),
  }
  const dataDiagnostics = {
    period: { start: startStr, end: untilStr },
    metaBilling: {
      source: 'Meta paid billing transactions',
      firstDate: billingDates[0] ?? null,
      lastDate: billingDates[billingDates.length - 1] ?? null,
      transactionCount: billings.length,
    },
    actualAdSpend: {
      source: 'Meta Insights spend',
      note: 'Spend is accrued ad delivery cost. Billing is cash/card charge timing, so values can differ in the same date range.',
    },
    orderProfit: {
      source: 'Order profit with estimated COGS for unmapped lines',
      mappedOrderCount,
      unmappedOrderCount,
      estimateRule: 'Unmapped COGS = known COGS + 50% of payout remaining after known COGS',
    },
  }

  return NextResponse.json({
    project,
    labelAudit,
    dataDiagnostics,
    payouts,
    spendByAccount,
    totalPayout,
    totalRevenue,
    totalPaymentFees,
    totalAdSpend,
    totalMetaBilling,
    totalFulfillmentCost,
    totalOrderProfit,
    totalOrderCogs,
    cashflowCosts,
    mappedOrderCount,
    unmappedOrderCount,
    costs,
    totalOtherCosts,
    actualCashflow,
    shopifyBalance,
    shopifyBalanceCurrency: project.shopifyStore?.currentBalanceCurrency ?? null,
    projectedCashflow,
    grossProfit,
    grossMargin,
    adSpendRatio,
    roas,
    payoutCount: payouts.length,
    avgRevenuePerPayout: payouts.length > 0 ? totalRevenue / payouts.length : 0,
    dateRange: { start: startStr, end: endStr },
    payoutDateRange: { start: payoutStartStr, end: endStr },
  })
}
