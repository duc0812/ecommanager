import { prisma } from '@/lib/db'
import { isNonProductLine } from '@/lib/order-lines'
import { safeHttpUrl } from '@/lib/design-studio'
import { syncDesignTasksCounted } from '@/lib/design-tasks'
import { parseProfileOverrides, profileKey, type ProductProfileOverride } from '@/lib/product-mapping'
import { recalculateMissingOrderLineCosts } from '@/lib/repos/order-costs'
import {
  fieldsFromLines, fromRouteKey, LAYER_FITS, OBSERVED_LINE_LIMIT, observationSince, parseLayerMap, profileStatus, PROFILE_STATUSES, toRouteKey,
  type LayerFit, type LayerMapEntry, type ProfileStatus,
} from '@/lib/product-profiles'

export class ValidationError extends Error {}

export const FROZEN_PIPELINE_STATUSES = ['EXPORTED', 'FULFILLED', 'CANCELLED', 'REFUNDED']
const CLOSED_TASK_STATUSES = ['DONE', 'CANCELLED']

export type ProductListRow = {
  key: string; storeId: string; shop: string; shopifyProductId: string; title: string; imageUrl: string | null
  variantsSeen: number; orderCount: number; openTasks: number; status: ProfileStatus; hasProfile: boolean; lastOrderAt: string
}

type ProfileRow = NonNullable<Awaited<ReturnType<typeof prisma.productProfile.findUnique>>>

function serializeProfile(p: ProfileRow) {
  return {
    id: p.id, title: p.title, imageUrl: p.imageUrl, supplierProductId: p.supplierProductId,
    overrides: parseProfileOverrides(p.overrides), printTemplateId: p.printTemplateId,
    masterArtworkUrl: p.masterArtworkUrl, masterArtworkId: p.masterArtworkId,
    layerMap: parseLayerMap(p.layerMap), notes: p.notes, updatedAt: p.updatedAt.toISOString(),
  }
}

function lineKey(orderId: string, shopifyLineId: string) {
  return `${orderId}::${shopifyLineId}`
}

export async function listProducts(f: { q?: string; status?: ProfileStatus } = {}): Promise<{ products: ProductListRow[]; withoutProductId: number }> {
  const since = observationSince()
  const [lines, openTasks, profiles] = await Promise.all([
    prisma.orderLine.findMany({
      where: { order: { placedAt: { gte: since } } },
      orderBy: { order: { placedAt: 'desc' } },
      select: {
        orderId: true, shopifyLineId: true, shopifyProductId: true, shopifyVariantId: true, productTitle: true,
        shopifyProductType: true, imageUrl: true, customAttributesJson: true,
        order: { select: { storeId: true, placedAt: true, store: { select: { shop: true } } } },
      },
    }),
    prisma.designTask.findMany({
      where: { status: { notIn: CLOSED_TASK_STATUSES }, order: { placedAt: { gte: since } } },
      select: { orderId: true, shopifyLineId: true },
    }),
    prisma.productProfile.findMany(),
  ])
  const openTaskKeys = new Set(openTasks.map(t => lineKey(t.orderId, t.shopifyLineId)))
  const profileByKey = new Map(profiles.map(p => [profileKey(p.storeId, p.shopifyProductId), p]))

  type Group = {
    storeId: string; shop: string; shopifyProductId: string; title: string; imageUrl: string | null; lastOrderAt: Date
    variants: Set<string>; orders: Set<string>; openTasks: number; fieldLines: Array<{ customAttributesJson: string | null }>
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
        storeId: l.order.storeId, shop: l.order.store.shop, shopifyProductId: l.shopifyProductId, title: l.productTitle,
        imageUrl: safeHttpUrl(l.imageUrl), lastOrderAt: l.order.placedAt, variants: new Set(), orders: new Set(), openTasks: 0, fieldLines: [],
      }
      groups.set(key, g)
    }
    if (!g.imageUrl) g.imageUrl = safeHttpUrl(l.imageUrl)
    if (l.shopifyVariantId) g.variants.add(l.shopifyVariantId)
    g.orders.add(l.orderId)
    if (openTaskKeys.has(lineKey(l.orderId, l.shopifyLineId))) g.openTasks++
    if (g.fieldLines.length < OBSERVED_LINE_LIMIT) g.fieldLines.push(l)
  }

  const q = f.q?.trim().toLowerCase()
  const products: ProductListRow[] = []
  for (const [key, g] of Array.from(groups.entries())) {
    const profile = profileByKey.get(key) ?? null
    const status = profileStatus(profile, fieldsFromLines(g.fieldLines))
    if (f.status && status !== f.status) continue
    if (q && !g.title.toLowerCase().includes(q) && !g.shopifyProductId.toLowerCase().includes(q)) continue
    products.push({
      key: toRouteKey(g.storeId, g.shopifyProductId), storeId: g.storeId, shop: g.shop, shopifyProductId: g.shopifyProductId,
      title: g.title, imageUrl: g.imageUrl ?? safeHttpUrl(profile?.imageUrl), variantsSeen: g.variants.size,
      orderCount: g.orders.size, openTasks: g.openTasks, status, hasProfile: !!profile, lastOrderAt: g.lastOrderAt.toISOString(),
    })
  }
  products.sort((a, b) => b.openTasks - a.openTasks || b.orderCount - a.orderCount || a.title.localeCompare(b.title))
  return { products, withoutProductId }
}

