import { prisma } from '@/lib/db'
import { computeProjectCashflow } from '@/lib/repos/cashflow'
import { monthEndBoundaryUtc, listPeriodMonths } from '@/lib/cashflow-snapshot'
import { zonedDayStartUtc, dateOnly } from '@/lib/cashflow-dates'
import { SHOPIFY_PAYOUT_START_DATE } from '@/lib/shopify-payout-policy'

export async function snapshotProjectMonth(projectId: string, periodMonth: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      assignments: { include: { staff: true } },
      shopifyStore: { select: { id: true, ianaTimezone: true, currentBalance: true, currentBalanceCurrency: true } },
    },
  })
  if (!project) throw new Error(`Project ${projectId} not found`)

  const timeZone = project.shopifyStore?.ianaTimezone ?? 'UTC'
  const { asOfDate, endDate } = monthEndBoundaryUtc(periodMonth, timeZone)
  const startDate = project.startDate
  const startStr = dateOnly(startDate)
  const endStr = asOfDate
  const payoutStartStr = startStr > SHOPIFY_PAYOUT_START_DATE ? startStr : SHOPIFY_PAYOUT_START_DATE
  const orderRangeStart = zonedDayStartUtc(startStr, timeZone)
  const orderRangeEnd = endDate

  const c = await computeProjectCashflow({
    project, timeZone, startStr, endStr, payoutStartStr,
    startDate, endDate, orderRangeStart, orderRangeEnd,
    periodIsValid: startDate <= endDate,
  })

  return prisma.cashflowSnapshot.upsert({
    where: { projectId_periodMonth: { projectId, periodMonth } },
    create: {
      projectId, periodMonth, asOfDate,
      totalPayout: c.totalPayout, totalMetaBilling: c.totalMetaBilling, metaFxFee: c.metaFxFee,
      totalOrderCogs: c.totalOrderCogs, totalOtherCosts: c.totalOtherCosts,
      actualCashflow: c.actualCashflow, shopifyBalance: c.shopifyBalance,
      inTransitPayout: c.inTransitPayout, pendingPayout: c.pendingPayout,
      pendingInvoiceCharge: c.pendingInvoiceCharge, projectedCashflow: c.projectedCashflow,
      takenAt: new Date(),
    },
    update: {
      asOfDate,
      totalPayout: c.totalPayout, totalMetaBilling: c.totalMetaBilling, metaFxFee: c.metaFxFee,
      totalOrderCogs: c.totalOrderCogs, totalOtherCosts: c.totalOtherCosts,
      actualCashflow: c.actualCashflow, shopifyBalance: c.shopifyBalance,
      inTransitPayout: c.inTransitPayout, pendingPayout: c.pendingPayout,
      pendingInvoiceCharge: c.pendingInvoiceCharge, projectedCashflow: c.projectedCashflow,
      takenAt: new Date(),
    },
  })
}

export async function backfillProjectSnapshots(projectId: string, now = new Date()) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { shopifyStore: { select: { ianaTimezone: true } } },
  })
  if (!project) throw new Error(`Project ${projectId} not found`)
  const timeZone = project.shopifyStore?.ianaTimezone ?? 'UTC'
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const lastMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`
  const months = listPeriodMonths(project.startDate, lastMonth, timeZone)
  for (const m of months) await snapshotProjectMonth(projectId, m)
  return { months }
}

export async function runMonthEndSnapshots(now = new Date()) {
  const prevMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const periodMonth = `${prevMonthDate.getUTCFullYear()}-${String(prevMonthDate.getUTCMonth() + 1).padStart(2, '0')}`
  const projects = await prisma.project.findMany({ where: { archivedAt: null }, select: { id: true } })
  let created = 0
  const errors: string[] = []
  for (const p of projects) {
    try {
      await snapshotProjectMonth(p.id, periodMonth)
      created++
    } catch (e: any) {
      errors.push(`${p.id}: ${e?.message ?? e}`)
    }
  }
  await prisma.appSetting.upsert({
    where: { key: 'last_cashflow_snapshot_result' },
    create: { key: 'last_cashflow_snapshot_result', value: JSON.stringify({ periodMonth, created, errors, ranAt: new Date().toISOString() }) },
    update: { value: JSON.stringify({ periodMonth, created, errors, ranAt: new Date().toISOString() }) },
  })
  return { created, errors }
}
