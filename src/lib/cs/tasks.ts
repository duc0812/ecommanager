import { prisma } from '@/lib/db'
import type { CsTask, CsTaskEvent, CsTicket } from '@/generated/prisma/client'
import { OPEN_STATUSES, TASK_DEPTS, TASK_META, TASK_STATUSES, TASK_TYPES, DEPT_LABELS, type TaskDept, type TaskStatus, type TaskType } from '@/lib/cs/task-labels'
export { DEPT_LABELS, OPEN_STATUSES, STATUS_LABELS, TASK_DEPTS, TASK_META, TASK_STATUSES, TASK_TYPES, type TaskDept, type TaskStatus, type TaskType } from '@/lib/cs/task-labels'

const DUE_HOURS = 24
const AMOUNT_REQUIRED: TaskType[] = ['REFUND']
export const fmtAmount = (n: number) => '$' + n.toFixed(2)

type Actor = { id: string; name: string }
const isType = (t: string): t is TaskType => (TASK_TYPES as readonly string[]).includes(t)
const isStatus = (s: string): s is TaskStatus => (TASK_STATUSES as readonly string[]).includes(s)
const isDept = (d: string): d is TaskDept => (TASK_DEPTS as readonly string[]).includes(d)
const validAmount = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null)
function checkedAmount(n: unknown): number | null {
  if (n === null || n === undefined || n === '') return null
  const v = validAmount(typeof n === 'string' ? Number(n) : n)
  if (v === null) throw new Error('Số tiền không hợp lệ')
  return v
}

export function needsRead(t: Pick<CsTicket, 'fdStatus' | 'lastCustomerAt' | 'lastAgentAt' | 'staffReadAt'>): boolean {
  if (t.fdStatus === 4 || t.fdStatus === 5) return false
  const times = [t.lastCustomerAt, t.lastAgentAt].filter((d): d is Date => !!d).map(d => d.getTime())
  if (!times.length) return false
  return !t.staffReadAt || t.staffReadAt.getTime() < Math.max(...times)
}

export async function markRead(ticketId: string, user: Actor, now = new Date()): Promise<void> {
  await prisma.csTicket.update({ where: { id: ticketId }, data: { staffReadAt: now, staffReadById: user.id, staffReadByName: user.name } })
}

async function openTask(data: { ticketId: string | null; orderNumber: string | null; type: TaskType; detail: string; amount?: number | null; dept?: TaskDept; source: 'AGENT' | 'STAFF'; actor: Actor | null }, now: Date): Promise<CsTask> {
  const meta = TASK_META[data.type]
  return prisma.csTask.create({
    data: {
      ticketId: data.ticketId, orderNumber: data.orderNumber, type: data.type, dept: data.dept ?? meta.dept, priority: meta.priority,
      detail: data.detail, amount: data.amount ?? null, source: data.source, createdById: data.actor?.id ?? null, createdByName: data.actor?.name ?? null,
      dueAt: new Date(now.getTime() + DUE_HOURS * 3600_000), createdAt: now,
      events: { create: { kind: 'CREATED', body: data.detail, toStatus: 'NEW', authorId: data.actor?.id ?? null, authorName: data.actor?.name ?? 'Agent', createdAt: now } },
    },
  })
}

// The agent proposes tasks on every analysis; an open task of the same type on the ticket is the same job, so a repeat is
// ignored and a changed detail is logged on it instead of opening a duplicate.
export async function applyAgentTasks(ticket: Pick<CsTicket, 'id' | 'orderNumber'>, tasks: { type: string; detail: string; amount?: number | null }[], now = new Date()): Promise<number> {
  let created = 0
  for (const t of tasks) {
    const detail = t.detail?.trim()
    if (!isType(t.type) || !detail) continue
    const open = await prisma.csTask.findFirst({ where: { ticketId: ticket.id, type: t.type, status: { in: OPEN_STATUSES } }, orderBy: { createdAt: 'desc' } })
    if (open) {
      const amount = validAmount(t.amount) ?? open.amount
      if (open.detail === detail && amount === open.amount) continue
      await prisma.csTask.update({ where: { id: open.id }, data: { detail, amount, events: { create: { kind: 'AGENT', body: detail, authorName: 'Agent', createdAt: now } } } })
      continue
    }
    await openTask({ ticketId: ticket.id, orderNumber: ticket.orderNumber, type: t.type, detail, amount: validAmount(t.amount), source: 'AGENT', actor: null }, now)
    created += 1
  }
  return created
}

