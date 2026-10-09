import fsp from 'fs/promises'
import { prisma } from '@/lib/db'
import { isNonProductLine } from '@/lib/order-lines'
import { safeHttpUrl } from '@/lib/design-studio'
import { loadTemplateContext, mapTemplate, pickTemplate } from '@/lib/design-tasks'
import { profileKey } from '@/lib/product-mapping'
import { fieldsFromLines, fromRouteKey, observationSince, toRouteKey } from '@/lib/product-profiles'
export { libraryStateFor } from '@/lib/artwork-library-state'
import {
  carryOverEdits, normalizeFields, parseFields, parseFixedTexts, parseStrings, productLibraryStatus, resultStatus,
  type ArtworkField, type EntryStatus, type FixedText, type LibraryProductStatus, type SlotStatus,
} from '@/lib/artwork-fields'
import type {
  LibraryChip, LibraryEntryView, LibraryFileView, LibraryFontRow, LibraryListRow, LibraryProductDetail, LibrarySlot, LibraryTemplateView,
} from '@/lib/artwork-library-types'
import { parseFontNames, FontParseError } from '@/lib/font-name'
import { storeLibraryFile, type LibraryKind, type TempFile } from '@/lib/library-storage'
import { pushLibraryFileToDrive } from '@/lib/design-drive-push'
import { isDriveConnected } from '@/lib/google-drive'

export class LibraryError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

const CLOSED_TASK_STATUSES = ['DONE', 'CANCELLED']
const OPEN_JOB_STATUSES = ['QUEUED', 'RUNNING']
export const LIBRARY_LINE_LIMIT = 500
export const FONT_MIME: Record<string, string> = { ttf: 'font/ttf', otf: 'font/otf', ttc: 'font/collection' }
export const PSD_MAX_BYTES = 1024 * 1024 * 1024
export const FONT_MAX_BYTES = 30 * 1024 * 1024
export const RESULT_MAX_FILE_BYTES = 1024 * 1024 * 1024

type LineRow = {
  orderId: string; shopifyLineId: string; shopifyProductId: string | null; productTitle: string; shopifyProductType: string | null
  imageUrl: string | null; customAttributesJson: string | null; sku: string | null; resolvedSupplierId: string | null; resolvedSupplierSku: string | null
  variantTitle: string | null; variantOptions: string | null
}

const LINE_SELECT = {
  orderId: true, shopifyLineId: true, shopifyProductId: true, productTitle: true, shopifyProductType: true, imageUrl: true,
  customAttributesJson: true, sku: true, resolvedSupplierId: true, resolvedSupplierSku: true, variantTitle: true, variantOptions: true,
} as const

type EntryRow = NonNullable<Awaited<ReturnType<typeof loadEntryRow>>>

function loadEntryRow(id: string) {
  return prisma.artworkEntry.findUnique({ where: { id }, include: ENTRY_INCLUDE })
}

const ENTRY_INCLUDE = {
  psdFile: true, artworkFile: true, previewFile: true,
  jobs: { orderBy: { createdAt: 'desc' as const }, take: 1 },
}

export function libraryFileUrl(id: string): string {
  return `/api/design-studio/library/files/${encodeURIComponent(id)}`
}

function fileView(f: { id: string; kind: string; fileName: string; size: number; storage: string; driveWebViewLink: string | null; createdAt: Date } | null): LibraryFileView | null {
  if (!f) return null
  return {
    id: f.id, kind: f.kind, fileName: f.fileName, size: f.size, storage: f.storage, driveWebViewLink: f.driveWebViewLink,
    url: libraryFileUrl(f.id), createdAt: f.createdAt.toISOString(),
  }
}

