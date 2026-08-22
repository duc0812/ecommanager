import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { SHOPIFY_PAYOUT_START_DATE } from '@/lib/shopify-payout-policy'
import { estimateOrderCostAndProfit } from '@/lib/order-profit'
import { productLinesOnly } from '@/lib/order-lines'
import { convertMetaAmountToUsdDated, normalizeMetaCurrency, sumMetaAmountsUsdDated } from '@/lib/meta-currency'
import { getMetaRateSchedule } from '@/lib/meta-exchange-rates'
import { PROJECT_REVENUE_EXCLUDED_STATUSES, summarizeProjectOrderFinancials } from '@/lib/project-metrics'

const OTHER_BILL_CATEGORIES = ['APP_TOOL', 'SUBSCRIPTION', 'SUPPLIER', 'OFFICE', 'OTHER'] as const

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

function validDateKey(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
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

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get('projectId')
  const staffId = searchParams.get('staffId')

  if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 })

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      assignments: { include: { staff: true } },
      shopifyStore: { select: { id: true, ianaTimezone: true, currentBalance: true, currentBalanceCurrency: true } },
    },
  })

  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const timeZone = project.shopifyStore?.ianaTimezone ?? 'UTC'
  const dateFromKey = validDateKey(searchParams.get('dateFrom'))
  const dateToKey = validDateKey(searchParams.get('dateTo'))
  const hasExplicitRange = Boolean(dateFromKey || dateToKey)
  let startDate = project.startDate
  let endDate: Date | null = null
  // An explicit from/to range takes precedence over the month picker.
  const monthRange = hasExplicitRange ? null : getMonthRange(searchParams.get('month'), timeZone)

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

  if (dateFromKey) startDate = zonedDayStartUtc(dateFromKey, timeZone)
  if (dateToKey) endDate = new Date(zonedDayStartUtc(addDays(dateToKey, 1), timeZone).getTime() - 1)

  const todayKey = dateKeyInZone(new Date(), timeZone)
  const today = new Date(zonedDayStartUtc(addDays(todayKey, 1), timeZone).getTime() - 1)
  if (!endDate || endDate > today) endDate = today

  // For an explicit range, use the picked day key directly so the string-based
  // queries (ad spend / billing / payout) match the selected boundary exactly.
  const startStr = dateFromKey ?? dateOnly(startDate)
  const payoutStartStr = startStr > SHOPIFY_PAYOUT_START_DATE ? startStr : SHOPIFY_PAYOUT_START_DATE
  const endStr = dateKeyInZone(endDate, timeZone)
  const orderRangeStart = zonedDayStartUtc(startStr, timeZone)
  const orderRangeEnd = new Date(zonedDayStartUtc(addDays(endStr, 1), timeZone).getTime() - 1)
  const periodIsValid = startDate <= endDate

  const paidMetaStatuses = ['PAID', 'SETTLED', 'COMPLETED']
  const metaAccounts = await prisma.metaAdAccount.findMany({
    where: { projectId },
    select: { id: true, accountId: true, accountName: true, currency: true },
  })
  const metaAccountIds = metaAccounts.map(account => account.id)
  const [payouts, billings, orders, dailyAdSpends, otherBills, fulfillmentBills] = await Promise.all([
    project.shopifyStore ? prisma.payout.findMany({
      where: {
        storeId: project.shopifyStore.id,
        date: {
          gte: payoutStartStr,
          lte: endStr,
        },
        status: 'paid',
      },
      orderBy: { date: 'desc' },
    }) : Promise.resolve([]),
    prisma.metaBilling.findMany({
      where: {
        billingDate: {
          gte: startStr,
          lte: endStr,
        },
        status: { in: paidMetaStatuses },
        adAccount: { projectId },
      },
      select: { adAccountId: true, amount: true, currency: true, billingDate: true },
    }),
    prisma.order.findMany({
      where: {
        projectId,
        placedAt: { gte: orderRangeStart, lte: orderRangeEnd },
        pipelineStatus: { notIn: [...PROJECT_REVENUE_EXCLUDED_STATUSES] },
      },
      include: {
        lines: {
          select: {
            qty: true,
            sku: true,
            productTitle: true,
            shopifyProductType: true,
            resolvedSupplierId: true,
            resolvedBaseCost: true,
            manualBaseCost: true,
            resolvedShipFirst: true,
            resolvedShipAdditional: true,
            resolvedImportTax: true,
          },
        },
      },
    }),
    periodIsValid && metaAccountIds.length > 0
      ? prisma.dailyAdSpend.findMany({
          where: {
            adAccountId: { in: metaAccountIds },
            date: { gte: startStr, lte: endStr },
          },
          select: { adAccountId: true, spend: true, currency: true, date: true },
        })
      : Promise.resolve([]),
    prisma.otherBill.findMany({
      where: {
        projectId,
        paidAt: { gte: startStr, lte: endStr },
      },
      select: { amountUsd: true, category: true },
    }),
    prisma.fulfillmentCost.findMany({
      where: {
        projectId,
        recognitionDate: { gte: startStr, lte: endStr },
      },
      select: { totalAmount: true },
    }),
  ])
  const schedule = await getMetaRateSchedule()

  const totalPayout = payouts.reduce((sum, p) => sum + p.amount, 0)
  const metaBillingSummary = sumMetaAmountsUsdDated(billings, schedule)
  const totalMetaBilling = metaBillingSummary.totalUsd
  const { totalRevenue, totalPaymentFees } = summarizeProjectOrderFinancials(orders)
  let totalOrderProfit = 0
  let totalOrderCogs = 0
  let mappedOrderCount = 0
  let unmappedOrderCount = 0
  for (const order of orders) {
    const productLines = productLinesOnly(order.lines)
    const estimate = estimateOrderCostAndProfit(order.expectedPayout, productLines)
    if (!estimate) continue
    if (estimate.hasUnmapped) {
      unmappedOrderCount++
    } else {
      mappedOrderCount++
    }
    totalOrderProfit += estimate.profit
    totalOrderCogs += estimate.estimatedCogs
  }
  const totalFulfillmentCost = totalOrderCogs
  const billingDates = billings.map(b => b.billingDate).sort()
  const orderDates = orders.map(order => dateKeyInZone(order.placedAt, timeZone)).sort()
  const payoutDates = payouts.map(payout => payout.date).sort()
  const latestOrderDate = orderDates[orderDates.length - 1] ?? null
  const latestPayoutDate = payoutDates[payoutDates.length - 1] ?? null
  const orderDataMayBeStale = Boolean(
    latestOrderDate
    && latestPayoutDate
    && latestPayoutDate > addDays(latestOrderDate, 7),
  )
  const untilStr = endStr
  const spendRowsByAccount = new Map<string, typeof dailyAdSpends>()
  for (const row of dailyAdSpends) {
    const rows = spendRowsByAccount.get(row.adAccountId) ?? []
    rows.push(row)
    spendRowsByAccount.set(row.adAccountId, rows)
  }
  const spendByAccount = metaAccounts.map(account => {
    const rows = spendRowsByAccount.get(account.id) ?? []
    const currency = normalizeMetaCurrency(account.currency)
    const originalSpend = rows.reduce((sum, row) => sum + row.spend, 0)
    let missingExchangeRate = false
    const spend = rows.reduce((sum, row) => {
      const amountUsd = convertMetaAmountToUsdDated(row.spend, row.currency || currency, row.date, schedule)
      if (amountUsd === null) missingExchangeRate = true
      return sum + (amountUsd ?? 0)
    }, 0)

    return {
      accountId: account.accountId,
      accountName: account.accountName,
      spend,
      originalSpend,
      currency,
      source: missingExchangeRate ? 'missing_exchange_rate' : 'synced_daily_ad_spend',
      ...(missingExchangeRate ? { error: `Chưa có tỷ giá ${currency} / USD` } : {}),
    }
  })
  const totalAdSpend = spendByAccount.reduce((sum, item) => sum + item.spend, 0)
  const otherBillsTotal = otherBills.reduce((sum, bill) => sum + bill.amountUsd, 0)
  const otherBillsByCategory = OTHER_BILL_CATEGORIES
    .map(category => ({
      category,
      total: otherBills.filter(bill => bill.category === category).reduce((sum, bill) => sum + bill.amountUsd, 0),
      count: otherBills.filter(bill => bill.category === category).length,
    }))
    .filter(row => row.count > 0)
  const fulfillmentBillsTotal = fulfillmentBills.reduce((sum, cost) => sum + cost.totalAmount, 0)
  const totalOtherCosts = otherBillsTotal + fulfillmentBillsTotal
  const cashflowCosts = totalOrderCogs + totalOtherCosts
  const actualCashflow = totalPayout - totalMetaBilling - cashflowCosts
  const shopifyBalance = project.shopifyStore?.currentBalance ?? 0
  // Payouts Shopify is transferring but has not deposited yet (forward-looking, not date-filtered).
  const inTransitPayoutRows = project.shopifyStore
    ? await prisma.payout.findMany({
        where: { storeId: project.shopifyStore.id, status: { in: ['in_transit', 'scheduled', 'pending'] } },
        select: { amount: true },
      })
    : []
  const inTransitPayout = inTransitPayoutRows.reduce((sum, row) => sum + row.amount, 0)
  const projectedCashflow = actualCashflow + shopifyBalance + inTransitPayout
  // "Tiền treo": order net revenue not yet received as a paid payout, in-transit payout, or available balance.
  const totalOrderNetRevenue = orders.reduce((sum, order) => sum + order.expectedPayout, 0)
  const pendingPayout = Math.max(0, totalOrderNetRevenue - totalPayout - inTransitPayout - shopifyBalance)
  const expectedCashflow = projectedCashflow + pendingPayout
  const grossProfit = totalOrderProfit - totalOtherCosts - totalAdSpend
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
      currency: normalizeMetaCurrency(account.currency),
    })),
  }
  const dataDiagnostics = {
    period: { start: startStr, end: untilStr },
    metaBilling: {
      source: 'Meta paid billing transactions',
      firstDate: billingDates[0] ?? null,
      lastDate: billingDates[billingDates.length - 1] ?? null,
      transactionCount: billings.length,
      missingRateCount: metaBillingSummary.missingCount,
    },
    actualAdSpend: {
      source: 'Synced Meta daily ad spend',
      note: 'Dashboard reads the synced DailyAdSpend table. Billing is cash/card charge timing, so values can differ in the same date range.',
    },
    orderProfit: {
      source: 'Order profit with estimated COGS for unmapped lines',
      mappedOrderCount,
      unmappedOrderCount,
      estimateRule: 'Unmapped COGS = known COGS + 50% of payout remaining after known COGS',
    },
    orderRevenue: {
      source: 'Shopify orders excluding refunded and cancelled orders',
      orderCount: orders.length,
      firstDate: orderDates[0] ?? null,
      lastDate: latestOrderDate,
      latestPayoutDate,
      mayBeStale: orderDataMayBeStale,
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
    otherBillsTotal,
    otherBillsByCategory,
    otherBillsCount: otherBills.length,
    fulfillmentBillsTotal,
    fulfillmentBillsCount: fulfillmentBills.length,
    totalOtherCosts,
    actualCashflow,
    shopifyBalance,
    shopifyBalanceCurrency: project.shopifyStore?.currentBalanceCurrency ?? null,
    inTransitPayout,
    projectedCashflow,
    pendingPayout,
    totalOrderNetRevenue,
    expectedCashflow,
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
