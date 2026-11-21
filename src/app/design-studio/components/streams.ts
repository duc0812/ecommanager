import type { QueueFilter, Tone } from './model'
import type { Readiness, TaskRow, TaskStatus } from './types'

export type StreamId = 'MAP' | 'TPL' | 'FILE' | 'REVIEW' | 'HANDOFF' | 'SENT' | 'DROPSHIP'
export type Urgency = 'OVER' | 'SOON' | 'OK'
export type StreamDef = { id: StreamId; title: string; icon: string; who: string; unit: 'task' | 'đơn' }

export const STREAMS: StreamDef[] = [
  { id: 'MAP', title: 'Mapping', icon: 'account_tree', who: 'fulfillment / leader', unit: 'task' },
  { id: 'TPL', title: 'Template', icon: 'dashboard_customize', who: 'leader / người dựng template', unit: 'task' },
  { id: 'FILE', title: 'Files in', icon: 'brush', who: 'designer', unit: 'task' },
  { id: 'REVIEW', title: 'Duyệt mẫu', icon: 'fact_check', who: 'leader', unit: 'task' },
  { id: 'HANDOFF', title: 'Duyệt sản xuất', icon: 'precision_manufacturing', who: 'fulfillment', unit: 'đơn' },
  { id: 'SENT', title: 'Đã chuyển xưởng', icon: 'local_shipping', who: 'theo dõi', unit: 'đơn' },
  { id: 'DROPSHIP', title: 'Dropship', icon: 'inventory', who: 'không cần design — map xưởng rồi gửi', unit: 'đơn' },
]

export const TASK_STREAMS: StreamId[] = ['MAP', 'TPL', 'FILE', 'REVIEW']

export const SOON_HOURS = 4
export const OPEN_TASK_STATUSES: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED', 'ASK_CUSTOMER']

export type StreamTask = Pick<TaskRow, 'status' | 'dueAt' | 'mapping' | 'dropship'>
export type TaskStream = Exclude<StreamId, 'HANDOFF' | 'SENT' | 'DROPSHIP'>
export const isTaskStream = (s: StreamId | null): s is TaskStream => s !== null && TASK_STREAMS.includes(s)

export type SecondaryFilter = QueueFilter
/** The secondary filters each task stream offers; a filter not listed for a stream counts as 'ALL' there. */
const SECONDARY_FILTERS: Record<TaskStream, SecondaryFilter[]> = { MAP: [], TPL: [], FILE: ['AUTO', 'LOW', 'MANUAL', 'NEEDS_ARTWORK'], REVIEW: ['AUTO', 'LOW', 'MANUAL'] }
export function secondaryFiltersOf(stream: StreamId | null): SecondaryFilter[] {
  return isTaskStream(stream) ? SECONDARY_FILTERS[stream] : []
}

export function urgencyOf(dueAt: string | null, now = Date.now()): Urgency {
  if (!dueAt) return 'OK'
  const ms = new Date(dueAt).getTime() - now
  if (ms < 0) return 'OVER'
  return Math.floor(ms / 3.6e6) <= SOON_HOURS ? 'SOON' : 'OK'
}

export function streamOf(t: Pick<StreamTask, 'status' | 'mapping' | 'dropship'>): StreamId | null {
  if (t.status === 'CANCELLED') return null
  if (t.status === 'DONE') return 'FILE'
  if (t.mapping === 'UNMAPPED') return 'MAP'
  if (t.mapping === 'NO_TEMPLATE' && (t.status === 'NEW' || t.status === 'ASSIGNED')) return 'TPL'
  if (t.status === 'REVIEW') return 'REVIEW'
  return 'FILE'
}

/** `extra`: shown after a divider and left out of the stream's total (Xong hôm nay is not open work). */
export type PriorityGroupDef<T> = { id: string; title: string; sub: string; tone: Tone; extra?: boolean; test: (item: T, now: number) => boolean }

const isWorking = (t: StreamTask) => t.status === 'NEW' || t.status === 'ASSIGNED' || t.status === 'DOING'