export function serializeEntry(e: EntryRow, approverNames: Map<string, string> = new Map()): LibraryEntryView {
  const job = e.jobs[0] ?? null
  return {
    id: e.id, storeId: e.storeId, shopifyProductId: e.shopifyProductId, printTemplateId: e.printTemplateId, supplierId: e.supplierId,
    status: e.status as EntryStatus, psd: fileView(e.psdFile), artwork: fileView(e.artworkFile), preview: fileView(e.previewFile),
    fields: parseFields(e.fields), fixedTexts: parseFixedTexts(e.fixedTexts), missingFonts: parseStrings(e.missingFonts), warnings: parseStrings(e.warnings),
    checkScore: e.checkScore, error: e.error, parsedAt: e.parsedAt?.toISOString() ?? null, approvedAt: e.approvedAt?.toISOString() ?? null,
    approvedByName: e.approvedById ? (approverNames.get(e.approvedById) ?? null) : null,
    notes: e.notes, updatedAt: e.updatedAt.toISOString(),
    job: job ? { id: job.id, status: job.status, attempts: job.attempts, error: job.error, createdAt: job.createdAt.toISOString() } : null,
  }
}

async function approverNames(entries: Array<{ approvedById: string | null }>): Promise<Map<string, string>> {
  const ids = Array.from(new Set(entries.map(e => e.approvedById).filter((x): x is string => !!x)))
  if (ids.length === 0) return new Map()
  const users = await prisma.appUser.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
  return new Map(users.map(u => [u.id, u.name]))
}

function templateView(t: Parameters<typeof mapTemplate>[0]): LibraryTemplateView {
  return mapTemplate(t)
}

function parseOptions(json: string | null): Record<string, string> {
  if (!json) return {}
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}

export function summarizeVariants(lines: Array<{ variantOptions: string | null; variantTitle: string | null }>): string {
  const byOption = new Map<string, Set<string>>()
  const titles = new Set<string>()
  for (const l of lines) {
    const opts = Object.entries(parseOptions(l.variantOptions)).filter(([, v]) => typeof v === 'string' && v.trim())
    if (opts.length === 0) {
      if (l.variantTitle?.trim()) titles.add(l.variantTitle.trim())
      continue
    }
    for (const [k, v] of opts) {
      if (!byOption.has(k)) byOption.set(k, new Set())
      byOption.get(k)!.add(String(v).trim())
    }
  }
  const parts = Array.from(byOption.values()).map(vals => Array.from(vals).join(', '))
  if (titles.size > 0) parts.push(Array.from(titles).join(', '))
  return parts.join(' · ')
}

type SlotDraft = { key: string; supplierId: string; templateId: string | null; template: LibraryTemplateView | null; skus: Set<string>; lines: LineRow[] }

function slotDrafts(lines: LineRow[], profile: { printTemplateId: string | null } | null, ctx: Awaited<ReturnType<typeof loadTemplateContext>>) {
  const slots = new Map<string, SlotDraft>()
  let unmapped = 0
  for (const l of lines) {
    if (!l.resolvedSupplierId) { unmapped++; continue }
    const tpl = pickTemplate(l, profile, ctx)
    const key = tpl ? `tpl:${tpl.id}` : `none:${l.resolvedSupplierId}`
    let s = slots.get(key)
    if (!s) {
      s = { key, supplierId: l.resolvedSupplierId, templateId: tpl?.id ?? null, template: tpl, skus: new Set(), lines: [] }
      slots.set(key, s)
    }
    const sku = l.resolvedSupplierSku?.trim()
    if (sku) s.skus.add(sku)
    s.lines.push(l)
  }
  return { slots: Array.from(slots.values()), unmapped }
}

function slotStatus(draft: { templateId: string | null }, entry: { status: string } | undefined): SlotStatus {
  if (!draft.templateId) return 'NO_TEMPLATE'
  return (entry?.status as EntryStatus | undefined) ?? 'EMPTY'
}

function overallStatus(active: SlotStatus[], stale: SlotStatus[]): LibraryProductStatus {
  if (active.length > 0) return productLibraryStatus(active)
  if (stale.length > 0) return productLibraryStatus(stale)
  return 'NO_TEMPLATE'
}

async function supplierMap(ids: string[]) {
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return new Map<string, { id: string; name: string; code: string }>()
  const rows = await prisma.supplier.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, code: true } })
  return new Map(rows.map(r => [r.id, r]))
}

function lineKey(orderId: string, shopifyLineId: string) {
  return `${orderId}::${shopifyLineId}`
}

