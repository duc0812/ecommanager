import fsp from 'fs/promises'
import { prisma } from '@/lib/db'
import { isNonProductLine } from '@/lib/order-lines'
import { safeHttpUrl } from '@/lib/design-studio'
import { loadTemplateContext, mapTemplate } from '@/lib/print-template-resolve'
import { profileKey } from '@/lib/product-mapping'
import { fieldsFromLines, fromRouteKey, observationSince, toRouteKey } from '@/lib/product-profiles'
export { libraryStateFor } from '@/lib/artwork-library-state'
import {
  carryOverEdits, normalizeFields, normalizeLayerFields, parseFields, parseFixedTexts, parseLayerFields, parseStrings, resultStatus,
  type ArtworkField, type EntryStatus, type FixedText, type LibraryProductStatus,
} from '@/lib/artwork-fields'
import { isCanonicalOptionKey, optionComboLabel, parseArtworkSplits, parseOptionKey, summarizeOptions, withSplit } from '@/lib/artwork-options'
import {
  LIBRARY_LINE_LIMIT, SLOT_LINE_SELECT, assignSlotEntries, buildSlotDrafts, computeProductSlots, productSlotLines, slotStatusSummary,
} from '@/lib/artwork-slots'
import type {
  LibraryChip, LibraryEntryView, LibraryFileView, LibraryFontRow, LibraryListRow, LibraryProductDetail, LibrarySlot, LibraryTemplateView,
} from '@/lib/artwork-library-types'
import { parseFontNames, FontParseError } from '@/lib/font-name'
import { storeLibraryFile, type LibraryKind, type TempFile } from '@/lib/library-storage'
import { pushLibraryFileToDrive } from '@/lib/design-drive-push'
import { isDriveConnected } from '@/lib/google-drive'

export { LIBRARY_LINE_LIMIT }

export class LibraryError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

const CLOSED_TASK_STATUSES = ['DONE', 'CANCELLED']
const OPEN_JOB_STATUSES = ['QUEUED', 'RUNNING']
export const FONT_MIME: Record<string, string> = { ttf: 'font/ttf', otf: 'font/otf', ttc: 'font/collection' }
export const PSD_MAX_BYTES = 1024 * 1024 * 1024
export const FONT_MAX_BYTES = 30 * 1024 * 1024
export const RESULT_MAX_FILE_BYTES = 1024 * 1024 * 1024

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
    id: e.id, storeId: e.storeId, shopifyProductId: e.shopifyProductId, printTemplateId: e.printTemplateId,
    optionKey: e.optionKey, optionLabel: e.optionKey ? optionComboLabel(e.optionKey) : null, supplierId: e.supplierId,
    status: e.status as EntryStatus, psd: fileView(e.psdFile), artwork: fileView(e.artworkFile), preview: fileView(e.previewFile),
    fields: parseFields(e.fields), fixedTexts: parseFixedTexts(e.fixedTexts), missingFonts: parseStrings(e.missingFonts), warnings: parseStrings(e.warnings),
    layerFields: parseLayerFields(e.layerFields),
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

async function supplierMap(ids: string[]) {
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return new Map<string, { id: string; name: string; code: string }>()
  const rows = await prisma.supplier.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, code: true } })
  return new Map(rows.map(r => [r.id, r]))
}

function lineKey(orderId: string, shopifyLineId: string) {
  return `${orderId}::${shopifyLineId}`
}

