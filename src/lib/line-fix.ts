/** Why a line its supplier already has is opened again for a design fix (owner 11/06/2026). The first one is the default. */
export const LINE_FIX_REASONS = ['Xưởng yêu cầu update design', 'Khách yêu cầu sửa', 'Nội bộ phát hiện lỗi'] as const
export type LineFixReason = (typeof LINE_FIX_REASONS)[number]
export const LINE_FIX_NOTE_MIN = 3
export const LINE_FIX_NOTE_MAX = 500
export const LINE_FIX_HELP = 'Chỉ mở lại dòng này. Dòng đã ghi sheet: duyệt lại xong không ghi sheet nữa — tool sẽ nói rõ cần báo xưởng xem lại folder cũ hay phải gửi xưởng link mới. Dòng gửi API: duyệt lại xong riêng dòng này quay về Duyệt sản xuất để gửi lại.'

export type LineFix = { reason: LineFixReason; note: string }

export function isLineFixReason(v: unknown): v is LineFixReason {
  return typeof v === 'string' && (LINE_FIX_REASONS as readonly string[]).includes(v)
}

export function parseLineFix(input: { reason?: unknown; note?: unknown }): LineFix | { error: string } {
  if (input.reason === undefined || input.reason === null || input.reason === '') return { error: 'Chọn lý do mở lại dòng' }
  if (!isLineFixReason(input.reason)) return { error: `Lý do không hợp lệ — chọn một trong: ${LINE_FIX_REASONS.join(', ')}` }
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (!note) return { error: 'Ghi "Cần sửa ở đâu" để designer biết chỗ cần sửa' }
  if (note.length < LINE_FIX_NOTE_MIN || note.length > LINE_FIX_NOTE_MAX) {
    return { error: `"Cần sửa ở đâu" dài từ ${LINE_FIX_NOTE_MIN} đến ${LINE_FIX_NOTE_MAX} ký tự (đang ${note.length})` }
  }
  return { reason: input.reason, note }
}

/** The event a reopen writes; the reason and the note are read back from it once the task fields are cleared by the approval. */
export const LINE_FIX_EVENT_PREFIX = 'Mở lại để sửa (đã gửi xưởng)'

export function lineFixMessage(fix: LineFix): string {
  return `${LINE_FIX_EVENT_PREFIX} — ${fix.reason}: ${fix.note}`
}

export function readLineFixMessage(message: string): LineFix | null {
  const head = `${LINE_FIX_EVENT_PREFIX} — `
  if (!message.startsWith(head)) return null
  const rest = message.slice(head.length)
  const reason = LINE_FIX_REASONS.find(r => rest.startsWith(`${r}: `))
  return reason ? { reason, note: rest.slice(reason.length + 2) } : null
}

/** A second event written with the reopen: the link the line carried, the one its supplier holds. */
export const HELD_LINK_PREFIX = 'Link xưởng đang giữ khi mở lại: '
const NO_HELD_LINK = '(không có)'

export function heldLinkMessage(link: string | null): string {
  return `${HELD_LINK_PREFIX}${link?.trim() || NO_HELD_LINK}`
}

export function readHeldLinkMessage(message: string): { link: string | null } | null {
  if (!message.startsWith(HELD_LINK_PREFIX)) return null
  const link = message.slice(HELD_LINK_PREFIX.length).trim()
  return { link: link && link !== NO_HELD_LINK ? link : null }
}

/** What staff do once a fix of a line delivered by a link is approved: nothing new to send, or a link the supplier never got. */
export type SupplierLinkKind = 'SAME_FOLDER' | 'NEW_LINK'
export const SUPPLIER_LINK_KINDS: SupplierLinkKind[] = ['SAME_FOLDER', 'NEW_LINK']
export const SUPPLIER_LINK_LABELS: Record<SupplierLinkKind, string> = { SAME_FOLDER: 'Link cũ vẫn đúng', NEW_LINK: 'Cần gửi link mới' }
const SAME_FOLDER_TAIL = ' xem lại folder design — link cũ vẫn đúng'

export function supplierLinkMessage(kind: SupplierLinkKind, supplierName: string): string {
  return kind === 'SAME_FOLDER' ? `Báo ${supplierName}${SAME_FOLDER_TAIL}` : `Gửi ${supplierName} LINK MỚI — link cũ không có file đã sửa`
}

/** The fix is not all in the task's Drive folder yet (still on this server, or the folder lacks a part): "Đã báo xưởng" waits. */
export const FIX_NOT_IN_FOLDER_MESSAGE = 'File đã sửa chưa nằm đủ trong folder Drive của task — chưa báo xưởng được. Tải lại sau khi file lên Drive.'

export function readSupplierLinkKind(message: string): SupplierLinkKind {
  return message.startsWith('Báo ') && message.endsWith(SAME_FOLDER_TAIL) ? 'SAME_FOLDER' : 'NEW_LINK'
}
