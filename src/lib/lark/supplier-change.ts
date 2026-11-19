import { prisma } from '@/lib/db'
import { safeHttpUrl } from '@/lib/design-studio'
import { syncDesignTasksCounted } from '@/lib/design-tasks'
import { agentTaskState, type AgentTaskState } from '@/lib/design-agent/delivery'
import { workStatesFor, type WorkState } from '@/lib/design-agent/work-state'
import { describeWorkState } from '@/lib/lark/status'
import { lineKeysOf } from '@/lib/order-lines'
import { parseProfileOverrides, profileKey, type ProductProfileOverride } from '@/lib/product-mapping'
import { productionOverride } from '@/lib/production-override'
import { recalculateMissingOrderLineCosts } from '@/lib/repos/order-costs'
import { FROZEN_PIPELINE_STATUSES } from '@/lib/repos/product-profiles'

export const REPLY_ONE_LINE_ONLY = 'Mỗi lần chỉ chuyển xưởng một dòng.'

const MAX_CANDIDATES = 5
const MIN_PARTIAL_NAME = 3
const NO_SUPPLIER = 'chưa có xưởng'
const NO_SKU = 'chưa có'
const CLOSED_TASK_STATUSES = ['DONE', 'CANCELLED']

type Combo = Record<string, string>
type ChangeResult = { changed: boolean; reply: string; error?: string }
type LineSnapshot = {
  lineId: string; orderId: string; shopifyLineId: string; key: string
  resolvedSupplierId: string | null; resolvedSupplierSku: string | null; resolvedBaseCost: number | null
  resolvedShipFirst: number | null; resolvedShipAdditional: number | null; resolvedImportTax: number | null; costSnapshotAt: string | null
}

class LineMoved extends Error {}

/** Lower case, no accents: "Xưởng Mới" and "xuong moi" are the same name. */
function plain(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim()
}

const wordsOf = (text: string) => plain(text).split(/[^a-z0-9]+/).filter(Boolean)
const bySku = (a: { sku: string }, b: { sku: string }) => a.sku.localeCompare(b.sku, 'en', { numeric: true })
const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 500)

function comboOf(json: string | null): Combo {
  if (!json) return {}
  try {
    const parsed = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Combo = {}
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string' && k.trim() && v.trim()) out[k.trim()] = v.trim()
    return out
  } catch { return {} }
}

/** One string per variant, whatever the order or the case of its options: the override matcher ignores both too. */
function comboSignature(combo: Combo): string {
  return JSON.stringify(Object.entries(combo).map(([k, v]) => [plain(k), plain(v)]).sort((a, b) => a[0].localeCompare(b[0])))
}

/** The new override goes first: the list is read top down, and a broader rule above it would keep the variant. */
function withOverride(overrides: ProductProfileOverride[], combo: Combo, supplierProductId: string): ProductProfileOverride[] {
  const signature = comboSignature(combo)
  return [{ combo, supplierProductId }, ...overrides.filter(o => comboSignature(o.combo) !== signature)]
}

async function findSupplier(name: string) {
  const want = plain(name)
  const suppliers = await prisma.supplier.findMany({ where: { isActive: true }, select: { id: true, name: true, code: true }, orderBy: { code: 'asc' } })
  const exact = suppliers.filter(s => plain(s.name) === want || plain(s.code) === want)
  if (exact.length > 0 || want.length < MIN_PARTIAL_NAME) return exact
  return suppliers.filter(s => plain(s.name).includes(want) || plain(s.code).includes(want))
}

type Product = { id: string; sku: string; productName: string | null; productType: string | null; variant1Value: string | null; variant2Value: string | null; printTemplate: { name: string } | null }