export function isProfileStatus(v: string | null | undefined): v is ProfileStatus {
  return !!v && (PROFILE_STATUSES as string[]).includes(v)
}

function parseOptions(json: string | null): Record<string, string> {
  if (!json) return {}
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}

export async function loadProduct(key: string, opts: { includeCost?: boolean } = {}) {
  const parsed = fromRouteKey(key)
  if (!parsed) return null
  const { storeId, shopifyProductId } = parsed
  const [store, profile, lines] = await Promise.all([
    prisma.shopifyStore.findUnique({ where: { id: storeId }, select: { id: true, shop: true } }),
    prisma.productProfile.findUnique({ where: { storeId_shopifyProductId: { storeId, shopifyProductId } } }),
    prisma.orderLine.findMany({
      where: { shopifyProductId, order: { storeId } },
      orderBy: { order: { placedAt: 'desc' } },
      take: OBSERVED_LINE_LIMIT,
      select: {
        orderId: true, shopifyLineId: true, shopifyVariantId: true, variantTitle: true, variantOptions: true, productTitle: true,
        shopifyProductType: true, imageUrl: true, customAttributesJson: true, resolvedSupplierId: true, resolvedSupplierSku: true,
        order: { select: { placedAt: true } },
      },
    }),
  ])
  if (!store || (!profile && lines.length === 0)) return null

  const lineKeys = lines.map(l => ({ orderId: l.orderId, shopifyLineId: l.shopifyLineId }))
  const [openTasks, supplierProducts, templates] = await Promise.all([
    lineKeys.length ? prisma.designTask.count({ where: { status: { notIn: CLOSED_TASK_STATUSES }, OR: lineKeys } }) : 0,
    prisma.supplierProduct.findMany({
      where: { supplier: { isActive: true } },
      orderBy: [{ supplierId: 'asc' }, { sku: 'asc' }],
      select: {
        id: true, sku: true, productName: true, productType: true, baseCost: !!opts.includeCost, supplierId: true,
        variant1Name: true, variant1Value: true, variant2Name: true, variant2Value: true,
        supplier: { select: { name: true, code: true } },
      },
    }),
    prisma.printTemplate.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, supplierId: true, supplierSku: true } }),
  ])

  const variants = new Map<string, { shopifyVariantId: string; variantTitle: string | null; options: Record<string, string>; supplierId: string | null; supplierSku: string | null }>()
  for (const l of lines) {
    if (!l.shopifyVariantId || variants.has(l.shopifyVariantId)) continue
    variants.set(l.shopifyVariantId, {
      shopifyVariantId: l.shopifyVariantId, variantTitle: l.variantTitle, options: parseOptions(l.variantOptions),
      supplierId: l.resolvedSupplierId, supplierSku: l.resolvedSupplierSku,
    })
  }
  const since = observationSince()
  const fields = fieldsFromLines(lines.filter(l => l.order.placedAt >= since && !isNonProductLine(l)))
  return {
    key: toRouteKey(storeId, shopifyProductId), storeId, shop: store.shop, shopifyProductId,
    profile: profile ? serializeProfile(profile) : null,
    status: profileStatus(profile, fields),
    summary: {
      title: lines[0]?.productTitle ?? profile?.title ?? '',
      imageUrl: safeHttpUrl(lines.find(l => safeHttpUrl(l.imageUrl))?.imageUrl) ?? safeHttpUrl(profile?.imageUrl),
      variants: Array.from(variants.values()),
      orderCount: new Set(lines.map(l => l.orderId)).size,
      openTasks,
      lastOrderAt: lines[0]?.order.placedAt.toISOString() ?? null,
    },
    observedFields: fields,
    supplierProducts,
    templates,
  }
}