export async function listLibraryProducts(f: { q?: string; status?: LibraryProductStatus } = {}): Promise<{ products: LibraryListRow[]; withoutProductId: number }> {
  const since = observationSince()
  const [lines, openTasks, profiles, entries] = await Promise.all([
    prisma.orderLine.findMany({
      where: { order: { placedAt: { gte: since } } },
      orderBy: { order: { placedAt: 'desc' } },
      select: { ...SLOT_LINE_SELECT, shopifyVariantId: true, order: { select: { storeId: true, store: { select: { shop: true } } } } },
    }),
    prisma.designTask.findMany({
      where: { status: { notIn: CLOSED_TASK_STATUSES }, order: { placedAt: { gte: since } } },
      select: { orderId: true, shopifyLineId: true },
    }),
    prisma.productProfile.findMany({ select: { storeId: true, shopifyProductId: true, printTemplateId: true, artworkSplits: true, title: true, imageUrl: true } }),
    prisma.artworkEntry.findMany({
      select: {
        id: true, storeId: true, shopifyProductId: true, printTemplateId: true, optionKey: true, supplierId: true, status: true, title: true, imageUrl: true,
        store: { select: { shop: true } },
      },
    }),
  ])
  const openTaskKeys = new Set(openTasks.map(t => lineKey(t.orderId, t.shopifyLineId)))
  const profileByKey = new Map(profiles.map(p => [profileKey(p.storeId, p.shopifyProductId), p]))
  const entriesByKey = new Map<string, typeof entries>()
  for (const e of entries) {
    const k = profileKey(e.storeId, e.shopifyProductId)
    entriesByKey.set(k, [...(entriesByKey.get(k) ?? []), e])
  }

  type Line = (typeof lines)[number]
  type Group = {
    storeId: string; shop: string; shopifyProductId: string; title: string; imageUrl: string | null
    orders: Set<string>; variants: Set<string>; openTasks: number; lines: Line[]
  }
  const groups = new Map<string, Group>()
  let withoutProductId = 0
  for (const l of lines) {
    if (isNonProductLine(l)) continue
    if (!l.shopifyProductId) { withoutProductId++; continue }
    const key = profileKey(l.order.storeId, l.shopifyProductId)
    let g = groups.get(key)
    if (!g) {
      g = {
        storeId: l.order.storeId, shop: l.order.store.shop, shopifyProductId: l.shopifyProductId, title: l.productTitle, imageUrl: safeHttpUrl(l.imageUrl),
        orders: new Set(), variants: new Set(), openTasks: 0, lines: [],
      }
      groups.set(key, g)
    }
    if (!g.imageUrl) g.imageUrl = safeHttpUrl(l.imageUrl)
    g.orders.add(l.orderId)
    if (l.shopifyVariantId) g.variants.add(l.shopifyVariantId)
    if (openTaskKeys.has(lineKey(l.orderId, l.shopifyLineId))) g.openTasks++
    if (g.lines.length < LIBRARY_LINE_LIMIT) g.lines.push(l)
  }
  for (const [key, list] of Array.from(entriesByKey.entries())) {
    if (groups.has(key)) continue
    const e = list[0]
    const profile = profileByKey.get(key)
    groups.set(key, {
      storeId: e.storeId, shop: e.store.shop, shopifyProductId: e.shopifyProductId, title: e.title || profile?.title || '',
      imageUrl: safeHttpUrl(e.imageUrl) ?? safeHttpUrl(profile?.imageUrl), orders: new Set(), variants: new Set(), openTasks: 0, lines: [],
    })
  }

  const q = f.q?.trim().toLowerCase()
  const groupList = Array.from(groups.entries()).filter(([, g]) => !q || g.title.toLowerCase().includes(q) || g.shopifyProductId.toLowerCase().includes(q))
  const ctx = await loadTemplateContext(
    groupList.flatMap(([, g]) => g.lines.filter(l => l.resolvedSupplierId)),
    groupList.map(([key]) => profileByKey.get(key)?.printTemplateId),
  )
  const computed = groupList.map(([key, g]) => {
    const { slots: drafts, unmapped } = buildSlotDrafts(g.lines, profileByKey.get(key) ?? null, ctx)
    const { slots, stale } = assignSlotEntries(drafts, entriesByKey.get(key) ?? [])
    return { key, g, slots, stale, unmapped }
  })
  const suppliers = await supplierMap(computed.flatMap(c => c.slots.map(s => s.supplierId)))

  const products: LibraryListRow[] = []
  for (const { key, g, slots, stale, unmapped } of computed) {
    const status = slotStatusSummary(slots, stale, unmapped)
    if (f.status && status !== f.status) continue
    const chips: LibraryChip[] = slots.map(s => ({
      supplierName: suppliers.get(s.supplierId)?.name ?? '?',
      templateName: s.template?.name ?? null,
      supplierSkus: s.skus,
      optionLabel: s.optionKey ? optionComboLabel(s.optionKey) : null,
      status: s.status,
    }))
    products.push({
      key: toRouteKey(g.storeId, g.shopifyProductId), storeId: g.storeId, shop: g.shop, shopifyProductId: g.shopifyProductId,
      title: g.title, imageUrl: g.imageUrl ?? safeHttpUrl(profileByKey.get(key)?.imageUrl), orderCount: g.orders.size, openTasks: g.openTasks,
      unmapped, status, chips, staleCount: stale.length, variantsSeen: g.variants.size, hasProfile: profileByKey.has(key),
    })
  }
  products.sort((a, b) => b.openTasks - a.openTasks || b.orderCount - a.orderCount || a.title.localeCompare(b.title))
  return { products, withoutProductId }
}

