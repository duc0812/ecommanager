import { prisma } from '@/lib/db'
import { isNonProductLine } from '@/lib/order-lines'
import { safeHttpUrl } from '@/lib/design-studio'
import { loadTemplateContext } from '@/lib/print-template-resolve'
import { profileKey } from '@/lib/product-mapping'
import { observationSince } from '@/lib/product-profiles'
import { nasProductKey, nasSlotPath } from '@/lib/artwork-nas-paths'
import { LIBRARY_LINE_LIMIT, SLOT_LINE_SELECT, buildSlotDrafts } from '@/lib/artwork-slots'
import { LibraryError, activeSlotTargets, normalizeOptionKey, slotTarget } from '@/lib/repos/artwork-library'

/**
 * PSDs live on the office NAS, never on the server. The worker PC (same LAN) creates one folder per product × template
 * × option, finds the PSD a designer dropped there, and reports it; the server queues a parse job and the worker reads
 * the PSD straight from the NAS. Paths are relative to the worker's ARTWORK_NAS_ROOT, "/" separated.
 */

export const NAS_SCAN_KEY = 'design.nas.scan'
const OPEN_JOB_STATUSES = ['QUEUED', 'RUNNING']

export type NasSlot = {
  storeId: string; shopifyProductId: string; templateId: string; optionKey: string; title: string
  /** Folder segments under the NAS root; the PSD's own folder once one was found, so a renamed product keeps its folder. */
  folder: string[]
  /** An existing product folder named "<productKey> …" is reused instead of creating a new one. */
  productKey: string
  entryId: string | null
  /** sha256 of the PSD the entry was parsed from (NAS or an old upload); the same file on the NAS is linked without re-parsing. */
  activeSha256: string | null
  nasPath: string | null
}

export type NasFound = { storeId: string; shopifyProductId: string; templateId: string; optionKey: string; nasPath: string; sha256: string; size: number; modifiedAt: string }
export type NasScanState = { root: string; at: string; found: number; queued: number; linked: number; missing: string[] }

/** A worker-reported path: relative, "/" separated, no "..", ends in .psd/.psb. */
export function cleanNasPath(raw: unknown): string {
  if (typeof raw !== 'string') throw new LibraryError('nasPath phải là chuỗi')
  const p = raw.replace(/\\/g, '/').replace(/^\/+/, '').trim()
  const parts = p.split('/')
  if (!p || /^[a-z]:/i.test(p) || parts.some(s => !s || s === '.' || s === '..')) throw new LibraryError(`nasPath không hợp lệ: ${raw}`)
  if (!/\.(psd|psb)$/i.test(p)) throw new LibraryError(`nasPath phải là file .psd/.psb: ${raw}`)
  return parts.join('/')
}

