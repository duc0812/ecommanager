export const OTHER_REASON_LABEL = 'Lý do khác'
export const OTHER_REASON_PREFIX = 'Khác: '
export const OTHER_REASON_MIN = 3
export const OTHER_REASON_MAX = 200

const OTHER_ERROR = 'Lý do khác dài từ 3 đến 200 ký tự'

export function isOtherReason(reason: string): boolean {
  return reason.startsWith('Khác:')
}

export function rejectSelection(picked: string[], otherOn: boolean, otherText: string): { reasons: string[]; error: string | null } {
  const reasons = [...picked]
  if (otherOn) {
    const text = otherText.trim()
    if (text.length < OTHER_REASON_MIN || text.length > OTHER_REASON_MAX) return { reasons, error: OTHER_ERROR }
    reasons.push(`${OTHER_REASON_PREFIX}${text}`)
  }
  return { reasons, error: reasons.length === 0 ? 'Chọn ít nhất một lý do' : null }
}

export function otherReasonError(otherOn: boolean, otherText: string, touched: boolean): string | null {
  if (!otherOn || !touched) return null
  const len = otherText.trim().length
  return len < OTHER_REASON_MIN || len > OTHER_REASON_MAX ? OTHER_ERROR : null
}

export function rejectReasonsError(reasons: string[]): string | null {
  for (const r of reasons) {
    if (!isOtherReason(r)) continue
    const len = r.slice('Khác:'.length).trim().length
    if (len < OTHER_REASON_MIN || len > OTHER_REASON_MAX) return OTHER_ERROR
  }
  return null
}

export function rejectReasonBucket(reason: string): string {
  return isOtherReason(reason) ? OTHER_REASON_LABEL : reason
}