export async function listLibraryProducts(f: { q?: string; status?: LibraryProductStatus } = {}): Promise<{ products: LibraryListRow[] }> {
  const since = observationSince()
  const [lines, openTasks, profiles, entries] = await Promise.all([
    prisma.orderLine.findMany({
      where: { order: { placedAt: { gte: since } } },
      orderBy: { order: { placedAt: 'desc' } },
      select: { ...LINE_SELECT, order: { select: { storeId: true, store: { select: { shop: true } } } } },
    }),
    prisma.designTask.findMany({
      where: { status: { notIn: CLOSED_TASK_STATUSES }, order: { placedAt: { gte: since } } },
      select: { orderId: true, shopifyLineId: true },
    }),
    prisma.productProfile.findMany({ select: { storeId: true, shopifyProductId: true, printTemplateId: true, title: true, imageUrl: true } }),
    prisma.artworkEntry.findMany({
      select: { id: true, storeId: true, shopifyProductId: true, printTemplateId: true, supplierId: true, status: true, title: true, imageUrl: true,
        printTemplate: { select: { name: true } }, store: { select: { shop: true } } },
    }),
  ])
  const openTaskKeys = new Set(openTasks.map(t => lineKey(t.orderId, t.shopifyLineId)))
  const profileByKey = new Map(profiles.map(p => [profileKey(p.storeId, p.shopifyProductId), p]))
  const entriesByKey = new Map<string, typeof entries>()
  for (const e of entries) {
    const k = profileKey(e.storeId, e.shopifyProductId)
    entriesByKey.set(k, [...(entriesByKey.get(k) ?? []), e])
  }

  type Group = { storeId: string; shop: string; shopifyProductId: string; title: string; imageUrl: string | null; orders: Set<string>; openTasks: number; lines: LineRow[] }
  const groups = new Map<string, Group>()
  for (const l of lines) {
    if (isNonProductLine(l) || !l.shopifyProductId) continue
    const key = profileKey(l.order.storeId, l.shopifyProductId)
    let g = groups.get(key)
    if (!g) {
      g = { storeId: l.order.storeId, shop: l.order.store.shop, shopifyProductId: l.shopifyProductId, title: l.productTitle, imageUrl: safeHttpUrl(l.imageUrl), orders: new Set(), openTasks: 0, lines: [] }
      groups.set(key, g)
    }
    if (!g.imageUrl) g.imageUrl = safeHttpUrl(l.imageUrl)
    g.orders.add(l.orderId)
    if (openTaskKeys.has(lineKey(l.orderId, l.shopifyLineId))) g.openTasks++
    if (g.lines.length < LIBRARY_LINE_LIMIT) g.lines.push(l)
  }
  for (const [key, list] of Array.from(entriesByKey.entries())) {
    if (groups.has(key)) continue
    const e = list[0]
    const profile = profileByKey.get(key)
    groups.set(key, {
      storeId: e.storeId, shop: e.store.shop, shopifyProductId: e.shopifyProductId, title: e.title || profile?.title || '',
      imageUrl: safeHttpUrl(e.imageUrl) ?? safeHttpUrl(profile?.imageUrl), orders: new Set(), openTasks: 0, lines: [],
    })
  }

  const groupList = Array.from(groups.entries())
  const ctx = await loadTemplateContext(
    groupList.flatMap(([, g]) => g.lines.filter(l => l.resolvedSupplierId)),
    groupList.map(([key]) => profileByKey.get(key)?.printTemplateId),
  )
  const drafts = groupList.map(([key, g]) => ({ key, g, ...slotDrafts(g.lines, profileByKey.get(key) ?? null, ctx) }))
  const suppliers = await supplierMap([...drafts.flatMap(d => d.slots.map(s => s.supplierId)), ...entries.map(e => e.supplierId)])

  const q = f.q?.trim().toLowerCase()
  const products: LibraryListRow[] = []
  for (const { key, g, slots, unmapped } of drafts) {
    if (q && !g.title.toLowerCase().includes(q) && !g.shopifyProductId.toLowerCase().includes(q)) continue
    const productEntries = entriesByKey.get(key) ?? []
    const entryByTemplate = new Map(productEntries.map(e => [e.printTemplateId, e]))
    const activeIds = new Set(slots.map(s => s.templateId).filter(Boolean))
    const chips: LibraryChip[] = slots.map(s => ({
      supplierName: suppliers.get(s.supplierId)?.name ?? '?',
      templateName: s.template?.name ?? null,
      supplierSkus: Array.from(s.skus).sort(),
      status: slotStatus(s, s.templateId ? entryByTemplate.get(s.templateId) : undefined),
    }))
    const stale = productEntries.filter(e => !activeIds.has(e.printTemplateId))
    const status = overallStatus(chips.map(c => c.status), stale.map(e => e.status as SlotStatus))
    if (f.status && status !== f.status) continue
    products.push({
      key: toRouteKey(g.storeId, g.shopifyProductId), storeId: g.storeId, shop: g.shop, shopifyProductId: g.shopifyProductId,
      title: g.title, imageUrl: g.imageUrl, orderCount: g.orders.size, openTasks: g.openTasks, unmapped, status, chips, staleCount: stale.length,
    })
  }
  products.sort((a, b) => b.openTasks - a.openTasks || b.orderCount - a.orderCount || a.title.localeCompare(b.title))
  return { products }
}