export async function listNasSlots(): Promise<NasSlot[]> {
  const [lines, profiles, entries, stores] = await Promise.all([
    prisma.orderLine.findMany({
      where: { order: { placedAt: { gte: observationSince() } }, shopifyProductId: { not: null } },
      orderBy: { order: { placedAt: 'desc' } },
      select: { ...SLOT_LINE_SELECT, order: { select: { storeId: true } } },
    }),
    prisma.productProfile.findMany({ select: { storeId: true, shopifyProductId: true, printTemplateId: true, artworkSplits: true, title: true } }),
    prisma.artworkEntry.findMany({
      select: { id: true, storeId: true, shopifyProductId: true, printTemplateId: true, optionKey: true, title: true, nasPath: true, nasSha256: true, psdFile: { select: { sha256: true } } },
    }),
    prisma.shopifyStore.findMany({ select: { id: true, shop: true, project: { select: { name: true } } } }),
  ])
  const storeName = new Map(stores.map(s => [s.id, s.project?.name ?? s.shop]))
  const profileByKey = new Map(profiles.map(p => [profileKey(p.storeId, p.shopifyProductId), p]))
  const groups = new Map<string, { storeId: string; shopifyProductId: string; title: string; lines: typeof lines }>()
  for (const l of lines) {
    if (isNonProductLine(l) || !l.shopifyProductId) continue
    const key = profileKey(l.order.storeId, l.shopifyProductId)
    const g = groups.get(key) ?? { storeId: l.order.storeId, shopifyProductId: l.shopifyProductId, title: l.productTitle, lines: [] }
    if (g.lines.length < LIBRARY_LINE_LIMIT) g.lines.push(l)
    groups.set(key, g)
  }
  const list = Array.from(groups.entries())
  const ctx = await loadTemplateContext(list.flatMap(([, g]) => g.lines.filter(l => l.resolvedSupplierId)), list.map(([k]) => profileByKey.get(k)?.printTemplateId))
  const supplierIds = new Set<string>()
  const drafts = list.map(([key, g]) => {
    const { slots } = buildSlotDrafts(g.lines, profileByKey.get(key) ?? null, ctx)
    for (const s of slots) supplierIds.add(s.supplierId)
    return { key, g, slots: slots.filter(s => s.template) }
  })
  const suppliers = new Map((await prisma.supplier.findMany({ where: { id: { in: Array.from(supplierIds) } }, select: { id: true, name: true } })).map(s => [s.id, s.name]))
  const templateSku = new Map((await prisma.printTemplate.findMany({ select: { id: true, supplierSku: true } })).map(t => [t.id, t.supplierSku]))

  const out: NasSlot[] = []
  for (const { g, slots } of drafts) {
    for (const s of slots) {
      const tpl = s.template!
      const entry = entries.find(e => e.storeId === g.storeId && e.shopifyProductId === g.shopifyProductId && e.printTemplateId === tpl.id && e.optionKey === s.optionKey) ?? null
      const folder = nasSlotPath({
        storeName: storeName.get(g.storeId) ?? 'Store', title: g.title, shopifyProductId: g.shopifyProductId, templateName: tpl.name,
        supplierName: suppliers.get(s.supplierId) ?? 'Xưởng', supplierSku: templateSku.get(tpl.id) ?? s.skus[0] ?? null, optionKey: s.optionKey,
        nasPath: entry?.nasPath,
      })
      out.push({
        storeId: g.storeId, shopifyProductId: g.shopifyProductId, templateId: tpl.id, optionKey: s.optionKey, title: g.title, folder,
        productKey: nasProductKey(g.title, g.shopifyProductId), entryId: entry?.id ?? null,
        activeSha256: entry?.nasSha256 ?? entry?.psdFile?.sha256 ?? null, nasPath: entry?.nasPath ?? null,
      })
    }
  }
  return out
}

const CLEARED_RESULTS = {
  artworkFileId: null, previewFileId: null, fields: '[]', fixedTexts: '[]', missingFonts: '[]', warnings: '[]',
  checkScore: null, error: null, parsedAt: null, approvedAt: null, approvedById: null,
}

function entryUnique(storeId: string, shopifyProductId: string, printTemplateId: string, optionKey: string) {
  return { storeId_shopifyProductId_printTemplateId_optionKey: { storeId, shopifyProductId, printTemplateId, optionKey } }
}

function cleanFound(raw: unknown): NasFound {
  if (!raw || typeof raw !== 'object') throw new LibraryError('Mục found không hợp lệ')
  const r = raw as Record<string, unknown>
  const str = (k: string) => {
    if (typeof r[k] !== 'string' || !(r[k] as string).trim()) throw new LibraryError(`Thiếu ${k}`)
    return (r[k] as string).trim()
  }
  const sha256 = str('sha256').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new LibraryError('sha256 không hợp lệ')
  const size = Number(r.size)
  if (!Number.isFinite(size) || size <= 0) throw new LibraryError('size không hợp lệ')
  const modifiedAt = new Date(str('modifiedAt'))
  if (Number.isNaN(modifiedAt.getTime())) throw new LibraryError('modifiedAt không hợp lệ')
  return {
    storeId: str('storeId'), shopifyProductId: str('shopifyProductId'), templateId: str('templateId'),
    optionKey: normalizeOptionKey(typeof r.optionKey === 'string' ? r.optionKey : ''), nasPath: cleanNasPath(r.nasPath),
    sha256, size: Math.round(size), modifiedAt: modifiedAt.toISOString(),
  }
}

export type NasReportResult = { linked: string[]; queued: string[]; unchanged: number; errors: string[] }

/**
 * The worker found these PSDs on the NAS. The same file the entry was parsed from is only linked (the parse result and
 * any approval stay); a new or changed PSD clears the results and queues a parse. `missing` lists PSDs an entry points at
 * that the scan no longer found, for the scan summary only.
 */
