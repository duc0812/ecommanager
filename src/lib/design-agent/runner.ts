import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import type { DesignAgentJob } from '@/generated/prisma/client'
import { hashedTokenInfo, mintHashedToken, revokeHashedToken, verifyBearerHash } from '@/lib/hashed-token'
import { getDesignSettings } from '@/lib/design-settings'
import { designOf } from '@/lib/flat-text-coverage'
import { linePersonalization, safeHttpUrl } from '@/lib/design-studio'
import { currentFiles, type FileKind } from '@/lib/task-files'
import { AGENT_SUBMIT_MESSAGE, SENT_BACK_REASONS, isSentLineOfOpenOrder, templateForLine, type Readiness, type TaskStatus } from '@/lib/design-tasks'
import {
  enqueueFixOnReject, notifyAgentQueue, waitForAgentQueue, type AgentJobKind, type AgentJobSource, type AgentJobStatus,
} from '@/lib/design-agent/jobs'
import { affectedForTask, type AffectedRow } from '@/lib/design-agent/affected'
import { ensureAgentUser } from '@/lib/design-agent/agent-user'
import { notifyNeedsOwner, type OwnerNotice } from '@/lib/design-agent/notify'

export const DESIGN_AGENT_TOKEN_KEY = 'design.agent.tokenHash'
export const DESIGN_AGENT_SEEN_KEY = 'design.agent.lastSeenAt'
export const AGENT_MAX_WAIT_S = 25
export const AGENT_MAX_ATTEMPTS = 2
export const RUNNER_LOST = 'runner lost'

const ONLINE_MS = 90_000
const EVENTS_IN_CLAIM = 20
const MAX_STAGE = 200
const MAX_ERROR = 2000
const MAX_NOTE_ERROR = 300
const MAX_INT = 2_147_483_647
const TASK_CANCELLED = 'Task đã huỷ'
const TASK_APPROVED = 'Task đã được duyệt'
const LINE_GONE = 'Không tìm thấy dòng của task'
const NO_ERROR_TEXT = 'Runner không gửi lý do'
const MAX_SUMMARY = 4000
const MAX_RESULT = 20000
const NOT_SUBMITTED = '\n(Agent báo xong nhưng task chưa được gửi duyệt.)'

declare global {
  // eslint-disable-next-line no-var
  var __designAgentOwnerNotices: Set<Promise<void>> | undefined
}

function pendingNotices(): Set<Promise<void>> {
  if (!globalThis.__designAgentOwnerNotices) globalThis.__designAgentOwnerNotices = new Set()
  return globalThis.__designAgentOwnerNotices
}

// Fire-and-forget: a slow or failing Lark must never delay or fail the runner's /result or /fail.
function tellOwner(notice: OwnerNotice): void {
  let sent: Promise<void>
  try { sent = Promise.resolve(notifyNeedsOwner(notice)) } catch (e) { sent = Promise.reject(e) }
  const tracked = sent
    .catch(e => { console.error(`[design agent] không báo được chủ shop cho job ${notice.jobId}:`, (e as Error)?.message ?? e) })
    .finally(() => { pendingNotices().delete(tracked) })
  pendingNotices().add(tracked)
}

/** Waits for the owner notices already started (tests). */
export async function settleOwnerNotices(): Promise<void> {
  await Promise.all(Array.from(pendingNotices()))
}

async function noteOnTask(taskId: string | null, message: string): Promise<void> {
  if (!taskId || !(await prisma.designTask.findUnique({ where: { id: taskId }, select: { id: true } }))) return
  const agent = await ensureAgentUser()
  await prisma.designTaskEvent.create({ data: { taskId, type: 'NOTE', message, actorId: agent.id } })
}

export function generateAgentRunnerToken(): Promise<string> {
  return mintHashedToken('dag_', DESIGN_AGENT_TOKEN_KEY)
}

export function revokeAgentRunnerToken(): Promise<void> {
  return revokeHashedToken(DESIGN_AGENT_TOKEN_KEY)
}

export function verifyAgentRunnerRequest(req: NextRequest): Promise<boolean> {
  return verifyBearerHash(req.headers.get('authorization'), DESIGN_AGENT_TOKEN_KEY)
}

