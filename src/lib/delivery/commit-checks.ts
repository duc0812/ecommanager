import { prisma } from '@/lib/db'
import { printFileFit } from '@/lib/print-file-fit'
import type { TemplateRow } from '@/lib/print-template-resolve'
import { partKey, sameLabel } from '@/lib/task-files'
import type { DeliveryDrive } from '@/lib/delivery/drive'
import type { CommitError, CommitInput, DeliveryFile, TaskState } from '@/lib/delivery/types'

export function refuse(httpStatus: CommitError['httpStatus'], code: string, error: string, current?: TaskState): CommitError {
  return { ok: false, error, code, httpStatus, ...(current ? { current } : {}) }
}

export const staleRefusal = (current: TaskState) =>
  refuse(409, 'stale', 'Task đã đổi từ lúc máy đọc trạng thái — đọc lại rồi gửi lại', current)

export const driveBusyRefusal = (err: Error) => refuse(503, 'busy', `Google Drive đang chậm hoặc quá tải — thử lại sau: ${err.message}`)

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const isPx = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && Number.isInteger(v) && v > 0)
const isOptional = (v: unknown, ok: (x: unknown) => boolean) => v === undefined || v === null || ok(v)

export function inputError(input: CommitInput): CommitError | null {
  const bad = (msg: string) => refuse(400, 'bad_request', msg)
  if (!input || typeof input !== 'object') return bad('Thiếu nội dung yêu cầu')
  if (!['push', 'replace', 'retire', 'revert'].includes(input.action)) return bad(`Action không hợp lệ: ${String(input.action)}`)
  if (!input.expected || typeof input.expected.status !== 'string' || !Array.isArray(input.expected.liveIds)
    || !input.expected.liveIds.every(id => typeof id === 'string')) return bad('Thiếu expected { status, liveIds }')
  if (!Array.isArray(input.files) || !Array.isArray(input.retire ?? [])) return bad('files và retire phải là danh sách')
  if (!isOptional(input.eventMessage, x => typeof x === 'string')) return bad('eventMessage phải là chuỗi')
  if (!isOptional(input.dryRun, x => typeof x === 'boolean')) return bad('dryRun phải là true/false')
  if (!isOptional(input.allowFinished, x => typeof x === 'boolean')) return bad('allowFinished phải là true/false')
  if (!isOptional(input.approve, x => typeof x === 'boolean')) return bad('approve phải là true/false')
  if (input.approve && input.action !== 'push' && input.action !== 'replace') return bad('approve chỉ dùng với push hoặc replace')
  if (!isOptional(input.retireSources, x => Array.isArray(x) && x.every(s => s === 'AUTO' || s === 'MANUAL'))) return bad('retireSources chỉ nhận AUTO, MANUAL')
  if (!isOptional(input.revertReadiness, x => x === 'MANUAL' || x === 'LOW')) return bad('revertReadiness chỉ nhận MANUAL hoặc LOW')
  const retire = input.retire ?? []
  if (!retire.every(id => isText(id))) return bad('retire phải là danh sách mã file')
  if (new Set(retire).size !== retire.length) return bad('retire có mã file lặp lại')
  const parts = new Set<string>()
  const ids = new Set<string>()
  for (const f of input.files) {
    if (!f || (f.kind !== 'PRINT' && f.kind !== 'MOCKUP')) return bad('File thiếu kind PRINT hoặc MOCKUP')
    if (!isText(f.printArea) || !isText(f.fileName) || !isText(f.driveFileId) || !isText(f.mimeType)) return bad('File thiếu printArea, fileName, driveFileId hoặc mimeType')
    if (!Number.isInteger(f.size) || f.size <= 0) return bad(`${f.printArea}: size phải là số byte`)
    if (!isPx(f.widthPx) || !isPx(f.heightPx)) return bad(`${f.printArea}: widthPx/heightPx phải là số px hoặc null`)
    if (!isOptional(f.shortcutOf, isText)) return bad(`${f.printArea}: shortcutOf phải là mã file Drive hoặc null`)
    if (f.shortcutOf && f.kind !== 'PRINT') return refuse(400, 'bad_shortcut', `${f.printArea}: lối tắt chỉ dùng cho file in`)
    const key = `${f.kind}/${partKey(f.printArea)}`
    if (parts.has(key)) return bad(`Hai file cho cùng phần ${f.kind} ${f.printArea}`)
    parts.add(key)
    if (ids.has(f.driveFileId)) return refuse(400, 'duplicate_file', `File ${f.driveFileId} được gửi hai lần`)
    ids.add(f.driveFileId)
  }
  const files = input.files.length
  if (input.action === 'push') {
    if (files === 0) return bad('push cần ít nhất một file')
    if (retire.length > 0) return bad('push không gỡ file — dùng replace')
  }
  if (input.action === 'replace') {
    if (files === 0) return bad('replace cần ít nhất một file — chỉ gỡ thì dùng retire')
  }
  if (input.action === 'retire') {
    if (files > 0) return bad('retire không nhận file — thay file thì dùng replace')
    if (retire.length === 0) return bad('retire cần ít nhất một mã file')
  }
  if (input.action === 'revert' && (files > 0 || retire.length > 0)) return bad('revert tự gỡ mọi file tự động — không gửi files hay retire')
  return null
}