async function productLines(storeId: string, shopifyProductId: string): Promise<LineRow[]> {
  const lines = await prisma.orderLine.findMany({
    where: { shopifyProductId, order: { storeId, placedAt: { gte: observationSince() } } },
    orderBy: { order: { placedAt: 'desc' } },
    take: LIBRARY_LINE_LIMIT,
    select: LINE_SELECT,
  })
  return lines.filter(l => !isNonProductLine(l))
}

export async function loadLibraryProduct(key: string): Promise<LibraryProductDetail | null> {
  const parsed = fromRouteKey(key)
  if (!parsed) return null
  const { storeId, shopifyProductId } = parsed
  const [store, profile, lines, entries, newest] = await Promise.all([
    prisma.shopifyStore.findUnique({ where: { id: storeId }, select: { id: true, shop: true, project: { select: { name: true } } } }),
    prisma.productProfile.findUnique({ where: { storeId_shopifyProductId: { storeId, shopifyProductId } } }),
    productLines(storeId, shopifyProductId),
    prisma.artworkEntry.findMany({ where: { storeId, shopifyProductId }, include: { ...ENTRY_INCLUDE, printTemplate: true, supplier: { select: { id: true, name: true, code: true } } } }),
    prisma.orderLine.findFirst({ where: { shopifyProductId, order: { storeId } }, orderBy: { order: { placedAt: 'desc' } }, select: { productTitle: true, imageUrl: true } }),
  ])
  if (!store) return null
  if (!profile && lines.length === 0 && entries.length === 0 && !newest) return null

  const ctx = await loadTemplateContext(lines.filter(l => l.resolvedSupplierId), [profile?.printTemplateId])
  const { slots: drafts, unmapped } = slotDrafts(lines, profile, ctx)
  const suppliers = await supplierMap(drafts.map(d => d.supplierId))
  const names = await approverNames(entries)
  const entryByTemplate = new Map(entries.map(e => [e.printTemplateId, e]))

  const slots: LibrarySlot[] = drafts.map(d => {
    const entry = d.templateId ? entryByTemplate.get(d.templateId) : undefined
    return {
      key: d.key,
      supplier: suppliers.get(d.supplierId) ?? { id: d.supplierId, name: '?', code: '?' },
      supplierSkus: Array.from(d.skus).sort(),
      variants: summarizeVariants(d.lines),
      lineCount: d.lines.length,
      template: d.template,
      status: slotStatus(d, entry),
      entry: entry ? serializeEntry(entry, names) : null,
    }
  })
  slots.sort((a, b) => (a.template ? 0 : 1) - (b.template ? 0 : 1) || b.lineCount - a.lineCount)
  const activeIds = new Set(drafts.map(d => d.templateId).filter(Boolean))
  const stale = entries.filter(e => !activeIds.has(e.printTemplateId)).map(e => ({
    template: templateView(e.printTemplate), supplier: e.supplier, entry: serializeEntry(e, names),
  }))
  const lineKeys = lines.map(l => ({ orderId: l.orderId, shopifyLineId: l.shopifyLineId }))
  const openTasks = lineKeys.length ? await prisma.designTask.count({ where: { status: { notIn: CLOSED_TASK_STATUSES }, OR: lineKeys } }) : 0

  return {
    key: toRouteKey(storeId, shopifyProductId), storeId, shop: store.shop, storeName: store.project?.name ?? store.shop, shopifyProductId,
    title: newest?.productTitle ?? entries[0]?.title ?? profile?.title ?? '',
    imageUrl: safeHttpUrl(lines.find(l => safeHttpUrl(l.imageUrl))?.imageUrl) ?? safeHttpUrl(newest?.imageUrl) ?? safeHttpUrl(entries[0]?.imageUrl) ?? safeHttpUrl(profile?.imageUrl),
    status: overallStatus(slots.map(s => s.status), stale.map(s => s.entry.status)),
    slots, stale, unmapped,
    observedFields: fieldsFromLines(lines),
    openTasks,
    orderCount: new Set(lines.map(l => l.orderId)).size,
  }
}

