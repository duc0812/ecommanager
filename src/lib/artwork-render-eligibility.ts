import { normField as baseNormField } from '@/lib/artwork-fields'

const normField = (name: string) => baseNormField(name).replace(/[:：?？\s]+$/, '')
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
  teeinblue?: boolean
}

/** A Teeinblue line keeps the customer's picks in `_tb_design`, a reference to a design this tool cannot render. */
const TEEINBLUE_DESIGN_KEY = '_tb_design'
export const TEEINBLUE_REASON = 'Thiết kế Teeinblue — không dựng tự động được, làm tay'

export function hasTeeinblueDesign(attrs: { key: string }[]): boolean {
  return attrs.some(a => a.key === TEEINBLUE_DESIGN_KEY)
}

export type AutoRenderEligibility = { ok: boolean; busy: boolean; reason: string | null; fields: string[]; missing: string[]; noName: boolean }

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

const NO_ANSWERS = new Set(['no', '0', 'false', 'không'])
const WORD_SWITCH_ANSWERS = new Set(['no', 'false', 'không', 'yes', 'true', 'có'])

/** Customer value for each artwork field, matched by name (case, spacing and a trailing colon ignored). Empty values and Yes/No switch answers count as missing. */
export function customerValues(fields: string[], personalization: { key: string; value: string }[]): Record<string, string> {
  const numericFields = new Set(fields.filter(f => /(?:number|số)/i.test(f)).map(normField))
  const byKey = new Map<string, string>()
  for (const p of personalization) {
    const k = normField(p.key)
    const v = p.value.trim()
    const lower = v.toLowerCase()
    const isSwitch = WORD_SWITCH_ANSWERS.has(lower) || ((lower === '0' || lower === '1') && !numericFields.has(k))
    if (!byKey.has(k) && v && !isSwitch) byKey.set(k, v)
  }
  const out: Record<string, string> = {}
  for (const f of fields) {
    const v = byKey.get(normField(f))
    if (v !== undefined) out[f] = v
  }
  return out
}

/** The customer answered the name switch with No: the line is printed without a name. The switch is the "Custom Name: Yes Or No?" question or a property named like the field itself ("Custom Name:" = No). Callers only honour it when no field value was typed — a typed name beats a stray No (Customall can send the switch twice). */
export function noNameRequested(personalization: { key: string; value: string }[], fields: string[] = []): boolean {
  const fieldKeys = new Set(fields.map(normField))
  return personalization.some(p => {
    if (!NO_ANSWERS.has(p.value.trim().toLowerCase())) return false
    const key = p.key.replace(/^_+/, '')
    return /yes\s*or\s*no/i.test(key) || fieldKeys.has(normField(key))
  })
}

export function renderPersonalization(library: Pick<TaskLibraryState, 'layers'> | null, personalization: { key: string; value: string }[]) {
  const fields = renderFields(library)
  const values = customerValues(fields, personalization)
  const empty = Object.keys(values).length === 0
  const explicitNo = empty && noNameRequested(personalization, fields)
  const keys = new Set(fields.map(normField))
  const explicitYes = personalization.some(p => {
    const key = p.key.replace(/^_+/, '')
    return ['yes', 'true', '1', 'có'].includes(p.value.trim().toLowerCase()) && (/yes\s*or\s*no/i.test(key) || keys.has(normField(key)))
  })
  // Missing values stay required by default; only explicitly optional fields may print blank.
  const required = fields.filter(f => explicitYes || (library?.layers ?? []).some(l => normField(l.field) === normField(f) && l.required !== false))
  const missing = explicitNo ? [] : required.filter(f => values[f] === undefined)
  const noName = empty && (explicitNo || (!explicitYes && fields.length > 0 && missing.length === 0))
  return { fields, values, missing, noName }
}

export function autoRenderEligibility(input: AutoRenderInput): AutoRenderEligibility {
  const { fields, missing, noName } = renderPersonalization(input.library, input.personalization)
  const no = (reason: string, busy = false): AutoRenderEligibility => ({ ok: false, busy, reason, fields, missing, noName })
  if (CLOSED.includes(input.taskStatus)) return no('Task đã đóng')
  if (input.teeinblue) return no(TEEINBLUE_REASON)
  if (!input.hasTemplate) return no('Dòng chưa có template in')
  if (input.slots.length === 0) return no('Template không có vùng in')
  if (!input.library?.entryId) return no('Chưa có artwork gốc cho template này')
  if (input.library.status !== 'READY') return no(`Artwork gốc chưa sẵn sàng (${STATUS_LABEL[input.library.status] ?? input.library.status})`)
  if (input.job && (input.job.status === 'QUEUED' || input.job.status === 'RUNNING')) return no('Đang dựng file in…', true)
  if (missing.length > 0) return no(`Khách chưa điền: ${missing.join(', ')}`)
  return { ok: true, busy: false, reason: null, fields, missing, noName }
}