export async function markAgentRunnerSeen(now: Date = new Date()): Promise<void> {
  const value = now.toISOString()
  await prisma.appSetting.upsert({ where: { key: DESIGN_AGENT_SEEN_KEY }, create: { key: DESIGN_AGENT_SEEN_KEY, value }, update: { value } })
}

export async function agentRunnerInfo(): Promise<{ configured: boolean; tokenUpdatedAt: string | null; lastSeenAt: string | null; online: boolean }> {
  const [token, seen] = await Promise.all([
    hashedTokenInfo(DESIGN_AGENT_TOKEN_KEY),
    prisma.appSetting.findUnique({ where: { key: DESIGN_AGENT_SEEN_KEY } }),
  ])
  const seenMs = seen ? Date.parse(seen.value) : NaN
  const lastSeenAt = Number.isFinite(seenMs) ? new Date(seenMs).toISOString() : null
  return {
    configured: token.configured,
    tokenUpdatedAt: token.configured ? token.updatedAt : null,
    lastSeenAt,
    online: lastSeenAt !== null && Date.now() - seenMs <= ONLINE_MS,
  }
}

export type AgentClaimFile = {
  id: string; kind: FileKind; printArea: string; version: number; fileName: string
  url: string; driveUrl: string | null; widthPx: number | null; heightPx: number | null
}

export type AgentClaim = {
  id: string; kind: AgentJobKind; source: AgentJobSource; attempts: number; priority: number
  requestText: string; requestedBy: string | null
  task: {
    key: string; status: TaskStatus; readiness: Readiness; orderNumber: string; linePosition: number
    sku: string | null; designCode: string | null; supplierSku: string | null; supplierId: string | null
    productTitle: string; variantTitle: string | null; imageUrl: string | null
    customFields: Record<string, string>; sent: boolean; driveFolderUrl: string | null; templateId: string | null
  }
  files: AgentClaimFile[]
  events: { at: string; type: string; message: string; actor: string | null }[]
  affected: AffectedRow[]
  parent: { id: string; summary: string | null } | null
}

