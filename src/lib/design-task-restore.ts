import { prisma } from '@/lib/db'
import { isNonProductLine } from '@/lib/order-lines'
import { AUTO_CANCEL_SHIPPED, AUTO_REVIEW_MESSAGE, lineWentToSupplier, type TaskStatus } from '@/lib/design-tasks'
import { LINE_FIX_EVENT_PREFIX } from '@/lib/line-fix'

/**
 * Owner 11/20/2026: every task the sync cancelled because its order was fulfilled, while no supplier ever got the line, goes
 * back to the state it was in. Dry run by default; `apply` writes the status and one SYSTEM line per task.
 */
export const RESTORE_PREFIX = 'Chủ shop 11/20/2026: mở lại task bị huỷ — dòng chưa gửi xưởng nào'
const LEADER_CANCEL = 'Huỷ task'
const OPEN_BEFORE: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED']

export type RestoreRow = {
  taskKey: string; orderNumber: string; placedAt: string; cancelledAt: string; restoreTo: TaskStatus
  supplier: string | null; hasFile: boolean; assigneeId: string | null
}

type Ev = { type: string; message: string; actorId: string | null; createdAt: Date; id: string }

/** The status the task was in before the cancel, replayed from its events (NEW when nothing says otherwise). */
export function statusBeforeCancel(events: Ev[]): TaskStatus {
  let status: TaskStatus = 'NEW'
  const sorted = [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
  for (const e of sorted) {
    if (e.type === 'SYSTEM' && e.message === AUTO_CANCEL_SHIPPED) break
    const m = e.message
    if (e.type === 'ASSIGN') status = 'ASSIGNED'
    else if (e.type === 'REJECT') status = 'REJECTED'
    else if (e.type === 'ASK') status = 'ASK_CUSTOMER'
    else if (e.type === 'STATUS') {
      if (m === 'Từ chối việc — trả về leader giao lại') status = 'NEW'
      else if (m === 'Nhận việc' || m === 'Mở lại để sửa' || m === 'Mở lại task đã huỷ') status = 'DOING'
      else if (m.startsWith('Gửi duyệt') || m === 'Tiếp tục sau khi hỏi khách') status = 'REVIEW'
      else if (m === 'Tiếp tục làm') status = 'DOING'
      else if (m.startsWith('Duyệt design')) status = 'DONE'
      else if (m === LEADER_CANCEL) status = 'CANCELLED'
    } else if (e.type === 'SYSTEM') {
      if (m === AUTO_REVIEW_MESSAGE || m.startsWith('Tự động gửi duyệt')) status = 'REVIEW'
      else if (m.endsWith('— giữ task mở') || m.startsWith(LINE_FIX_EVENT_PREFIX)) status = 'REJECTED'
    }
  }
  if (status === 'ASK_CUSTOMER') status = 'DOING'
  return OPEN_BEFORE.includes(status) ? status : 'NEW'
}

/** Cancelled by the sync for a fulfilled order, and nobody cancelled it by hand after that. */
function cancelledBySync(events: Ev[]): Date | null {
  let at: Date | null = null
  for (const e of [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (e.type === 'SYSTEM' && e.message === AUTO_CANCEL_SHIPPED) at = e.createdAt
    else if (e.type === 'STATUS' && e.message === LEADER_CANCEL) at = null
  }
  return at
}

/** `taskKeys`: restore (or list) only these; without it every candidate. */
export async function restoreUnsentCancelledTasks(opts: { apply: boolean; taskKeys?: string[] }): Promise<{ rows: RestoreRow[]; restored: number }> {
  const tasks = await prisma.designTask.findMany({
    where: {
      status: 'CANCELLED', events: { some: { type: 'SYSTEM', message: AUTO_CANCEL_SHIPPED } }, order: { pipelineStatus: { notIn: ['CANCELLED', 'REFUNDED'] } },
      ...(opts.taskKeys ? { taskKey: { in: opts.taskKeys } } : {}),
    },
    include: {
      events: { select: { id: true, type: true, message: true, actorId: true, createdAt: true } },
      order: { select: { shopifyOrderNumber: true, placedAt: true, pipelineStatus: true, exportedAt: true, exportedToSupplierId: true, trelloCardUrl: true, lines: true } },
    },
    orderBy: { taskKey: 'asc' },
  })
  const supplierIds = new Set<string>()
  const picked: Array<{ task: (typeof tasks)[number]; line: (typeof tasks)[number]['order']['lines'][number]; cancelledAt: Date }> = []
  for (const task of tasks) {
    const line = task.order.lines.find(l => l.shopifyLineId === task.shopifyLineId)
    if (!line || isNonProductLine(line) || line.dropship) continue
    const cancelledAt = cancelledBySync(task.events)
    if (!cancelledAt) continue
    if (await lineWentToSupplier(task.order, line)) continue
    picked.push({ task, line, cancelledAt })
    const sid = line.exportedToSupplierId ?? line.resolvedSupplierId
    if (sid) supplierIds.add(sid)
  }
  const suppliers = supplierIds.size ? await prisma.supplier.findMany({ where: { id: { in: Array.from(supplierIds) } }, select: { id: true, name: true } }) : []
  const nameOf = new Map(suppliers.map(s => [s.id, s.name]))
  const files = picked.length
    ? await prisma.designArtwork.findMany({ where: { orderId: { in: picked.map(p => p.task.orderId) }, removedAt: null }, select: { orderId: true, shopifyLineId: true }, distinct: ['orderId', 'shopifyLineId'] })
    : []
  const hasFile = new Set(files.map(f => `${f.orderId}/${f.shopifyLineId}`))

  const rows: RestoreRow[] = picked.map(({ task, line, cancelledAt }) => ({
    taskKey: task.taskKey, orderNumber: task.order.shopifyOrderNumber, placedAt: task.order.placedAt.toISOString(), cancelledAt: cancelledAt.toISOString(),
    restoreTo: statusBeforeCancel(task.events), supplier: nameOf.get(line.exportedToSupplierId ?? line.resolvedSupplierId ?? '') ?? null,
    hasFile: hasFile.has(`${task.orderId}/${task.shopifyLineId}`) || !!line.designDriveLink || !!task.order.trelloCardUrl, assigneeId: task.assigneeId,
  }))
  if (!opts.apply) return { rows, restored: 0 }

  let restored = 0
  for (const row of rows) {
    const r = await prisma.designTask.updateMany({
      where: { taskKey: row.taskKey, status: 'CANCELLED' },
      data: { status: row.restoreTo, prevStatus: null, ...(row.restoreTo === 'REJECTED' ? {} : { rejectReasons: null, rejectNote: null }) },
    })
    if (r.count === 0) continue
    const task = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: row.taskKey }, select: { id: true } })
    await prisma.designTaskEvent.create({ data: { taskId: task.id, type: 'SYSTEM', message: `${RESTORE_PREFIX} (trả về ${row.restoreTo})` } })
    restored++
  }
  return { rows, restored }
}