export async function loadEntryView(id: string): Promise<LibraryEntryView | null> {
  const row = await loadEntryRow(id)
  if (!row) return null
  return serializeEntry(row, await approverNames([row]))
}

function driveFolderFor(storeName: string, title: string, supplierName: string, templateName: string): string[] {
  return ['Library', storeName, title || 'Untitled', `${supplierName} - ${templateName}`]
}

export function pushInBackground(fileId: string, folder: string[]) {
  void pushLibraryFileToDrive(fileId, folder).then(r => {
    if (r.warning) console.error(`[artwork library] drive push ${fileId}: ${r.warning}`)
  }).catch(err => console.error('[artwork library] drive push crashed:', err?.message ?? err))
}

async function entryDriveFolder(entryId: string): Promise<string[] | null> {
  const e = await prisma.artworkEntry.findUnique({
    where: { id: entryId },
    select: { title: true, store: { select: { shop: true, project: { select: { name: true } } } }, supplier: { select: { name: true } }, printTemplate: { select: { name: true } } },
  })
  if (!e) return null
  return driveFolderFor(e.store.project?.name ?? e.store.shop, e.title, e.supplier.name, e.printTemplate.name)
}

export async function activeTemplateIds(storeId: string, shopifyProductId: string): Promise<Set<string>> {
  const [profile, lines] = await Promise.all([
    prisma.productProfile.findUnique({ where: { storeId_shopifyProductId: { storeId, shopifyProductId } }, select: { printTemplateId: true } }),
    productLines(storeId, shopifyProductId),
  ])
  const ctx = await loadTemplateContext(lines.filter(l => l.resolvedSupplierId), [profile?.printTemplateId])
  return new Set(slotDrafts(lines, profile, ctx).slots.map(s => s.templateId).filter((x): x is string => !!x))
}

const CLEARED_RESULTS = {
  artworkFileId: null, previewFileId: null, fields: '[]', fixedTexts: '[]', missingFonts: '[]', warnings: '[]',
  checkScore: null, error: null, parsedAt: null, approvedAt: null, approvedById: null,
}

function supersedeJobs(entryId: string, reason: string) {
  return prisma.artworkJob.updateMany({
    where: { entryId, status: { in: OPEN_JOB_STATUSES } },
    data: { status: 'FAILED', error: reason, finishedAt: new Date() },
  })
}