export async function buildAgentClaim(job: DesignAgentJob): Promise<AgentClaim | null> {
  const task = job.taskId ? await prisma.designTask.findUnique({ where: { id: job.taskId }, include: { order: { select: { shopifyOrderNumber: true } } } }) : null
  if (!task) return null
  const line = await prisma.orderLine.findFirst({ where: { orderId: task.orderId, shopifyLineId: task.shopifyLineId } })
  if (!line) return null
  const [artworks, recent, template, sent, affected] = await Promise.all([
    prisma.designArtwork.findMany({ where: { orderId: task.orderId, shopifyLineId: task.shopifyLineId, removedAt: null } }),
    prisma.designTaskEvent.findMany({ where: { taskId: task.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: EVENTS_IN_CLAIM }),
    templateForLine(line),
    isSentLineOfOpenOrder(line.id),
    affectedForTask(task.id),
  ])
  let parent: AgentClaim['parent'] = null
  if (job.kind === 'LIBRARY_APPLY') {
    await prisma.designAgentJob.update({ where: { id: job.id }, data: { affectedJson: JSON.stringify({ rows: affected.rows, fulfilledCount: affected.fulfilledCount }) } })
    const fix = job.parentJobId ? await prisma.designAgentJob.findUnique({ where: { id: job.parentJobId }, select: { id: true, summary: true } }) : null
    parent = fix ? { id: fix.id, summary: fix.summary } : null
  }
  const actorIds = Array.from(new Set(recent.map(e => e.actorId).filter((x): x is string => !!x)))
  const actors = actorIds.length ? await prisma.appUser.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : []
  const actorName = new Map(actors.map(a => [a.id, a.name]))
  const files = [...currentFiles(artworks, 'PRINT'), ...currentFiles(artworks, 'MOCKUP')].map((f): AgentClaimFile => ({
    id: f.id, kind: f.kind === 'MOCKUP' ? 'MOCKUP' : 'PRINT', printArea: f.printArea, version: f.version, fileName: f.fileName,
    url: `/api/design-agent/runner/files/${f.id}`, driveUrl: safeHttpUrl(f.driveWebViewLink), widthPx: f.widthPx, heightPx: f.heightPx,
  }))
  const customFields: Record<string, string> = {}
  for (const f of linePersonalization(line)) customFields[f.key] = f.value
  return {
    id: job.id, kind: job.kind as AgentJobKind, source: job.source as AgentJobSource, attempts: job.attempts, priority: job.priority,
    requestText: job.requestText, requestedBy: job.requestedBy,
    task: {
      key: task.taskKey, status: task.status as TaskStatus, readiness: task.readiness as Readiness,
      orderNumber: task.order.shopifyOrderNumber, linePosition: line.linePosition,
      sku: line.sku, designCode: designOf(line.sku) || null, supplierSku: line.resolvedSupplierSku, supplierId: line.resolvedSupplierId,
      productTitle: line.productTitle, variantTitle: line.variantTitle, imageUrl: safeHttpUrl(line.imageUrl),
      customFields, sent, driveFolderUrl: safeHttpUrl(task.driveFolderUrl), templateId: template?.id ?? null,
    },
    files,
    events: recent.reverse().map(e => ({ at: e.createdAt.toISOString(), type: e.type, message: e.message, actor: e.actorId ? (actorName.get(e.actorId) ?? null) : null })),
    affected: affected.rows,
    parent,
  }
}

export async function releaseExpiredAgentLeases(now: Date = new Date()): Promise<void> {
  const { leaseMinutes } = (await getDesignSettings()).agent
  const cutoff = new Date(now.getTime() - leaseMinutes * 60_000)
  const expired = await prisma.designAgentJob.findMany({
    where: { status: 'RUNNING', OR: [{ lockedAt: null }, { lockedAt: { lt: cutoff } }] },
  })
  for (const job of expired) {
    const where = { id: job.id, status: 'RUNNING', attempts: job.attempts, lockedAt: job.lockedAt }
    if (job.attempts < AGENT_MAX_ATTEMPTS) {
      await prisma.designAgentJob.updateMany({ where, data: { status: 'QUEUED', lockedAt: null, stage: null } })
    } else {
      const r = await prisma.designAgentJob.updateMany({ where, data: { status: 'FAILED', error: RUNNER_LOST, finishedAt: now, lockedAt: null } })
      if (r.count > 0) tellOwner({ jobId: job.id, taskKey: job.taskKey, kind: job.kind as AgentJobKind, reason: 'FAILED', summary: RUNNER_LOST })
    }
  }
}

async function cancelJob(id: string, error: string, now: Date): Promise<void> {
  await prisma.designAgentJob.updateMany({ where: { id, status: 'QUEUED' }, data: { status: 'CANCELLED', error, finishedAt: now } })
}

async function claimRound(free: number, now: Date, gone: () => boolean): Promise<{ jobs: AgentClaim[]; capacity: number }> {
  await releaseExpiredAgentLeases(now)
  const wanted = Number.isFinite(free) ? Math.floor(free) : 0
  const { maxConcurrent } = (await getDesignSettings()).agent
  const running = await prisma.designAgentJob.findMany({ where: { status: 'RUNNING' }, select: { taskId: true } })
  const capacity = Math.min(wanted, maxConcurrent - running.length)
  if (capacity <= 0) return { jobs: [], capacity: 0 }
  const busy = new Set(running.map(r => r.taskId).filter((x): x is string => !!x))
  const queued = await prisma.designAgentJob.findMany({
    where: { status: 'QUEUED' }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }], take: 200,
  })
  const jobs: AgentClaim[] = []
  for (const job of queued) {
    if (jobs.length >= capacity || gone()) break
    const task = job.taskId ? await prisma.designTask.findUnique({ where: { id: job.taskId }, select: { status: true } }) : null
    if (!task || task.status === 'CANCELLED') { await cancelJob(job.id, TASK_CANCELLED, now); continue }
    if ((job.kind === 'FIX' || job.kind === 'MAKE') && task.status === 'DONE') { await cancelJob(job.id, TASK_APPROVED, now); continue }
    if (busy.has(job.taskId!)) continue
    const taken = await prisma.designAgentJob.updateMany({
      where: { id: job.id, status: 'QUEUED', attempts: job.attempts },
      data: { status: 'RUNNING', attempts: job.attempts + 1, lockedAt: now, stage: null, ...(job.startedAt ? {} : { startedAt: now }) },
    })
    if (taken.count === 0) continue
    busy.add(job.taskId!)
    const claim = await buildAgentClaim(await prisma.designAgentJob.findUniqueOrThrow({ where: { id: job.id } }))
    if (!claim) {
      await prisma.designAgentJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { status: 'CANCELLED', error: LINE_GONE, finishedAt: now, lockedAt: null } })
      continue
    }
    jobs.push(claim)
  }
  return { jobs, capacity }
}