export type SaveProfileInput = {
  supplierProductId?: unknown; overrides?: unknown; printTemplateId?: unknown
  masterArtworkUrl?: unknown; layerMap?: unknown; notes?: unknown
}

function optionalId(v: unknown, name: string): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  if (typeof v !== 'string') throw new ValidationError(`${name} phải là chuỗi`)
  return v.trim() || null
}

function validateOverrides(v: unknown): ProductProfileOverride[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new ValidationError('overrides phải là danh sách')
  return v.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ValidationError(`overrides[${i}] không hợp lệ`)
    const { combo, supplierProductId } = item as Record<string, unknown>
    if (typeof supplierProductId !== 'string' || !supplierProductId.trim()) throw new ValidationError(`overrides[${i}].supplierProductId bắt buộc`)
    if (!combo || typeof combo !== 'object' || Array.isArray(combo)) throw new ValidationError(`overrides[${i}].combo phải là object`)
    const entries = Object.entries(combo as Record<string, unknown>)
    if (entries.length === 0) throw new ValidationError(`overrides[${i}].combo không được rỗng`)
    const clean: Record<string, string> = {}
    for (const [k, val] of entries) {
      if (!k.trim() || typeof val !== 'string' || !val.trim()) throw new ValidationError(`overrides[${i}].combo chỉ nhận cặp option → giá trị`)
      clean[k.trim()] = val.trim()
    }
    return { combo: clean, supplierProductId: supplierProductId.trim() }
  })
}

function validateLayerMap(v: unknown): LayerMapEntry[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new ValidationError('layerMap phải là danh sách')
  const seenFields = new Set<string>()
  return v.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ValidationError(`layerMap[${i}] không hợp lệ`)
    const { field, layer, font, maxChars, fit } = item as Record<string, unknown>
    if (typeof field !== 'string' || !field.trim()) throw new ValidationError(`layerMap[${i}].field bắt buộc`)
    if (typeof layer !== 'string' || !layer.trim()) throw new ValidationError(`layerMap[${i}].layer bắt buộc`)
    if (font !== undefined && font !== null && typeof font !== 'string') throw new ValidationError(`layerMap[${i}].font phải là chuỗi`)
    if (maxChars !== undefined && maxChars !== null && !(typeof maxChars === 'number' && Number.isInteger(maxChars) && maxChars > 0)) {
      throw new ValidationError(`layerMap[${i}].maxChars phải là số nguyên dương`)
    }
    if (!LAYER_FITS.includes(fit as LayerFit)) throw new ValidationError(`layerMap[${i}].fit phải là shrink, wrap hoặc none`)
    const norm = field.trim().toLowerCase()
    if (seenFields.has(norm)) throw new ValidationError(`layerMap có field trùng: ${field.trim()}`)
    seenFields.add(norm)
    return {
      field: field.trim(), layer: layer.trim(),
      ...(typeof font === 'string' && font.trim() ? { font: font.trim() } : {}),
      ...(typeof maxChars === 'number' ? { maxChars } : {}),
      fit: fit as LayerFit,
    }
  })
}