export async function uploadEntryPsd(input: {
  storeId: string; shopifyProductId: string; templateId: string; fileName: string; temp: TempFile; uploadedById: string | null
}): Promise<{ entry: LibraryEntryView; drive: boolean }> {
  const { storeId, shopifyProductId, templateId } = input
  const [store, template, existing, newest, profile] = await Promise.all([
    prisma.shopifyStore.findUnique({ where: { id: storeId }, select: { id: true, shop: true, project: { select: { name: true } } } }),
    prisma.printTemplate.findUnique({ where: { id: templateId }, include: { supplier: { select: { id: true, name: true } } } }),
    prisma.artworkEntry.findUnique({ where: { storeId_shopifyProductId_printTemplateId: { storeId, shopifyProductId, printTemplateId: templateId } } }),
    prisma.orderLine.findFirst({ where: { shopifyProductId, order: { storeId } }, orderBy: { order: { placedAt: 'desc' } }, select: { productTitle: true, imageUrl: true } }),
    prisma.productProfile.findUnique({ where: { storeId_shopifyProductId: { storeId, shopifyProductId } }, select: { title: true, imageUrl: true } }),
  ])
  if (!store) throw new LibraryError('Không tìm thấy store', 404)
  if (!template) throw new LibraryError('Không tìm thấy template', 404)
  const title = newest?.productTitle ?? existing?.title ?? profile?.title
  if (!title) throw new LibraryError('Không tìm thấy sản phẩm', 404)
  if (!existing && !(await activeTemplateIds(storeId, shopifyProductId)).has(templateId)) {
    throw new LibraryError('Template này không nhận dòng đơn nào của sản phẩm')
  }

  const numericId = shopifyProductId.split('/').pop() ?? 'product'
  const { file } = await storeLibraryFile({
    temp: input.temp, kind: 'PSD', fileName: input.fileName, mimeType: 'image/vnd.adobe.photoshop',
    relDir: ['psd', storeId, numericId, templateId], uploadedById: input.uploadedById,
  })
  const imageUrl = safeHttpUrl(newest?.imageUrl) ?? existing?.imageUrl ?? safeHttpUrl(profile?.imageUrl) ?? null
  const data = {
    supplierId: template.supplierId, title, imageUrl, status: 'QUEUED', psdFileId: file.id, ...CLEARED_RESULTS,
  }
  const entry = await prisma.$transaction(async tx => {
    const row = await tx.artworkEntry.upsert({
      where: { storeId_shopifyProductId_printTemplateId: { storeId, shopifyProductId, printTemplateId: templateId } },
      create: { storeId, shopifyProductId, printTemplateId: templateId, ...data },
      update: data,
    })
    await tx.artworkJob.updateMany({
      where: { entryId: row.id, status: { in: OPEN_JOB_STATUSES } },
      data: { status: 'FAILED', error: 'Thay bằng PSD mới', finishedAt: new Date() },
    })
    await tx.artworkJob.create({ data: { entryId: row.id, kind: 'PARSE_PSD' } })
    return row
  })
  const drive = file.storage === 'LOCAL' && await isDriveConnected()
  if (drive) pushInBackground(file.id, driveFolderFor(store.project?.name ?? store.shop, title, template.supplier.name, template.name))
  return { entry: (await loadEntryView(entry.id))!, drive }
}

export async function requeueEntry(entryId: string, reason = 'Đọc lại PSD'): Promise<void> {
  const e = await prisma.artworkEntry.findUnique({ where: { id: entryId }, select: { id: true, psdFileId: true } })
  if (!e) throw new LibraryError('Không tìm thấy entry', 404)
  if (!e.psdFileId) throw new LibraryError('Entry chưa có PSD')
  await prisma.$transaction([
    supersedeJobs(entryId, reason),
    prisma.artworkJob.create({ data: { entryId, kind: 'PARSE_PSD' } }),
    prisma.artworkEntry.update({ where: { id: entryId }, data: { status: 'QUEUED', error: null } }),
  ])
}

