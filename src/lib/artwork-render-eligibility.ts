import { normField } from '@/lib/artwork-fields'
import type { TaskLibraryState } from '@/lib/artwork-library-types'

export type RenderJobStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED'

export type RenderJobView = {
  id: string; status: RenderJobStatus; attempts: number; error: string | null
  createdAt: string; finishedAt: string | null; artworkId: string | null; printArea: string | null
}

export type AutoRenderInput = {
  taskStatus: string
  hasTemplate: boolean
  slots: string[]
  library: Pick<TaskLibraryState, 'entryId' | 'status' | 'layers'> | null
  personalization: { key: string; value: string }[]
  job: Pick<RenderJobView, 'status'> | null
}

export type AutoRenderEligibility = { ok: boolean; busy: boolean; reason: string | null; fields: string[]; missing: string[] }

const CLOSED = ['DONE', 'CANCELLED']
const STATUS_LABEL: Record<string, string> = {
  NONE: 'chưa có', EMPTY: 'chưa có PSD', QUEUED: 'đang chờ đọc PSD', PARSING: 'đang đọc PSD', NEEDS_FONTS: 'thiếu font',
  NEEDS_REVIEW: 'chờ duyệt', ERROR: 'đọc PSD lỗi',
}

export function renderFields(library: Pick<TaskLibraryState, 'layers'> | null): string[] {
  const seen = new Map<string, string>()
  for (const l of library?.layers ?? []) if (!seen.has(normField(l.field))) seen.set(normField(l.field), l.field)
  return Array.from(seen.values())
}

/** Customer value for each artwork field, matched by name (case and spacing ignored). Empty values count as missing. */
export function customerValues(fields: string[], personalization: { key: string; value: string }[]): Record<string, string> {
  const byKey = new Map<string, string>()
  for (const p of personalization) {
    const k = normField(p.key)
    if (!byKey.has(k) && p.value.trim()) byKey.set(k, p.value.trim())
  }
  const out: Record<string, string> = {}
  for (const f of fields) {
    const v = byKey.get(normField(f))
    if (v !== undefined) out[f] = v
  }
  return out
}

export function autoRenderEligibility(input: AutoRenderInput): AutoRenderEligibility {
  const fields = renderFields(input.library)
  const values = customerValues(fields, input.personalization)
  const missing = fields.filter(f => values[f] === undefined)
  const no = (reason: string, busy = false): AutoRenderEligibility => ({ ok: false, busy, reason, fields, missing })
  if (CLOSED.includes(input.taskStatus)) return no('Task đã đóng')
  if (!input.hasTemplate) return no('Dòng chưa có template in')
  if (input.slots.length === 0) return no('Template không có vùng in')
  if (!input.library?.entryId) return no('Chưa có artwork gốc cho template này')
  if (input.library.status !== 'READY') return no(`Artwork gốc chưa sẵn sàng (${STATUS_LABEL[input.library.status] ?? input.library.status})`)
  if (input.job && (input.job.status === 'QUEUED' || input.job.status === 'RUNNING')) return no('Đang dựng file in…', true)
  if (missing.length > 0) return no(`Khách chưa điền: ${missing.join(', ')}`)
  return { ok: true, busy: false, reason: null, fields, missing }
}