export async function loadLibraryProduct(key: string): Promise<LibraryProductDetail | null> {
  const parsed = fromRouteKey(key)
  if (!parsed) return null
  const { storeId, shopifyProductId } = parsed
  const [store, profile, lines, entries, newest] = await Promise.all([
    prisma.shopifyStore.findUnique({ where: { id: storeId }, select: { id: true, shop: true, project: { select: { name: true } } } }),
    prisma.productProfile.findUnique({ where: { storeId_shopifyProductId: { storeId, shopifyProductId } } }),
    productSlotLines(storeId, shopifyProductId),
    prisma.artworkEntry.findMany({ where: { storeId, shopifyProductId }, include: { ...ENTRY_INCLUDE, printTemplate: true, supplier: { select: { id: true, name: true, code: true } } } }),
    prisma.orderLine.findFirst({ where: { shopifyProductId, order: { storeId } }, orderBy: { order: { placedAt: 'desc' } }, select: { productTitle: true, imageUrl: true } }),
  ])
  if (!store) return null
  if (!profile && lines.length === 0 && entries.length === 0 && !newest) return null

  const { slots: assigned, stale: staleEntries, unmapped, status } = await computeProductSlots(lines, profile, entries)
  const suppliers = await supplierMap(assigned.map(d => d.supplierId))
  const names = await approverNames(entries)

  const slots: LibrarySlot[] = assigned.map(d => ({
    key: d.key,
    title: d.title,
    options: d.options,
    optionKey: d.optionKey,
    optionLabel: d.optionKey ? optionComboLabel(d.optionKey) : null,
    splitOption: d.splitOption,
    splitChoices: d.splitChoices,
    supplier: suppliers.get(d.supplierId) ?? { id: d.supplierId, name: '?', code: '?' },
    supplierSkus: d.skus,
    variants: summarizeVariants(d.lines),
    lineCount: d.lines.length,
    template: d.template,
    status: d.status,
    entry: d.entry ? serializeEntry(d.entry, names) : null,
    inherited: d.inherited,
  }))
  const stale = staleEntries.map(e => ({ template: templateView(e.printTemplate), supplier: e.supplier, entry: serializeEntry(e, names) }))
  const lineKeys = lines.map(l => ({ orderId: l.orderId, shopifyLineId: l.shopifyLineId }))
  const openTasks = lineKeys.length ? await prisma.designTask.count({ where: { status: { notIn: CLOSED_TASK_STATUSES }, OR: lineKeys } }) : 0

  return {
    key: toRouteKey(storeId, shopifyProductId), storeId, shop: store.shop, storeName: store.project?.name ?? store.shop, shopifyProductId,
    title: newest?.productTitle ?? entries[0]?.title ?? profile?.title ?? '',
    imageUrl: safeHttpUrl(lines.find(l => safeHttpUrl(l.imageUrl))?.imageUrl) ?? safeHttpUrl(newest?.imageUrl) ?? safeHttpUrl(entries[0]?.imageUrl) ?? safeHttpUrl(profile?.imageUrl),
    status, slots, stale, unmapped,
    observedFields: fieldsFromLines(lines),
    openTasks,
    orderCount: new Set(lines.map(l => l.orderId)).size,
    legacyMasterUrl: safeHttpUrl(profile?.masterArtworkUrl),
  }
}

export async function loadEntryView(id: string): Promise<LibraryEntryView | null> {
  const row = await loadEntryRow(id)
  if (!row) return null
  return serializeEntry(row, await approverNames([row]))
}

function driveFolderFor(storeName: string, title: string, supplierName: string, templateName: string, optionKey: string): string[] {
  const option = optionKey ? ` - ${optionComboLabel(optionKey)}` : ''
  return ['Library', storeName, title || 'Untitled', `${supplierName} - ${templateName}${option}`]
}

export function pushInBackground(fileId: string, folder: string[]) {
  void pushLibraryFileToDrive(fileId, folder).then(r => {
    if (r.warning) console.error(`[artwork library] drive push ${fileId}: ${r.warning}`)
  }).catch(err => console.error('[artwork library] drive push crashed:', err?.message ?? err))
}