export async function updateEntry(entryId: string, body: unknown, actor: { id: string }): Promise<LibraryEntryView> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LibraryError('Body không hợp lệ')
  const b = body as Record<string, unknown>
  const e = await prisma.artworkEntry.findUnique({ where: { id: entryId } })
  if (!e) throw new LibraryError('Không tìm thấy entry', 404)

  if (b.reparse === true) {
    await requeueEntry(entryId)
    return (await loadEntryView(entryId))!
  }
  const data: Record<string, unknown> = {}
  if (b.fields !== undefined) {
    if (e.status === 'QUEUED' || e.status === 'PARSING') throw new LibraryError('Đang đọc PSD — sửa sau khi đọc xong', 409)
    try { data.fields = JSON.stringify(normalizeFields(b.fields)) } catch (err: any) { throw new LibraryError(err.message) }
  }
  if (b.notes !== undefined) {
    if (b.notes !== null && typeof b.notes !== 'string') throw new LibraryError('notes phải là chuỗi')
    data.notes = typeof b.notes === 'string' ? (b.notes.trim().slice(0, 4000) || null) : null
  }
  if (b.approve === true) {
    if (e.status !== 'NEEDS_REVIEW') throw new LibraryError('Chỉ xác nhận được entry đang chờ duyệt')
    data.status = 'READY'
    data.approvedAt = new Date()
    data.approvedById = actor.id
  }
  if (Object.keys(data).length === 0) throw new LibraryError('Không có gì để cập nhật')
  if (data.status) {
    const r = await prisma.artworkEntry.updateMany({ where: { id: entryId, status: 'NEEDS_REVIEW' }, data })
    if (r.count === 0) throw new LibraryError('Entry đã đổi trạng thái', 409)
  } else {
    await prisma.artworkEntry.update({ where: { id: entryId }, data })
  }
  return (await loadEntryView(entryId))!
}

export async function deleteEntry(entryId: string): Promise<boolean> {
  const r = await prisma.artworkEntry.deleteMany({ where: { id: entryId } })
  return r.count > 0
}

export async function saveFontUpload(input: { temp: TempFile; fileName: string; uploadedById: string | null }) {
  const ext = input.fileName.split('.').pop()?.toLowerCase() ?? ''
  const mimeType = FONT_MIME[ext]
  if (!mimeType) throw new LibraryError('Chỉ nhận .ttf, .otf, .ttc')
  let names
  try {
    names = parseFontNames(await fsp.readFile(input.temp.tmpPath))
  } catch (err: any) {
    if (err instanceof FontParseError) throw new LibraryError(`Không đọc được font: ${err.message}`)
    throw err
  }
  const { file, reused } = await storeLibraryFile({ temp: input.temp, kind: 'FONT', fileName: input.fileName, mimeType, relDir: ['fonts'], uploadedById: input.uploadedById })
  const fonts = []
  for (const n of names) {
    const row = await prisma.designFont.upsert({
      where: { postscriptName: n.postscriptName },
      create: { postscriptName: n.postscriptName, family: n.family, style: n.style, fileId: file.id, uploadedById: input.uploadedById },
      update: { family: n.family, style: n.style, fileId: file.id, uploadedById: input.uploadedById },
    })
    fonts.push({ id: row.id, postscriptName: row.postscriptName, family: row.family, style: row.style })
  }
  if (!reused && file.storage === 'LOCAL') pushInBackground(file.id, ['Fonts'])
  const requeued = await requeueForFonts(names.map(n => n.postscriptName))
  return { fonts, requeued }
}

export async function requeueForFonts(postscriptNames: string[]): Promise<number> {
  const uploaded = new Set(postscriptNames.map(n => n.toLowerCase()))
  if (uploaded.size === 0) return 0
  const [waiting, known] = await Promise.all([
    prisma.artworkEntry.findMany({ where: { status: 'NEEDS_FONTS' }, select: { id: true, missingFonts: true } }),
    prisma.designFont.findMany({ select: { postscriptName: true } }),
  ])
  const available = new Set(known.map(k => k.postscriptName.toLowerCase()))
  let n = 0
  for (const e of waiting) {
    const missing = parseStrings(e.missingFonts).map(m => m.toLowerCase())
    if (!missing.some(m => uploaded.has(m))) continue
    if (!missing.every(m => available.has(m))) continue
    await requeueEntry(e.id, 'Đã có font mới — đọc lại')
    n++
  }
  return n
}

export async function listFonts(): Promise<LibraryFontRow[]> {
  const [fonts, entries] = await Promise.all([
    prisma.designFont.findMany({ orderBy: [{ family: 'asc' }, { style: 'asc' }], include: { file: true } }),
    prisma.artworkEntry.findMany({ select: { fields: true, fixedTexts: true } }),
  ])
  const usage = new Map<string, number>()
  for (const e of entries) {
    const used = new Set<string>([...parseFields(e.fields).map(f => f.font), ...parseFixedTexts(e.fixedTexts).map(t => t.font)].filter(Boolean).map(s => s.toLowerCase()))
    used.forEach(name => usage.set(name, (usage.get(name) ?? 0) + 1))
  }
  return fonts.map(f => ({
    id: f.id, postscriptName: f.postscriptName, family: f.family, style: f.style, size: f.file.size, fileId: f.fileId,
    fileName: f.file.fileName, storage: f.file.storage, usedBy: usage.get(f.postscriptName.toLowerCase()) ?? 0, createdAt: f.createdAt.toISOString(),
  }))
}

