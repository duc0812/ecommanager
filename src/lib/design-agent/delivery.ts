import { prisma } from '@/lib/db'
import type { DesignAgentJob } from '@/generated/prisma/client'
import { getDesignSettings } from '@/lib/design-settings'
import type { FileKind } from '@/lib/task-files'
import {
  LineFixError, isSentLineOfOpenOrder, rejectReviewAsAgent, reopenLineForFix, submitAgentForReview, transitionTask, type TaskStatus,
} from '@/lib/design-tasks'
import { AgentJobError, enqueueAgentJob } from '@/lib/design-agent/jobs'
import { findLineByKey } from '@/lib/design-agent/affected'
import { ensureAgentUser } from '@/lib/design-agent/agent-user'

export const HOLD_NOTE_PREFIX = 'Auto render giữ lại: '

const MAX_NOTE = 2000
const MAX_HOLD_REASON = 300
const NO_TASK = 'Không tìm thấy task'
const SENT_NEEDS_TOOL = 'Đơn đã gửi xưởng — cần mở lại trên tool với lý do'

export type AgentTaskState = { taskId: string; taskKey: string; status: TaskStatus; sent: boolean; lineId: string; orderId: string; orderNumber: string }

export async function agentTaskState(taskKey: string): Promise<AgentTaskState | null> {
  const task = await prisma.designTask.findUnique({ where: { taskKey }, include: { order: { select: { shopifyOrderNumber: true } } } })
  if (!task) return null
  const line = await prisma.orderLine.findFirst({ where: { orderId: task.orderId, shopifyLineId: task.shopifyLineId }, select: { id: true } })
  if (!line) return null
  return {
    taskId: task.id, taskKey: task.taskKey, status: task.status as TaskStatus, sent: await isSentLineOfOpenOrder(line.id),
    lineId: line.id, orderId: task.orderId, orderNumber: task.order.shopifyOrderNumber,
  }
}

function affectedKeys(json: string | null): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : []
    return rows.map((r: any) => r?.taskKey).filter((k: unknown): k is string => typeof k === 'string')
  } catch { return [] }
}

/** The job allowed to deliver to this task now: its own RUNNING job, or a RUNNING LIBRARY_APPLY job that lists it. */
export async function runningJobCovering(taskKey: string): Promise<DesignAgentJob | null> {
  const task = await prisma.designTask.findUnique({ where: { taskKey }, select: { id: true } })
  if (task) {
    const own = await prisma.designAgentJob.findFirst({ where: { taskId: task.id, status: 'RUNNING' }, orderBy: { createdAt: 'asc' } })
    if (own) return own
  }
  const spreading = await prisma.designAgentJob.findMany({ where: { status: 'RUNNING', kind: 'LIBRARY_APPLY' }, orderBy: { createdAt: 'asc' } })
  return spreading.find(j => affectedKeys(j.affectedJson).includes(taskKey)) ?? null
}

export async function agentUploadGuard(taskKey: string, kind: FileKind): Promise<{ ok: true } | { error: string; status: 404 | 409 }> {
  if (!(await runningJobCovering(taskKey))) return { error: 'Task không có job Agent đang chạy', status: 409 }
  const task = await prisma.designTask.findUnique({ where: { taskKey }, select: { status: true } })
  if (!task) return { error: NO_TASK, status: 404 }
  if (kind === 'PRINT' && (task.status === 'DONE' || task.status === 'CANCELLED')) return { error: 'Task đã duyệt — mở lại trước khi thay file in', status: 409 }
  if (task.status === 'CANCELLED') return { error: 'Task đã huỷ', status: 409 }
  return { ok: true }
}

export async function agentSubmit(taskKey: string) {
  const agent = await ensureAgentUser()
  return submitAgentForReview(taskKey, agent.id)
}

async function reopenSentAsAgent(lineId: string, input: { reason?: unknown; note?: unknown }): Promise<{ status: TaskStatus; sent: boolean }> {
  const agent = await ensureAgentUser()
  try {
    const r = await reopenLineForFix(lineId, agent, { reason: input.reason, note: input.note }, { agent: true })
    return { status: r.task.status, sent: true }
  } catch (e) {
    if (e instanceof LineFixError) throw new AgentJobError(e.message, e.status)
    throw e
  }
}

export async function agentReopenTask(key: string, input: { reason?: unknown; note?: unknown }, opts: { allowSent: boolean }): Promise<{ status: TaskStatus; sent: boolean }> {
  const state = await agentTaskState(key)
  if (state) {
    if (state.status !== 'DONE') return { status: state.status, sent: state.sent }
    if (!state.sent) {
      const agent = await ensureAgentUser()
      const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : undefined
      const r = await transitionTask(key, agent, { to: 'DOING', note }, { agent: true })
      return { status: r.task.status, sent: false }
    }
    if (!opts.allowSent) throw new AgentJobError(SENT_NEEDS_TOOL, 409)
    return reopenSentAsAgent(state.lineId, input)
  }
  if (await prisma.designTask.findUnique({ where: { taskKey: key }, select: { id: true } })) {
    throw new AgentJobError('Dòng đơn của task đang được đồng bộ lại — thử lại sau vài giây', 409)
  }
  const line = await findLineByKey(key)
  if (!line) throw new AgentJobError(`Không tìm thấy task hoặc dòng ${key}`, 404)
  if (!(await isSentLineOfOpenOrder(line.lineId))) throw new AgentJobError('Dòng chưa có task — bấm Đồng bộ task trên tool', 409)
  if (!opts.allowSent) throw new AgentJobError(SENT_NEEDS_TOOL, 409)
  return reopenSentAsAgent(line.lineId, input)
}

export async function agentRejectReview(taskKey: string, input: { reason: string; note: string }): Promise<void> {
  if (!(await prisma.designTask.findUnique({ where: { taskKey }, select: { id: true } }))) throw new AgentJobError(NO_TASK, 404)
  const agent = await ensureAgentUser()
  if (!(await rejectReviewAsAgent(taskKey, agent.id, input))) throw new AgentJobError('Task không ở Chờ duyệt', 409)
}

async function writeAgentNote(taskKey: string, message: string): Promise<void> {
  const task = await prisma.designTask.findUnique({ where: { taskKey }, select: { id: true } })
  if (!task) throw new AgentJobError(NO_TASK, 404)
  const agent = await ensureAgentUser()
  await prisma.designTaskEvent.create({ data: { taskId: task.id, type: 'NOTE', message, actorId: agent.id } })
}

export async function agentAddNote(taskKey: string, message: string): Promise<void> {
  const text = typeof message === 'string' ? message.trim().slice(0, MAX_NOTE) : ''
  if (!text) throw new AgentJobError('Thiếu nội dung ghi chú', 400)
  await writeAgentNote(taskKey, `Agent: ${text}`)
}

export async function agentHold(taskKey: string, reason: string): Promise<{ jobId: string | null }> {
  const why = typeof reason === 'string' ? reason.trim().slice(0, MAX_HOLD_REASON) : ''
  if (!why) throw new AgentJobError('Thiếu lý do giữ lại', 400)
  const text = `${HOLD_NOTE_PREFIX}${why}`
  await writeAgentNote(taskKey, text)
  if (!(await getDesignSettings()).agent.autoFixOnReject) return { jobId: null }
  const { job } = await enqueueAgentJob({ kind: 'FIX', source: 'AUTO_HOLD', taskKey, requestText: text, requestedBy: 'Auto render' })
  return { jobId: job.id }
}