async function entryDriveFolder(entryId: string): Promise<string[] | null> {
  const e = await prisma.artworkEntry.findUnique({
    where: { id: entryId },
    select: {
      title: true, optionKey: true, store: { select: { shop: true, project: { select: { name: true } } } },
      supplier: { select: { name: true } }, printTemplate: { select: { name: true } },
    },
  })
  if (!e) return null
  return driveFolderFor(e.store.project?.name ?? e.store.shop, e.title, e.supplier.name, e.printTemplate.name, e.optionKey)
}

export function slotTarget(templateId: string, optionKey: string): string {
  return `${templateId}|${optionKey}`
}

export async function activeSlotTargets(storeId: string, shopifyProductId: string): Promise<Set<string>> {
  const [profile, lines] = await Promise.all([
    prisma.productProfile.findUnique({ where: { storeId_shopifyProductId: { storeId, shopifyProductId } }, select: { printTemplateId: true, artworkSplits: true } }),
    productSlotLines(storeId, shopifyProductId),
  ])
  const ctx = await loadTemplateContext(lines.filter(l => l.resolvedSupplierId), [profile?.printTemplateId])
  return new Set(buildSlotDrafts(lines, profile, ctx).slots.filter(s => s.templateId).map(s => slotTarget(s.templateId as string, s.optionKey)))
}

