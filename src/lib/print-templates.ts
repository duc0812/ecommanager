import fs from 'fs/promises'
import path from 'path'
import { prisma } from '@/lib/db'
import { storageRoot, safeFileName } from '@/lib/design-storage'
import { mapTemplate, syncDesignTasksCounted } from '@/lib/design-tasks'

export const MAX_SOURCE_BYTES = 200 * 1024 * 1024
export const MAX_GUIDE_BYTES = 30 * 1024 * 1024
export const MAX_REQUEST_BYTES = MAX_SOURCE_BYTES + MAX_GUIDE_BYTES + 1024 * 1024

export const SOURCE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', tif: 'image/tiff', tiff: 'image/tiff',
  psd: 'image/vnd.adobe.photoshop', pdf: 'application/pdf',
}

const CLOSED_PIPELINE = ['EXPORTED', 'FULFILLED', 'CANCELLED', 'REFUNDED']

export type AreaInput = { name: string; x: number; y: number; w: number; h: number }
export type TemplateFields = {
  name: string; widthPx: number; heightPx: number; dpi: number; bleedIn: number; safeIn: number; mirror: boolean; areas: AreaInput[]
}
type TemplateRecord = {
  id: string; name: string; widthPx: number; heightPx: number; dpi: number; bleedIn: number; safeIn: number; mirror: boolean
  areas: string; guideImagePath: string | null; templateUrl: string | null; updatedAt: Date
  supplierId: string; supplierSku: string | null; sourceFileName: string | null; sourceFilePath: string | null
}

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '') return Number(v)
  return undefined
}

function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return ['1', 'true', 'on', 'yes'].includes(v.trim().toLowerCase())
  return undefined
}

function parseAreas(v: unknown): unknown[] | undefined | 'invalid' {
  if (v === undefined || v === null || v === '') return undefined
  if (Array.isArray(v)) return v
  if (typeof v !== 'string') return 'invalid'
  try {
    const parsed = JSON.parse(v)
    return Array.isArray(parsed) ? parsed : 'invalid'
  } catch { return 'invalid' }
}

export function validateTemplateFields(raw: Record<string, unknown>, existing?: TemplateFields): { ok: true; fields: TemplateFields } | { ok: false; error: string } {
  const name = typeof raw.name === 'string' ? raw.name.trim() : existing?.name ?? ''
  if (!name) return { ok: false, error: 'Nhập tên template' }
  const widthPx = toNum(raw.widthPx) ?? existing?.widthPx
  const heightPx = toNum(raw.heightPx) ?? existing?.heightPx
  const dpi = toNum(raw.dpi) ?? existing?.dpi ?? 300
  const bleedIn = toNum(raw.bleedIn) ?? existing?.bleedIn ?? 0.125
  const safeIn = toNum(raw.safeIn) ?? existing?.safeIn ?? 0.2
  if (!(Number.isFinite(widthPx) && (widthPx as number) > 0)) return { ok: false, error: 'widthPx phải > 0' }
  if (!(Number.isFinite(heightPx) && (heightPx as number) > 0)) return { ok: false, error: 'heightPx phải > 0' }
  if (!(Number.isFinite(dpi) && dpi > 0)) return { ok: false, error: 'dpi phải > 0' }
  if (!(Number.isFinite(bleedIn) && bleedIn >= 0)) return { ok: false, error: 'bleedIn phải ≥ 0' }
  if (!(Number.isFinite(safeIn) && safeIn >= 0)) return { ok: false, error: 'safeIn phải ≥ 0' }
  const W = Math.round(widthPx as number), H = Math.round(heightPx as number)
  const mirror = toBool(raw.mirror) ?? existing?.mirror ?? false

  const parsed = parseAreas(raw.areas)
  if (parsed === 'invalid') return { ok: false, error: 'areas phải là mảng JSON' }
  const sourceAreas: unknown[] = parsed ?? existing?.areas ?? [{ name: 'Print', x: 0, y: 0, w: W, h: H }]
  if (sourceAreas.length === 0) return { ok: false, error: 'Cần ít nhất một vùng in' }
  const areas: AreaInput[] = []
  const seen = new Set<string>()
  for (const a of sourceAreas as any[]) {
    const area = { name: typeof a?.name === 'string' ? a.name.trim() : '', x: toNum(a?.x), y: toNum(a?.y), w: toNum(a?.w), h: toNum(a?.h) }
    if (!area.name) return { ok: false, error: 'Mỗi vùng in cần tên' }
    if (seen.has(area.name.toLowerCase())) return { ok: false, error: `Trùng tên vùng in: ${area.name}` }
    seen.add(area.name.toLowerCase())
    const { x, y, w, h } = area
    if (![x, y, w, h].every(n => Number.isFinite(n))) return { ok: false, error: `Vùng ${area.name}: x, y, w, h phải là số` }
    if ((x as number) < 0 || (y as number) < 0 || (w as number) <= 0 || (h as number) <= 0) return { ok: false, error: `Vùng ${area.name}: x, y ≥ 0 và w, h > 0` }
    if ((x as number) + (w as number) > W || (y as number) + (h as number) > H) return { ok: false, error: `Vùng ${area.name} nằm ngoài khổ ${W}×${H}` }
    areas.push({ name: area.name, x: Math.round(x as number), y: Math.round(y as number), w: Math.round(w as number), h: Math.round(h as number) })
  }
  return { ok: true, fields: { name, widthPx: W, heightPx: H, dpi: Math.round(dpi), bleedIn, safeIn, mirror, areas } }
}