export async function claimAgentJobs(free: number, now: Date = new Date()): Promise<AgentClaim[]> {
  return (await claimRound(free, now, () => false)).jobs
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, Math.max(0, ms))
    if (signal?.aborted) done()
    else signal?.addEventListener('abort', done)
  })
}

// `signal` is the runner's request: once it is aborted nothing more is claimed, because a claimed job whose answer reaches nobody
// would sit RUNNING for a whole lease and lose one of its two attempts.
export async function claimAgentJobsWithWait(free: number, waitSeconds: number, signal?: AbortSignal): Promise<AgentClaim[]> {
  const seconds = Number.isFinite(waitSeconds) ? Math.min(Math.max(waitSeconds, 0), AGENT_MAX_WAIT_S) : 0
  const deadline = Date.now() + seconds * 1000
  const gone = () => signal?.aborted === true
  if (gone()) return []
  const first = await claimRound(free, new Date(), gone)
  if (first.jobs.length > 0 || seconds === 0) return first.jobs
  // No room: wait the window out, so a runner that asks again at once does not spin.
  if (first.capacity <= 0) {
    await pause(deadline - Date.now(), signal)
    return []
  }
  const stop = new AbortController()
  const onAbort = () => stop.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    // A wake-up with nobody waiting is not remembered, so the wait is registered before the second look.
    const woken = waitForAgentQueue(Math.max(0, deadline - Date.now()), stop.signal)
    if (gone()) return []
    const second = await claimRound(free, new Date(), gone)
    if (second.jobs.length > 0) return second.jobs
    await woken
    if (gone()) return []
    return (await claimRound(free, new Date(), gone)).jobs
  } finally {
    signal?.removeEventListener('abort', onAbort)
    stop.abort()
  }
}

export async function heartbeatAgentJob(id: string, patch: { stage?: unknown; rounds?: unknown }): Promise<boolean> {
  const data: { lockedAt: Date; stage?: string; rounds?: number } = { lockedAt: new Date() }
  if (typeof patch.stage === 'string') data.stage = patch.stage.slice(0, MAX_STAGE)
  if (Number.isInteger(patch.rounds) && (patch.rounds as number) >= 0) data.rounds = Math.min(patch.rounds as number, MAX_INT)
  const r = await prisma.designAgentJob.updateMany({ where: { id, status: 'RUNNING' }, data })
  return r.count > 0
}

function errorText(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.trim() : NO_ERROR_TEXT
}

export async function failAgentJob(id: string, input: { error: unknown; permanent?: unknown }): Promise<{ status: 'QUEUED' | 'FAILED'; attempts: number } | null> {
  const job = await prisma.designAgentJob.findUnique({ where: { id } })
  if (!job || job.status !== 'RUNNING') return null
  const error = errorText(input.error).slice(0, MAX_ERROR)
  const where = { id, status: 'RUNNING', attempts: job.attempts }
  if (input.permanent !== true && job.attempts < AGENT_MAX_ATTEMPTS) {
    const r = await prisma.designAgentJob.updateMany({ where, data: { status: 'QUEUED', lockedAt: null, stage: null, error } })
    if (r.count === 0) return null
    notifyAgentQueue()
    return { status: 'QUEUED', attempts: job.attempts }
  }
  const r = await prisma.designAgentJob.updateMany({ where, data: { status: 'FAILED', lockedAt: null, finishedAt: new Date(), error } })
  if (r.count === 0) return null
  await noteOnTask(job.taskId, `Agent: không chạy được — ${error.slice(0, MAX_NOTE_ERROR)}`)
  tellOwner({ jobId: job.id, taskKey: job.taskKey, kind: job.kind as AgentJobKind, reason: 'FAILED', summary: error })
  return { status: 'FAILED', attempts: job.attempts }
}