export function normalizeOptionKey(raw: string | null | undefined): string {
  const v = (raw ?? '').trim()
  if (!v) return ''
  if (parseOptionKey(v) === null) throw new LibraryError('optionKey không hợp lệ (cần JSON {"Option": "giá trị"})')
  if (!isCanonicalOptionKey(v)) throw new LibraryError('optionKey phải sắp theo tên option, không có khoảng trắng thừa')
  return v
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

function entryUnique(storeId: string, shopifyProductId: string, printTemplateId: string, optionKey: string) {
  return { storeId_shopifyProductId_printTemplateId_optionKey: { storeId, shopifyProductId, printTemplateId, optionKey } }
}

function missingSlotError(optionKey: string): LibraryError {
  return new LibraryError(optionKey
    ? `Sản phẩm không có slot ${optionComboLabel(optionKey)} cho template này`
    : 'Template này không nhận dòng đơn nào của sản phẩm')
}

export async function assertUploadTarget(storeId: string, shopifyProductId: string, templateId: string, rawOptionKey?: string | null): Promise<string> {
  const optionKey = normalizeOptionKey(rawOptionKey)
  const [store, template, existing] = await Promise.all([
    prisma.shopifyStore.findUnique({ where: { id: storeId }, select: { id: true } }),
    prisma.printTemplate.findUnique({ where: { id: templateId }, select: { id: true } }),
    prisma.artworkEntry.findUnique({ where: entryUnique(storeId, shopifyProductId, templateId, optionKey), select: { id: true } }),
  ])
  if (!store) throw new LibraryError('Không tìm thấy store', 404)
  if (!template) throw new LibraryError('Không tìm thấy template', 404)
  if (!existing && !(await activeSlotTargets(storeId, shopifyProductId)).has(slotTarget(templateId, optionKey))) throw missingSlotError(optionKey)
  return optionKey
}

export async function uploadEntryPsd(input: {
  storeId: string; shopifyProductId: string; templateId: string; optionKey?: string; fileName: string; temp: TempFile; uploadedById: string | null
}): Promise<{ entry: LibraryEntryView; drive: boolean }> {
  const { storeId, shopifyProductId, templateId } = input
  const optionKey = normalizeOptionKey(input.optionKey)
  const [store, template, existing, newest, profile] = await Promise.all([
    prisma.shopifyStore.findUnique({ where: { id: storeId }, select: { id: true, shop: true, project: { select: { name: true } } } }),
    prisma.printTemplate.findUnique({ where: { id: templateId }, include: { supplier: { select: { id: true, name: true } } } }),
    prisma.artworkEntry.findUnique({ where: entryUnique(storeId, shopifyProductId, templateId, optionKey) }),
    prisma.orderLine.findFirst({ where: { shopifyProductId, order: { storeId } }, orderBy: { order: { placedAt: 'desc' } }, select: { productTitle: true, imageUrl: true } }),
    prisma.productProfile.findUnique({ where: { storeId_shopifyProductId: { storeId, shopifyProductId } }, select: { title: true, imageUrl: true } }),
  ])
  if (!store) throw new LibraryError('Không tìm thấy store', 404)
  if (!template) throw new LibraryError('Không tìm thấy template', 404)
  const title = newest?.productTitle ?? existing?.title ?? profile?.title
  if (!title) throw new LibraryError('Không tìm thấy sản phẩm', 404)
  if (!existing && !(await activeSlotTargets(storeId, shopifyProductId)).has(slotTarget(templateId, optionKey))) throw missingSlotError(optionKey)

  const numericId = shopifyProductId.split('/').pop() ?? 'product'
  const relDir = ['psd', storeId, numericId, templateId, ...(optionKey ? [optionComboLabel(optionKey)] : [])]
  const { file } = await storeLibraryFile({
    temp: input.temp, kind: 'PSD', fileName: input.fileName, mimeType: 'image/vnd.adobe.photoshop', relDir, uploadedById: input.uploadedById,
  })
  const imageUrl = safeHttpUrl(newest?.imageUrl) ?? existing?.imageUrl ?? safeHttpUrl(profile?.imageUrl) ?? null
  const data = {
    supplierId: template.supplierId, title, imageUrl, status: 'QUEUED', psdFileId: file.id, ...CLEARED_RESULTS,
  }
  const entry = await prisma.$transaction(async tx => {
    const row = await tx.artworkEntry.upsert({
      where: entryUnique(storeId, shopifyProductId, templateId, optionKey),
      create: { storeId, shopifyProductId, printTemplateId: templateId, optionKey, ...data },
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
  if (drive) pushInBackground(file.id, driveFolderFor(store.project?.name ?? store.shop, title, template.supplier.name, template.name, optionKey))
  return { entry: (await loadEntryView(entry.id))!, drive }
}

export async function setArtworkSplit(key: string, body: unknown): Promise<LibraryProductDetail> {
  const parsed = fromRouteKey(key)
  if (!parsed) throw new LibraryError('Mã sản phẩm không hợp lệ')
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LibraryError('Body không hợp lệ')
  const { printTemplateId, optionName } = body as Record<string, unknown>
  if (typeof printTemplateId !== 'string' || !printTemplateId.trim()) throw new LibraryError('printTemplateId bắt buộc')
  if (optionName !== null && (typeof optionName !== 'string' || !optionName.trim())) throw new LibraryError('optionName phải là tên option, hoặc null để gộp lại')
  const { storeId, shopifyProductId } = parsed
  const templateId = printTemplateId.trim()
  const name = typeof optionName === 'string' ? optionName.trim() : null
  const [profile, lines, newest] = await Promise.all([
    prisma.productProfile.findUnique({ where: { storeId_shopifyProductId: { storeId, shopifyProductId } } }),
    productSlotLines(storeId, shopifyProductId),
    prisma.orderLine.findFirst({ where: { shopifyProductId, order: { storeId } }, orderBy: { order: { placedAt: 'desc' } }, select: { productTitle: true, imageUrl: true } }),
  ])
  const current = parseArtworkSplits(profile?.artworkSplits)
  if (name) {
    const ctx = await loadTemplateContext(lines.filter(l => l.resolvedSupplierId), [profile?.printTemplateId])
    const templateLines = buildSlotDrafts(lines, profile, ctx).slots.filter(s => s.templateId === templateId).flatMap(s => s.lines)
    if (templateLines.length === 0) throw new LibraryError('Template này không nhận dòng đơn nào của sản phẩm')
    if (!summarizeOptions(templateLines).some(o => o.name === name)) throw new LibraryError(`Không thấy option "${name}" trên các dòng của template này`)
  }
  const next = withSplit(current, templateId, name)
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    const title = newest?.productTitle ?? profile?.title
    if (!title) throw new LibraryError('Không tìm thấy sản phẩm', 404)
    const artworkSplits = JSON.stringify(next)
    await prisma.productProfile.upsert({
      where: { storeId_shopifyProductId: { storeId, shopifyProductId } },
      create: { storeId, shopifyProductId, title, imageUrl: safeHttpUrl(newest?.imageUrl), artworkSplits },
      update: { artworkSplits },
    })
  }
  const detail = await loadLibraryProduct(key)
  if (!detail) throw new LibraryError('Không tìm thấy sản phẩm', 404)
  return detail
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
  if (b.layerFields !== undefined) {
    let layerFields
    try { layerFields = normalizeLayerFields(b.layerFields) } catch (err: any) { throw new LibraryError(err.message) }
    if (!e.psdFileId) throw new LibraryError('Entry chưa có PSD')
    await prisma.artworkEntry.update({ where: { id: entryId }, data: { layerFields: JSON.stringify(layerFields) } })
    await requeueEntry(entryId, 'Đổi layer custom — đọc lại')
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