function validateMasterUrl(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  if (typeof v !== 'string') throw new ValidationError('masterArtworkUrl phải là link http(s)')
  const url = safeHttpUrl(v.trim())
  if (!url) throw new ValidationError('masterArtworkUrl phải là link http(s)')
  return url
}

function validateNotes(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v !== 'string') throw new ValidationError('notes phải là chuỗi')
  return v.trim() || null
}

export async function saveProfile(key: string, input: SaveProfileInput) {
  const parsed = fromRouteKey(key)
  if (!parsed) throw new ValidationError('Mã sản phẩm không hợp lệ')
  const { storeId, shopifyProductId } = parsed
  if (!input || typeof input !== 'object') throw new ValidationError('Body không hợp lệ')

  const supplierProductIdIn = optionalId(input.supplierProductId, 'supplierProductId')
  const overridesIn = validateOverrides(input.overrides)
  const printTemplateIdIn = optionalId(input.printTemplateId, 'printTemplateId')
  const masterIn = validateMasterUrl(input.masterArtworkUrl)
  const layerMapIn = validateLayerMap(input.layerMap)
  const notesIn = validateNotes(input.notes)

  const [store, existing, newestLine] = await Promise.all([
    prisma.shopifyStore.findUnique({ where: { id: storeId }, select: { id: true } }),
    prisma.productProfile.findUnique({ where: { storeId_shopifyProductId: { storeId, shopifyProductId } } }),
    prisma.orderLine.findFirst({
      where: { shopifyProductId, order: { storeId } },
      orderBy: { order: { placedAt: 'desc' } },
      select: { productTitle: true, imageUrl: true },
    }),
  ])
  if (!store) throw new ValidationError('Không tìm thấy store')
  const title = newestLine?.productTitle ?? existing?.title
  if (!title) throw new ValidationError('Không tìm thấy sản phẩm trong đơn hàng')

  const supplierProductId = supplierProductIdIn !== undefined ? supplierProductIdIn : (existing?.supplierProductId ?? null)
  const overrides = overridesIn ?? parseProfileOverrides(existing?.overrides)
  const printTemplateId = printTemplateIdIn !== undefined ? printTemplateIdIn : (existing?.printTemplateId ?? null)

  const spIds = Array.from(new Set([...(supplierProductId ? [supplierProductId] : []), ...overrides.map(o => o.supplierProductId)]))
  const sps = spIds.length
    ? await prisma.supplierProduct.findMany({ where: { id: { in: spIds } }, select: { id: true, sku: true, supplierId: true, supplier: { select: { isActive: true } } } })
    : []
  const missing = spIds.filter(id => !sps.some(s => s.id === id))
  if (missing.length > 0) throw new ValidationError(`Không tìm thấy sản phẩm xưởng: ${missing.join(', ')}`)
  const inactive = sps.filter(s => !s.supplier.isActive)
  if (inactive.length > 0) throw new ValidationError(`Xưởng đã ngừng hoạt động: ${inactive.map(s => s.sku).join(', ')}`)
  if (printTemplateId) {
    const template = await prisma.printTemplate.findUnique({ where: { id: printTemplateId }, select: { supplierId: true } })
    if (!template) throw new ValidationError('Không tìm thấy template')
    const supplierIds = new Set(sps.map(s => s.supplierId))
    if (supplierIds.size > 0 && !supplierIds.has(template.supplierId)) throw new ValidationError('Template thuộc xưởng khác')
  }
  const supplierChanged = !existing
    ? !!supplierProductId || overrides.length > 0
    : (existing.supplierProductId ?? null) !== supplierProductId
      || JSON.stringify(parseProfileOverrides(existing.overrides)) !== JSON.stringify(overrides)

  const data = {
    title,
    imageUrl: safeHttpUrl(newestLine?.imageUrl) ?? existing?.imageUrl ?? null,
    supplierProductId,
    overrides: JSON.stringify(overrides),
    printTemplateId,
    masterArtworkUrl: masterIn !== undefined ? masterIn : (existing?.masterArtworkUrl ?? null),
    layerMap: layerMapIn !== undefined ? JSON.stringify(layerMapIn) : (existing?.layerMap ?? '[]'),
    notes: notesIn !== undefined ? notesIn : (existing?.notes ?? null),
  }
  const profile = await prisma.productProfile.upsert({
    where: { storeId_shopifyProductId: { storeId, shopifyProductId } },
    create: { storeId, shopifyProductId, ...data },
    update: data,
  })
  const reevaluation = supplierChanged
    ? await reevaluateProduct(storeId, shopifyProductId)
    : { ordersUpdated: 0, tasksTouched: 0, errors: [] }
  return { profile: serializeProfile(profile), reevaluation }
}

