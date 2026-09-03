import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { SHOPIFY_PAYOUT_START_DATE } from '@/lib/shopify-payout-policy'
import { dateOnly, dateKeyInZone, zonedDayStartUtc, addDays } from '@/lib/cashflow-dates'
import { computeProjectCashflow } from '@/lib/repos/cashflow'

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

  const computed = await computeProjectCashflow({
    project, timeZone, startStr, endStr, payoutStartStr,
    startDate, endDate, orderRangeStart, orderRangeEnd, periodIsValid,
  })
  return NextResponse.json({
    project,
    ...computed,
    payoutDateRange: { start: payoutStartStr, end: endStr },
  })
}
