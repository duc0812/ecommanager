export type EntryStatus = 'EMPTY' | 'QUEUED' | 'PARSING' | 'NEEDS_FONTS' | 'NEEDS_REVIEW' | 'READY' | 'ERROR'
export const ENTRY_STATUSES: EntryStatus[] = ['EMPTY', 'QUEUED', 'PARSING', 'NEEDS_FONTS', 'NEEDS_REVIEW', 'READY', 'ERROR']
export type SlotStatus = EntryStatus | 'NO_TEMPLATE'
export type LibraryProductStatus = 'READY' | 'NO_MAPPING' | 'NO_TEMPLATE' | 'EMPTY' | 'ERROR' | 'NEEDS_FONTS' | 'NEEDS_REVIEW' | 'PARSING' | 'QUEUED'
export const LIBRARY_PRODUCT_STATUSES: LibraryProductStatus[] = ['NO_MAPPING', 'NO_TEMPLATE', 'EMPTY', 'ERROR', 'NEEDS_FONTS', 'NEEDS_REVIEW', 'PARSING', 'QUEUED', 'READY']

export function isLibraryProductStatus(v: string | null | undefined): v is LibraryProductStatus {
  return !!v && (LIBRARY_PRODUCT_STATUSES as string[]).includes(v)
}

export type FieldFit = 'shrink' | 'wrap' | 'none'
export const FIELD_FITS: FieldFit[] = ['shrink', 'wrap', 'none']
export type FieldAlign = 'left' | 'center' | 'right'
export type FieldAnchor = 'top' | 'center' | 'bottom'
export type Box = { x: number; y: number; w: number; h: number }

export type ArtworkField = {
  field: string; layer: string; area?: string; sample: string; font: string; sizePx: number; color: string
  align: FieldAlign; box: Box; anchor: FieldAnchor; tracking: number; leading?: number
  stroke?: { px: number; color: string }
  shadow?: { dx: number; dy: number; blur: number; color: string; opacity: number; spread?: number }
  scaleX?: number; charColors?: string[]; layers?: string[]
  fit: FieldFit; maxChars?: number
}

export type FixedText = { name: string; text: string; font: string }

export const CHECK_SCORE_MAX = 6

export class FieldValidationError extends Error {}

const ALIGNS: FieldAlign[] = ['left', 'center', 'right']
const ANCHORS: FieldAnchor[] = ['top', 'center', 'bottom']
const COLOR = /^#[0-9a-f]{6}$/i

function obj(v: unknown, where: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new FieldValidationError(`${where} phải là object`)
  return v as Record<string, unknown>
}

function num(v: unknown, where: string, opts: { min?: number; optional?: boolean } = {}): number | undefined {
  if (v === undefined || v === null) {
    if (opts.optional) return undefined
    throw new FieldValidationError(`${where} bắt buộc`)
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new FieldValidationError(`${where} phải là số`)
  if (opts.min !== undefined && v < opts.min) throw new FieldValidationError(`${where} phải ≥ ${opts.min}`)
  return v
}

function str(v: unknown, where: string, opts: { allowEmpty?: boolean; max?: number } = {}): string {
  if (typeof v !== 'string') throw new FieldValidationError(`${where} phải là chuỗi`)
  const s = v.trim()
  if (!s && !opts.allowEmpty) throw new FieldValidationError(`${where} bắt buộc`)
  if (s.length > (opts.max ?? 500)) throw new FieldValidationError(`${where} quá dài`)
  return s
}

function color(v: unknown, where: string): string {
  if (typeof v !== 'string' || !COLOR.test(v)) throw new FieldValidationError(`${where} phải dạng #rrggbb`)
  return v.toLowerCase()
}

function oneOf<T extends string>(v: unknown, list: T[], fallback: T | null, where: string): T {
  if ((v === undefined || v === null) && fallback !== null) return fallback
  if (!list.includes(v as T)) throw new FieldValidationError(`${where} phải là ${list.join(' | ')}`)
  return v as T
}

export function normalizeField(v: unknown, i: number): ArtworkField {
  const w = `fields[${i}]`
  const o = obj(v, w)
  const b = obj(o.box, `${w}.box`)
  const field: ArtworkField = {
    field: str(o.field, `${w}.field`, { max: 120 }),
    layer: str(o.layer, `${w}.layer`, { max: 255 }),
    sample: typeof o.sample === 'string' ? o.sample : '',
    font: str(o.font ?? '', `${w}.font`, { allowEmpty: true, max: 255 }),
    sizePx: num(o.sizePx, `${w}.sizePx`, { min: 0 }) as number,
    color: color(o.color, `${w}.color`),
    align: oneOf(o.align, ALIGNS, 'left', `${w}.align`),
    box: {
      x: num(b.x, `${w}.box.x`) as number, y: num(b.y, `${w}.box.y`) as number,
      w: num(b.w, `${w}.box.w`, { min: 0 }) as number, h: num(b.h, `${w}.box.h`, { min: 0 }) as number,
    },
    anchor: oneOf(o.anchor, ANCHORS, 'top', `${w}.anchor`),
    tracking: num(o.tracking, `${w}.tracking`, { optional: true }) ?? 0,
    fit: oneOf(o.fit, FIELD_FITS, 'shrink', `${w}.fit`),
  }
  if (typeof o.area === 'string' && o.area.trim()) field.area = o.area.trim()
  const leading = num(o.leading, `${w}.leading`, { optional: true })
  if (leading !== undefined) field.leading = leading
  if (o.stroke !== undefined && o.stroke !== null) {
    const s = obj(o.stroke, `${w}.stroke`)
    field.stroke = { px: num(s.px, `${w}.stroke.px`, { min: 0 }) as number, color: color(s.color, `${w}.stroke.color`) }
  }
  if (o.shadow !== undefined && o.shadow !== null) {
    const s = obj(o.shadow, `${w}.shadow`)
    field.shadow = {
      dx: num(s.dx, `${w}.shadow.dx`) as number, dy: num(s.dy, `${w}.shadow.dy`) as number,
      blur: num(s.blur, `${w}.shadow.blur`, { min: 0 }) as number, color: color(s.color, `${w}.shadow.color`),
      opacity: num(s.opacity, `${w}.shadow.opacity`, { min: 0 }) as number,
    }
    const spread = num(s.spread, `${w}.shadow.spread`, { optional: true })
    if (spread !== undefined) field.shadow.spread = spread
  }
  const scaleX = num(o.scaleX, `${w}.scaleX`, { optional: true })
  if (scaleX !== undefined) {
    if (scaleX <= 0) throw new FieldValidationError(`${w}.scaleX phải > 0`)
    field.scaleX = scaleX
  }
  if (o.charColors !== undefined && o.charColors !== null) {
    if (!Array.isArray(o.charColors) || o.charColors.length > 2000) throw new FieldValidationError(`${w}.charColors phải là danh sách màu`)
    field.charColors = o.charColors.map((c, j) => color(c, `${w}.charColors[${j}]`))
  }
  if (o.layers !== undefined && o.layers !== null) {
    if (!Array.isArray(o.layers) || o.layers.length > 100) throw new FieldValidationError(`${w}.layers phải là danh sách tên layer`)
    field.layers = o.layers.map((l, j) => str(l, `${w}.layers[${j}]`, { max: 255 }))
  }
  if (o.maxChars !== undefined && o.maxChars !== null) {
    if (typeof o.maxChars !== 'number' || !Number.isInteger(o.maxChars) || o.maxChars <= 0) throw new FieldValidationError(`${w}.maxChars phải là số nguyên dương`)
    field.maxChars = o.maxChars
  }
  return field
}

export function normalizeFields(v: unknown): ArtworkField[] {
  if (!Array.isArray(v)) throw new FieldValidationError('fields phải là danh sách')
  if (v.length > 200) throw new FieldValidationError('Quá nhiều trường')
  return v.map((f, i) => normalizeField(f, i))
}

export function normalizeFixedTexts(v: unknown): FixedText[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new FieldValidationError('fixedTexts phải là danh sách')
  return v.slice(0, 500).map((t, i) => {
    const o = obj(t, `fixedTexts[${i}]`)
    return {
      name: typeof o.name === 'string' ? o.name : '',
      text: typeof o.text === 'string' ? o.text.slice(0, 2000) : '',
      font: typeof o.font === 'string' ? o.font : '',
    }
  })
}

export function normalizeStrings(v: unknown, where: string, max = 200): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) throw new FieldValidationError(`${where} phải là danh sách chuỗi`)
  return Array.from(new Set((v as string[]).map(s => s.trim()).filter(Boolean))).slice(0, max)
}

