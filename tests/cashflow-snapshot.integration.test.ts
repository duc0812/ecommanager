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
    expect(first.asOfDate).toBe('2026-06-30')
    expect(typeof first.projectedCashflow).toBe('number')
    const second = await snapshotProjectMonth(PID, '2026-06')
    expect(second.id).toBe(first.id)
    const count = await prisma.cashflowSnapshot.count({ where: { projectId: PID, periodMonth: '2026-06' } })
    expect(count).toBe(1)
  })

  it('backfills every month from project start through last completed month', async () => {
    const res = await backfillProjectSnapshots(PID, new Date('2026-09-04T00:00:00Z'))
    expect(res.months).toEqual(['2026-06', '2026-07', '2026-08'])
    const count = await prisma.cashflowSnapshot.count({ where: { projectId: PID } })
    expect(count).toBe(3)
  })
})