type LineRow = { id: string; kind: string; printArea: string; driveFileId: string | null; removedAt: Date | null }

/** A re-sent commit whose files are all live at their parts and whose retired rows are all gone; checked before `expected`. */
export function isAlreadyApplied(rows: LineRow[], input: CommitInput): boolean {
  const retire = input.retire ?? []
  if (input.files.length + retire.length === 0) return false
  const live = rows.filter(r => !r.removedAt)
  return input.files.every(f => live.some(r => r.driveFileId === f.driveFileId && r.kind === f.kind && sameLabel(r.printArea, f.printArea)))
    && retire.every(id => rows.some(r => r.id === id && !!r.removedAt))
}

export function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const x = [...a].sort(), y = [...b].sort()
  return x.every((id, i) => id === y[i])
}

export function isStale(state: TaskState, expected: CommitInput['expected']): boolean {
  return expected.status !== state.status || !sameIds(expected.liveIds, state.artworks.map(a => a.id))
}

export function duplicateFileError(state: TaskState, files: DeliveryFile[]): CommitError | null {
  const hit = files.find(f => state.artworks.some(a => a.driveFileId === f.driveFileId))
  return hit ? refuse(400, 'duplicate_file', `${hit.printArea}: file ${hit.driveFileId} đã là file đang dùng của dòng này`) : null
}

const DRIVE_ID_CHAR = /[A-Za-z0-9_-]/

/** The Drive id appears in a stored link as a whole id, not as part of a longer one. */
export function linkHoldsFileId(link: string, id: string): boolean {
  for (let at = link.indexOf(id); at >= 0; at = link.indexOf(id, at + 1)) {
    const before = link[at - 1]
    const after = link[at + id.length]
    if ((!before || !DRIVE_ID_CHAR.test(before)) && (!after || !DRIVE_ID_CHAR.test(after))) return true
  }
  return false
}

/** A file the design library links to (SkuSupplierDesign.designLink), whether or not any order line has a row for it. */
export async function inDesignLibrary(driveFileId: string): Promise<boolean> {
  const rows = await prisma.skuSupplierDesign.findMany({ where: { designLink: { contains: driveFileId } }, select: { designLink: true } })
  return rows.some(r => !!r.designLink && linkHoldsFileId(r.designLink, driveFileId))
}

async function isShortcutTarget(driveFileId: string, line: { orderId: string; shopifyLineId: string }): Promise<boolean> {
  const live = await prisma.designArtwork.findFirst({
    where: { driveFileId, kind: 'PRINT', removedAt: null, NOT: { orderId: line.orderId, shopifyLineId: line.shopifyLineId } }, select: { id: true },
  })
  return !!live || inDesignLibrary(driveFileId)
}

/**
 * Every file must be on Drive, not trashed, the size the machine sent, and in the incoming or task folder; a shortcut points at
 * another line's live print or at a file of the design library.
 */