export async function reportNasScan(body: unknown): Promise<NasReportResult> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LibraryError('Body không hợp lệ')
  const b = body as Record<string, unknown>
  const root = typeof b.root === 'string' ? b.root.trim().slice(0, 300) : ''
  const rawFound = Array.isArray(b.found) ? b.found : []
  const missing = Array.isArray(b.missing) ? b.missing.filter((m): m is string => typeof m === 'string').slice(0, 200) : []
  const out: NasReportResult = { linked: [], queued: [], unchanged: 0, errors: [] }
  const targets = new Map<string, Set<string>>()

  for (const raw of rawFound.slice(0, 2000)) {
    let f: NasFound
    try { f = cleanFound(raw) } catch (e: any) { out.errors.push(e?.message ?? String(e)); continue }
    const nas = { nasPath: f.nasPath, nasSha256: f.sha256, nasSize: f.size, nasModifiedAt: new Date(f.modifiedAt) }
    const existing = await prisma.artworkEntry.findUnique({
      where: entryUnique(f.storeId, f.shopifyProductId, f.templateId, f.optionKey), include: { psdFile: { select: { sha256: true } } },
    })
    if (!existing) {
      const pk = `${f.storeId}|${f.shopifyProductId}`
      if (!targets.has(pk)) targets.set(pk, await activeSlotTargets(f.storeId, f.shopifyProductId))
      if (!targets.get(pk)!.has(slotTarget(f.templateId, f.optionKey))) { out.errors.push(`${f.nasPath}: sản phẩm không còn slot cho template này`); continue }
    }
    const active = existing?.nasSha256 ?? existing?.psdFile?.sha256 ?? null
    if (existing && active === f.sha256) {
      if (existing.nasPath === f.nasPath && existing.nasSha256 === f.sha256) { out.unchanged++; continue }
      await prisma.artworkEntry.update({ where: { id: existing.id }, data: nas })
      out.linked.push(f.nasPath)
      continue
    }
    const base = existing ? null : await newEntryBase(f.storeId, f.shopifyProductId, f.templateId)
    if (!existing && !base) { out.errors.push(`${f.nasPath}: không tìm thấy sản phẩm hoặc template`); continue }
    await prisma.$transaction(async tx => {
      const row = existing
        ? await tx.artworkEntry.update({ where: { id: existing.id }, data: { status: 'QUEUED', ...CLEARED_RESULTS, ...nas } })
        : await tx.artworkEntry.create({
            data: { storeId: f.storeId, shopifyProductId: f.shopifyProductId, printTemplateId: f.templateId, optionKey: f.optionKey, ...base!, status: 'QUEUED', ...CLEARED_RESULTS, ...nas },
          })
      await tx.artworkJob.updateMany({
        where: { entryId: row.id, status: { in: OPEN_JOB_STATUSES } },
        data: { status: 'FAILED', error: 'Thay bằng PSD mới trên NAS', finishedAt: new Date() },
      })
      await tx.artworkJob.create({ data: { entryId: row.id, kind: 'PARSE_PSD' } })
    })
    out.queued.push(f.nasPath)
  }

  const state: NasScanState = {
    root, at: new Date().toISOString(), found: rawFound.length, queued: out.queued.length, linked: out.linked.length, missing,
  }
  await prisma.appSetting.upsert({ where: { key: NAS_SCAN_KEY }, create: { key: NAS_SCAN_KEY, value: JSON.stringify(state) }, update: { value: JSON.stringify(state) } })
  return out
}

async function newEntryBase(storeId: string, shopifyProductId: string, templateId: string) {
  const [template, newest, profile] = await Promise.all([
    prisma.printTemplate.findUnique({ where: { id: templateId }, select: { supplierId: true } }),
    prisma.orderLine.findFirst({ where: { shopifyProductId, order: { storeId } }, orderBy: { order: { placedAt: 'desc' } }, select: { productTitle: true, imageUrl: true } }),
    prisma.productProfile.findUnique({ where: { storeId_shopifyProductId: { storeId, shopifyProductId } }, select: { title: true, imageUrl: true } }),
  ])
  const title = newest?.productTitle ?? profile?.title
  if (!template || !title) return null
  return { supplierId: template.supplierId, title, imageUrl: safeHttpUrl(newest?.imageUrl) ?? safeHttpUrl(profile?.imageUrl) ?? null }
}

export async function nasScanState(): Promise<NasScanState | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: NAS_SCAN_KEY } })
  if (!row) return null
  try { return JSON.parse(row.value) as NasScanState } catch { return null }
}
