import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { snapshotProjectMonth } from '@/lib/cashflow-snapshot-scheduler'

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
})