function tiers<T extends { dueAt: string | null }>(prefix: string, urgent: [string, string], soon: [string, string], ok: [string, string]): PriorityGroupDef<T>[] {
  return [
    { id: `${prefix}_URGENT`, title: urgent[0], sub: urgent[1], tone: 'bad', test: (t, now) => urgencyOf(t.dueAt, now) === 'OVER' },
    { id: `${prefix}_SOON`, title: soon[0], sub: soon[1], tone: 'warn', test: (t, now) => urgencyOf(t.dueAt, now) === 'SOON' },
    { id: `${prefix}_OK`, title: ok[0], sub: ok[1], tone: 'idle', test: () => true },
  ]
}

export const TASK_GROUPS: Record<TaskStream, PriorityGroupDef<StreamTask>[]> = {
  MAP: tiers<StreamTask>('MP', ['Cần mapping gấp', 'quá hạn, chưa có xưởng'], ['Sắp quá hạn', 'còn tối đa 4h'], ['Còn hạn', 'chưa tới hạn']),
  TPL: tiers<StreamTask>('TP', ['Thiếu template gấp', 'quá hạn, chưa có template'], ['Sắp quá hạn', 'còn tối đa 4h'], ['Còn hạn', 'chưa tới hạn']),
  FILE: [
    { id: 'FI_URGENT', title: 'Files in gấp', sub: 'quá hạn, chưa có file in', tone: 'bad', test: (t, now) => isWorking(t) && urgencyOf(t.dueAt, now) === 'OVER' },
    { id: 'FI_FIX_URGENT', title: 'Files in cần sửa gấp', sub: 'bị trả lại, đã quá hạn', tone: 'bad', test: (t, now) => t.status === 'REJECTED' && urgencyOf(t.dueAt, now) === 'OVER' },
    { id: 'FI_SOON', title: 'Sắp quá hạn', sub: 'còn tối đa 4h', tone: 'warn', test: (t, now) => isWorking(t) && urgencyOf(t.dueAt, now) === 'SOON' },
    { id: 'FI_FIX', title: 'Cần sửa', sub: 'bị trả lại, còn hạn', tone: 'warn', test: t => t.status === 'REJECTED' },
    { id: 'FI_ASK', title: 'Chờ khách trả lời', sub: 'đang hỏi khách', tone: 'idle', test: t => t.status === 'ASK_CUSTOMER' },
    { id: 'FI_OK', title: 'Còn hạn', sub: 'mới / đã giao / đang làm', tone: 'idle', test: t => isWorking(t) },
    { id: 'FI_DONE', title: 'Xong hôm nay', sub: 'đã duyệt hôm nay', tone: 'ok', extra: true, test: () => true },
  ],
  REVIEW: tiers<StreamTask>('RV', ['Quá hạn — cần duyệt gấp', 'quá hạn, chờ duyệt mẫu'], ['Sắp quá hạn — cần duyệt', 'còn tối đa 4h'], ['Còn hạn', 'chưa tới hạn']),
}

export const HANDOFF_GROUPS: PriorityGroupDef<{ dueAt: string | null }>[] = tiers('HO', ['Quá hạn — cần gửi xưởng gấp', 'quá hạn, chưa gửi xưởng'], ['Sắp quá hạn', 'còn tối đa 4h'], ['Còn hạn', 'chưa tới hạn'])

export function groupOf<T>(defs: PriorityGroupDef<T>[], item: T, now = Date.now()): PriorityGroupDef<T> {
  return defs.find(d => d.test(item, now)) ?? defs[defs.length - 1]
}

export function byDue(a: { dueAt: string | null }, b: { dueAt: string | null }): number {
  if (a.dueAt === b.dueAt) return 0
  if (a.dueAt === null) return 1
  if (b.dueAt === null) return -1
  return a.dueAt < b.dueAt ? -1 : 1
}

const inStream = <T extends StreamTask>(stream: TaskStream, tasks: T[]) => tasks.filter(t => streamOf(t) === stream)

export function groupTasks<T extends StreamTask>(stream: TaskStream, tasks: T[], group: string | null, now = Date.now()): { def: PriorityGroupDef<StreamTask>; rows: T[] }[] {
  const mine = inStream(stream, tasks)
  return TASK_GROUPS[stream]
    .filter(def => group === null || def.id === group)
    .map(def => ({ def, rows: mine.filter(t => groupOf(TASK_GROUPS[stream], t, now) === def).sort(byDue) }))
    .filter(g => g.rows.length > 0)
}

export type StreamCounts = Record<StreamId, { total: number | null; overdue: number }>