function parseArray(json: string | null | undefined): unknown[] {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

export function parseFields(json: string | null | undefined): ArtworkField[] {
  const out: ArtworkField[] = []
  parseArray(json).forEach((f, i) => { try { out.push(normalizeField(f, i)) } catch {} })
  return out
}

export function parseFixedTexts(json: string | null | undefined): FixedText[] {
  try { return normalizeFixedTexts(parseArray(json)) } catch { return [] }
}

export function parseStrings(json: string | null | undefined): string[] {
  return parseArray(json).filter((x): x is string => typeof x === 'string')
}

export function resultStatus(r: { fields: ArtworkField[]; missingFonts: string[]; warnings: string[]; checkScore: number | null }): EntryStatus {
  if (r.missingFonts.length > 0) return 'NEEDS_FONTS'
  if (r.warnings.length > 0 || r.fields.length === 0) return 'NEEDS_REVIEW'
  return r.checkScore !== null && r.checkScore <= CHECK_SCORE_MAX ? 'READY' : 'NEEDS_REVIEW'
}

export function carryOverEdits(next: ArtworkField[], previous: ArtworkField[]): ArtworkField[] {
  if (previous.length === 0) return next
  const byLayer = new Map(previous.map(f => [f.layer, f]))
  return next.map(f => {
    const prev = byLayer.get(f.layer)
    if (!prev) return f
    const merged: ArtworkField = { ...f, field: prev.field, fit: prev.fit }
    if (prev.maxChars !== undefined) merged.maxChars = prev.maxChars
    else delete merged.maxChars
    return merged
  })
}

const SLOT_RANK: Record<LibraryProductStatus, number> = {
  NO_MAPPING: -1, NO_TEMPLATE: 0, EMPTY: 1, ERROR: 2, NEEDS_FONTS: 3, NEEDS_REVIEW: 4, PARSING: 5, QUEUED: 5, READY: 6,
}

export function productLibraryStatus(slots: SlotStatus[]): LibraryProductStatus {
  if (slots.length === 0) return 'EMPTY'
  if (slots.every(s => s === 'READY')) return 'READY'
  return slots.reduce<LibraryProductStatus>((worst, s) => (SLOT_RANK[s] < SLOT_RANK[worst] ? s : worst), 'READY')
}

export function productStatus(input: { active: SlotStatus[]; stale: SlotStatus[]; unmapped: number }): LibraryProductStatus {
  if (input.unmapped > 0) return 'NO_MAPPING'
  if (input.active.length > 0) return productLibraryStatus(input.active)
  if (input.stale.length > 0) return productLibraryStatus(input.stale)
  return 'NO_TEMPLATE'
}

export function normField(name: string): string {
  return name.toLowerCase().trim()
}