export type WorkerResultInput = {
  fields: ArtworkField[]; fixedTexts: FixedText[]; missingFonts: string[]; warnings: string[]; checkScore: number | null
}

export async function applyParseResult(input: {
  jobId: string; result: WorkerResultInput; artwork: TempFile; preview: TempFile | null
}): Promise<{ entry: LibraryEntryView; status: EntryStatus } | null> {
  const job = await prisma.artworkJob.findUnique({ where: { id: input.jobId }, include: { entry: true } })
  if (!job || job.status !== 'RUNNING') return null
  const entry = job.entry
  const store = async (temp: TempFile, kind: LibraryKind, name: string) => (await storeLibraryFile({
    temp, kind, fileName: name, mimeType: 'image/png', relDir: [kind.toLowerCase(), entry.id], uploadedById: null,
  })).file
  const artworkFile = await store(input.artwork, 'ARTWORK', 'artwork.png')
  const previewFile = input.preview ? await store(input.preview, 'PREVIEW', 'preview.png') : null
  const fields = carryOverEdits(input.result.fields, parseFields(entry.fields))
  const status = resultStatus({ ...input.result, fields })

  const claimed = await prisma.artworkJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { status: 'DONE', error: null, finishedAt: new Date() } })
  if (claimed.count === 0) return null
  await prisma.artworkEntry.update({
    where: { id: entry.id },
    data: {
      status, artworkFileId: artworkFile.id, previewFileId: previewFile?.id ?? null,
      fields: JSON.stringify(fields), fixedTexts: JSON.stringify(input.result.fixedTexts),
      missingFonts: JSON.stringify(input.result.missingFonts), warnings: JSON.stringify(input.result.warnings),
      checkScore: input.result.checkScore, error: null, parsedAt: new Date(), approvedAt: null, approvedById: null,
    },
  })
  if (artworkFile.storage === 'LOCAL') {
    const folder = await entryDriveFolder(entry.id)
    if (folder) pushInBackground(artworkFile.id, folder)
  }
  let finalStatus = status
  if (status === 'NEEDS_FONTS') {
    const known = new Set((await prisma.designFont.findMany({ select: { postscriptName: true } })).map(f => f.postscriptName.toLowerCase()))
    if (input.result.missingFonts.every(m => known.has(m.toLowerCase()))) {
      await requeueEntry(entry.id, 'Font đã có trong lúc đọc — đọc lại')
      finalStatus = 'QUEUED'
    }
  }
  return { entry: (await loadEntryView(entry.id))!, status: finalStatus }
}

export function toProductGid(v: string | null | undefined): string | null {
  const s = (v ?? '').trim()
  if (/^\d+$/.test(s)) return `gid://shopify/Product/${s}`
  return /^gid:\/\/shopify\/Product\/\d+$/.test(s) ? s : null
}

export async function assertUploadTarget(storeId: string, shopifyProductId: string, templateId: string): Promise<void> {
  const [store, template, existing] = await Promise.all([
    prisma.shopifyStore.findUnique({ where: { id: storeId }, select: { id: true } }),
    prisma.printTemplate.findUnique({ where: { id: templateId }, select: { id: true } }),
    prisma.artworkEntry.findUnique({ where: { storeId_shopifyProductId_printTemplateId: { storeId, shopifyProductId, printTemplateId: templateId } }, select: { id: true } }),
  ])
  if (!store) throw new LibraryError('Không tìm thấy store', 404)
  if (!template) throw new LibraryError('Không tìm thấy template', 404)
  if (!existing && !(await activeTemplateIds(storeId, shopifyProductId)).has(templateId)) {
    throw new LibraryError('Template này không nhận dòng đơn nào của sản phẩm')
  }
}
