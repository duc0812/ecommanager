import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db'
import type { Prisma } from '@/generated/prisma/client'

const keyFor = (taskId: string) => `design.outsource.operation.${taskId}`
export class OutsourceOperationError extends Error {
  readonly status = 409
}
function locked(value: string | undefined) {
  try { return Number(JSON.parse(value ?? '{}').until) > Date.now() } catch { return false }
}
export async function assertNoOutsourceReview(tx: Prisma.TransactionClient, taskId: string) {
  const lease = await tx.appSetting.findUnique({ where: { key: keyFor(taskId) } })
  if (locked(lease?.value)) throw new OutsourceOperationError('Nội bộ đang duyệt task, vui lòng tải lại sau ít giây')
}

// A database lease covers approval's existing cross-module writes without keeping a SQLite transaction open during Drive work.
export async function withOutsourceReviewLock<T>(taskId: string, run: () => Promise<T>): Promise<T> {
  const key = keyFor(taskId)
  const value = JSON.stringify({ token: randomUUID(), until: Date.now() + 10 * 60_000 })
  await prisma.$transaction(async tx => {
    await assertNoOutsourceReview(tx, taskId)
    await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
  })
  try { return await run() }
  finally { await prisma.appSetting.deleteMany({ where: { key, value } }) }
}