/** The one product the message names, or the SKUs to offer when it names none or several. */
function findProduct(products: Product[], supplierSku: string, instruction: string): { product: Product | null; candidates: Product[] } {
  const sku = plain(supplierSku)
  if (sku) {
    const exact = products.filter(p => plain(p.sku) === sku)
    if (exact.length === 1) return { product: exact[0], candidates: [] }
    return { product: null, candidates: (exact.length ? exact : products.filter(p => plain(p.sku).includes(sku))).sort(bySku) }
  }
  const stock = products.map(p => ({ p, words: new Set(wordsOf([p.sku, p.productName, p.productType, p.variant1Value, p.variant2Value].filter(Boolean).join(' '))) }))
  // Words no product carries ("chuyển", "sang") say nothing about the product, so they are left out.
  const asked = Array.from(new Set(wordsOf(instruction))).filter(w => stock.some(s => s.words.has(w)))
  if (asked.length === 0) return { product: null, candidates: [] }
  const fits = stock.filter(s => asked.every(w => s.words.has(w))).map(s => s.p).sort(bySku)
  if (fits.length === 1) return { product: fits[0], candidates: [] }
  if (fits.length > 1) return { product: null, candidates: fits }
  const score = (s: { words: Set<string> }) => asked.filter(w => s.words.has(w)).length
  return { product: null, candidates: stock.filter(s => score(s) > 0).sort((a, b) => score(b) - score(a) || bySku(a.p, b.p)).map(s => s.p) }
}

/** A template of the supplier's own for this SKU. The supplier's default (no SKU) fits no product in particular. */
async function realTemplateName(supplierId: string, product: Product): Promise<string | null> {
  if (product.printTemplate) return product.printTemplate.name
  const templates = await prisma.printTemplate.findMany({ where: { supplierId, supplierSku: { not: null } }, select: { name: true, supplierSku: true } })
  const sku = product.sku.trim().toLowerCase()
  return templates.find(t => (t.supplierSku as string).trim().toLowerCase() === sku)?.name ?? null
}

async function groupOf(storeId: string, shopifyProductId: string, signature: string) {
  const lines = await prisma.orderLine.findMany({
    where: { shopifyProductId, order: { storeId, pipelineStatus: { notIn: FROZEN_PIPELINE_STATUSES } } },
    include: { order: { select: { shopifyOrderNumber: true } } },
  })
  return lines.filter(l => comboSignature(comboOf(l.variantOptions)) === signature)
}

type GroupLine = Awaited<ReturnType<typeof groupOf>>[number]

async function keysOf(group: GroupLine[]): Promise<{ keyOf: Map<string, string>; taskKeyOf: Map<string, string> }> {
  const orderIds = Array.from(new Set(group.map(l => l.orderId)))
  const [tasks, siblings] = await Promise.all([
    prisma.designTask.findMany({ where: { orderId: { in: orderIds } }, select: { orderId: true, shopifyLineId: true, taskKey: true } }),
    prisma.orderLine.findMany({
      where: { orderId: { in: orderIds } },
      select: { orderId: true, shopifyLineId: true, linePosition: true, sku: true, productTitle: true, shopifyProductType: true },
    }),
  ])
  const keyOf = new Map<string, string>()
  const taskKeyOf = new Map<string, string>()
  for (const l of group) {
    const task = tasks.find(t => t.orderId === l.orderId && t.shopifyLineId === l.shopifyLineId)
    if (task) taskKeyOf.set(l.id, task.taskKey)
    const fromPosition = lineKeysOf(l.order.shopifyOrderNumber, siblings.filter(s => s.orderId === l.orderId)).get(l.shopifyLineId)
    keyOf.set(l.id, task?.taskKey ?? fromPosition ?? `${l.order.shopifyOrderNumber.replace(/^#/, '')} (${l.productTitle})`)
  }
  return { keyOf, taskKeyOf }
}

function notFree(key: string, state: WorkState | undefined, now: Date): string {
  if (!state || state.kind === 'UNKNOWN') return `${key}: chưa xác định được ai đang giữ vì dữ liệu từ máy local chưa cập nhật.`
  return describeWorkState(key, state, now)
}

async function supplierNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = Array.from(new Set(ids.filter((x): x is string => !!x)))
  if (wanted.length === 0) return new Map()
  return new Map((await prisma.supplier.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } })).map(s => [s.id, s.name]))
}

