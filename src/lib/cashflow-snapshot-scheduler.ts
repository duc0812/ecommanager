import { initOnce } from '@/lib/job-lock'
import { prisma } from '@/lib/db'
import { computeProjectCashflow } from '@/lib/repos/cashflow'
import { listPeriodMonths, snapshotCloseDateKey } from '@/lib/cashflow-snapshot'
import { zonedDayStartUtc, dateOnly, addDays } from '@/lib/cashflow-dates'
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
  // A snapshot is a meter reading taken on the 1st of the following month, so that date is
  // both what it is dated and how far it accumulates. Read on the day itself it carries a
  // live balance; recomputed later it carries none, because that instant has passed.
  const asOfDate = snapshotCloseDateKey(periodMonth)
  const endDate = new Date(zonedDayStartUtc(addDays(asOfDate, 1), timeZone).getTime() - 1)
  const startDate = project.startDate
  const startStr = dateOnly(startDate)
  const payoutStartStr = startStr > SHOPIFY_PAYOUT_START_DATE ? startStr : SHOPIFY_PAYOUT_START_DATE

  const c = await computeProjectCashflow({
    project, timeZone, startStr, endStr: asOfDate, payoutStartStr,
    startDate, endDate,
    orderRangeStart: zonedDayStartUtc(startStr, timeZone),
    orderRangeEnd: endDate,
    periodIsValid: startDate <= endDate,
  })

  return prisma.cashflowSnapshot.upsert({
    where: { projectId_periodMonth: { projectId, periodMonth } },
    create: {
      projectId, periodMonth, asOfDate,
      totalPayout: c.totalPayout, totalMetaBilling: c.totalMetaBilling, metaFxFee: c.metaFxFee,
      totalOrderCogs: c.totalOrderCogs, totalOtherCosts: c.totalOtherCosts,
      actualCashflow: c.actualCashflow, shopifyBalance: c.shopifyBalance,
      inTransitPayout: c.inTransitPayout,
      pendingInvoiceCharge: c.pendingInvoiceCharge, projectedCashflow: c.projectedCashflow,
      expectedCashflow: c.expectedCashflow,
      takenAt: new Date(),
    },
    update: {
      asOfDate,
      totalPayout: c.totalPayout, totalMetaBilling: c.totalMetaBilling, metaFxFee: c.metaFxFee,
      totalOrderCogs: c.totalOrderCogs, totalOtherCosts: c.totalOtherCosts,
      actualCashflow: c.actualCashflow, shopifyBalance: c.shopifyBalance,
      inTransitPayout: c.inTransitPayout,
      pendingInvoiceCharge: c.pendingInvoiceCharge, projectedCashflow: c.projectedCashflow,
      expectedCashflow: c.expectedCashflow,
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

// The month close now runs as the last step of the 15:00 Asia/Ho_Chi_Minh daily sync (see
// `monthToCloseOn` in daily-sync.ts), so the snapshot reads data refreshed minutes earlier
// instead of whatever yesterday's sync left behind. No separate cron.
export function initCashflowSnapshotScheduler() {
  if (!initOnce('cashflow-snapshot-scheduler')) return
  console.log('[cashflow-snapshot] Month close runs inside the 15:00 Asia/Ho_Chi_Minh daily sync')
}
