import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { estimateOrderCostAndProfit } from '@/lib/order-profit'

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

function getPeriodRange(period: string, timeZone: string, from?: string | null, to?: string | null) {
  const todayStr = dateKeyInZone(new Date(), timeZone)
  const buildRange = (fromKey: string, toKey: string) => ({
    from: zonedDayStartUtc(fromKey, timeZone),
    to: new Date(zonedDayStartUtc(addDays(toKey, 1), timeZone).getTime() - 1),
    fromKey,
    toKey,
  })

  if (period === 'custom' && from && to) return buildRange(from, to)
  if (period === 'today') return buildRange(todayStr, todayStr)
  if (period === 'this-week') {
    const dow = new Date(`${todayStr}T12:00:00.000Z`).getUTCDay()
    return buildRange(addDays(todayStr, -((dow + 6) % 7)), todayStr)
  }
  return buildRange(`${todayStr.slice(0, 7)}-01`, todayStr)
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
      where: { projectId, placedAt: { gte: from, lte: to } },
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
      orderBy: { placedAt: 'asc' },
    })

    const metaAccounts = await prisma.metaAdAccount.findMany({
      where: { projectId },
      select: { id: true },
    })
    const accountIds = metaAccounts.map(a => a.id)
    const dailySpends = accountIds.length > 0
      ? await prisma.dailyAdSpend.findMany({
          where: { adAccountId: { in: accountIds }, date: { gte: fromKey, lte: toKey } },
        })
      : []

    const spendByDate: Record<string, number> = {}
    for (const ds of dailySpends) {
      spendByDate[ds.date] = (spendByDate[ds.date] ?? 0) + ds.spend
    }

    const dayMap: Record<string, { orders: number; ordersUnmapped: number; revenue: number; profit: number }> = {}
    for (const order of orders) {
      const dateKey = dateKeyInZone(order.placedAt, timeZone)
      if (!dayMap[dateKey]) dayMap[dateKey] = { orders: 0, ordersUnmapped: 0, revenue: 0, profit: 0 }

      const productLines = order.lines.filter(line => {
        if (line.sku) return true
        const title = line.productTitle.toLowerCase().trim()
        return title !== 'tip' && title !== 'shipping protection'
      })
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
        revenue: Math.round(day.revenue * 100) / 100,
        profit: Math.round(day.profit * 100) / 100,
        adSpend: Math.round((spendByDate[cursor] ?? 0) * 100) / 100,
      })
      cursor = addDays(cursor, 1)
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
      period: { from: fromKey, to: toKey, timeZone },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