export function fieldsOf(t: TemplateRecord): TemplateFields {
  const m = mapTemplate(t)
  return { name: m.name, widthPx: m.widthPx, heightPx: m.heightPx, dpi: m.dpi, bleedIn: m.bleedIn, safeIn: m.safeIn, mirror: m.mirror, areas: m.areas }
}

export function guideExt(bytes: Buffer): 'png' | 'jpg' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  return null
}

export function sourceExt(fileName: string): string | null {
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
  return SOURCE_MIME[ext] ? ext : null
}

function templateDir(templateId: string): { abs: string; rel: string } {
  const root = path.resolve(storageRoot())
  const rel = `templates/${safeFileName(templateId)}`
  const abs = path.resolve(root, rel)
  if (!abs.startsWith(root + path.sep)) throw new Error('Invalid storage path')
  return { abs, rel }
}

async function writeReplacing(templateId: string, base: 'guide' | 'source', ext: string, bytes: Buffer): Promise<string> {
  const dir = templateDir(templateId)
  await fs.mkdir(dir.abs, { recursive: true })
  for (const f of await fs.readdir(dir.abs)) {
    if (f.startsWith(`${base}.`) && f !== `${base}.${ext}`) await fs.rm(path.join(dir.abs, f), { force: true })
  }
  await fs.writeFile(path.join(dir.abs, `${base}.${ext}`), bytes)
  return `${dir.rel}/${base}.${ext}`
}

export function saveGuide(templateId: string, ext: string, bytes: Buffer) { return writeReplacing(templateId, 'guide', ext, bytes) }
export function saveSource(templateId: string, ext: string, bytes: Buffer) { return writeReplacing(templateId, 'source', ext, bytes) }

export async function removeStoredFile(rel: string | null) {
  if (!rel) return
  const root = path.resolve(storageRoot())
  const abs = path.resolve(root, rel)
  if (abs.startsWith(root + path.sep)) await fs.rm(abs, { force: true })
}

export async function removeTemplateDir(templateId: string) {
  await fs.rm(templateDir(templateId).abs, { recursive: true, force: true })
}

export function localTemplatePath(rel: string | null): string | null {
  if (!rel) return null
  const root = path.resolve(storageRoot())
  const abs = path.resolve(root, rel)
  return abs.startsWith(root + path.sep) ? abs : null
}

export function templateDto(t: TemplateRecord & { supplierProducts?: { id: string }[] }) {
  return {
    ...mapTemplate(t),
    supplierSku: t.supplierSku,
    sourceFileName: t.sourceFileName,
    sourceUrl: t.sourceFilePath ? `/api/fulfillment/suppliers/${t.supplierId}/print-templates/${t.id}/source` : null,
    supplierProductIds: (t.supplierProducts ?? []).map(p => p.id),
    updatedAt: t.updatedAt.toISOString(),
  }
}

export async function loadSupplierTemplate(supplierId: string, templateId: string) {
  const t = await prisma.printTemplate.findUnique({ where: { id: templateId }, include: { supplierProducts: { select: { id: true } } } })
  return t && t.supplierId === supplierId ? t : null
}

export function parseIdList(v: unknown): string[] | null | 'invalid' {
  if (v === undefined || v === null || v === '') return null
  let arr: unknown = v
  if (typeof v === 'string') {
    try { arr = JSON.parse(v) } catch { return 'invalid' }
  }
  if (!Array.isArray(arr) || !arr.every(x => typeof x === 'string' && x)) return 'invalid'
  return Array.from(new Set(arr as string[]))
}

