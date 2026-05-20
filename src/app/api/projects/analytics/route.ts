import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

type CostBuckets = {
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

function parseDateOnly(value: string) {
  return new Date(`${value}T00:00:00.000Z`)
}

function getMonthRange(month: string | null) {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return null
  const [year, monthIndex] = month.split('-').map(Number)
  const start = new Date(Date.UTC(year, monthIndex - 1, 1))
  const end = new Date(Date.UTC(year, monthIndex, 0))
  return { start, end }
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
    appBilling: getNumberParam(searchParams, 'appBilling'),
    toolsBilling: getNumberParam(searchParams, 'toolsBilling'),
  }

  if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 })

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { assignments: { include: { staff: true } } },
  })

  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  let startDate = project.startDate
  let endDate: Date | null = null
  const monthRange = getMonthRange(searchParams.get('month'))

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

  const today = parseDateOnly(dateOnly(new Date()))
  if (!endDate || endDate > today) endDate = today

  const startStr = dateOnly(startDate)
  const endStr = dateOnly(endDate)
  const periodIsValid = startDate <= endDate

  const paidMetaStatuses = ['PAID', 'SETTLED', 'COMPLETED']
  const [payouts, metaAccounts, billings] = await Promise.all([
    prisma.payout.findMany({
      where: {
        date: {
          gte: startStr,
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
  ])

  const totalRevenue = payouts.reduce((sum, p) => sum + p.chargesGrossAmount, 0)
  const totalPayout = payouts.reduce((sum, p) => sum + p.amount, 0)
  const totalPaymentFees = payouts.reduce((sum, p) => {
    return sum + p.chargesFeeAmount + p.refundsFeeAmount + p.adjustmentsFeeAmount
  }, 0)
  const totalMetaBilling = billings.reduce((sum, b) => sum + b.amount, 0)
  const totalFulfillmentCost = 0
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
  const actualCashflow = totalPayout - totalMetaBilling - totalOtherCosts
  const grossProfit = totalRevenue - totalPaymentFees - costs.fulfillment - costs.appBilling - costs.toolsBilling - totalAdSpend
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
    costs,
    totalOtherCosts,
    actualCashflow,
    grossProfit,
    grossMargin,
    adSpendRatio,
    roas,
    payoutCount: payouts.length,
    avgRevenuePerPayout: payouts.length > 0 ? totalRevenue / payouts.length : 0,
    dateRange: { start: startStr, end: endStr },
  })
}
