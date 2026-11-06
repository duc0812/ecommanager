import { prisma } from '@/lib/db'

// Lives apart from jobs.ts and worker.ts so both can call it: worker.ts already imports jobs.ts.

export const CLONE_LEASE_MS = 10 * 60 * 1000
export const CLONE_MAX_ATTEMPTS = 2
export const WORKER_LOST = 'Máy xử lý không trả kết quả.'

const expiredWhere = (now: Date) => ({ status: 'RUNNING', OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now.getTime() - CLONE_LEASE_MS) } }] })

// A read only, so the page poll does not take SQLite's write lock every few seconds when nothing has expired.
export async function hasExpiredLease(now: Date): Promise<boolean> {
  return (await prisma.cloneJob.findFirst({ where: expiredWhere(now), select: { id: true } })) !== null
}

// The lease condition is the compare-and-set: a heartbeat that lands first moves lockedAt out of it, and the row is left alone.
export async function releaseExpiredLeases(now: Date): Promise<void> {
  const expired = expiredWhere(now)
  await prisma.cloneJob.updateMany({
    where: { ...expired, attempts: { lt: CLONE_MAX_ATTEMPTS } },
    data: { status: 'QUEUED', lockedAt: null, stage: null },
  })
  await prisma.cloneJob.updateMany({
    where: { ...expired, attempts: { gte: CLONE_MAX_ATTEMPTS } },
    data: { status: 'FAILED', failKind: 'WORKER_LOST', error: WORKER_LOST, finishedAt: now, lockedAt: null },
  })
}
