import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { ordersWithComputedPL } from '@/lib/repos/reports'
import { payoutDateWhereForStores } from '@/lib/shopify-payout-policy'
import { convertMetaAmountToUsdDated, sumMetaAmountsUsdDated } from '@/lib/meta-currency'
import { getMetaRateSchedule } from '@/lib/meta-exchange-rates'
import { PAID_META_STATUSES } from '@/lib/meta-fee'
import { projectRowsWhere, projectWhere, requireFinanceScope, type FinanceScope } from '@/lib/finance-scope'

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

type BillingRow = { amount: number; currency: string; billingDate: string; paymentMethod: string | null; paymentMethodLast4: string | null }

function cardSummary(bills: BillingRow[], schedule: Awaited<ReturnType<typeof getMetaRateSchedule>>) {
  const map = new Map<string, { last4: string; method: string; usd: number }>()
  for (const b of bills) {
    const usd = convertMetaAmountToUsdDated(b.amount, b.currency, b.billingDate, schedule) ?? 0
    const last4 = b.paymentMethodLast4 || '—'
    const entry = map.get(last4) ?? { last4, method: b.paymentMethod || '', usd: 0 }
    entry.usd += usd
    if (!entry.method && b.paymentMethod) entry.method = b.paymentMethod
    map.set(last4, entry)
  }
  return Array.from(map.values())
    .map(c => ({ last4: c.last4, method: c.method, usd: Math.round(c.usd * 100) / 100 }))
    .filter(c => c.usd > 0)
    .sort((a, b) => b.usd - a.usd)
}

type OverviewStore = { id: string; ianaTimezone: string | null; projectId: string | null }

type ZoneGroup = {
  timeZone: string
  storeIds: string[]
  projectIds: string[]
  // Ad accounts that belong to no store of the request. The first group takes them and counts them in its own zone.
  rest: 'none' | 'unassigned' | 'everything'
}

// A day's figures follow the time zone of the store that sold it. Stores that share a zone are one group, so with
// a single zone (every store today) the queries are the ones a single store always ran.
function zoneGroups(stores: OverviewStore[], scope: FinanceScope): ZoneGroup[] {
  const byZone = new Map<string, OverviewStore[]>()
  for (const store of stores) {
    const zone = store.ianaTimezone ?? 'UTC'
    byZone.set(zone, [...(byZone.get(zone) ?? []), store])
  }
  const rest = scope.projectIds === null ? 'everything' : scope.includeUnassigned ? 'unassigned' : 'none'
  if (byZone.size === 0) return [{ timeZone: 'UTC', storeIds: [], projectIds: [], rest }]
  return Array.from(byZone, ([timeZone, list], index) => ({
    timeZone,
    storeIds: list.map(s => s.id),
    projectIds: list.flatMap(s => (s.projectId ? [s.projectId] : [])),
    rest: index === 0 ? rest : 'none',
  }))
}

