import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { computeOrderProfitFromDb } from '@/lib/order-profit'

function getPeriodRange(period: string) {
  const now = new Date()
  const todayStr = now.toISOString().split('T')[0]

  if (period === 'today') {
    return { from: new Date(`${todayStr}T00:00:00.000Z`), to: new Date(`${todayStr}T23:59:59.999Z`), label: 'Hôm nay' }
  }
  if (period === 'this-week') {
    const dow = now.getUTCDay()
    const monday = new Date(now)
    monday.setUTCDate(now.getUTCDate() - ((dow + 6) % 7))
    const mondayStr = monday.toISOString().split('T')[0]
    return { from: new Date(`${mondayStr}T00:00:00.000Z`), to: new Date(`${todayStr}T23:59:59.999Z`), label: 'Tuần này' }
  }
  if (period === 'this-month') {
    const monthStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    return { from: new Date(`${monthStr}-01T00:00:00.000Z`), to: new Date(`${todayStr}T23:59:59.999Z`), label: 'Tháng này' }
  }
  return null // all-time
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const period = searchParams.get('period') ?? 'all'
    const periodRange = getPeriodRange(period)

    const paidMetaStatuses = ['PAID', 'SETTLED', 'COMPLETED']

    const [payouts, metaBillings, projects, staff] = await Promise.all([
      prisma.payout.findMany({ where: { status: 'paid' } }),
      prisma.metaBilling.findMany({ where: { status: { in: paidMetaStatuses } } }),
      prisma.project.findMany({
        include: { assignments: { include: { staff: true } } },
        orderBy: { startDate: 'desc' },
      }),
      prisma.staff.findMany(),
    ])

    const totalRevenue = payouts.reduce((s, p) => s + p.amount, 0)
    const payoutCount = payouts.length
    const recentPayouts = await prisma.payout.findMany({
      where: { status: 'paid' }, orderBy: { date: 'desc' }, take: 5,
    })

    const totalSpend = metaBillings.reduce((s, b) => s + b.amount, 0)
    const billingCount = metaBillings.length
    const recentBillings = await prisma.metaBilling.findMany({
      where: { status: { in: paidMetaStatuses } }, orderBy: { billingDate: 'desc' }, take: 5,
    })

    const projectList = projects.map(p => ({
      id: p.id,
      name: p.name,
      startDate: p.startDate,
      staffCount: p.assignments.length,
      monthlyCost: p.assignments.reduce((s, a) => s + (a.staff?.monthlyCost ?? 0), 0),
    }))

    // Period metrics
    let periodMetrics = null
    if (periodRange) {
      const [periodOrders, periodAdSpends] = await Promise.all([
        prisma.order.findMany({
          where: { placedAt: { gte: periodRange.from, lte: periodRange.to } },
          include: {
            lines: {
              select: { qty: true, resolvedBaseCost: true, resolvedShipFirst: true, resolvedShipAdditional: true, resolvedImportTax: true },
            },
          },
        }),
        prisma.dailyAdSpend.findMany({
          where: {
            date: {
              gte: periodRange.from.toISOString().split('T')[0],
              lte: periodRange.to.toISOString().split('T')[0],
            },
          },
        }),
      ])

      let totalOrderProfit = 0
      let mappedOrders = 0
      let totalOrderRevenue = 0

      for (const order of periodOrders) {
        const profit = computeOrderProfitFromDb(order.expectedPayout, order.lines)
        if (profit !== null) {
          totalOrderProfit += profit
          mappedOrders++
          totalOrderRevenue += order.grossAmount
        }
      }

      const adSpend = periodAdSpends.reduce((s, d) => s + d.spend, 0)
      const roas = adSpend > 0 ? totalOrderRevenue / adSpend : 0
      const avgMargin = totalOrderRevenue > 0 ? (totalOrderProfit / totalOrderRevenue) * 100 : 0
      const aov = mappedOrders > 0 ? totalOrderRevenue / mappedOrders : 0

      const unfulfilledOrders = await prisma.order.count({
        where: {
          placedAt: { gte: periodRange.from, lte: periodRange.to },
          OR: [
            { fulfillmentStatus: 'unfulfilled' },
            { fulfillmentStatus: null },
          ],
        },
      })

      periodMetrics = {
        period,
        label: periodRange.label,
        from: periodRange.from.toISOString().split('T')[0],
        to: periodRange.to.toISOString().split('T')[0],
        orders: periodOrders.length,
        revenue: Math.round(totalOrderRevenue * 100) / 100,
        adSpend: Math.round(adSpend * 100) / 100,
        orderProfit: Math.round(totalOrderProfit * 100) / 100,
        netProfit: Math.round((totalOrderProfit - adSpend) * 100) / 100,
        roas: Math.round(roas * 100) / 100,
        avgMargin: Math.round(avgMargin * 100) / 100,
        avgOrderValue: Math.round(aov * 100) / 100,
        unfulfilledOrders,
      }
    }

    // Chart data: last 30 days revenue + ad spend grouped by day
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const [chartOrders, chartSpends] = await Promise.all([
      prisma.order.findMany({
        where: { placedAt: { gte: thirtyDaysAgo } },
        select: { placedAt: true, grossAmount: true },
      }),
      prisma.dailyAdSpend.findMany({
        where: { date: { gte: thirtyDaysAgo.toISOString().split('T')[0] } },
      }),
    ])

    const revenueByDate: Record<string, number> = {}
    for (const o of chartOrders) {
      const d = o.placedAt.toISOString().split('T')[0]
      revenueByDate[d] = (revenueByDate[d] ?? 0) + o.grossAmount
    }
    const spendByDate: Record<string, number> = {}
    for (const s of chartSpends) {
      spendByDate[s.date] = (spendByDate[s.date] ?? 0) + s.spend
    }

    const chartData: Array<{ date: string; revenue: number; adSpend: number }> = []
    const cursor = new Date(thirtyDaysAgo)
    const today = new Date()
    while (cursor <= today) {
      const d = cursor.toISOString().split('T')[0]
      chartData.push({
        date: d,
        revenue: Math.round((revenueByDate[d] ?? 0) * 100) / 100,
        adSpend: Math.round((spendByDate[d] ?? 0) * 100) / 100,
      })
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }

    return NextResponse.json({
      shopify: { totalRevenue, payoutCount, recentPayouts },
      meta: { totalSpend, billingCount, recentBillings },
      projects: { count: projects.length, list: projectList },
      staff: { count: staff.length, totalMonthlyCost: staff.reduce((s, st) => s + st.monthlyCost, 0) },
      netCashflow: totalRevenue - totalSpend,
      periodMetrics,
      chartData,
    })
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 })
  }
}
