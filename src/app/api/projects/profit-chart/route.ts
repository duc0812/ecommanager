import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { estimateOrderCostAndProfit } from '@/lib/order-profit'
import { productLinesOnly } from '@/lib/order-lines'
import { convertMetaAmountToUsdDated } from '@/lib/meta-currency'
import { getMetaRateSchedule } from '@/lib/meta-exchange-rates'
import { PROJECT_REVENUE_EXCLUDED_STATUSES } from '@/lib/project-metrics'
import { dateKeyInZone, addDays, getPeriodRange } from '@/lib/cashflow-dates'

function roundMetric(value: number) {
  return Math.round((value + 1e-9) * 100) / 100
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get('projectId')
  if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 })

  const period = searchParams.get('period') ?? 'this-month'

  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { shopifyStore: { select: { ianaTimezone: true } } },
    })
    const timeZone = project?.shopifyStore?.ianaTimezone ?? 'UTC'
    const { from, to, fromKey, toKey } = getPeriodRange(period, timeZone, searchParams.get('from'), searchParams.get('to'))

    const orders = await prisma.order.findMany({
      where: {
        projectId,
        placedAt: { gte: from, lte: to },
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
      orderBy: { placedAt: 'asc' },
    })

    const metaAccounts = await prisma.metaAdAccount.findMany({
      where: { projectId },
      select: { id: true, accountId: true, accountName: true, currency: true },
    })
    const accountIds = metaAccounts.map(a => a.id)
    const accountCurrencies = new Map(metaAccounts.map(account => [account.id, account.currency]))
    const schedule = await getMetaRateSchedule()
    const dailySpends = accountIds.length > 0
      ? await prisma.dailyAdSpend.findMany({
          where: { adAccountId: { in: accountIds }, date: { gte: fromKey, lte: toKey } },
        })
      : []

    const spendByDate: Record<string, number> = {}
    const missingRateIds = new Set<string>()
    for (const ds of dailySpends) {
      const spendUsd = convertMetaAmountToUsdDated(
        ds.spend,
        accountCurrencies.get(ds.adAccountId) || ds.currency,
        ds.date,
        schedule,
      )
      if (spendUsd === null) missingRateIds.add(ds.adAccountId)
      spendByDate[ds.date] = (spendByDate[ds.date] ?? 0) + (spendUsd ?? 0)
    }

    const dayMap: Record<string, { orders: number; ordersUnmapped: number; revenue: number; profit: number }> = {}
    for (const order of orders) {
      const dateKey = dateKeyInZone(order.placedAt, timeZone)
      if (!dayMap[dateKey]) dayMap[dateKey] = { orders: 0, ordersUnmapped: 0, revenue: 0, profit: 0 }

      const productLines = productLinesOnly(order.lines)
      const estimate = estimateOrderCostAndProfit(order.expectedPayout, productLines)
      dayMap[dateKey].orders++
      dayMap[dateKey].revenue += order.grossAmount
      if (estimate?.hasUnmapped) {
        dayMap[dateKey].ordersUnmapped++
      }
      dayMap[dateKey].profit += estimate?.profit ?? 0
    }

    const dailyData = []
    let cursor = fromKey
    while (cursor <= toKey) {
      const day = dayMap[cursor] ?? { orders: 0, ordersUnmapped: 0, revenue: 0, profit: 0 }
      dailyData.push({
        date: cursor,
        orders: day.orders,
        ordersUnmapped: day.ordersUnmapped,
        revenue: roundMetric(day.revenue),
        profit: roundMetric(day.profit),
        adSpend: roundMetric(spendByDate[cursor] ?? 0),
      })
      cursor = addDays(cursor, 1)
    }

    // Build summary from raw values. Summing already-rounded daily points can drift
    // by a few cents from the Project Analytics cards for the same period.
    const totalOrders = orders.length
    const totalOrdersUnmapped = Object.values(dayMap).reduce((sum, day) => sum + day.ordersUnmapped, 0)
    const totalRevenue = roundMetric(orders.reduce((sum, order) => sum + order.grossAmount, 0))
    const totalProfit = roundMetric(Object.values(dayMap).reduce((sum, day) => sum + day.profit, 0))
    const totalAdSpend = roundMetric(Object.values(spendByDate).reduce((sum, spend) => sum + spend, 0))
    const avgMargin = totalRevenue > 0 ? roundMetric((totalProfit / totalRevenue) * 100) : 0
    const avgOrderProfit = totalOrders > 0 ? roundMetric(totalProfit / totalOrders) : 0

    return NextResponse.json({
      dailyData,
      summary: {
        totalOrders,
        totalOrdersUnmapped,
        totalRevenue,
        totalProfit,
        totalAdSpend,
        netProfit: roundMetric(totalProfit - totalAdSpend),
        avgMargin,
        avgOrderProfit,
      },
      period: { from: fromKey, to: toKey, timeZone },
      missingExchangeRateAccounts: metaAccounts.filter(account => missingRateIds.has(account.id)),
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
