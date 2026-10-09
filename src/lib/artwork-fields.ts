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
  gradient?: FieldGradient; bevel?: FieldBevel
  fit: FieldFit; maxChars?: number
}

export type GradientStop = { pos: number; color: string; mid: number }
export type GradientAlphaStop = { pos: number; opacity: number; mid: number }
export type FieldGradient = {
  type: 'linear'; angle: number; scale: number; offset: { x: number; y: number }; align: boolean; reverse: boolean
  opacity: number; interpolation: GradientInterpolation; smoothness: number; stops: GradientStop[]
  alphaStops?: GradientAlphaStop[]; frame?: Box
}
export type GradientInterpolation = 'perceptual' | 'linear' | 'classic'
export type BevelBlendMode = 'normal' | 'screen' | 'multiply' | 'linearDodge' | 'overlay'
export type BevelLight = { color: string; opacity: number; mode: BevelBlendMode }
export type FieldBevel = {
  technique: 'smooth' | 'chiselHard' | 'chiselSoft'; depth: number; direction: 'up' | 'down'; size: number; soften: number
  angle: number; altitude: number; contour?: [number, number][]; highlight: BevelLight; shadow: BevelLight
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
  if (o.gradient !== undefined && o.gradient !== null) field.gradient = normalizeGradient(o.gradient, `${w}.gradient`)
  if (o.bevel !== undefined && o.bevel !== null) field.bevel = normalizeBevel(o.bevel, `${w}.bevel`)
  if (o.maxChars !== undefined && o.maxChars !== null) {
    if (typeof o.maxChars !== 'number' || !Number.isInteger(o.maxChars) || o.maxChars <= 0) throw new FieldValidationError(`${w}.maxChars phải là số nguyên dương`)
    field.maxChars = o.maxChars
  }
  return field
}

const INTERPOLATIONS: GradientInterpolation[] = ['perceptual', 'linear', 'classic']
const BEVEL_MODES: BevelBlendMode[] = ['normal', 'screen', 'multiply', 'linearDodge', 'overlay']
const TECHNIQUES: FieldBevel['technique'][] = ['smooth', 'chiselHard', 'chiselSoft']

function unit(v: unknown, where: string): number {
  const n = num(v, where, { min: 0 }) as number
  if (n > 1) throw new FieldValidationError(`${where} phải trong 0–1`)
  return n
}

function normalizeGradient(v: unknown, w: string): FieldGradient {
  const o = obj(v, w)
  if (o.type !== 'linear') throw new FieldValidationError(`${w}.type chỉ hỗ trợ linear`)
  const off = obj(o.offset ?? { x: 0, y: 0 }, `${w}.offset`)
  if (!Array.isArray(o.stops) || o.stops.length < 1 || o.stops.length > 64) throw new FieldValidationError(`${w}.stops phải có 1–64 điểm màu`)
  const g: FieldGradient = {
    type: 'linear',
    angle: num(o.angle ?? 0, `${w}.angle`) as number,
    scale: num(o.scale ?? 100, `${w}.scale`, { min: 0 }) as number,
    offset: { x: num(off.x ?? 0, `${w}.offset.x`) as number, y: num(off.y ?? 0, `${w}.offset.y`) as number },
    align: o.align !== false,
    reverse: o.reverse === true,
    opacity: unit(o.opacity ?? 1, `${w}.opacity`),
    interpolation: oneOf(o.interpolation, INTERPOLATIONS, 'classic', `${w}.interpolation`),
    smoothness: unit(o.smoothness ?? 0, `${w}.smoothness`),
    stops: o.stops.map((s, j) => {
      const x = obj(s, `${w}.stops[${j}]`)
      return { pos: unit(x.pos, `${w}.stops[${j}].pos`), color: color(x.color, `${w}.stops[${j}].color`), mid: unit(x.mid ?? 0.5, `${w}.stops[${j}].mid`) }
    }),
  }
  if (o.alphaStops !== undefined && o.alphaStops !== null) {
    if (!Array.isArray(o.alphaStops) || o.alphaStops.length > 64) throw new FieldValidationError(`${w}.alphaStops phải là danh sách`)
    g.alphaStops = o.alphaStops.map((s, j) => {
      const x = obj(s, `${w}.alphaStops[${j}]`)
      return { pos: unit(x.pos, `${w}.alphaStops[${j}].pos`), opacity: unit(x.opacity, `${w}.alphaStops[${j}].opacity`), mid: unit(x.mid ?? 0.5, `${w}.alphaStops[${j}].mid`) }
    })
  }
  if (o.frame !== undefined && o.frame !== null) {
    const f = obj(o.frame, `${w}.frame`)
    g.frame = { x: num(f.x, `${w}.frame.x`) as number, y: num(f.y, `${w}.frame.y`) as number, w: num(f.w, `${w}.frame.w`, { min: 0 }) as number, h: num(f.h, `${w}.frame.h`, { min: 0 }) as number }
  }
  return g
}

