import { prisma } from '@/lib/db'
import { isSentLineOfOpenOrder, requiredSlotsForLine, taskKeptByPerson } from '@/lib/design-tasks'
import { isOrderOpen } from '@/lib/design-agent/order-open'
import type { DeliveryDrive } from '@/lib/delivery/drive'
import type { TaskState } from '@/lib/delivery/types'

export class DeliveryLineMissingError extends Error {
  constructor() {
    super('Dòng đơn của task đang được đồng bộ lại — thử lại sau vài giây')
  }
}

export async function deliveryTaskState(taskKey: string, drive: DeliveryDrive): Promise<TaskState | null> {
  const task = await prisma.designTask.findUnique({ where: { taskKey } })
  if (!task) return null
  const { orderId, shopifyLineId } = task
  const line = await prisma.orderLine.findFirst({ where: { orderId, shopifyLineId }, select: { id: true } })
  if (!line) throw new DeliveryLineMissingError()

  // orderOpen: the line still takes files — its order is open, or a person reopened the task to ship the line again (owner 11/20/2026).
  const [rows, open, kept, sent, required] = await Promise.all([
    prisma.designArtwork.findMany({ where: { orderId, shopifyLineId }, orderBy: [{ kind: 'asc' }, { printArea: 'asc' }, { version: 'asc' }] }),
    isOrderOpen(orderId),
    taskKeptByPerson(task.id),
    isSentLineOfOpenOrder(line.id),
    requiredSlotsForLine(orderId, shopifyLineId),
  ])
  const orderOpen = open || kept
  const folder = await drive.taskFolder(orderId, shopifyLineId)
  const incoming = await drive.incomingFolder(taskKey)

  const nextVersion: Record<string, number> = {}
  for (const r of rows) {
    const k = `${r.kind}/${r.printArea}`
    nextVersion[k] = Math.max(nextVersion[k] ?? 0, r.version + 1)
  }

  const live = rows.filter(r => !r.removedAt)
  const ids = Array.from(new Set(live.map(r => r.driveFileId).filter((x): x is string => !!x)))
  const others = ids.length === 0 ? [] : await prisma.designArtwork.findMany({
    where: { driveFileId: { in: ids }, removedAt: null, NOT: { orderId, shopifyLineId } },
    select: { driveFileId: true, orderId: true, shopifyLineId: true },
  })
  const sharedWith = (fileId: string | null) => (fileId ? others.filter(o => o.driveFileId === fileId).length : 0)

  return {
    taskKey,
    status: task.status,
    readiness: task.readiness,
    orderOpen,
    sent,
    folder: { id: folder.id, url: folder.url },
    incomingFolder: { id: incoming },
    artworks: live.map(r => ({
      id: r.id, kind: r.kind, printArea: r.printArea, version: r.version, source: r.source,
      uploadedById: r.uploadedById, driveFileId: r.driveFileId, sharedWith: sharedWith(r.driveFileId),
    })),
    nextVersion,
    required,
  }
}