/** Costs, task rows and the supplier shown on each task, for the orders of the changed lines only. */
async function settle(lines: Array<{ orderId: string; shopifyLineId: string }>, eventFor: (line: { orderId: string; shopifyLineId: string }) => string | null): Promise<string[]> {
  const orderIds = Array.from(new Set(lines.map(l => l.orderId)))
  const errors: string[] = []
  await recalculateMissingOrderLineCosts({ orderIds }).catch(e => { errors.push(`tính giá vốn: ${errText(e)}`) })
  await syncDesignTasksCounted(orderIds).then(r => errors.push(...r.errors), e => { errors.push(`đồng bộ task: ${errText(e)}`) })
  try {
    const [current, tasks] = await Promise.all([
      prisma.orderLine.findMany({ where: { orderId: { in: orderIds } }, select: { orderId: true, shopifyLineId: true, resolvedSupplierId: true } }),
      prisma.designTask.findMany({ where: { orderId: { in: orderIds } }, select: { id: true, orderId: true, shopifyLineId: true, status: true, supplierSnapshot: true } }),
    ])
    const names = await supplierNames(current.map(l => l.resolvedSupplierId))
    for (const line of lines) {
      const task = tasks.find(t => t.orderId === line.orderId && t.shopifyLineId === line.shopifyLineId)
      if (!task) continue
      const supplierId = current.find(l => l.orderId === line.orderId && l.shopifyLineId === line.shopifyLineId)?.resolvedSupplierId
      const name = supplierId ? names.get(supplierId) ?? null : null
      const message = eventFor(line)
      const open = !CLOSED_TASK_STATUSES.includes(task.status)
      await prisma.designTask.update({
        where: { id: task.id },
        data: {
          ...(open && name && name !== task.supplierSnapshot ? { supplierSnapshot: name } : {}),
          ...(message ? { events: { create: { type: 'SYSTEM', message } } } : {}),
        },
      })
    }
  } catch (e) { errors.push(`ghi sự kiện: ${errText(e)}`) }
  return errors
}

const SETTLE_FAILED = ' Lưu ý: chưa tính lại xong giá vốn hoặc task của các dòng này — hãy bấm đồng bộ lại trên tool.'