function normalizeLight(v: unknown, w: string, mode: BevelBlendMode): BevelLight {
  const o = obj(v, w)
  return { color: color(o.color, `${w}.color`), opacity: unit(o.opacity ?? 0.75, `${w}.opacity`), mode: oneOf(o.mode, BEVEL_MODES, mode, `${w}.mode`) }
}

function normalizeBevel(v: unknown, w: string): FieldBevel {
  const o = obj(v, w)
  const b: FieldBevel = {
    technique: oneOf(o.technique, TECHNIQUES, 'smooth', `${w}.technique`),
    depth: num(o.depth ?? 100, `${w}.depth`, { min: 0 }) as number,
    direction: oneOf(o.direction, ['up', 'down'], 'up', `${w}.direction`),
    size: num(o.size ?? 0, `${w}.size`, { min: 0 }) as number,
    soften: num(o.soften ?? 0, `${w}.soften`, { min: 0 }) as number,
    angle: num(o.angle ?? 120, `${w}.angle`) as number,
    altitude: num(o.altitude ?? 30, `${w}.altitude`) as number,
    highlight: normalizeLight(o.highlight, `${w}.highlight`, 'screen'),
    shadow: normalizeLight(o.shadow, `${w}.shadow`, 'multiply'),
  }
  if (o.contour !== undefined && o.contour !== null) {
    if (!Array.isArray(o.contour) || o.contour.length < 2 || o.contour.length > 64) throw new FieldValidationError(`${w}.contour phải có 2–64 điểm`)
    b.contour = o.contour.map((p, j) => {
      if (!Array.isArray(p) || p.length !== 2) throw new FieldValidationError(`${w}.contour[${j}] phải là [x, y]`)
      return [num(p[0], `${w}.contour[${j}][0]`, { min: 0 }) as number, num(p[1], `${w}.contour[${j}][1]`, { min: 0 }) as number]
    })
  }
  return b
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

export type LayerFields = Record<string, string>

export function normalizeLayerFields(v: unknown): LayerFields {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new FieldValidationError('layerFields phải là object {tên layer: tên trường}')
  const entries = Object.entries(v as Record<string, unknown>)
  if (entries.length > 200) throw new FieldValidationError('layerFields quá nhiều layer')
  const out: LayerFields = {}
  for (const [layer, field] of entries) {
    if (!layer || layer.length > 255) throw new FieldValidationError('Tên layer không hợp lệ')
    if (field === null || field === '') continue
    out[layer] = str(field, `layerFields["${layer}"]`, { max: 120 })
  }
  return out
}

export function parseLayerFields(json: string | null | undefined): LayerFields {
  if (!json) return {}
  try { return normalizeLayerFields(JSON.parse(json)) } catch { return {} }
}

export function normField(name: string): string {
  return name.toLowerCase().trim()
}
