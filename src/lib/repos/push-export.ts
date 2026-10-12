import { prisma } from '@/lib/db'
import { markOrdersExported } from '@/lib/repos/orders'

export const ACTIVE_PUSH_STATUSES = ['SENDING', 'CREATED']

export type PushRef = { id: string; orderId: string; supplierId: string; pushedAt: Date; pushedById?: string | null }
export type ActivePush = { status: string; supplierOrderCode: string | null; externalOrderId: string; exportMarked: boolean }

export async function logHandoffEvent(orderId: string, message: string, actorId: string | null) {
  const tasks = await prisma.designTask.findMany({ where: { orderId, status: { not: 'CANCELLED' } }, select: { id: true } })
  if (tasks.length === 0) return
  await prisma.designTaskEvent.createMany({ data: tasks.map(t => ({ taskId: t.id, type: actorId ? 'HANDOFF' : 'SYSTEM', message, actorId })) })
}

/**
 * The one place a supplier push marks its order: Exported, the API handoff, and the state a cancel restores.
 * Returns false when the order is not in an exportable status (it then stays as it is).
 */
export async function markPushExported(push: PushRef): Promise<boolean> {
  const before = await prisma.order.findUnique({
    where: { id: push.orderId },
    select: {
      pipelineStatus: true, exportedAt: true, exportedToSupplierId: true,
      supplierHandoffAt: true, supplierHandoffMode: true, supplierHandoffById: true,
    },
  })
  const marked = await markOrdersExported([push.orderId], push.supplierId, push.pushedAt, { mode: 'API', byId: push.pushedById ?? null })
  if (marked.count === 0 || !before) return false
  await prisma.supplierOrderPush.update({
    where: { id: push.id },
    data: {
      exportMarked: true,
      prevExportJson: JSON.stringify({
        pipelineStatus: before.pipelineStatus,
        exportedAt: before.exportedAt ? before.exportedAt.toISOString() : null,
        exportedToSupplierId: before.exportedToSupplierId,
        supplierHandoffAt: before.supplierHandoffAt ? before.supplierHandoffAt.toISOString() : null,
        supplierHandoffMode: before.supplierHandoffMode,
        supplierHandoffById: before.supplierHandoffById,
      }),
    },
  })
  return true
}

export async function activePushByOrder(orderIds: string[]): Promise<Map<string, ActivePush>> {
  const out = new Map<string, ActivePush>()
  if (orderIds.length === 0) return out
  const rows = await prisma.supplierOrderPush.findMany({
    where: { orderId: { in: orderIds }, status: { in: ACTIVE_PUSH_STATUSES } },
    orderBy: { createdAt: 'desc' },
    select: { orderId: true, status: true, supplierOrderCode: true, externalOrderId: true, exportMarked: true },
  })
  for (const r of rows) {
    if (!out.has(r.orderId)) out.set(r.orderId, { status: r.status, supplierOrderCode: r.supplierOrderCode, externalOrderId: r.externalOrderId, exportMarked: r.exportMarked })
  }
  return out
}