export async function changeSupplierFromLark(
  input: { task: AgentTaskState; supplierName: string; supplierSku: string; instruction: string; sender: string }, now: Date = new Date(),
): Promise<ChangeResult> {
  const key = input.task.taskKey
  const refuse = (text: string): ChangeResult => ({ changed: false, reply: `${key}: ${text}` })
  const asked = input.supplierName.replace(/\s+/g, ' ').trim()
  if (!asked) return refuse(`chưa rõ chuyển sang xưởng nào. Hãy ghi tên xưởng và SKU, ví dụ: ${key} chuyển sang Merchize SKU ABC.`)

  const suppliers = await findSupplier(asked)
  if (suppliers.length === 0) return refuse(`không tìm thấy xưởng "${asked}".`)
  if (suppliers.length > 1) {
    return refuse(`"${asked}" khớp nhiều xưởng: ${suppliers.slice(0, MAX_CANDIDATES).map(s => `${s.name} (${s.code})`).join(', ')}. Hãy ghi rõ tên hoặc mã xưởng.`)
  }
  const supplier = suppliers[0]

  const products = await prisma.supplierProduct.findMany({
    where: { supplierId: supplier.id },
    select: { id: true, sku: true, productName: true, productType: true, variant1Value: true, variant2Value: true, printTemplate: { select: { name: true } } },
  })
  const { product, candidates } = findProduct(products, input.supplierSku, input.instruction)
  if (!product) {
    const offer = candidates.slice(0, MAX_CANDIDATES).map(p => p.sku)
    return refuse(`chưa xác định được sản phẩm của ${supplier.name}. Hãy ghi đúng SKU xưởng.${offer.length ? ` Gợi ý: ${offer.join(', ')}` : ' Không có SKU nào gần giống.'}`)
  }

  const templateName = await realTemplateName(supplier.id, product)
  if (!templateName) {
    return refuse(`SKU ${product.sku} của ${supplier.name} chưa có template in riêng (template mặc định của xưởng không được tính). Hãy tạo template cho SKU này trên tool rồi nhắn lại.`)
  }

  const named = await prisma.orderLine.findUnique({
    where: { id: input.task.lineId },
    include: { order: { select: { storeId: true, pipelineStatus: true } } },
  })
  if (!named) return refuse('không tìm thấy dòng đơn này.')
  if (FROZEN_PIPELINE_STATUSES.includes(named.order.pipelineStatus)) return refuse('đơn đã xuất xưởng hoặc đã đóng — không chuyển xưởng được.')
  if (!named.shopifyProductId) return refuse('dòng này không gắn với sản phẩm Shopify nên không chuyển riêng được. Hãy đổi mapping trên tool.')
  const combo = comboOf(named.variantOptions)
  // An empty combo matches every line: saving it would move the whole product.
  if (Object.keys(combo).length === 0) return refuse('dòng này không có thông tin biến thể nên không chuyển riêng được. Hãy đổi mapping của sản phẩm trên tool.')

  const { storeId } = named.order
  const shopifyProductId = named.shopifyProductId
  const found = await groupOf(storeId, shopifyProductId, comboSignature(combo))
  const { keyOf, taskKeyOf } = await keysOf(found)
  const name = (l: { id: string }) => keyOf.get(l.id) as string
  const group = found.sort((a, b) => Number(b.id === named.id) - Number(a.id === named.id) || name(a).localeCompare(name(b), 'en', { numeric: true }))
  if (!group.some(l => l.id === named.id)) return refuse('dòng đơn vừa thay đổi, hãy thử lại.')

  const exported = group.find(l => l.exportedAt)
  if (exported) return refuse(`không chuyển được — dòng ${name(exported)} cùng biến thể đã xuất xưởng.`)

  const withTask = group.filter(l => taskKeyOf.has(l.id))
  const states = new Map<string, AgentTaskState | null>()
  for (const l of withTask) states.set(l.id, l.id === named.id ? input.task : await agentTaskState(taskKeyOf.get(l.id) as string))
  const work = await workStatesFor(Array.from(states.values()).filter((s): s is AgentTaskState => !!s), now)
  for (const l of withTask) {
    const state = work.get(taskKeyOf.get(l.id) as string)
    if (state?.kind !== 'FREE') return refuse(`không chuyển được vì dòng cùng biến thể chưa rảnh — ${notFree(name(l), state, now)}`)
  }

  const prints = await prisma.designArtwork.findMany({
    where: { orderId: { in: Array.from(new Set(group.map(l => l.orderId))) }, kind: 'PRINT', removedAt: null },
    select: { orderId: true, shopifyLineId: true },
  })
  const printed = group.find(l => prints.some(p => p.orderId === l.orderId && p.shopifyLineId === l.shopifyLineId))
  if (printed) return refuse(`không chuyển được — dòng ${name(printed)} cùng biến thể đang có file in. Gỡ file in của xưởng cũ trên tool rồi nhắn lại.`)

  // A line edited by hand, or a variant mapped by hand, is resolved before the product profile: the override would not move it.
  const variantIds = Array.from(new Set(group.map(l => l.shopifyVariantId).filter((x): x is string => !!x)))
  const manual = variantIds.length
    ? await prisma.variantManualMapping.findMany({ where: { shopifyVariantId: { in: variantIds } }, select: { shopifyVariantId: true } })
    : []
  const pinned = group.find(l => productionOverride(l.productionOverrideJson) || manual.some(m => m.shopifyVariantId === l.shopifyVariantId))
  if (pinned) return refuse(`không chuyển được — dòng ${name(pinned)} đang được chỉnh xưởng riêng trên tool (không theo mapping sản phẩm). Hãy đổi xưởng của dòng đó trên tool.`)

  const snapshot: LineSnapshot[] = group.map(l => ({
    lineId: l.id, orderId: l.orderId, shopifyLineId: l.shopifyLineId, key: name(l),
    resolvedSupplierId: l.resolvedSupplierId, resolvedSupplierSku: l.resolvedSupplierSku, resolvedBaseCost: l.resolvedBaseCost,
    resolvedShipFirst: l.resolvedShipFirst, resolvedShipAdditional: l.resolvedShipAdditional, resolvedImportTax: l.resolvedImportTax,
    costSnapshotAt: l.costSnapshotAt ? l.costSnapshotAt.toISOString() : null,
  }))
  try {
    await prisma.$transaction(async tx => {
      const where = { storeId_shopifyProductId: { storeId, shopifyProductId } }
      const profile = await tx.productProfile.findUnique({ where })
      const before = parseProfileOverrides(profile?.overrides)
      const overrides = JSON.stringify(withOverride(before, combo, product.id))
      if (profile) await tx.productProfile.update({ where, data: { overrides } })
      else await tx.productProfile.create({ data: { storeId, shopifyProductId, title: named.productTitle, imageUrl: safeHttpUrl(named.imageUrl), overrides } })
      const moved = await tx.orderLine.updateMany({
        where: { id: { in: group.map(l => l.id) }, exportedAt: null },
        data: { resolvedSupplierId: supplier.id, resolvedSupplierSku: product.sku, resolvedBaseCost: null },
      })
      // A line exported between the check and the write takes the whole change back.
      if (moved.count !== group.length) throw new LineMoved()
      await tx.botMappingChange.create({
        data: {
          taskKey: key, profileKey: profileKey(storeId, shopifyProductId), comboJson: JSON.stringify(combo),
          beforeOverridesJson: JSON.stringify(before), afterSupplierProductId: product.id,
          lineSnapshotJson: JSON.stringify(snapshot), requestedBy: input.sender, createdAt: now,
        },
      })
    })
  } catch (e) {
    if (e instanceof LineMoved) return refuse('không chuyển được — có dòng cùng biến thể vừa được xuất xưởng. Chưa đổi gì.')
    throw e
  }

  const oldNames = await supplierNames(snapshot.map(s => s.resolvedSupplierId))
  const errors = await settle(group, line => {
    const prior = snapshot.find(s => s.orderId === line.orderId && s.shopifyLineId === line.shopifyLineId)
    const old = prior?.resolvedSupplierId ? oldNames.get(prior.resolvedSupplierId) ?? NO_SUPPLIER : NO_SUPPLIER
    return `Chuyển xưởng theo yêu cầu của ${input.sender} trên Lark: ${old} sang ${supplier.name} (${product.sku})`
  })

  const after = await prisma.orderLine.findMany({ where: { id: { in: group.map(l => l.id) } }, select: { id: true, resolvedSupplierId: true, resolvedSupplierSku: true } })
  const elsewhere = group.filter(l => {
    const current = after.find(a => a.id === l.id)
    return !current || current.resolvedSupplierId !== supplier.id || current.resolvedSupplierSku !== product.sku
  })
  const drift = elsewhere.length
    ? ` Lưu ý: ${elsewhere.slice(0, MAX_CANDIDATES).map(name).join(', ')} đang ở SKU khác theo mapping kích cỡ, màu của xưởng — hãy kiểm tra trên tool.`
    : ''
  return {
    changed: true,
    reply: `${key}: đã chuyển sang ${supplier.name}, SKU ${product.sku}, template ${templateName}. Đã đổi ${group.length} dòng cùng biến thể.${drift}${errors.length ? SETTLE_FAILED : ''}`,
    ...(errors.length ? { error: errors.join('; ') } : {}),
  }
}