export async function assertSupplierProducts(supplierId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true
  const n = await prisma.supplierProduct.count({ where: { id: { in: ids }, supplierId } })
  return n === ids.length
}

export async function resyncOpenOrdersForSkus(supplierId: string, skus: string[]): Promise<{ tasksTouched: number; errors: string[] }> {
  if (skus.length === 0) return { tasksTouched: 0, errors: [] }
  const orders = await prisma.order.findMany({
    where: {
      pipelineStatus: { notIn: CLOSED_PIPELINE },
      lines: { some: { resolvedSupplierId: supplierId, resolvedSupplierSku: { in: skus } } },
    },
    select: { id: true },
  })
  return syncDesignTasksCounted(orders.map(o => o.id))
}

export async function setTemplateLinks(supplierId: string, templateId: string, productIds: string[]) {
  const before = await prisma.supplierProduct.findMany({ where: { supplierId, OR: [{ printTemplateId: templateId }, { id: { in: productIds } }] }, select: { id: true, sku: true } })
  await prisma.$transaction([
    prisma.supplierProduct.updateMany({ where: { supplierId, printTemplateId: templateId, id: { notIn: productIds } }, data: { printTemplateId: null } }),
    prisma.supplierProduct.updateMany({ where: { supplierId, id: { in: productIds } }, data: { printTemplateId: templateId } }),
  ])
  return resyncOpenOrdersForSkus(supplierId, before.map(p => p.sku))
}

export async function linkProducts(supplierId: string, productIds: string[], templateId: string | null) {
  const rows = await prisma.supplierProduct.findMany({ where: { supplierId, id: { in: productIds } }, select: { sku: true } })
  const r = await prisma.supplierProduct.updateMany({ where: { supplierId, id: { in: productIds } }, data: { printTemplateId: templateId } })
  const sync = await resyncOpenOrdersForSkus(supplierId, rows.map(p => p.sku))
  return { updated: r.count, ...sync }
}

export type TemplateRequest = { fields: Record<string, unknown>; guide: File | null; source: File | null }

function asFile(v: FormDataEntryValue | null): File | null {
  return v && typeof v !== 'string' && typeof (v as any).arrayBuffer === 'function' && (v as File).size > 0 ? (v as File) : null
}

export async function readTemplateRequest(req: Request): Promise<{ ok: true; value: TemplateRequest } | { ok: false; status: number; error: string }> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return { ok: false, status: 413, error: 'File lớn hơn 200 MB' }
  const type = req.headers.get('content-type') ?? ''
  if (type.includes('multipart/form-data')) {
    const form = await req.formData().catch(() => null)
    if (!form) return { ok: false, status: 400, error: 'Form không hợp lệ' }
    const fields: Record<string, unknown> = {}
    form.forEach((v, k) => { if (typeof v === 'string') fields[k] = v })
    const guide = asFile(form.get('guide'))
    const source = asFile(form.get('source'))
    if (guide && guide.size > MAX_GUIDE_BYTES) return { ok: false, status: 400, error: 'Ảnh guide lớn hơn 30 MB' }
    if (source && source.size > MAX_SOURCE_BYTES) return { ok: false, status: 400, error: 'File gốc lớn hơn 200 MB' }
    return { ok: true, value: { fields, guide, source } }
  }
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 400, error: 'Body không hợp lệ' }
  return { ok: true, value: { fields: body as Record<string, unknown>, guide: null, source: null } }
}

export async function storeTemplateFiles(templateId: string, input: TemplateRequest): Promise<{ ok: true; data: Record<string, string | null> } | { ok: false; error: string }> {
  const data: Record<string, string | null> = {}
  let guideBytes: Buffer | null = null, guideKind: string | null = null
  if (input.guide) {
    guideBytes = Buffer.from(await input.guide.arrayBuffer())
    guideKind = guideExt(guideBytes)
    if (!guideKind) return { ok: false, error: 'Ảnh guide phải là PNG hoặc JPG' }
  }
  let srcExt: string | null = null
  if (input.source) {
    srcExt = sourceExt(input.source.name)
    if (!srcExt) return { ok: false, error: 'File gốc phải là png, jpg, tif, psd hoặc pdf' }
  }
  if (guideBytes && guideKind) data.guideImagePath = await saveGuide(templateId, guideKind, guideBytes)
  if (input.source && srcExt) {
    data.sourceFilePath = await saveSource(templateId, srcExt === 'jpeg' ? 'jpg' : srcExt === 'tiff' ? 'tif' : srcExt, Buffer.from(await input.source.arrayBuffer()))
    data.sourceFileName = safeFileName(input.source.name)
  }
  return { ok: true, data }
}