export async function reevaluateProduct(storeId: string, shopifyProductId: string): Promise<{ ordersUpdated: number; tasksTouched: number; errors: string[] }> {
  const orders = await prisma.order.findMany({
    where: { storeId, pipelineStatus: { notIn: FROZEN_PIPELINE_STATUSES }, lines: { some: { shopifyProductId } } },
    select: { id: true },
  })
  const orderIds = orders.map(o => o.id)
  if (orderIds.length === 0) return { ordersUpdated: 0, tasksTouched: 0, errors: [] }
  const recalc = await recalculateMissingOrderLineCosts({ orderIds, shopifyProductId, refreshExisting: true, preserveUnchangedSnapshot: true })
  const { tasksTouched, errors } = await syncDesignTasksCounted(orderIds)
  const snapshotsUpdated = await refreshTaskSupplierSnapshots(orderIds, shopifyProductId)
  return { ordersUpdated: recalc.changedOrders, tasksTouched: tasksTouched + snapshotsUpdated, errors }
}

async function refreshTaskSupplierSnapshots(orderIds: string[], shopifyProductId: string): Promise<number> {
  const lines = await prisma.orderLine.findMany({
    where: { orderId: { in: orderIds }, shopifyProductId, resolvedSupplierId: { not: null } },
    select: { orderId: true, shopifyLineId: true, resolvedSupplierId: true },
  })
  if (lines.length === 0) return 0
  const [suppliers, tasks] = await Promise.all([
    prisma.supplier.findMany({ where: { id: { in: Array.from(new Set(lines.map(l => l.resolvedSupplierId as string))) } }, select: { id: true, name: true } }),
    prisma.designTask.findMany({
      where: { orderId: { in: orderIds }, status: { notIn: CLOSED_TASK_STATUSES } },
      select: { id: true, orderId: true, shopifyLineId: true, supplierSnapshot: true },
    }),
  ])
  const nameById = new Map(suppliers.map(s => [s.id, s.name]))
  const nameByLine = new Map(lines.map(l => [lineKey(l.orderId, l.shopifyLineId), nameById.get(l.resolvedSupplierId as string) ?? null]))
  let updated = 0
  for (const t of tasks) {
    const name = nameByLine.get(lineKey(t.orderId, t.shopifyLineId))
    if (!name || name === t.supplierSnapshot) continue
    await prisma.designTask.update({ where: { id: t.id }, data: { supplierSnapshot: name } })
    updated++
  }
  return updated
}
