import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { estimateOrderCostAndProfit } from '@/lib/order-profit'
import { productLinesOnly } from '@/lib/order-lines'
import { convertMetaAmountToUsdDated } from '@/lib/meta-currency'
import { getMetaRateSchedule } from '@/lib/meta-exchange-rates'
import { getVndCardLast4, billingFxFeeUsd } from '@/lib/meta-fee'
import { PROJECT_REVENUE_EXCLUDED_STATUSES } from '@/lib/project-metrics'
import { computeSellerCommission } from '@/lib/seller-commission'

function monthOf(dateStr: string) {
  return dateStr.slice(0, 7)
}

function lastDayOfMonth(month: string) {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().split('T')[0]
}

function monthList(startMonth: string, endMonth: string) {
  const out: string[] = []
  let [y, m] = startMonth.split('-').map(Number)
  const [ey, em] = endMonth.split('-').map(Number)
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m++
    if (m > 12) { m = 1; y++ }
  }
  return out
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get('projectId')
  const staffId = searchParams.get('staffId')
  if (!projectId || !staffId) return NextResponse.json({ error: 'projectId and staffId required' }, { status: 400 })

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { assignments: { include: { staff: true } }, shopifyStore: { select: { id: true } } },
  })
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  const assignment = project.assignments.find(a => a.staffId === staffId)
  if (!assignment) return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })

  const nowMonth = new Date().toISOString().slice(0, 7)
  const startMonth = assignment.startDate.toISOString().slice(0, 7)
  const endMonthRaw = assignment.endDate ? assignment.endDate.toISOString().slice(0, 7) : nowMonth
  const endMonth = endMonthRaw > nowMonth ? nowMonth : endMonthRaw
  if (startMonth > endMonth) {
    return NextResponse.json({ staff: assignment.staff, months: [], totalCommission: 0 })
  }
  const months = monthList(startMonth, endMonth)
  const startStr = `${startMonth}-01`
  const endStr = lastDayOfMonth(endMonth)
  const rangeStart = new Date(`${startStr}T00:00:00.000Z`)
  const rangeEnd = new Date(`${endStr}T23:59:59.999Z`)

  const paidMetaStatuses = ['PAID', 'SETTLED', 'COMPLETED']
  const [payouts, billings, orders, otherBills, fulfillmentBills, schedule, vndCards] = await Promise.all([
    project.shopifyStore
      ? prisma.payout.findMany({ where: { storeId: project.shopifyStore.id, status: 'paid', date: { gte: startStr, lte: endStr } }, select: { date: true, amount: true } })
      : Promise.resolve([]),
    prisma.metaBilling.findMany({
      where: { status: { in: paidMetaStatuses }, adAccount: { projectId }, billingDate: { gte: startStr, lte: endStr } },
      select: { amount: true, currency: true, billingDate: true, paymentMethodLast4: true },
    }),
    prisma.order.findMany({
      where: { projectId, placedAt: { gte: rangeStart, lte: rangeEnd }, pipelineStatus: { notIn: [...PROJECT_REVENUE_EXCLUDED_STATUSES] } },
      select: {
        placedAt: true,
        expectedPayout: true,
        lines: { select: { qty: true, sku: true, productTitle: true, shopifyProductType: true, resolvedSupplierId: true, resolvedBaseCost: true, manualBaseCost: true, resolvedShipFirst: true, resolvedShipAdditional: true, resolvedImportTax: true } },
      },
    }),
    prisma.otherBill.findMany({ where: { projectId, paidAt: { gte: startStr, lte: endStr } }, select: { amountUsd: true, paidAt: true } }),
    prisma.fulfillmentCost.findMany({ where: { projectId, recognitionDate: { gte: startStr, lte: endStr } }, select: { totalAmount: true, recognitionDate: true } }),
    getMetaRateSchedule(),
    getVndCardLast4(),
  ])

  const realizedByMonth = new Map<string, number>()
  for (const m of months) realizedByMonth.set(m, 0)
  const add = (month: string, delta: number) => { if (realizedByMonth.has(month)) realizedByMonth.set(month, (realizedByMonth.get(month) ?? 0) + delta) }

  for (const p of payouts) add(monthOf(p.date), p.amount)
  for (const b of billings) {
    const usd = convertMetaAmountToUsdDated(b.amount, b.currency, b.billingDate, schedule) ?? 0
    add(monthOf(b.billingDate), -(usd + billingFxFeeUsd(b, vndCards, schedule)))
  }
  for (const o of orders) {
    const est = estimateOrderCostAndProfit(o.expectedPayout, productLinesOnly(o.lines))
    if (est) add(o.placedAt.toISOString().slice(0, 7), -est.estimatedCogs)
  }
  for (const ob of otherBills) add(monthOf(ob.paidAt), -ob.amountUsd)
  for (const fc of fulfillmentBills) add(monthOf(fc.recognitionDate), -fc.totalAmount)

  const { rows, totalCommission } = computeSellerCommission(months.map(m => ({ month: m, realized: realizedByMonth.get(m) ?? 0 })))

  return NextResponse.json({
    staff: { id: assignment.staff.id, name: assignment.staff.name, role: assignment.staff.role },
    period: { start: startMonth, end: endMonth },
    months: rows,
    totalCommission,
  })
}
