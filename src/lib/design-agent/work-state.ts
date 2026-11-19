import { prisma } from '@/lib/db'
import type { DesignAgentJob, WorkBoardEntry } from '@/generated/prisma/client'
import type { AgentTaskState } from '@/lib/design-agent/delivery'
import { readWorkBoard } from '@/lib/design-agent/work-board'

export { AgentJobBusy } from '@/lib/design-agent/jobs'

export type WorkState =
  | { kind: 'CLOSED'; reason: 'CANCELLED' | 'ORDER_CLOSED' | 'ASK_CUSTOMER' | 'SENT' }
  | { kind: 'AGENT'; jobId: string; status: string; stage: string | null; startedAt: Date | null }
  | { kind: 'UNKNOWN' }
  | { kind: 'QUEUE'; state: string; version: number | null; etaAt: Date | null; detail: string | null }
  | { kind: 'STREAM'; worker: string }
  | { kind: 'PERSON'; name: string }
  | { kind: 'AUTO' }
  | { kind: 'FREE'; heldReason: string | null }

export const QUEUE_WORKER = 'Hàng duyệt local'
export const AUTO_WORKER = 'Auto render'
export const UNNAMED_ASSIGNEE = 'nhân sự được giao'

// An `in` list longer than this risks SQLite's parameter limit (P2029, 11/17/2026).
const CHUNK = 500

/** Who keeps the line, for the states that stop the Agent; null for the others. */
export function workHolder(state: WorkState): string | null {
  if (state.kind === 'QUEUE') return QUEUE_WORKER
  if (state.kind === 'STREAM') return state.worker
  if (state.kind === 'PERSON') return state.name
  if (state.kind === 'AUTO') return AUTO_WORKER
  return null
}

function closedReason(task: AgentTaskState): Extract<WorkState, { kind: 'CLOSED' }>['reason'] | null {
  if (task.status === 'CANCELLED') return 'CANCELLED'
  if (!task.orderOpen) return 'ORDER_CLOSED'
  if (task.status === 'ASK_CUSTOMER') return 'ASK_CUSTOMER'
  if (task.status === 'DONE' && task.sent) return 'SENT'
  return null
}

async function inChunks<T, R>(ids: T[], load: (part: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await load(ids.slice(i, i + CHUNK))))
  return out
}

async function openJobs(taskIds: Set<string>): Promise<Map<string, DesignAgentJob>> {
  const rows = await prisma.designAgentJob.findMany({
    where: { taskId: { not: null }, status: { in: ['QUEUED', 'RUNNING'] }, kind: { not: 'LIBRARY_APPLY' } },
    orderBy: { createdAt: 'asc' },
  })
  const out = new Map<string, DesignAgentJob>()
  for (const r of rows) if (r.taskId && taskIds.has(r.taskId) && !out.has(r.taskId)) out.set(r.taskId, r)
  return out
}

export async function workStatesFor(tasks: AgentTaskState[], now: Date = new Date()): Promise<Map<string, WorkState>> {
  const out = new Map<string, WorkState>()
  const open = tasks.filter(t => {
    const reason = closedReason(t)
    if (reason) out.set(t.taskKey, { kind: 'CLOSED', reason })
    return !reason
  })
  if (open.length === 0) return out

  const jobs = await openJobs(new Set(open.map(t => t.taskId)))
  const idle = open.filter(t => {
    const job = jobs.get(t.taskId)
    if (job) out.set(t.taskKey, { kind: 'AGENT', jobId: job.id, status: job.status, stage: job.stage, startedAt: job.startedAt })
    return !job
  })
  if (idle.length === 0) return out

  const board = await readWorkBoard(idle.length > CHUNK ? null : idle.map(t => t.taskKey), now)
  if (!board.fresh) {
    for (const t of idle) out.set(t.taskKey, { kind: 'UNKNOWN' })
    return out
  }
  const rowsOf = new Map<string, WorkBoardEntry[]>()
  for (const e of board.entries) rowsOf.set(e.taskKey, [...(rowsOf.get(e.taskKey) ?? []), e])

  const unheld = idle.filter(t => {
    const rows = rowsOf.get(t.taskKey) ?? []
    const queued = rows.find(r => r.source === 'LOCAL_QUEUE' && r.state !== 'held')
    const stream = rows.find(r => r.source === 'STREAM')
    if (queued) out.set(t.taskKey, { kind: 'QUEUE', state: queued.state, version: queued.version, etaAt: queued.etaAt, detail: queued.detail })
    else if (stream) out.set(t.taskKey, { kind: 'STREAM', worker: stream.worker })
    else if (t.status === 'REJECTED' && board.rejectedOwner) out.set(t.taskKey, { kind: 'STREAM', worker: board.rejectedOwner })
    return !out.has(t.taskKey)
  })
  if (unheld.length === 0) return out

  const taskRows = await inChunks(unheld.map(t => t.taskId), part =>
    prisma.designTask.findMany({ where: { id: { in: part } }, select: { id: true, assigneeId: true, readiness: true } }))
  const rowOf = new Map(taskRows.map(r => [r.id, r]))
  const assigned = (t: AgentTaskState) => ((t.status === 'ASSIGNED' || t.status === 'DOING') ? rowOf.get(t.taskId)?.assigneeId ?? null : null)
  const assigneeIds = Array.from(new Set(unheld.map(assigned).filter((x): x is string => !!x)))
  const users = await inChunks(assigneeIds, part => prisma.appUser.findMany({ where: { id: { in: part } }, select: { id: true, name: true } }))
  const nameOf = new Map(users.map(u => [u.id, u.name]))

  for (const t of unheld) {
    const assigneeId = assigned(t)
    if (assigneeId) out.set(t.taskKey, { kind: 'PERSON', name: nameOf.get(assigneeId)?.trim() || UNNAMED_ASSIGNEE })
    else if (t.status === 'NEW' && rowOf.get(t.taskId)?.readiness === 'AUTO') out.set(t.taskKey, { kind: 'AUTO' })
    else {
      const held = (rowsOf.get(t.taskKey) ?? []).find(r => r.source === 'LOCAL_QUEUE' && r.state === 'held')
      out.set(t.taskKey, { kind: 'FREE', heldReason: held?.detail ?? null })
    }
  }
  return out
}

export async function workStateFor(task: AgentTaskState, now: Date = new Date()): Promise<WorkState> {
  return (await workStatesFor([task], now)).get(task.taskKey) as WorkState
}
