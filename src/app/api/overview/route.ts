import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { ordersWithComputedPL } from '@/lib/repos/reports'

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

function getPeriodRange(period: string, timeZone: string, date?: string | null) {
  const now = new Date()
  const todayStr = dateKeyInZone(now, timeZone)

  const buildRange = (fromKey: string, toKey: string, label: string) => ({
    from: zonedDayStartUtc(fromKey, timeZone),
    to: new Date(zonedDayStartUtc(addDays(toKey, 1), timeZone).getTime() - 1),
    fromKey,
    toKey,
    label,
  })

  if (period === 'custom' && date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return buildRange(date, date, `Ngày ${date}`)
  }
  if (period === 'today') {
    return buildRange(todayStr, todayStr, 'Hôm nay')
  }
  if (period === 'this-week') {
    const dow = new Date(`${todayStr}T12:00:00.000Z`).getUTCDay()
    const mondayStr = addDays(todayStr, -((dow + 6) % 7))
    return buildRange(mondayStr, todayStr, 'Tuần này')
  }
  if (period === 'this-month') {
    return buildRange(`${todayStr.slice(0, 7)}-01`, todayStr, 'Tháng này')
  }
  return null // all-time
}

function tipAmount(order: Awaited<ReturnType<typeof ordersWithComputedPL>>[number]) {
  return order.lines.reduce((sum, line) => {
    if (line.productTitle.toLowerCase().trim() !== 'tip') return sum
    return sum + line.unitPrice * line.qty
  }, 0)
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const period = searchParams.get('period') ?? 'all'
    const store = await prisma.shopifyStore.findFirst({ select: { ianaTimezone: true } })
    const storeTimeZone = store?.ianaTimezone ?? 'UTC'
    const periodRange = getPeriodRange(period, storeTimeZone, searchParams.get('date'))

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
        ordersWithComputedPL({ dateFrom: periodRange.from, dateTo: periodRange.to, limit: 10000 }),
        prisma.dailyAdSpend.findMany({
          where: {
            date: {
              gte: periodRange.fromKey,
              lte: periodRange.toKey,
            },
          },
        }),
      ])

      const totalOrderRevenue = periodOrders.reduce((s, order) => s + order.grossAmount - tipAmount(order), 0)
      const totalOrderProfit = periodOrders.reduce((s, order) => s + order.computed.profit, 0)
      const adSpend = periodAdSpends.reduce((s, d) => s + d.spend, 0)
      const roas = adSpend > 0 ? totalOrderRevenue / adSpend : 0
      const avgMargin = totalOrderRevenue > 0 ? (totalOrderProfit / totalOrderRevenue) * 100 : 0
      const aov = periodOrders.length > 0 ? totalOrderRevenue / periodOrders.length : 0

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
        from: periodRange.fromKey,
        to: periodRange.toKey,
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