export async function driveFileError(files: DeliveryFile[], state: TaskState, line: { orderId: string; shopifyLineId: string }, drive: DeliveryDrive): Promise<CommitError | null> {
  for (const f of files) {
    if (f.shortcutOf) {
      if (f.driveFileId !== f.shortcutOf) return refuse(400, 'bad_shortcut', `${f.printArea}: driveFileId phải trùng shortcutOf`)
      if (!(await isShortcutTarget(f.shortcutOf, line))) {
        return refuse(400, 'bad_shortcut', `${f.printArea}: file gốc ${f.shortcutOf} không phải file in đang dùng của dòng đơn khác hay file của thư viện design`)
      }
    }
    const info = await drive.fileInfo(f.driveFileId)
    if (!info || info.trashed) return refuse(400, 'drive_missing', `${f.printArea}: không thấy file ${f.driveFileId} trên Drive hoặc file đã vào thùng rác`)
    if (info.size !== f.size) return refuse(400, 'size_mismatch', `${f.printArea}: file trên Drive ${info.size} byte, máy gửi ${f.size} byte`)
    if (!f.shortcutOf && !info.parents.some(p => p === state.incomingFolder.id || p === state.folder.id)) {
      return refuse(400, 'wrong_folder', `${f.printArea}: file ${f.driveFileId} không nằm trong thư mục chờ hay thư mục task`)
    }
  }
  return null
}

/** A print whose part names no slot of the line's template is written anyway, with a warning. */
export function slotWarnings(template: TemplateRow | null, slots: string[], files: DeliveryFile[]): string[] {
  if (!template) return []
  return files.filter(f => f.kind === 'PRINT' && !slots.some(s => sameLabel(s, f.printArea))).map(f => `Phần ${f.printArea} không có trong template`)
}

function usDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { timeZone: 'UTC', month: '2-digit', day: '2-digit', year: 'numeric' })
}

const oldLayout = (area: string, w: number | string, h: number | string, label: string, until: string) =>
  refuse(400, 'old_layout', `${area}: ${w}×${h} px là layout cũ "${label}" của template (chỉ nhận file làm tới ${usDate(until)}) — render lại theo layout mới`)

/**
 * A print sized to a template layout that expired (`filesUntil`) is refused; so is a set whose part names make the line's view
 * an expired alternative set (its areas would pass by size alone). Any other size mismatch only warns, as the old push did.
 */
export function layoutCheck(raw: TemplateRow | null, view: TemplateRow | null, files: DeliveryFile[], now: Date): { error: CommitError | null; warnings: string[] } {
  const warnings: string[] = []
  if (!raw) return { error: null, warnings }
  const prints = files.filter(f => f.kind === 'PRINT')
  if (view?.areaSet) {
    const set = raw.altSets.find(s => s.areas === view.areas) ?? raw.altSets.find(s => s.label === view.areaSet)
    const hit = set?.filesUntil && new Date(set.filesUntil).getTime() < now.getTime()
      ? prints.find(f => set.areas.some(a => sameLabel(a.name, f.printArea))) : undefined
    if (set?.filesUntil && hit) return { error: oldLayout(hit.printArea, hit.widthPx ?? '?', hit.heightPx ?? '?', set.label, set.filesUntil), warnings }
  }
  for (const f of prints) {
    if (!f.widthPx || !f.heightPx) continue
    const size = { widthPx: f.widthPx, heightPx: f.heightPx }
    if (printFileFit(raw, f.printArea, { ...size, createdAt: now }).state === 'bad') {
      const old = raw.altSets.find(s => s.filesUntil && printFileFit(raw, f.printArea, { ...size, createdAt: s.filesUntil }).state === 'ok')
      if (old?.filesUntil) return { error: oldLayout(f.printArea, f.widthPx, f.heightPx, old.label, old.filesUntil), warnings }
    }
    const fit = printFileFit(view ?? raw, f.printArea, { ...size, createdAt: now })
    if (fit.state === 'bad') warnings.push(`${f.printArea}: ${f.widthPx}×${f.heightPx} px, template cần ${fit.expected.w}×${fit.expected.h} px — vẫn ghi`)
  }
  return { error: null, warnings }
}
