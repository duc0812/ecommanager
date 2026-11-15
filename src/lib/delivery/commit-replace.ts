import type { TemplateRow } from '@/lib/print-template-resolve'
import { sameLabel } from '@/lib/task-files'
import { refuse } from '@/lib/delivery/commit-checks'
import { goneText, replaceEventMessage, retireEventMessage, revertEventMessage } from '@/lib/delivery/commit-text'
import type { CommitError, CommitInput, DeliveryFile, TaskState } from '@/lib/delivery/types'

export type PlannedFile = DeliveryFile & { version: number }

export type LiveArtwork = TaskState['artworks'][number]

export type Plan = {
  inserts: PlannedFile[]
  retire: LiveArtwork[]
  event: { type: string; message: string }
  /** Written by the guarded task update; `readiness` also joins its where clause. */
  task?: { status: string; readiness: string; prevStatus: null }
  guardReadiness?: string
}

export type Ctx = {
  taskId: string
  orderId: string
  shopifyLineId: string
  input: CommitInput
  files: DeliveryFile[]
  state: TaskState
  template: TemplateRow | null
  now: Date
}

const REPLACE_FROM = ['REVIEW', 'DOING', 'REJECTED']
const DEFAULT_SOURCES = ['AUTO']

export const partLabel = (a: { kind: string; printArea: string; version: number }) => `${a.kind === 'MOCKUP' ? 'mockup ' : ''}${a.printArea} v${a.version}`

const optionalText = (s: string | undefined) => (s?.trim() ? s : undefined)

export function nextVersionFor(state: TaskState, kind: string, area: string): number {
  let next = 1
  for (const [key, n] of Object.entries(state.nextVersion)) {
    const cut = key.indexOf('/')
    if (key.slice(0, cut) === kind && sameLabel(key.slice(cut + 1), area)) next = Math.max(next, n)
  }
  return next
}

function stateError(ctx: Ctx, action: string): CommitError | null {
  const { state, input } = ctx
  if (state.status === 'DONE' && input.allowFinished) return null
  if (REPLACE_FROM.includes(state.status)) return null
  const hint = state.status === 'DONE' ? ' — task DONE cần allowFinished' : ''
  return refuse(409, 'wrong_state', `Task đang ${state.status} — ${action} chỉ nhận task REVIEW, DOING, REJECTED (DONE khi có allowFinished)${hint}`, ctx.state)
}

function retiredRows(ctx: Ctx): CommitError | LiveArtwork[] {
  const { state, input } = ctx
  const sources: string[] = input.retireSources ?? DEFAULT_SOURCES
  const rows: LiveArtwork[] = []
  for (const id of input.retire) {
    const a = state.artworks.find(x => x.id === id)
    if (!a) return refuse(400, 'bad_request', `File ${id} không phải file đang dùng của dòng này`)
    if (!sources.includes(a.source)) {
      return refuse(409, 'not_retirable', `${partLabel(a)} là file ${a.source} — chỉ gỡ được file ${sources.join('/')} (thêm "${a.source}" vào retireSources nếu chắc chắn)`, state)
    }
    rows.push(a)
  }
  return rows
}

function lastPrintError(ctx: Ctx, retired: LiveArtwork[], inserts: PlannedFile[]): CommitError | null {
  const gone = new Set(retired.map(r => r.id))
  const left = ctx.state.artworks.filter(a => a.kind === 'PRINT' && !gone.has(a.id)).length + inserts.filter(f => f.kind === 'PRINT').length
  return left > 0 ? null : refuse(409, 'last_print', 'Gỡ xong dòng sẽ không còn file in nào — không gỡ file in cuối cùng', ctx.state)
}

export function planReplace(ctx: Ctx): CommitError | Plan {
  const wrong = stateError(ctx, 'replace')
  if (wrong) return wrong
  const retired = retiredRows(ctx)
  if (!Array.isArray(retired)) return retired
  const gone = new Set(retired.map(r => r.id))
  const kept = ctx.files.filter(f => ctx.state.artworks.some(a => !gone.has(a.id) && a.kind === f.kind && sameLabel(a.printArea, f.printArea)))
  if (kept.length) {
    return refuse(400, 'bad_request', `${kept.map(f => `${f.kind === 'MOCKUP' ? 'mockup ' : ''}${f.printArea}`).join(', ')}: phần này còn file đang dùng chưa nằm trong retire`)
  }
  const inserts = ctx.files.map(f => ({ ...f, version: nextVersionFor(ctx.state, f.kind, f.printArea) }))
  const last = lastPrintError(ctx, retired, inserts)
  if (last) return last
  return { inserts, retire: retired, event: { type: 'ARTWORK', message: replaceEventMessage(inserts, goneText(retired), optionalText(ctx.input.eventMessage)) } }
}

export function planRetire(ctx: Ctx): CommitError | Plan {
  const wrong = stateError(ctx, 'retire')
  if (wrong) return wrong
  const retired = retiredRows(ctx)
  if (!Array.isArray(retired)) return retired
  const last = lastPrintError(ctx, retired, [])
  if (last) return last
  return { inserts: [], retire: retired, event: { type: 'ARTWORK', message: retireEventMessage(goneText(retired), optionalText(ctx.input.eventMessage)) } }
}

export function planRevert(ctx: Ctx): CommitError | Plan {
  const { state, input } = ctx
  const prints = state.artworks.filter(a => a.kind === 'PRINT')
  const foreign = prints.filter(a => a.source !== 'AUTO')
  if (state.status !== 'REVIEW' || state.readiness !== 'AUTO' || prints.length === 0 || foreign.length) {
    const why = foreign.length ? `có file in không phải tự động: ${foreign.map(a => `${partLabel(a)} (${a.source})`).join(', ')}`
      : prints.length === 0 ? 'không có file in tự động để gỡ' : `task đang ${state.status}/${state.readiness}`
    return refuse(409, 'wrong_state', `revert chỉ nhận task REVIEW/AUTO mà mọi file in đều tự động — ${why}`, state)
  }
  const retired = [...prints, ...state.artworks.filter(a => a.kind !== 'PRINT' && a.source === 'AUTO')]
  return {
    inserts: [],
    retire: retired,
    event: { type: 'SYSTEM', message: revertEventMessage(goneText(retired), optionalText(input.eventMessage)) },
    task: { status: 'NEW', readiness: input.revertReadiness ?? 'MANUAL', prevStatus: null },
    guardReadiness: 'AUTO',
  }
}

type LineRow = { id: string; kind: string; source: string; removedAt: Date | null; removedById: string | null }

/**
 * A revert re-sent after its answer was lost: the AUTO rows the machine saw (`expected.liveIds`) are all gone, removed by
 * no person, and the line holds no live AUTO print — a replace since then would have put one back.
 */
export function isRevertApplied(rows: LineRow[], input: CommitInput): boolean {
  const seen = rows.filter(r => input.expected.liveIds.includes(r.id) && r.source === 'AUTO')
  return seen.length > 0
    && seen.every(r => !!r.removedAt && r.removedById === null)
    && !rows.some(r => !r.removedAt && r.kind === 'PRINT' && r.source === 'AUTO')
}
