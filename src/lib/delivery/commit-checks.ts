import { prisma } from '@/lib/db'
import { printFileFit } from '@/lib/print-file-fit'
import type { TemplateRow } from '@/lib/print-template-resolve'
import type { DeliveryDrive } from '@/lib/delivery/drive'
import type { CommitError, CommitInput, DeliveryFile, TaskState } from '@/lib/delivery/types'

export const SUPPORTED_ACTIONS: CommitInput['action'][] = ['push']

export function refuse(httpStatus: CommitError['httpStatus'], code: string, error: string, current?: TaskState): CommitError {
  return { ok: false, error, code, httpStatus, ...(current ? { current } : {}) }
}

export const staleRefusal = (current: TaskState) =>
  refuse(409, 'stale', 'Task đã đổi từ lúc máy đọc trạng thái — đọc lại rồi gửi lại', current)

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

export function inputError(input: CommitInput): CommitError | null {
  const bad = (msg: string) => refuse(400, 'bad_request', msg)
  if (!input || typeof input !== 'object') return bad('Thiếu nội dung yêu cầu')
  if (!['push', 'replace', 'retire', 'revert'].includes(input.action)) return bad(`Action không hợp lệ: ${String(input.action)}`)
  if (!SUPPORTED_ACTIONS.includes(input.action)) return refuse(400, 'unsupported_action', `Action ${input.action} chưa hỗ trợ`)
  if (!input.expected || typeof input.expected.status !== 'string' || !Array.isArray(input.expected.liveIds)) return bad('Thiếu expected { status, liveIds }')
  if (!Array.isArray(input.files) || !Array.isArray(input.retire ?? [])) return bad('files và retire phải là danh sách')
  const seen = new Set<string>()
  for (const f of input.files) {
    if (!f || (f.kind !== 'PRINT' && f.kind !== 'MOCKUP')) return bad('File thiếu kind PRINT hoặc MOCKUP')
    if (!isText(f.printArea) || !isText(f.fileName) || !isText(f.driveFileId) || !isText(f.mimeType)) return bad('File thiếu printArea, fileName, driveFileId hoặc mimeType')
    if (!Number.isInteger(f.size) || f.size <= 0) return bad(`${f.printArea}: size phải là số byte`)
    const key = `${f.kind}/${f.printArea}`
    if (seen.has(key)) return bad(`Hai file cho cùng phần ${key}`)
    seen.add(key)
  }
  if (input.action === 'push') {
    if (input.files.length === 0) return bad('push cần ít nhất một file')
    if ((input.retire ?? []).length > 0) return bad('push không gỡ file — dùng replace')
  }
  return null
}

type LineRow = { id: string; kind: string; printArea: string; driveFileId: string | null; removedAt: Date | null }

/** A re-sent commit whose files are all live at their parts and whose retired rows are all gone; checked before `expected`. */
export function isAlreadyApplied(rows: LineRow[], input: CommitInput): boolean {
  const retire = input.retire ?? []
  if (input.files.length + retire.length === 0) return false
  const live = rows.filter(r => !r.removedAt)
  return input.files.every(f => live.some(r => r.driveFileId === f.driveFileId && r.kind === f.kind && r.printArea === f.printArea))
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

/** Every file must be on Drive, not trashed, the size the machine sent, and in the incoming or task folder; a shortcut points at another line's live print. */
export async function driveFileError(files: DeliveryFile[], state: TaskState, line: { orderId: string; shopifyLineId: string }, drive: DeliveryDrive): Promise<CommitError | null> {
  for (const f of files) {
    if (f.shortcutOf) {
      if (f.driveFileId !== f.shortcutOf) return refuse(400, 'bad_shortcut', `${f.printArea}: driveFileId phải trùng shortcutOf`)
      const target = await prisma.designArtwork.findFirst({
        where: { driveFileId: f.shortcutOf, kind: 'PRINT', removedAt: null, NOT: { orderId: line.orderId, shopifyLineId: line.shopifyLineId } }, select: { id: true },
      })
      if (!target) return refuse(400, 'bad_shortcut', `${f.printArea}: file gốc ${f.shortcutOf} không phải file in đang dùng của dòng đơn khác`)
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

function usDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { timeZone: 'UTC', month: '2-digit', day: '2-digit', year: 'numeric' })
}

/** A print sized to a template layout that expired (`filesUntil`) is refused; any other size mismatch only warns, as the old push did. */
export function layoutCheck(template: TemplateRow | null, files: DeliveryFile[], now: Date): { error: CommitError | null; warnings: string[] } {
  const warnings: string[] = []
  if (!template) return { error: null, warnings }
  for (const f of files) {
    if (f.kind !== 'PRINT' || !f.widthPx || !f.heightPx) continue
    const size = { widthPx: f.widthPx, heightPx: f.heightPx }
    const fit = printFileFit(template, f.printArea, { ...size, createdAt: now })
    if (fit.state !== 'bad') continue
    const old = template.altSets.find(s => s.filesUntil && printFileFit(template, f.printArea, { ...size, createdAt: s.filesUntil }).state === 'ok')
    if (old?.filesUntil) {
      return {
        error: refuse(400, 'old_layout', `${f.printArea}: ${f.widthPx}×${f.heightPx} px là layout cũ "${old.label}" của template (chỉ nhận file làm tới ${usDate(old.filesUntil)}) — render lại theo layout mới`),
        warnings,
      }
    }
    warnings.push(`${f.printArea}: ${f.widthPx}×${f.heightPx} px, template cần ${fit.expected.w}×${fit.expected.h} px — vẫn ghi`)
  }
  return { error: null, warnings }
}
