import { prisma } from '@/lib/db'
import { estimateOrderCostAndProfit } from '@/lib/order-profit'
import { productLinesOnly } from '@/lib/order-lines'
import { convertMetaAmountToUsdDated, normalizeMetaCurrency, sumMetaAmountsUsdDated } from '@/lib/meta-currency'
import { getMetaRateSchedule } from '@/lib/meta-exchange-rates'
import { getVndCardLast4, sumBillingFxFeesUsd } from '@/lib/meta-fee'
import { PROJECT_REVENUE_EXCLUDED_STATUSES, summarizeProjectOrderFinancials } from '@/lib/project-metrics'
import { dateKeyInZone, addDays } from '@/lib/cashflow-dates'

const OTHER_BILL_CATEGORIES = ['APP_TOOL', 'SUBSCRIPTION', 'SUPPLIER', 'OFFICE', 'OTHER'] as const

export function sumPendingInvoiceChargeUsd(
  accounts: { balance: number | null; balanceCurrency: string | null }[],
  dateKey: string,
  schedule: { effectiveDate: string; rate: number }[],
): number {
  let total = 0
  for (const a of accounts) {
    if (a.balance === null || a.balance === undefined) continue
    const usd = convertMetaAmountToUsdDated(a.balance, a.balanceCurrency, dateKey, schedule)
    if (usd === null) continue
    total += usd
  }
  return Math.round(total * 100) / 100
}

export type ProjectCashflowInput = {
  project: any
  timeZone: string
  startStr: string
  endStr: string
  payoutStartStr: string
  startDate: Date
  endDate: Date
  orderRangeStart: Date
  orderRangeEnd: Date
  periodIsValid: boolean
}

export type ProjectCashflowResult = Record<string, any>

export async function computeProjectCashflow(input: ProjectCashflowInput): Promise<ProjectCashflowResult> {
  const {
    project,
    timeZone,
    startStr,
    endStr,
    payoutStartStr,
    startDate,
    endDate,
    orderRangeStart,
    orderRangeEnd,
    periodIsValid,
  } = input

  const paidMetaStatuses = ['PAID', 'SETTLED', 'COMPLETED']
  const metaAccounts = await prisma.metaAdAccount.findMany({
    where: { projectId: project.id },
    select: { id: true, accountId: true, accountName: true, currency: true, balance: true, balanceCurrency: true },
  })
  const metaAccountIds = metaAccounts.map((account: any) => account.id)
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
        adAccount: { projectId: project.id },
      },
      select: { adAccountId: true, amount: true, currency: true, billingDate: true, paymentMethodLast4: true },
    }),
    prisma.order.findMany({
      where: {
        projectId: project.id,
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
        projectId: project.id,
        paidAt: { gte: startStr, lte: endStr },
      },
      select: { amountUsd: true, category: true },
    }),
    prisma.fulfillmentCost.findMany({
      where: {
        projectId: project.id,
        recognitionDate: { gte: startStr, lte: endStr },
      },
      select: { totalAmount: true },
    }),
  ])
  const schedule = await getMetaRateSchedule()

  const totalPayout = payouts.reduce((sum: number, p: any) => sum + p.amount, 0)
  const metaBillingSummary = sumMetaAmountsUsdDated(billings, schedule)
  const totalMetaBilling = metaBillingSummary.totalUsd
  const vndCards = await getVndCardLast4()
  const metaFxFee = sumBillingFxFeesUsd(billings, vndCards, schedule)
  const paidReality = totalMetaBilling + metaFxFee
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
  const billingDates = billings.map((b: any) => b.billingDate).sort()
  const orderDates = orders.map((order: any) => dateKeyInZone(order.placedAt, timeZone)).sort()
  const payoutDates = payouts.map((payout: any) => payout.date).sort()
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
  const spendByAccount = metaAccounts.map((account: any) => {
    const rows = spendRowsByAccount.get(account.id) ?? []
    const currency = normalizeMetaCurrency(account.currency)
    const originalSpend = rows.reduce((sum: number, row: any) => sum + row.spend, 0)
    let missingExchangeRate = false
    const spend = rows.reduce((sum: number, row: any) => {
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
  const totalAdSpend = spendByAccount.reduce((sum: number, item: any) => sum + item.spend, 0)
  const otherBillsTotal = otherBills.reduce((sum: number, bill: any) => sum + bill.amountUsd, 0)
  const otherBillsByCategory = OTHER_BILL_CATEGORIES
    .map(category => ({
      category,
      total: otherBills.filter((bill: any) => bill.category === category).reduce((sum: number, bill: any) => sum + bill.amountUsd, 0),
      count: otherBills.filter((bill: any) => bill.category === category).length,
    }))
    .filter(row => row.count > 0)
  const fulfillmentBillsTotal = fulfillmentBills.reduce((sum: number, cost: any) => sum + cost.totalAmount, 0)
  const totalOtherCosts = otherBillsTotal + fulfillmentBillsTotal
  const cashflowCosts = totalOrderCogs + totalOtherCosts
  const actualCashflow = totalPayout - totalMetaBilling - metaFxFee - cashflowCosts
  const shopifyBalance = project.shopifyStore?.currentBalance ?? 0
  const inTransitPayoutRows = project.shopifyStore
    ? await prisma.payout.findMany({
        where: { storeId: project.shopifyStore.id, status: { in: ['in_transit', 'scheduled', 'pending'] } },
        select: { amount: true },
      })
    : []
  const inTransitPayout = inTransitPayoutRows.reduce((sum: number, row: any) => sum + row.amount, 0)
  const pendingInvoiceCharge = sumPendingInvoiceChargeUsd(metaAccounts, endStr, schedule)
  const projectedCashflow = actualCashflow + shopifyBalance + inTransitPayout - pendingInvoiceCharge
  const totalOrderNetRevenue = orders.reduce((sum: number, order: any) => sum + order.expectedPayout, 0)
  const pendingPayout = Math.max(0, totalOrderNetRevenue - totalPayout - inTransitPayout - shopifyBalance)
  const expectedCashflow = projectedCashflow + pendingPayout
  const grossProfit = totalOrderProfit - totalOtherCosts - totalAdSpend - metaFxFee
  const grossMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0
  const effectiveAdCost = totalAdSpend + metaFxFee
  const adSpendRatio = totalRevenue > 0 ? (effectiveAdCost / totalRevenue) * 100 : 0
  const roas = effectiveAdCost > 0 ? totalRevenue / effectiveAdCost : 0
  const activeAssignments = project.assignments
    .filter((assignment: any) => {
      const assignmentStart = assignment.startDate.toISOString().split('T')[0]
      const assignmentEnd = assignment.endDate ? assignment.endDate.toISOString().split('T')[0] : null
      return assignmentStart <= untilStr && (!assignmentEnd || assignmentEnd >= startStr)
    })
    .map((assignment: any) => ({
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
    metaAccounts: metaAccounts.map((account: any) => ({
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

  return {
    labelAudit,
    dataDiagnostics,
    payouts,
    spendByAccount,
    totalPayout,
    totalRevenue,
    totalPaymentFees,
    totalAdSpend,
    totalMetaBilling,
    metaFxFee,
    paidReality,
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
    pendingInvoiceCharge,
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
  }
}
