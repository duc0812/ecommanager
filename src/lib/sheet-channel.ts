import { prisma } from '@/lib/db'

export const SHEET_CHANNELS_KEY = 'supplier.sheetChannels'

/** `header` is matched by name; a column with no usable title (Jomall's date column) names its position, as `position: 'A'`. */
export type SheetColumn = { header?: string; position?: string; source: string }

export type SheetChannel = {
  supplierCode: string
  /** Off keeps the supplier on CSV, so the setup can be proved before it goes live. */
  enabled: boolean
  spreadsheetId: string
  /** "ORDER {M}-{YYYY}": the month's tab, by the day the order is sent. */
  tabPattern: string
  /** Only this store's orders may enter the sheet: a row written there cannot be taken back. */
  storeShop: string
  columns: SheetColumn[]
}

export function parseSheetChannels(json: string | null | undefined): SheetChannel[] {
  if (!json) return []
  try {
    const list = JSON.parse(json)
    if (!Array.isArray(list)) return []
    return list.filter(c => c && typeof c.supplierCode === 'string' && typeof c.spreadsheetId === 'string' && typeof c.tabPattern === 'string'
      && typeof c.storeShop === 'string' && Array.isArray(c.columns))
      .map(c => ({ ...c, enabled: c.enabled === true }))
  } catch {
    return []
  }
}

export async function getSheetChannels(): Promise<SheetChannel[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: SHEET_CHANNELS_KEY } })
  return parseSheetChannels(row?.value)
}

export function enabledChannelFor(channels: SheetChannel[], supplier: { code: string } | null | undefined): SheetChannel | null {
  if (!supplier) return null
  const code = supplier.code.trim().toLowerCase()
  return channels.find(c => c.enabled && c.supplierCode.trim().toLowerCase() === code) ?? null
}

const VN_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: 'numeric', day: 'numeric' })

function vnParts(at: Date): { y: number; m: number; d: number } {
  const parts = VN_PARTS.formatToParts(at)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value)
  return { y: get('year'), m: get('month'), d: get('day') }
}

/** The day an order is sent, as the sheet writes it: 11/4/2026. */
export function sheetDate(at: Date): string {
  const { y, m, d } = vnParts(at)
  return `${m}/${d}/${y}`
}

/** This month's tab name, or that of `back` months before. */
export function tabNameFor(pattern: string, at: Date, back = 0): string {
  const { y, m } = vnParts(at)
  const index = y * 12 + (m - 1) - back
  return pattern.replace('{M}', String((index % 12) + 1)).replace('{YYYY}', String(Math.floor(index / 12)))
}

/** The keys a sheet row stands for. A row with no line suffix in either column covers its whole order. */
export function rowKeys(orderNumber: string, vendor: string): { lines: string[]; orders: string[] } {
  const clean = (s: string) => s.trim().replace(/^#/, '').replace(/-/g, '_').toUpperCase()
  const values = [clean(orderNumber), clean(vendor)].filter(Boolean)
  const lines = values.filter(v => v.includes('_'))
  return lines.length > 0 ? { lines, orders: [] } : { lines: [], orders: values }
}

export type SheetKeys = { lines: Set<string>; orders: Set<string> }

export function collectKeys(rows: { orderNumber: string; vendor: string }[], into: SheetKeys = { lines: new Set(), orders: new Set() }): SheetKeys {
  for (const r of rows) {
    const k = rowKeys(r.orderNumber, r.vendor)
    k.lines.forEach(v => into.lines.add(v))
    k.orders.forEach(v => into.orders.add(v))
  }
  return into
}

/** Is this line already in the sheet? `LIT123_1R` is a redo, a different key from `LIT123_1`. */
export function hasLine(keys: SheetKeys, lineKey: string): boolean {
  const key = lineKey.toUpperCase()
  return keys.lines.has(key) || keys.orders.has(key.split('_')[0])
}

const norm = (s: string) => s.trim().toLowerCase()

function positionIndex(position: string): number {
  return position.toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
}

export function columnLetter(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** Where each column sits today. Positions moved between monthly tabs, so a header is always looked up by name. */
export function mapColumns(headers: string[], columns: SheetColumn[]): { indexes: number[]; missing: string[] } {
  const names = headers.map(norm)
  const indexes: number[] = []
  const missing: string[] = []
  for (const c of columns) {
    const i = c.position ? positionIndex(c.position) : names.indexOf(norm(c.header ?? ''))
    if (i < 0) missing.push(c.header ?? c.position ?? '')
    else indexes.push(i)
  }
  return { indexes, missing }
}

/** One sheet row: only the mapped cells hold a value, up to the last mapped column. */
export function buildRow(indexes: number[], values: string[]): string[] {
  const row: string[] = Array(Math.max(...indexes) + 1).fill('')
  indexes.forEach((col, i) => { row[col] = values[i] })
  return row
}

export function sameRow(sent: string[], got: string[] | undefined): boolean {
  return sent.every((v, i) => v.trim() === String(got?.[i] ?? '').trim())
}

/** The sheet's own row marking a new day. */
export const DAY_SEPARATOR_COLOR = { red: 0, green: 1, blue: 0 }

export function lastDataRow(rows: string[][]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].some(c => String(c ?? '').trim())) return i + 1
  }
  return 0
}

function isFilled(c: { red?: number; green?: number; blue?: number } | null): boolean {
  if (!c) return false
  return (c.red ?? 0) < 0.99 || (c.green ?? 0) < 0.99 || (c.blue ?? 0) < 0.99
}

/**
 * Where a send goes: right after the last row with data, past the coloured empty rows that follow it. Those mark the days,
 * and Jomall's sheet can hold the next one ready. The first send of a new day with no such row adds one, in `separatorRow`.
 */
export function planRows(a: { lastRow: number; lastDate: string; today: string; colors: ({ red?: number; green?: number; blue?: number } | null)[] }): { separatorRow: number | null; startRow: number } {
  let startRow = a.lastRow + 1
  let i = 0
  while (isFilled(a.colors[i] ?? null)) { startRow++; i++ }
  if (i > 0 || a.lastRow <= 1 || a.lastDate.trim() === a.today) return { separatorRow: null, startRow }
  return { separatorRow: a.lastRow + 1, startRow: a.lastRow + 2 }
}

const STYLE = /hoodie|zip|shirt|jersey|jacket|sweater|cardigan|crewneck|v-neck|full set|only pants|only shirt/i
const KEEP_STYLE = /full set|only pants|only shirt/i
const SIZE = /^(?:[2-9]?x{0,3}[sml]|[2-9]xl|xxl|one size|adult|(?:youth|kid|toddler)\b.*|\d.*)$/i

/**
 * The sheet's Size: the blank's size, unless the catalogue keeps a style there ("Pullover Hoodie"), then the size in the
 * order's variant. Pajama sets keep the style, it says which pieces ("Full Set / L"). Blank when the product has no size.
 */
export function sizeLabel(variant1: string | null | undefined, variantTitle: string | null | undefined): string {
  const blank = (variant1 ?? '').trim()
  if (blank && !STYLE.test(blank)) return blank
  const parts = (variantTitle ?? '').split('/').map(p => p.trim()).filter(Boolean)
  const size = [...parts].reverse().find(p => SIZE.test(p) && !STYLE.test(p))
  if (!size) return blank
  return KEEP_STYLE.test(blank) ? `${blank} / ${size}` : size
}