export async function GET(req: NextRequest) {
  const scope = await requireFinanceScope(req, 'overview')
  if ('error' in scope) return scope.error
  try {
    const { searchParams } = new URL(req.url)
    const period = searchParams.get('period') ?? 'all'
    const stores = await prisma.shopifyStore.findMany({
      where: scope.storeIds ? { id: { in: scope.storeIds } } : {},
      orderBy: { connectedAt: 'asc' },
      select: { id: true, shop: true, ianaTimezone: true, payoutStartDate: true, projectId: true, currentBalanceCurrency: true, project: { select: { name: true } } },
    })
    const groups = zoneGroups(stores, scope)
    const allProjectIds = stores.flatMap(s => (s.projectId ? [s.projectId] : []))
    const everyAccount = scope.projectIds === null && groups.length === 1

    // The ad accounts of one zone group, as a filter and as a test on a loaded row.
    const accountWhere = (group: ZoneGroup) => (everyAccount ? {} : {
      OR: [
        { projectId: { in: group.projectIds } },
        ...(group.rest === 'unassigned' ? [{ projectId: null }] : []),
        ...(group.rest === 'everything' ? [{ projectId: null }, { projectId: { notIn: allProjectIds } }] : []),
      ],
    })
    const groupHasAccount = (group: ZoneGroup, projectId: string | null) => everyAccount
      || (projectId !== null && group.projectIds.includes(projectId))
      || (group.rest === 'unassigned' && projectId === null)
      || (group.rest === 'everything' && (projectId === null || !allProjectIds.includes(projectId)))

    const paidMetaStatuses = PAID_META_STATUSES
    // Each store's payouts count from its own start date.
    const payoutWhere = {
      status: 'paid',
      ...payoutDateWhereForStores(stores),
    }
    const billingWhere = { status: { in: paidMetaStatuses }, ...(scope.projectIds ? { adAccount: projectRowsWhere(scope) } : {}) }

    const [payouts, metaBillings, metaAccounts, projects, staff] = await Promise.all([
      prisma.payout.findMany({ where: payoutWhere }),
      prisma.metaBilling.findMany({ where: billingWhere }),
      prisma.metaAdAccount.findMany({ where: projectRowsWhere(scope), select: { id: true, accountId: true, accountName: true, currency: true, projectId: true } }),
      prisma.project.findMany({
        where: projectWhere(scope),
        include: { assignments: { include: { staff: true } } },
        orderBy: { startDate: 'desc' },
      }),
      prisma.staff.findMany({ where: scope.projectIds ? { assignments: { some: { projectId: { in: scope.projectIds } } } } : {} }),
    ])
    const schedule = await getMetaRateSchedule()

    const totalRevenue = payouts.reduce((s, p) => s + p.amount, 0)
    const payoutCount = payouts.length
    const recentPayouts = await prisma.payout.findMany({
      where: payoutWhere, orderBy: { date: 'desc' }, take: 5,
    })

    const metaBillingSummary = sumMetaAmountsUsdDated(metaBillings, schedule)
    const totalSpend = metaBillingSummary.totalUsd
    const billingCount = metaBillings.length
    const recentBillingsRaw = await prisma.metaBilling.findMany({
      where: billingWhere, orderBy: { billingDate: 'desc' }, take: 5,
    })
    const recentBillings = recentBillingsRaw.map(billing => ({
      ...billing,
      amountUsd: convertMetaAmountToUsdDated(
        billing.amount,
        billing.currency,
        billing.billingDate,
        schedule,
      ),
    }))
    const missingRateCount = metaBillingSummary.missingCount

    const projectList = projects.map(p => ({
      id: p.id,
      name: p.name,
      startDate: p.startDate,
      staffCount: p.assignments.length,
      monthlyCost: p.assignments.reduce((s, a) => s + (a.staff?.monthlyCost ?? 0), 0),
    }))

    // Period metrics: each zone group works out its own day, then the groups are added together
    const periodRanges = groups.map(group => getPeriodRange(period, group.timeZone, searchParams.get('date')))
    const periodRange = periodRanges[0]
    let periodMetrics = null
    let periodOrdersByStore: Map<string, { revenue: number; count: number; currencies: Set<string> }> | null = null
    if (periodRange) {
      const accountProject = new Map(metaAccounts.map(a => [a.id, a.projectId]))
      const perGroup = await Promise.all(groups.map(async (group, index) => {
        const range = periodRanges[index]!
        const storeFilter = everyAccount ? null : group.storeIds
        const [orders, adSpends, unfulfilled] = await Promise.all([
          ordersWithComputedPL({ dateFrom: range.from, dateTo: range.to, limit: 10000, storeIds: storeFilter }),
          prisma.dailyAdSpend.findMany({
            where: {
              date: {
                gte: range.fromKey,
                lte: range.toKey,
              },
              ...(everyAccount ? {} : { adAccount: accountWhere(group) }),
            },
          }),
          prisma.order.count({
            where: {
              placedAt: { gte: range.from, lte: range.to },
              ...(storeFilter ? { storeId: { in: storeFilter } } : {}),
              OR: [
                { fulfillmentStatus: 'unfulfilled' },
                { fulfillmentStatus: null },
              ],
            },
          }),
        ])
        const bills = metaBillings.filter(b => b.billingDate >= range.fromKey && b.billingDate <= range.toKey
          && groupHasAccount(group, accountProject.get(b.adAccountId) ?? null))
        return { orders, adSpends, unfulfilled, bills }
      }))
      const periodOrders = perGroup.flatMap(g => g.orders)
      const periodAdSpends = perGroup.flatMap(g => g.adSpends)

      const mappedPeriodOrders = periodOrders.filter(order => !order.computed.hasUnmappedSku)
      const unmappedOrders = periodOrders.length - mappedPeriodOrders.length
      const totalOrderRevenue = periodOrders.reduce((s, order) => s + order.grossAmount - tipAmount(order), 0)
      const totalOrderProfit = periodOrders.reduce((s, order) => s + order.computed.profit, 0)
      const adSpend = sumMetaAmountsUsdDated(periodAdSpends.map(spend => ({
        amount: spend.spend,
        currency: spend.currency,
        billingDate: spend.date,
      })), schedule).totalUsd

      const spendByAccount = new Map<string, number>()
      for (const s of periodAdSpends) {
        const usd = convertMetaAmountToUsdDated(s.spend, s.currency, s.date, schedule) ?? 0
        spendByAccount.set(s.adAccountId, (spendByAccount.get(s.adAccountId) ?? 0) + usd)
      }
      const accountById = new Map(metaAccounts.map(a => [a.id, a]))
      const adSpendByAccount = Array.from(spendByAccount.entries())
        .map(([id, usd]) => ({
          accountId: id,
          name: accountById.get(id)?.accountName || accountById.get(id)?.accountId || 'Account',
          spendUsd: Math.round(usd * 100) / 100,
        }))
        .filter(a => a.spendUsd > 0)
        .sort((a, b) => b.spendUsd - a.spendUsd)

      const roas = adSpend > 0 ? totalOrderRevenue / adSpend : 0
      const avgMargin = totalOrderRevenue > 0 ? (totalOrderProfit / totalOrderRevenue) * 100 : 0
      const aov = periodOrders.length > 0 ? totalOrderRevenue / periodOrders.length : 0

      const unfulfilledOrders = perGroup.reduce((total, g) => total + g.unfulfilled, 0)

      periodOrdersByStore = new Map()
      for (const order of periodOrders) {
        const entry = periodOrdersByStore.get(order.storeId) ?? { revenue: 0, count: 0, currencies: new Set<string>() }
        entry.revenue += order.grossAmount - tipAmount(order)
        entry.count += 1
        entry.currencies.add(order.currency)
        periodOrdersByStore.set(order.storeId, entry)
      }

      periodMetrics = {
        period,
        label: periodRange.label,
        from: periodRange.fromKey,
        to: periodRange.toKey,
        orders: periodOrders.length,
        mappedOrders: mappedPeriodOrders.length,
        unmappedOrders,
        revenue: Math.round(totalOrderRevenue * 100) / 100,
        adSpend: Math.round(adSpend * 100) / 100,
        adSpendByAccount,
        spendByCard: cardSummary(perGroup.flatMap(g => g.bills), schedule),
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
        where: { placedAt: { gte: thirtyDaysAgo }, ...(scope.storeIds ? { storeId: { in: scope.storeIds } } : {}) },
        select: { placedAt: true, grossAmount: true },
      }),
      prisma.dailyAdSpend.findMany({
        where: { date: { gte: thirtyDaysAgo.toISOString().split('T')[0] }, ...(scope.projectIds ? { adAccount: projectRowsWhere(scope) } : {}) },
      }),
    ])

    const revenueByDate: Record<string, number> = {}
    for (const o of chartOrders) {
      const d = o.placedAt.toISOString().split('T')[0]
      revenueByDate[d] = (revenueByDate[d] ?? 0) + o.grossAmount
    }
    const spendByDate: Record<string, number> = {}
    for (const s of chartSpends) {
      const spendUsd = convertMetaAmountToUsdDated(s.spend, s.currency, s.date, schedule)
      spendByDate[s.date] = (spendByDate[s.date] ?? 0) + (spendUsd ?? 0)
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

    // Payout and order amounts are in the currency of their store and are added as they are, so the totals above are
    // only one number when `currencies` has one entry; storeTotals gives each store's own figure and currency.
    const storeTotals = stores.map(store => {
      const mine = payouts.filter(p => p.storeId === store.id)
      const period = periodOrdersByStore?.get(store.id)
      const currencies = Array.from(new Set([...mine.map(p => p.currency), ...Array.from(period?.currencies ?? [])])).sort()
      return {
        storeId: store.id,
        name: store.project?.name ?? store.shop,
        currency: currencies.length === 1 ? currencies[0] : currencies.length === 0 ? store.currentBalanceCurrency : null,
        currencies,
        payouts: { total: mine.reduce((sum, p) => sum + p.amount, 0), count: mine.length },
        orders: periodOrdersByStore ? { revenue: Math.round((period?.revenue ?? 0) * 100) / 100, count: period?.count ?? 0 } : null,
      }
    })

    return NextResponse.json({
      shopify: { totalRevenue, payoutCount, recentPayouts },
      meta: { totalSpend, billingCount, recentBillings, missingRateCount, spendByCard: cardSummary(metaBillings, schedule) },
      projects: { count: projects.length, list: projectList },
      staff: { count: staff.length, totalMonthlyCost: staff.reduce((s, st) => s + st.monthlyCost, 0) },
      netCashflow: totalRevenue - totalSpend,
      periodMetrics,
      chartData,
      stores: stores.map(s => s.project?.name ?? s.shop),
      storeTotals,
      currencies: Array.from(new Set(storeTotals.flatMap(t => t.currencies))).sort(),
    })
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 })
  }
}
