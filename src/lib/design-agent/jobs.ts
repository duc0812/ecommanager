import { prisma } from '@/lib/db'
import type { DesignAgentJob } from '@/generated/prisma/client'
import { designOf } from '@/lib/flat-text-coverage'
import { getDesignSettings } from '@/lib/design-settings'

export type AgentJobKind = 'FIX' | 'MAKE' | 'MOCKUP' | 'LIBRARY_APPLY'
export type AgentJobSource = 'REJECT' | 'LINE_REOPEN' | 'LARK' | 'LIBRARY' | 'AUTO_HOLD' | 'BACKFILL'
export type AgentJobStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'NEEDS_OWNER' | 'FAILED' | 'CANCELLED'

export class AgentJobError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export function buildRequestText(reasons: string[], note?: string | null): string {
  return `Lý do: ${reasons.join('; ')}` + (note ? `\nGhi chú: ${note}` : '')
}

export type EnqueueInput = {
  kind: AgentJobKind
  source: AgentJobSource
  taskKey: string
  requestText: string
  requestedById?: string | null
  requestedBy?: string | null
  factory?: boolean
  parentJobId?: string | null
}

const OPEN: AgentJobStatus[] = ['QUEUED', 'RUNNING']

export async function enqueueAgentJob(input: EnqueueInput): Promise<{ job: DesignAgentJob; created: boolean; appended: boolean }> {
  const task = await prisma.designTask.findUnique({ where: { taskKey: input.taskKey }, include: { order: { include: { lines: true } } } })
  if (!task) throw new AgentJobError(`Không tìm thấy task ${input.taskKey}`, 404)
  if (input.kind !== 'LIBRARY_APPLY') {
    const open = await prisma.designAgentJob.findFirst({
      where: { taskId: task.id, status: { in: OPEN }, kind: { not: 'LIBRARY_APPLY' } },
      orderBy: { createdAt: 'asc' },
    })
    if (open) {
      if (open.status === 'QUEUED' && input.source === 'LARK') {
        const job = await prisma.designAgentJob.update({
          where: { id: open.id },
          data: { requestText: `${open.requestText}\n${input.requestedBy ?? ''}: ${input.requestText}` },
        })
        return { job, created: false, appended: true }
      }
      return { job: open, created: false, appended: false }
    }
  }
  const line = task.order.lines.find(l => l.shopifyLineId === task.shopifyLineId)
  const job = await prisma.designAgentJob.create({
    data: {
      kind: input.kind,
      source: input.source,
      taskId: task.id,
      taskKey: task.taskKey,
      designCode: (line ? designOf(line.sku) : '') || null,
      requestText: input.requestText,
      requestedById: input.requestedById ?? null,
      requestedBy: input.requestedBy ?? null,
      priority: input.factory ? 10 : 0,
      parentJobId: input.parentJobId ?? null,
    },
  })
  notifyAgentQueue()
  return { job, created: true, appended: false }
}

export async function enqueueFixOnReject(input: {
  taskKey: string
  reasons: string[]
  note: string | null
  by: { id: string; name: string }
  source: 'REJECT' | 'LINE_REOPEN'
  factory: boolean
}): Promise<DesignAgentJob | null> {
  try {
    if (!(await getDesignSettings()).agent.autoFixOnReject) return null
    const { job } = await enqueueAgentJob({
      kind: 'FIX',
      source: input.source,
      taskKey: input.taskKey,
      requestText: buildRequestText(input.reasons, input.note),
      requestedById: input.by.id,
      requestedBy: input.by.name,
      factory: input.factory,
    })
    return job
  } catch (e) {
    console.error(`[design agent] không xếp được job cho ${input.taskKey}:`, (e as Error)?.message ?? e)
    return null
  }
}

export async function openJobForTask(taskId: string): Promise<DesignAgentJob | null> {
  return prisma.designAgentJob.findFirst({
    where: { taskId, status: { in: OPEN }, kind: { not: 'LIBRARY_APPLY' } },
    orderBy: { createdAt: 'asc' },
  })
}

export async function openJobStatusByTask(taskIds: string[]): Promise<Map<string, 'QUEUED' | 'RUNNING'>> {
  const out = new Map<string, 'QUEUED' | 'RUNNING'>()
  if (taskIds.length === 0) return out
  const rows = await prisma.designAgentJob.findMany({
    where: { taskId: { in: taskIds }, status: { in: OPEN }, kind: { not: 'LIBRARY_APPLY' } },
    orderBy: { createdAt: 'asc' },
  })
  for (const r of rows) {
    if (r.taskId && !out.has(r.taskId)) out.set(r.taskId, r.status as 'QUEUED' | 'RUNNING')
  }
  return out
}

export async function cancelQueuedJobsForTask(taskId: string, why: string): Promise<number> {
  const { count } = await prisma.designAgentJob.updateMany({
    where: { taskId, status: 'QUEUED', kind: { not: 'LIBRARY_APPLY' } },
    data: { status: 'CANCELLED', finishedAt: new Date(), error: why },
  })
  return count
}

declare global {
  // eslint-disable-next-line no-var
  var __designAgentQueueWaiters: Set<() => void> | undefined
}

function waiters(): Set<() => void> {
  if (!globalThis.__designAgentQueueWaiters) globalThis.__designAgentQueueWaiters = new Set()
  return globalThis.__designAgentQueueWaiters
}

export function notifyAgentQueue(): void {
  const set = waiters()
  const pending = Array.from(set)
  set.clear()
  for (const wake of pending) wake()
}

export function waitForAgentQueue(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const set = waiters()
    const wake = () => {
      clearTimeout(timer)
      set.delete(wake)
      signal?.removeEventListener('abort', wake)
      resolve()
    }
    const timer = setTimeout(wake, ms)
    set.add(wake)
    if (signal?.aborted) wake()
    else signal?.addEventListener('abort', wake)
  })
}
