import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { snapshotProjectMonth, backfillProjectSnapshots } from '@/lib/cashflow-snapshot-scheduler'

const PID = 'test_snap_proj'

describe('snapshotProjectMonth', () => {
  beforeAll(async () => {
    await prisma.project.upsert({
      where: { id: PID },
      create: { id: PID, name: 'Snap Test', startDate: new Date('2026-06-01T00:00:00Z') },
      update: {},
    })
  })
  afterAll(async () => {
    await prisma.cashflowSnapshot.deleteMany({ where: { projectId: PID } })
    await prisma.project.deleteMany({ where: { id: PID } })
  })

  it('creates a snapshot row with breakdown, idempotent on re-run', async () => {
    const first = await snapshotProjectMonth(PID, '2026-06')
    expect(first.periodMonth).toBe('2026-06')
    // The meter is read on the 1st of the next month, so that is the instant it describes.
    expect(first.asOfDate).toBe('2026-07-01')
    expect(typeof first.actualCashflow).toBe('number')
    const second = await snapshotProjectMonth(PID, '2026-06')
    expect(second.id).toBe(first.id)
    const count = await prisma.cashflowSnapshot.count({ where: { projectId: PID, periodMonth: '2026-06' } })
    expect(count).toBe(1)
  })

  it('records the balance as unknown for a month that closed long ago', async () => {
    // Today's Shopify balance says nothing about a June that ended months back: writing it
    // down anyway is what put one day's figures into seven months on production.
    const row = await snapshotProjectMonth(PID, '2026-06')
    expect(row.shopifyBalance).toBeNull()
    expect(row.inTransitPayout).toBeNull()
    expect(row.pendingInvoiceCharge).toBeNull()
    expect(row.projectedCashflow).toBeNull()
  })

  it('keeps the balance for a period that still runs to today', async () => {
    const todayKey = new Date().toISOString().slice(0, 10)
    const periodMonth = todayKey.slice(0, 7)
    const row = await snapshotProjectMonth(PID, periodMonth)
    expect(row.shopifyBalance).not.toBeNull()
    expect(row.projectedCashflow).not.toBeNull()
    await prisma.cashflowSnapshot.deleteMany({ where: { projectId: PID, periodMonth } })
  })

  it('backfills every month from project start through last completed month', async () => {
    const res = await backfillProjectSnapshots(PID, new Date('2026-09-04T00:00:00Z'))
    expect(res.months).toEqual(['2026-06', '2026-07', '2026-08'])
    const count = await prisma.cashflowSnapshot.count({ where: { projectId: PID } })
    expect(count).toBe(3)
  })
})
