import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { computeOrderProfitFromDb } from '@/lib/order-profit'

function getPeriodRange(period: string, from?: string | null, to?: string | null) {
  const now = new Date()
  const todayStr = now.toISOString().split('T')[0]

  if (period === 'custom' && from && to) {
    return { from: new Date(`${from}T00:00:00.000Z`), to: new Date(`${to}T23:59:59.999Z`) }
  }
  if (period === 'today') {
    return { from: new Date(`${todayStr}T00:00:00.000Z`), to: new Date(`${todayStr}T23:59:59.999Z`) }
  }
  if (period === 'this-week') {
    const dow = now.getUTCDay()
    const monday = new Date(now)
    monday.setUTCDate(now.getUTCDate() - ((dow + 6) % 7))
    const mondayStr = monday.toISOString().split('T')[0]
    return { from: new Date(`${mondayStr}T00:00:00.000Z`), to: new Date(`${todayStr}T23:59:59.999Z`) }
  }
  // default: this-month
  const monthStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  return {
    from: new Date(`${monthStr}-01T00:00:00.000Z`),
    to: new Date(`${todayStr}T23:59:59.999Z`),
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get('projectId')
  if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 })

  const period = searchParams.get('period') ?? 'this-month'
  const { from, to } = getPeriodRange(period, searchParams.get('from'), searchParams.get('to'))

  try {
    // Lấy orders của project trong khoảng thời gian
    const orders = await prisma.order.findMany({
      where: { projectId, placedAt: { gte: from, lte: to } },
      include: {
        lines: {
          select: {
            qty: true,
            resolvedBaseCost: true,
            resolvedShipFirst: true,
            resolvedShipAdditional: true,
            resolvedImportTax: true,
          },
        },
      },
      orderBy: { placedAt: 'asc' },
    })

    // Lấy MetaAdAccount của project để query DailyAdSpend
    const metaAccounts = await prisma.metaAdAccount.findMany({
      where: { projectId },
      select: { id: true },
    })
    const accountIds = metaAccounts.map(a => a.id)

    const fromDate = from.toISOString().split('T')[0]
    const toDate = to.toISOString().split('T')[0]

    const dailySpends = accountIds.length > 0
      ? await prisma.dailyAdSpend.findMany({
          where: { adAccountId: { in: accountIds }, date: { gte: fromDate, lte: toDate } },
        })
      : []

    // Tổng spend theo ngày
    const spendByDate: Record<string, number> = {}
    for (const ds of dailySpends) {
      spendByDate[ds.date] = (spendByDate[ds.date] ?? 0) + ds.spend
    }

    // Group orders theo ngày
    const dayMap: Record<string, { orders: number; ordersUnmapped: number; revenue: number; profit: number }> = {}

    for (const order of orders) {
      const dateKey = order.placedAt.toISOString().split('T')[0]
      if (!dayMap[dateKey]) dayMap[dateKey] = { orders: 0, ordersUnmapped: 0, revenue: 0, profit: 0 }

      const profit = computeOrderProfitFromDb(order.expectedPayout, order.lines)

      if (profit === null) {
        dayMap[dateKey].ordersUnmapped++
      } else {
        dayMap[dateKey].orders++
        dayMap[dateKey].revenue += order.grossAmount
        dayMap[dateKey].profit += profit
      }
    }

    // Build daily series — fill in missing days with zeros
    const dailyData = []
    const cursor = new Date(from)
    while (cursor <= to) {
      const dateStr = cursor.toISOString().split('T')[0]
      const day = dayMap[dateStr] ?? { orders: 0, ordersUnmapped: 0, revenue: 0, profit: 0 }
      dailyData.push({
        date: dateStr,
        orders: day.orders,
        ordersUnmapped: day.ordersUnmapped,
        revenue: Math.round(day.revenue * 100) / 100,
        profit: Math.round(day.profit * 100) / 100,
        adSpend: Math.round((spendByDate[dateStr] ?? 0) * 100) / 100,
      })
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }

    const totalOrders = dailyData.reduce((s, d) => s + d.orders, 0)
    const totalOrdersUnmapped = dailyData.reduce((s, d) => s + d.ordersUnmapped, 0)
    const totalRevenue = Math.round(dailyData.reduce((s, d) => s + d.revenue, 0) * 100) / 100
    const totalProfit = Math.round(dailyData.reduce((s, d) => s + d.profit, 0) * 100) / 100
    const totalAdSpend = Math.round(dailyData.reduce((s, d) => s + d.adSpend, 0) * 100) / 100
    const avgMargin = totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 10000) / 100 : 0
    const avgOrderProfit = totalOrders > 0 ? Math.round((totalProfit / totalOrders) * 100) / 100 : 0

    return NextResponse.json({
      dailyData,
      summary: {
        totalOrders,
        totalOrdersUnmapped,
        totalRevenue,
        totalProfit,
        totalAdSpend,
        netProfit: Math.round((totalProfit - totalAdSpend) * 100) / 100,
        avgMargin,
        avgOrderProfit,
      },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
