import { createHash } from 'crypto'

export const LOCAL_COVERAGE_KEY = 'artwork_library_local_state'
export type CoverageEntry = Record<string, unknown> & { storeId: string; shopifyProductId: string; printTemplateId: string; optionKey: string; status: string }
export type CoverageScope = { storeId: string; shopifyProductId: string }
export class CoverageError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, name: string, max = 200): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new CoverageError(`${name} không hợp lệ`)
  return v.trim()
}
export function coverageScope(v: unknown): CoverageScope {
  if (!object(v)) throw new CoverageError('Body không hợp lệ')
  const storeId = text(v.storeId, 'storeId')
  const shopifyProductId = text(v.shopifyProductId, 'shopifyProductId')
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(shopifyProductId)) throw new CoverageError('shopifyProductId không hợp lệ')
  return { storeId, shopifyProductId }
}
export function readCoverageSnapshot(raw: string | null): Record<string, unknown> & { entries: CoverageEntry[] } {
  if (raw === null) return { entries: [] }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new CoverageError('Trạng thái thư viện hiện tại không đọc được; giữ nguyên', 409) }
  if (!object(value) || !Array.isArray(value.entries) || !value.entries.every(object)) throw new CoverageError('Trạng thái thư viện hiện tại không hợp lệ; giữ nguyên', 409)
  return value as Record<string, unknown> & { entries: CoverageEntry[] }
}
export function scopedCoverage(entries: CoverageEntry[], scope: CoverageScope): CoverageEntry[] {
  return entries.filter(e => e.storeId === scope.storeId && e.shopifyProductId === scope.shopifyProductId)
}
export function coverageHash(entries: CoverageEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}
const STATUSES = ['READY', 'NEEDS_REVIEW', 'NEEDS_FONTS', 'ERROR', 'QUEUED', 'PARSING']
export function validateCoverageEntries(raw: unknown, scope: CoverageScope): CoverageEntry[] {
  if (!Array.isArray(raw) || raw.length > 100) throw new CoverageError('entries phải là danh sách tối đa 100 mục')
  const seen = new Set<string>()
  return raw.map(v => {
    if (!object(v) || v.storeId !== scope.storeId || v.shopifyProductId !== scope.shopifyProductId) throw new CoverageError('Entry không thuộc sản phẩm đang đồng bộ')
    text(v.id, 'entry.id', 300)
    const tid = text(v.printTemplateId, 'entry.printTemplateId')
    if (typeof v.optionKey !== 'string' || v.optionKey.length > 1000) throw new CoverageError('optionKey không hợp lệ')
    if (v.optionKey) {
      let options: unknown
      try { options = JSON.parse(v.optionKey) } catch { throw new CoverageError('optionKey không hợp lệ') }
      if (!object(options) || !Object.values(options).every(x => typeof x === 'string')) throw new CoverageError('optionKey không hợp lệ')
    }
    const key = `${tid}|${v.optionKey}`
    if (seen.has(key)) throw new CoverageError('Trùng template/option trong sản phẩm')
    seen.add(key)
    if (!STATUSES.includes(String(v.status))) throw new CoverageError('Entry status không hợp lệ')
    const fields = (f: unknown) => Array.isArray(f) && f.length <= 50 && f.every(x => typeof x === 'string' && x.trim() && x.length <= 120)
    if (v.fields !== undefined && !fields(v.fields)) throw new CoverageError('fields không hợp lệ')
    if (v.specs !== undefined) {
      if (!Array.isArray(v.specs) || !v.specs.length || v.specs.length > 100) throw new CoverageError('specs không hợp lệ')
      for (const s of v.specs) {
        if (!object(s) || !/^[A-Za-z0-9]+$/.test(text(s.design, 'spec.design')) || !fields(s.fields)) throw new CoverageError('Spec không hợp lệ')
        for (const k of ['supplierSku', 'skuIs', 'skuContains', 'skuNot', 'skuEnds', 'variantContains']) if (s[k] !== undefined && typeof s[k] !== 'string') throw new CoverageError(`spec.${k} không hợp lệ`)
        if (s.minOrder !== undefined && (!Number.isInteger(s.minOrder) || Number(s.minOrder) < 0)) throw new CoverageError('spec.minOrder không hợp lệ')
        if (s.match !== undefined && (!object(s.match) || !Object.values(s.match).every(x => typeof x === 'string'))) throw new CoverageError('spec.match không hợp lệ')
        for (const k of ['customall', 'noTextOk']) if (s[k] !== undefined && typeof s[k] !== 'boolean') throw new CoverageError(`spec.${k} không hợp lệ`)
      }
    }
    if (v.status === 'READY' && !Array.isArray(v.fields) && !Array.isArray(v.specs)) throw new CoverageError('READY cần fields hoặc specs')
    return v as CoverageEntry
  })
}
export function mergeCoverage(raw: string | null, scope: CoverageScope, entries: CoverageEntry[], expectedHash: string, now: string) {
  const snapshot = readCoverageSnapshot(raw)
  const previous = scopedCoverage(snapshot.entries, scope)
  if (coverageHash(previous) !== expectedHash) throw new CoverageError('Thư viện sản phẩm đã đổi; đọc lại trước khi đồng bộ', 409)
  const unrelated = snapshot.entries.filter(e => e.storeId !== scope.storeId || e.shopifyProductId !== scope.shopifyProductId)
  return { ...snapshot, entries: [...unrelated, ...entries], updatedAt: now }
}