/** Per stream: open tasks, and how many sit in a red group — the "N gấp" pill always equals the sum of that stream's red chips. */
export function streamCounts(tasks: StreamTask[], handoff: { count: number; overdue: number }, dropship: number | null, now = Date.now()): StreamCounts {
  const counts: StreamCounts = {
    MAP: { total: 0, overdue: 0 }, TPL: { total: 0, overdue: 0 }, FILE: { total: 0, overdue: 0 },
    REVIEW: { total: 0, overdue: 0 }, HANDOFF: { total: handoff.count, overdue: handoff.overdue }, SENT: { total: null, overdue: 0 }, DROPSHIP: { total: dropship, overdue: 0 },
  }
  for (const t of tasks) {
    if (!OPEN_TASK_STATUSES.includes(t.status)) continue
    const s = streamOf(t)
    if (!isTaskStream(s)) continue
    counts[s].total! += 1
    if (groupOf(TASK_GROUPS[s], t, now).tone === 'bad') counts[s].overdue += 1
  }
  return counts
}

export function groupCounts(stream: TaskStream, tasks: StreamTask[], now = Date.now()): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(TASK_GROUPS[stream].map(d => [d.id, 0]))
  for (const t of inStream(stream, tasks)) out[groupOf(TASK_GROUPS[stream], t, now).id] += 1
  return out
}

export type FlagNote = { key: string; tone: Tone; icon: string; title: string; text: string; links: { label: string; href: string }[] }
export type FlagInput = {
  status: TaskStatus; dueAt: string | null; readiness: Readiness; mapping: TaskRow['mapping']
  stream: StreamId | null; inQueue: boolean; productPageHref: string | null
}

const OVERDUE_WORDING: Partial<Record<StreamId, string>> = { MAP: 'cần mapping gấp', TPL: 'cần dựng template gấp', REVIEW: 'cần duyệt gấp' }

export function flagNotes(input: FlagInput, now = Date.now()): FlagNote[] {
  const { status, dueAt, readiness, mapping, stream, inQueue, productPageHref } = input
  if (status === 'DONE' || status === 'CANCELLED') {
    return inQueue ? [] : [{ key: 'outside', tone: 'idle', icon: 'info', title: 'Task này đã duyệt / đã huỷ,', text: 'không nằm trong hàng đợi.', links: [] }]
  }
  const notes: FlagNote[] = []
  const open = OPEN_TASK_STATUSES.includes(status)
  if (open && dueAt && urgencyOf(dueAt, now) === 'OVER') {
    const hours = Math.floor((now - new Date(dueAt).getTime()) / 3.6e6)
    const what = (stream && OVERDUE_WORDING[stream]) || 'cần file in gấp'
    notes.push({ key: 'overdue', tone: 'bad', icon: 'alarm', title: `Quá hạn ${hours}h — ${what}`, text: '', links: [] })
  }
  const parts: string[] = []
  const links: FlagNote['links'] = []
  if (mapping === 'UNMAPPED') {
    parts.push('chưa map xưởng')
    links.push({ label: 'Mở Product Mapping', href: '/fulfillment/mapping' })
  }
  if (stream === 'TPL') {
    parts.push('chưa có template in')
    links.push({ label: 'Mở Templates', href: '/design-studio/templates' })
    if (productPageHref) links.push({ label: 'Mở trang sản phẩm', href: productPageHref })
  }
  const blocked = parts.length > 0
  if (blocked) {
    notes.push({ key: 'blocked', tone: 'warn', icon: 'report', title: 'Đang vướng:', text: `${parts.join(' · ')}. Task này không render tự động được cho tới khi gỡ xong.`, links })
  }
  const noTemplate = mapping === 'NO_TEMPLATE' && status !== 'NEW' && status !== 'ASSIGNED'
  if (noTemplate) {
    notes.push({ key: 'no-template', tone: 'warn', icon: 'dashboard_customize', title: 'Không có template —', text: 'tự kiểm tra khổ file trước khi gửi duyệt', links: [] })
  }
  if (open && readiness === 'LOW' && !blocked && !noTemplate) {
    notes.push({ key: 'low', tone: 'warn', icon: 'tune', title: 'Cần chỉnh:', text: 'máy đã render file tự động, sửa tay (vị trí / font / màu) rồi mới gửi duyệt.', links: [] })
  }
  return notes
}
