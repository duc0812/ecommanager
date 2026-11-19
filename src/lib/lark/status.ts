import { prisma } from '@/lib/db'
import { templateForLine, type TaskStatus } from '@/lib/design-tasks'
import { FILE_KINDS, currentFiles } from '@/lib/task-files'
import type { AgentTaskState } from '@/lib/design-agent/delivery'
import { workStateFor, type WorkState } from '@/lib/design-agent/work-state'
import { replyHeldBefore } from '@/lib/lark/replies'

export const MAX_STATUS_REPLY = 1500
const MAX_DETAIL = 300
const MAX_EVENT = 120
const MAX_NAME = 80
const MAX_SUMMARY = 200
const EVENTS_SHOWN = 3
const NEXT_TICK = 'lượt quét tới (tối đa 10 phút)'
const NONE = 'chưa có'

const STATUS_LABEL: Record<TaskStatus, string> = {
  NEW: 'Mới', ASSIGNED: 'Đã giao', DOING: 'Đang làm', REVIEW: 'Chờ duyệt', ASK_CUSTOMER: 'Đang hỏi khách',
  REJECTED: 'Bị trả lại', DONE: 'Xong', CANCELLED: 'Đã huỷ',
}
const JOB_LABEL: Record<string, string> = {
  QUEUED: 'đang chờ', RUNNING: 'đang chạy', DONE: 'xong', NEEDS_OWNER: 'cần chủ shop xem', FAILED: 'lỗi', CANCELLED: 'đã huỷ',
}
const CLOSED_LABEL: Record<Extract<WorkState, { kind: 'CLOSED' }>['reason'], string> = {
  CANCELLED: 'task đã huỷ.', ORDER_CLOSED: 'đơn đã giao hoặc đã đóng.', ASK_CUSTOMER: 'đang chờ khách trả lời.', SENT: 'đơn đã gửi xưởng.',
}

/** Text that came from a task, a queue or a job is shown as data: one line, cut to length. */
export function cutLine(text: string | null | undefined, max: number): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const sentence = (text: string | null, max: number) => cutLine(text, max).replace(/[.\s]+$/, '')

const usDate = (d: Date) => d.toLocaleDateString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', month: '2-digit', day: '2-digit', year: 'numeric' })

/** Whole minutes left, rounded up; null once the moment has passed, so a reply never shows zero or a negative count. */
function minutesLeft(etaAt: Date | null, now: Date): number | null {
  if (!etaAt) return null
  const ms = etaAt.getTime() - now.getTime()
  return ms > 0 ? Math.ceil(ms / 60_000) : null
}

function describeQueue(state: Extract<WorkState, { kind: 'QUEUE' }>, now: Date): string {
  const left = minutesLeft(state.etaAt, now)
  const detail = sentence(state.detail, MAX_DETAIL)
  if (state.state === 'waiting') {
    const version = state.version != null ? ` v${state.version}` : ''
    return `đã có bản sửa${version} ở hàng duyệt local, ${left ? `khoảng ${left} phút nữa tự lên cloud` : `sẽ lên cloud ở ${NEXT_TICK}`}.`
  }
  if (state.state === 'qa_failed') {
    const hold = left ? `Sau ${left} phút nếu không ai xử lý sẽ bị giữ lại.` : `Nếu không ai xử lý sẽ bị giữ lại ở ${NEXT_TICK}.`
    return `bản ở hàng duyệt local đang lỗi QA${detail ? `: ${detail}` : ''}. ${hold}`
  }
  return `đang ở hàng duyệt local, trạng thái ${cutLine(state.state, MAX_NAME)}${detail ? `: ${detail}` : ''}.`
}

function describeBody(state: WorkState, now: Date): string {
  switch (state.kind) {
    case 'QUEUE': return describeQueue(state, now)
    case 'STREAM': return `${cutLine(state.worker, MAX_NAME)} đang giữ dòng này.`
    case 'PERSON': return `${cutLine(state.name, MAX_NAME)} đang làm dòng này.`
    case 'AUTO': return 'auto render sẽ xử lý ở lượt hằng giờ.'
    case 'AGENT': return `Agent đang làm${state.stage ? `, bước ${cutLine(state.stage, MAX_NAME)}` : ''}.`
    case 'UNKNOWN': return 'chưa xác định được ai đang giữ vì dữ liệu từ máy local chưa cập nhật. Bot chưa tạo việc.'
    case 'CLOSED': return CLOSED_LABEL[state.reason]
    case 'FREE': return `chưa có ai giữ dòng này.${state.heldReason ? replyHeldBefore(state.heldReason) : ''}`
  }
}

export function describeWorkState(key: string, state: WorkState, now: Date): string {
  return `${key}: ${describeBody(state, now)}`
}

export async function larkTaskStatus(task: AgentTaskState, now: Date = new Date()): Promise<string> {
  const line = await prisma.orderLine.findUnique({
    where: { id: task.lineId },
    select: { orderId: true, shopifyLineId: true, resolvedSupplierId: true, resolvedSupplierSku: true, shopifyProductId: true, shopifyProductType: true },
  })
  const supplier = line?.resolvedSupplierId
    ? await prisma.supplier.findUnique({ where: { id: line.resolvedSupplierId }, select: { name: true } })
    : null
  const template = line ? await templateForLine(line) : null
  const files = line
    ? await prisma.designArtwork.findMany({
      where: { orderId: line.orderId, shopifyLineId: line.shopifyLineId, removedAt: null, kind: { in: FILE_KINDS } },
      select: { kind: true, printArea: true, version: true, createdAt: true },
    })
    : []
  const prints = currentFiles(files, 'PRINT')
  const mockups = currentFiles(files, 'MOCKUP')
  const newestFile = [...prints, ...mockups].reduce<Date | null>((max, f) => (!max || f.createdAt > max ? f.createdAt : max), null)
  const events = await prisma.designTaskEvent.findMany({
    where: { taskId: task.taskId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: EVENTS_SHOWN, select: { message: true, createdAt: true },
  })
  const job = await prisma.designAgentJob.findFirst({
    where: { taskId: task.taskId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { status: true, stage: true, summary: true, createdAt: true },
  })
  const state = await workStateFor(task, now)

  const named = (text: string | null | undefined) => cutLine(text, MAX_NAME) || NONE
  const jobText = job
    ? `${usDate(job.createdAt)} · ${JOB_LABEL[job.status] ?? cutLine(job.status, MAX_NAME)}${job.stage ? `, bước ${cutLine(job.stage, MAX_NAME)}` : ''}${job.summary?.trim() ? ` — ${cutLine(job.summary, MAX_SUMMARY)}` : ''}`
    : NONE
  const out = [
    `${task.taskKey} — ${STATUS_LABEL[task.status] ?? task.status}`,
    `Xưởng: ${named(supplier?.name)} · SKU xưởng: ${named(line?.resolvedSupplierSku)} · Template: ${named(template?.name)}`,
    `File in: ${prints.length} · Mockup: ${mockups.length}${newestFile ? ` · file mới nhất ${usDate(newestFile)}` : ''}`,
    describeWorkState(task.taskKey, state, now),
    `Việc Agent gần nhất: ${jobText}`,
  ]
  if (events.length) out.push('Hoạt động gần đây:', ...events.map(e => `- ${usDate(e.createdAt)}: ${cutLine(e.message, MAX_EVENT)}`))
  return out.join('\n').slice(0, MAX_STATUS_REPLY)
}