function parseSnapshot(json: string): LineSnapshot[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter(s => s && typeof s.lineId === 'string') : []
  } catch { return [] }
}

/** Overrides as they were before the change; when the profile was edited since, only this combo is put back. */
function overridesAfterUndo(current: ProductProfileOverride[], before: ProductProfileOverride[], combo: Combo, movedTo: string): ProductProfileOverride[] {
  if (JSON.stringify(current) === JSON.stringify(withOverride(before, combo, movedTo))) return before
  const signature = comboSignature(combo)
  const same = (o: ProductProfileOverride) => comboSignature(o.combo) === signature
  const kept = current.filter(o => !(same(o) && o.supplierProductId === movedTo))
  const prior = before.find(same)
  return prior && !kept.some(same) ? [prior, ...kept] : kept
}

export async function undoSupplierFromLark(input: { task: AgentTaskState; sender: string }): Promise<{ changed: boolean; reply: string; error?: string }> {
  const key = input.task.taskKey
  const refuse = (text: string) => ({ changed: false, reply: `${key}: ${text}` })
  const change = await prisma.botMappingChange.findFirst({ where: { taskKey: key, undoneAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  if (!change) return refuse('chưa có lần chuyển xưởng nào qua Lark để hoàn tác.')

  const combo = comboOf(change.comboJson)
  const signature = comboSignature(combo)
  const later = (await prisma.botMappingChange.findMany({
    where: { profileKey: change.profileKey, undoneAt: null, createdAt: { gte: change.createdAt }, id: { not: change.id } }, orderBy: { createdAt: 'desc' },
  })).find(c => c.createdAt > change.createdAt && comboSignature(comboOf(c.comboJson)) === signature)
  if (later) return refuse(`không hoàn tác được — biến thể này đã được chuyển xưởng lần nữa qua ${later.taskKey}. Hãy hoàn tác lần đó trước.`)

  const snapshot = parseSnapshot(change.lineSnapshotJson)
  const lines = await prisma.orderLine.findMany({
    where: { id: { in: snapshot.map(s => s.lineId) } },
    select: { id: true, orderId: true, shopifyLineId: true, exportedAt: true, order: { select: { pipelineStatus: true } } },
  })
  const present = snapshot.filter(s => lines.some(l => l.id === s.lineId))
  const exported = present.find(s => lines.find(l => l.id === s.lineId)?.exportedAt)
  if (exported) return refuse(`không hoàn tác được — dòng ${exported.key} đã xuất xưởng sau lần chuyển.`)
  const prints = await prisma.designArtwork.findMany({
    where: { orderId: { in: Array.from(new Set(present.map(s => s.orderId))) }, kind: 'PRINT', removedAt: null, createdAt: { gt: change.createdAt } },
    select: { orderId: true, shopifyLineId: true },
  })
  const printed = present.find(s => prints.some(p => p.orderId === s.orderId && p.shopifyLineId === s.shopifyLineId))
  if (printed) return refuse(`không hoàn tác được — dòng ${printed.key} đã có file in làm sau lần chuyển.`)

  // A line whose order was closed since stays as it is: closed orders are never re-mapped.
  const restore = present.filter(s => !FROZEN_PIPELINE_STATUSES.includes(lines.find(l => l.id === s.lineId)?.order.pipelineStatus ?? ''))
  const [storeId, ...rest] = change.profileKey.split('|')
  const shopifyProductId = rest.join('|')
  try {
    await prisma.$transaction(async tx => {
      const where = { storeId_shopifyProductId: { storeId, shopifyProductId } }
      const profile = await tx.productProfile.findUnique({ where })
      if (profile) {
        const overrides = overridesAfterUndo(parseProfileOverrides(profile.overrides), parseProfileOverrides(change.beforeOverridesJson), combo, change.afterSupplierProductId)
        await tx.productProfile.update({ where, data: { overrides: JSON.stringify(overrides) } })
      }
      for (const s of restore) {
        const back = await tx.orderLine.updateMany({
          where: { id: s.lineId, exportedAt: null },
          data: {
            resolvedSupplierId: s.resolvedSupplierId, resolvedSupplierSku: s.resolvedSupplierSku, resolvedBaseCost: s.resolvedBaseCost,
            resolvedShipFirst: s.resolvedShipFirst, resolvedShipAdditional: s.resolvedShipAdditional, resolvedImportTax: s.resolvedImportTax,
            costSnapshotAt: s.costSnapshotAt ? new Date(s.costSnapshotAt) : null,
          },
        })
        if (back.count !== 1) throw new LineMoved()
      }
      const marked = await tx.botMappingChange.updateMany({ where: { id: change.id, undoneAt: null }, data: { undoneAt: new Date() } })
      if (marked.count !== 1) throw new LineMoved()
    })
  } catch (e) {
    if (e instanceof LineMoved) return refuse('không hoàn tác được — có dòng vừa được xuất xưởng hoặc lần chuyển này vừa được hoàn tác. Chưa đổi gì.')
    throw e
  }

  const moved = await prisma.supplierProduct.findUnique({ where: { id: change.afterSupplierProductId }, select: { supplier: { select: { name: true } } } })
  const names = await supplierNames(snapshot.map(s => s.resolvedSupplierId))
  const oldName = (s: LineSnapshot | undefined) => (s?.resolvedSupplierId ? names.get(s.resolvedSupplierId) ?? NO_SUPPLIER : NO_SUPPLIER)
  const errors = await settle(restore, line => {
    const prior = restore.find(s => s.orderId === line.orderId && s.shopifyLineId === line.shopifyLineId)
    return `Hoàn tác chuyển xưởng theo yêu cầu của ${input.sender} trên Lark: ${moved?.supplier.name ?? NO_SUPPLIER} về ${oldName(prior)} (${prior?.resolvedSupplierSku ?? NO_SKU})`
  })
  const own = snapshot.find(s => s.lineId === input.task.lineId) ?? snapshot[0]
  return {
    changed: true,
    reply: `${key}: đã hoàn tác, trả về ${oldName(own)}, SKU ${own?.resolvedSupplierSku ?? NO_SKU}. Đã đổi lại ${restore.length} dòng cùng biến thể.${errors.length ? SETTLE_FAILED : ''}`,
    ...(errors.length ? { error: errors.join('; ') } : {}),
  }
}
