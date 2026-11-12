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

function affectedRowCount(json: string | null): number {
  if (!json) return 0
  try {
    const parsed = JSON.parse(json)
    const rows = Array.isArray(parsed) ? parsed : parsed?.rows
    return Array.isArray(rows) ? rows.length : 0
  } catch { return 0 }
}

export async function queueLibraryApplyOnApproval(taskId: string, by: { id: string | null; name: string }): Promise<DesignAgentJob | null> {
  const parent = await prisma.designAgentJob.findFirst({
    where: { taskId, kind: 'FIX', libraryState: 'YES' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  if (!parent || !parent.taskKey) return null
  if (await prisma.designAgentJob.findFirst({ where: { parentJobId: parent.id }, select: { id: true } })) return null
  const { job } = await enqueueAgentJob({
    kind: 'LIBRARY_APPLY',
    source: 'LIBRARY',
    taskKey: parent.taskKey,
    parentJobId: parent.id,
    requestedById: by.id,
    requestedBy: by.name,
    factory: parent.priority === 10,
    requestText: `Cập nhật thư viện và các đơn cùng design ${parent.designCode ?? ''} từ bản sửa đã duyệt của ${parent.taskKey}`,
  })
  return job
}

export async function decideLibrary(
  jobId: string, save: boolean, by: { id: string; name: string },
): Promise<{ libraryState: 'YES' | 'NO'; applyJobId: string | null }> {
  const job = await prisma.designAgentJob.findUnique({ where: { id: jobId } })
  if (!job) throw new AgentJobError('Không tìm thấy job', 404)
  const libraryState = save ? 'YES' : 'NO'
  const taken = await prisma.designAgentJob.updateMany({ where: { id: jobId, libraryState: 'ASKED' }, data: { libraryState } })
  if (taken.count === 0) throw new AgentJobError('Câu hỏi này đã được trả lời', 409)
  const task = job.taskId ? await prisma.designTask.findUnique({ where: { id: job.taskId }, select: { id: true, status: true } }) : null
  if (task) {
    const message = save ? `Lưu thư viện: có — cập nhật ${affectedRowCount(job.affectedJson)} đơn sau khi duyệt` : 'Lưu thư viện: không — chỉ sửa đơn này'
    await prisma.designTaskEvent.create({ data: { taskId: task.id, type: 'NOTE', message, actorId: by.id } })
  }
  if (!save || !task || task.status !== 'DONE') return { libraryState, applyJobId: null }
  const apply = await queueLibraryApplyOnApproval(task.id, by)
  return { libraryState, applyJobId: apply?.id ?? null }
}

export async function agentQueueCounts(): Promise<{ queued: number; running: number; needsOwner: number; failed: number }> {
  const rows = await prisma.designAgentJob.groupBy({ by: ['status'], _count: { _all: true } })
  const n = (s: AgentJobStatus) => rows.find(r => r.status === s)?._count._all ?? 0
  return { queued: n('QUEUED'), running: n('RUNNING'), needsOwner: n('NEEDS_OWNER'), failed: n('FAILED') }
}

function storedReasons(json: string | null): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

export async function backfillRejected(opts: {
  dryRun: boolean
  by: { id: string; name: string }
  factoryReasons: string[]
}): Promise<{ dryRun: boolean; count: number; taskKeys: string[]; queued: number }> {
  const [rejected, open] = await Promise.all([
    prisma.designTask.findMany({
      where: { status: 'REJECTED' }, orderBy: { taskKey: 'asc' },
      include: { order: { select: { pipelineStatus: true, financialStatus: true, fulfillmentStatus: true } } },
    }),
    prisma.designAgentJob.findMany({ where: { status: { in: OPEN }, taskId: { not: null } }, select: { taskId: true } }),
  ])
  const busy = new Set(open.map(j => j.taskId))
  const tasks = rejected.filter(t => {
    const o = t.order
    if (['CANCELLED', 'REFUNDED', 'FULFILLED'].includes(o.pipelineStatus)) return false
    if (['REFUNDED', 'VOIDED'].includes(o.financialStatus.toUpperCase())) return false
    return (o.fulfillmentStatus ?? '').toLowerCase() !== 'fulfilled' && !busy.has(t.id)
  })
  const taskKeys = tasks.map(t => t.taskKey)
  if (opts.dryRun) return { dryRun: true, count: taskKeys.length, taskKeys, queued: 0 }
  let queued = 0
  for (const t of tasks) {
    const reasons = storedReasons(t.rejectReasons)
    try {
      const { created } = await enqueueAgentJob({
        kind: 'FIX', source: 'BACKFILL', taskKey: t.taskKey, requestText: buildRequestText(reasons, t.rejectNote),
        requestedById: opts.by.id, requestedBy: opts.by.name, factory: reasons.some(r => opts.factoryReasons.includes(r)),
      })
      if (created) queued++
    } catch (e) {
      console.error(`[design agent] backfill không xếp được ${t.taskKey}:`, (e as Error)?.message ?? e)
    }
  }
  return { dryRun: false, count: taskKeys.length, taskKeys, queued }
}