export async function createTask(input: { ticketId?: string | null; orderNumber?: string | null; type: string; detail: string; dept?: string; amount?: number | null }, user: Actor, now = new Date()): Promise<CsTask> {
  if (!isType(input.type)) throw new Error('Loại task không hợp lệ')
  const detail = input.detail?.trim()
  if (!detail) throw new Error('Thiếu nội dung task')
  if (input.dept !== undefined && !isDept(input.dept)) throw new Error('Bộ phận không hợp lệ')
  const ticket = input.ticketId ? await prisma.csTicket.findUnique({ where: { id: input.ticketId }, select: { id: true, orderNumber: true } }) : null
  if (input.ticketId && !ticket) throw new Error('Không tìm thấy ticket')
  return openTask({ ticketId: ticket?.id ?? null, orderNumber: input.orderNumber?.trim() || ticket?.orderNumber || null, type: input.type, detail, amount: checkedAmount(input.amount), dept: input.dept as TaskDept | undefined, source: 'STAFF', actor: user }, now)
}

export async function updateTask(id: string, patch: { status?: string; dept?: string; note?: string; amount?: number | null }, user: Actor, now = new Date()): Promise<CsTask> {
  const task = await prisma.csTask.findUniqueOrThrow({ where: { id } })
  const amount = patch.amount === undefined ? undefined : checkedAmount(patch.amount)
  if (patch.status === 'DONE' && AMOUNT_REQUIRED.includes(task.type as TaskType) && (amount ?? task.amount) == null) throw new Error('Chưa ghi số tiền đã chốt với khách')
  if (patch.status !== undefined && !isStatus(patch.status)) throw new Error('Trạng thái không hợp lệ')
  if (patch.dept !== undefined && !isDept(patch.dept)) throw new Error('Bộ phận không hợp lệ')
  const note = patch.note?.trim() ?? ''
  const events: { kind: string; body: string; fromStatus?: string; toStatus?: string; authorId: string; authorName: string; createdAt: Date }[] = []
  const data: Record<string, unknown> = {}
  if (patch.status && patch.status !== task.status) {
    data.status = patch.status
    data.doneAt = patch.status === 'DONE' ? now : null
    events.push({ kind: 'STATUS', body: note, fromStatus: task.status, toStatus: patch.status, authorId: user.id, authorName: user.name, createdAt: now })
  }
  if (patch.dept && patch.dept !== task.dept) {
    data.dept = patch.dept
    events.push({ kind: 'DEPT', body: `${DEPT_LABELS[task.dept as TaskDept] ?? task.dept} → ${DEPT_LABELS[patch.dept as TaskDept]}`, authorId: user.id, authorName: user.name, createdAt: now })
  }
  if (amount !== undefined && amount !== task.amount) {
    data.amount = amount
    events.push({ kind: 'AMOUNT', body: amount == null ? 'Xoá số tiền' : fmtAmount(amount), authorId: user.id, authorName: user.name, createdAt: now })
  }
  if (!events.length && note) events.push({ kind: 'COMMENT', body: note, authorId: user.id, authorName: user.name, createdAt: now })
  return prisma.csTask.update({ where: { id }, data: { ...data, events: { create: events } } })
}

export async function addTaskComment(id: string, body: string, user: Actor, now = new Date()): Promise<CsTaskEvent> {
  const text = body?.trim()
  if (!text) throw new Error('Bình luận trống')
  await prisma.csTask.findUniqueOrThrow({ where: { id }, select: { id: true } })
  return prisma.csTaskEvent.create({ data: { taskId: id, kind: 'COMMENT', body: text, authorId: user.id, authorName: user.name, createdAt: now } })
}

export type TaskRow = CsTask & { ticket: Pick<CsTicket, 'id' | 'fdTicketId' | 'subject' | 'requesterName'> | null; eventCount: number }

export async function listTasks(filter: { dept?: string; type?: string; doneSince?: Date }): Promise<TaskRow[]> {
  const doneSince = filter.doneSince ?? new Date(Date.now() - 7 * 86400_000)
  const tasks = await prisma.csTask.findMany({
    where: {
      ...(filter.dept ? { dept: filter.dept } : {}),
      ...(filter.type ? { type: filter.type } : {}),
      OR: [{ status: { in: OPEN_STATUSES } }, { updatedAt: { gte: doneSince } }],
    },
    include: { ticket: { select: { id: true, fdTicketId: true, subject: true, requesterName: true } }, _count: { select: { events: true } } },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    take: 500,
  })
  return tasks.map(({ _count, ...t }) => ({ ...t, eventCount: _count.events }))
}

export async function taskDetail(id: string): Promise<{ task: TaskRow; events: CsTaskEvent[] } | null> {
  const task = await prisma.csTask.findUnique({
    where: { id },
    include: { ticket: { select: { id: true, fdTicketId: true, subject: true, requesterName: true } }, events: { orderBy: { createdAt: 'asc' } } },
  })
  if (!task) return null
  const { events, ...rest } = task
  return { task: { ...rest, eventCount: events.length }, events }
}

export async function ticketTasks(ticketId: string): Promise<CsTask[]> {
  return prisma.csTask.findMany({ where: { ticketId }, orderBy: [{ createdAt: 'desc' }] })
}