function rejectReasonsOf(json: string | null): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

async function submittedSince(taskId: string, since: Date | null): Promise<boolean> {
  const e = await prisma.designTaskEvent.findFirst({
    where: { taskId, type: 'STATUS', message: AGENT_SUBMIT_MESSAGE, ...(since ? { createdAt: { gte: since } } : {}) }, select: { id: true },
  })
  return !!e
}

export async function completeAgentJob(
  id: string, input: { outcome: unknown; summary: unknown; rounds?: unknown; result?: unknown },
): Promise<{ status: AgentJobStatus } | { error: string; status: 400 | 409 }> {
  const told = typeof input.summary === 'string' ? input.summary.trim() : ''
  if ((input.outcome !== 'DONE' && input.outcome !== 'NEEDS_OWNER') || !told) return { error: 'outcome và summary là bắt buộc', status: 400 }
  const job = await prisma.designAgentJob.findUnique({ where: { id } })
  if (!job || job.status !== 'RUNNING') return { error: 'not running', status: 409 }

  let status: AgentJobStatus = input.outcome
  let summary = told.slice(0, MAX_SUMMARY)
  let libraryState: string | null = null
  let affectedJson: string | undefined
  let refix: { taskKey: string; reasons: string[]; note: string | null } | null = null
  if (input.outcome === 'DONE' && (job.kind === 'FIX' || job.kind === 'MAKE')) {
    const task = job.taskId ? await prisma.designTask.findUnique({ where: { id: job.taskId } }) : null
    const submitted = !!task && (task.status === 'REVIEW' || task.status === 'DONE' || await submittedSince(task.id, job.startedAt))
    if (!task || !submitted) {
      status = 'NEEDS_OWNER'
      summary += NOT_SUBMITTED
    } else if (task.status === 'REJECTED') {
      refix = { taskKey: task.taskKey, reasons: rejectReasonsOf(task.rejectReasons), note: task.rejectNote }
    } else if (job.kind === 'FIX') {
      const affected = await affectedForTask(task.id)
      if (affected.rows.length > 0) {
        libraryState = 'ASKED'
        affectedJson = JSON.stringify({ rows: affected.rows, fulfilledCount: affected.fulfilledCount })
      }
    }
  }

  const rounds = Number.isInteger(input.rounds) && (input.rounds as number) >= 0 ? Math.min(input.rounds as number, MAX_INT) : undefined
  const resultJson = input.result === undefined ? null : (JSON.stringify(input.result) ?? null)?.slice(0, MAX_RESULT) ?? null
  const written = await prisma.designAgentJob.updateMany({
    where: { id, status: 'RUNNING', attempts: job.attempts },
    data: {
      status, summary, resultJson, finishedAt: new Date(), lockedAt: null, libraryState,
      ...(rounds !== undefined ? { rounds } : {}), ...(affectedJson !== undefined ? { affectedJson } : {}),
    },
  })
  if (written.count === 0) return { error: 'not running', status: 409 }

  if (job.kind === 'LIBRARY_APPLY' && status === 'DONE' && job.parentJobId) {
    await prisma.designAgentJob.updateMany({ where: { id: job.parentJobId, libraryState: 'YES' }, data: { libraryState: 'APPLIED' } })
  }
  await noteOnTask(job.taskId, `Agent: ${summary}`)
  if (refix) {
    const agent = await ensureAgentUser()
    await enqueueFixOnReject({
      taskKey: refix.taskKey, reasons: refix.reasons, note: refix.note, by: agent, source: 'REJECT',
      factory: refix.reasons.some(r => SENT_BACK_REASONS.includes(r)),
    })
  }
  if (status === 'NEEDS_OWNER') tellOwner({ jobId: job.id, taskKey: job.taskKey, kind: job.kind as AgentJobKind, reason: 'NEEDS_OWNER', summary })
  return { status }
}
