import { prisma } from '@/lib/db'
import { isNonProductLine } from '@/lib/order-lines'
import { safeHttpUrl } from '@/lib/design-studio'
import { syncDesignTasksCounted } from '@/lib/design-tasks'
import { parseProfileOverrides, type ProductProfileOverride } from '@/lib/product-mapping'
import { recalculateMissingOrderLineCosts } from '@/lib/repos/order-costs'
import { fieldsFromLines, fromRouteKey, OBSERVED_LINE_LIMIT, observationSince, toRouteKey } from '@/lib/product-profiles'

export class ValidationError extends Error {}

export const FROZEN_PIPELINE_STATUSES = ['EXPORTED', 'FULFILLED', 'CANCELLED', 'REFUNDED']
const CLOSED_TASK_STATUSES = ['DONE', 'CANCELLED']

type ProfileRow = NonNullable<Awaited<ReturnType<typeof prisma.productProfile.findUnique>>>

function serializeProfile(p: ProfileRow) {
  return {
    id: p.id, title: p.title, imageUrl: p.imageUrl, supplierProductId: p.supplierProductId,
    overrides: parseProfileOverrides(p.overrides), printTemplateId: p.printTemplateId,
    masterArtworkUrl: safeHttpUrl(p.masterArtworkUrl), notes: p.notes, updatedAt: p.updatedAt.toISOString(),
  }
}

function lineKey(orderId: string, shopifyLineId: string) {
  return `${orderId}::${shopifyLineId}`
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
        shopifyProductType: true, imageUrl: true, customAttributesJson: true, resolvedSupplierId: true, resolvedSupplierSku: true, sku: true,
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

  const lineSupplierIds = Array.from(new Set(lines.map(l => l.resolvedSupplierId).filter((x): x is string => !!x)))
  const supplierNames = new Map((lineSupplierIds.length
    ? await prisma.supplier.findMany({ where: { id: { in: lineSupplierIds } }, select: { id: true, name: true } })
    : []).map(x => [x.id, x.name]))
  const variants = new Map<string, {
    shopifyVariantId: string; variantTitle: string | null; options: Record<string, string>; supplierId: string | null; supplierSku: string | null; supplierName: string | null
  }>()
  for (const l of lines) {
    if (!l.shopifyVariantId || variants.has(l.shopifyVariantId)) continue
    variants.set(l.shopifyVariantId, {
      shopifyVariantId: l.shopifyVariantId, variantTitle: l.variantTitle, options: parseOptions(l.variantOptions),
      supplierId: l.resolvedSupplierId, supplierSku: l.resolvedSupplierSku,
      supplierName: l.resolvedSupplierId ? (supplierNames.get(l.resolvedSupplierId) ?? null) : null,
    })
  }
  const since = observationSince()
  const observed = lines.filter(l => l.order.placedAt >= since && !isNonProductLine(l))
  const fields = fieldsFromLines(observed)
  return {
    key: toRouteKey(storeId, shopifyProductId), storeId, shop: store.shop, shopifyProductId,
    profile: profile ? serializeProfile(profile) : null,
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
  supplierProductId?: unknown; overrides?: unknown; printTemplateId?: unknown; notes?: unknown
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
