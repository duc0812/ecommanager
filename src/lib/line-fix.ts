/** Why a line its supplier already has is opened again for a design fix (owner 11/06/2026). The first one is the default. */
export const LINE_FIX_REASONS = ['Xưởng yêu cầu update design', 'Khách yêu cầu sửa', 'Nội bộ phát hiện lỗi'] as const
export type LineFixReason = (typeof LINE_FIX_REASONS)[number]
export const LINE_FIX_NOTE_MIN = 3
export const LINE_FIX_NOTE_MAX = 500
export const LINE_FIX_HELP = 'Chỉ mở lại dòng này. Dòng đã ghi sheet: duyệt lại xong chỉ cần báo xưởng xem lại folder, không ghi sheet nữa. Dòng gửi API: duyệt lại xong riêng dòng này quay về Duyệt sản xuất để gửi lại.'

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
