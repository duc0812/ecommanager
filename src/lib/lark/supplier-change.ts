import { prisma } from '@/lib/db'
import { safeHttpUrl } from '@/lib/design-studio'
import { syncDesignTasksCounted } from '@/lib/design-tasks'
import { agentTaskState, type AgentTaskState } from '@/lib/design-agent/delivery'
import { workStatesFor, type WorkState } from '@/lib/design-agent/work-state'
import { describeWorkState } from '@/lib/lark/status'
import { lineKeysOf } from '@/lib/order-lines'
import { loadTemplateContext, pickTemplate } from '@/lib/print-template-resolve'
import { parseProfileOverrides, profileKey, type ProductProfileOverride } from '@/lib/product-mapping'
import { productionOverride } from '@/lib/production-override'
import { loadLineResolver, recalculateMissingOrderLineCosts } from '@/lib/repos/order-costs'
import { FROZEN_PIPELINE_STATUSES } from '@/lib/repos/product-profiles'

export const REPLY_ONE_LINE_ONLY = 'Mỗi lần chỉ chuyển xưởng một dòng.'

const MAX_CANDIDATES = 5
const MIN_PARTIAL_NAME = 3
const MIN_SURE_WORDS = 2
const NO_SUPPLIER = 'chưa có xưởng'
const NO_SKU = 'chưa có'
const CLOSED_TASK_STATUSES = ['DONE', 'CANCELLED']

type Combo = Record<string, string>
type ChangeResult = { changed: boolean; reply: string; error?: string }
type LineRef = { orderId: string; shopifyLineId: string }
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
const sameLine = (a: LineRef, b: LineRef) => a.orderId === b.orderId && a.shopifyLineId === b.shopifyLineId
const listed = (keys: string[]) => `${keys.slice(0, MAX_CANDIDATES).join(', ')}${keys.length > MAX_CANDIDATES ? '…' : ''}`

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

/** Overrides as they were before the change; when the profile was edited since, only this combo is put back. */
function withoutOverride(current: ProductProfileOverride[], before: ProductProfileOverride[], combo: Combo, movedTo: string): ProductProfileOverride[] {
  if (JSON.stringify(current) === JSON.stringify(withOverride(before, combo, movedTo))) return before
  const signature = comboSignature(combo)
  const same = (o: ProductProfileOverride) => comboSignature(o.combo) === signature
  const kept = current.filter(o => !(same(o) && o.supplierProductId === movedTo))
  const prior = before.find(same)
  return prior && !kept.some(same) ? [prior, ...kept] : kept
}

async function findSupplier(name: string) {
  const want = plain(name)
  const suppliers = await prisma.supplier.findMany({ where: { isActive: true }, select: { id: true, name: true, code: true }, orderBy: { code: 'asc' } })
  const exact = suppliers.filter(s => plain(s.name) === want || plain(s.code) === want)
  if (exact.length > 0 || want.length < MIN_PARTIAL_NAME) return exact
  return suppliers.filter(s => plain(s.name).includes(want) || plain(s.code).includes(want))
}

type Product = { id: string; sku: string; productName: string | null; productType: string | null; variant1Value: string | null; variant2Value: string | null; printTemplateId: string | null }

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
  if (fits.length === 1) {
    // One stray word that happens to sit in a single product name is not a choice: it takes two words, the SKU or the whole name.
    const said = plain(instruction).split(' ')
    const only = fits[0]
    const sure = asked.length >= MIN_SURE_WORDS || said.includes(plain(only.sku)) || (!!only.productName && said.includes(plain(only.productName)))
    return sure ? { product: only, candidates: [] } : { product: null, candidates: fits }
  }
  if (fits.length > 1) return { product: null, candidates: fits }
  const score = (s: { words: Set<string> }) => asked.filter(w => s.words.has(w)).length
  return { product: null, candidates: stock.filter(s => score(s) > 0).sort((a, b) => score(b) - score(a) || bySku(a.p, b.p)).map(s => s.p) }
}

type TemplateAfter = { name: string | null; real: boolean; fallback: boolean; pinned: boolean }

/**
 * The template the tool will show for the line once it sits on the new supplier and SKU, found with the tool's own picker.
 * It is real when it belongs to that supplier, carries a SKU of its own, and is either linked to the product or named after
 * its SKU. The supplier's default (no SKU) and a product pin made for another SKU fit no product in particular.
 */
async function templateAfterChange(
  line: { orderId: string; shopifyProductId: string; shopifyProductType: string | null }, profile: { printTemplateId: string | null } | null, supplierId: string, product: Product,
): Promise<TemplateAfter> {
  const lookup = { ...line, resolvedSupplierId: supplierId, resolvedSupplierSku: product.sku }
  const picked = pickTemplate(lookup, profile, await loadTemplateContext([lookup], [profile?.printTemplateId]))
  if (!picked) return { name: null, real: false, fallback: true, pinned: false }
  const row = await prisma.printTemplate.findUnique({ where: { id: picked.id }, select: { supplierId: true, supplierSku: true } })
  const ownSku = row?.supplierSku ?? null
  const real = !!row && row.supplierId === supplierId && ownSku !== null
    && (picked.id === product.printTemplateId || ownSku.trim().toLowerCase() === product.sku.trim().toLowerCase())
  return { name: picked.name, real, fallback: !!row && ownSku === null, pinned: !!profile?.printTemplateId && picked.id === profile.printTemplateId }
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
    const task = tasks.find(t => sameLine(t, l))
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

/** Costs and task rows, for the orders of the changed lines only. */
async function settleOrders(orderIds: string[]): Promise<string[]> {
  const errors: string[] = []
  await recalculateMissingOrderLineCosts({ orderIds }).catch(e => { errors.push(`tính giá vốn: ${errText(e)}`) })
  await syncDesignTasksCounted(orderIds).then(r => errors.push(...r.errors), e => { errors.push(`đồng bộ task: ${errText(e)}`) })
  return errors
}

/** The supplier shown on each task and the event that says why it changed. */
async function noteOnTasks(lines: LineRef[], eventFor: (line: LineRef) => string): Promise<string[]> {
  if (lines.length === 0) return []
  try {
    const orderIds = Array.from(new Set(lines.map(l => l.orderId)))
    const [current, tasks] = await Promise.all([
      prisma.orderLine.findMany({ where: { orderId: { in: orderIds } }, select: { orderId: true, shopifyLineId: true, resolvedSupplierId: true } }),
      prisma.designTask.findMany({ where: { orderId: { in: orderIds } }, select: { id: true, orderId: true, shopifyLineId: true, status: true, supplierSnapshot: true } }),
    ])
    const names = await supplierNames(current.map(l => l.resolvedSupplierId))
    for (const line of lines) {
      const task = tasks.find(t => sameLine(t, line))
      if (!task) continue
      const supplierId = current.find(l => sameLine(l, line))?.resolvedSupplierId
      const name = supplierId ? names.get(supplierId) ?? null : null
      const open = !CLOSED_TASK_STATUSES.includes(task.status)
      await prisma.designTask.update({
        where: { id: task.id },
        data: {
          ...(open && name && name !== task.supplierSnapshot ? { supplierSnapshot: name } : {}),
          events: { create: { type: 'SYSTEM', message: eventFor(line) } },
        },
      })
    }
    return []
  } catch (e) { return [`ghi sự kiện: ${errText(e)}`] }
}

/**
 * The first group line that did not land where the message asked: today's mapping must give it the named product by
 * itself, and the cost refresh must have priced it there. The values written before the refresh prove nothing.
 */
async function firstNotLanded(group: GroupLine[], supplierId: string, product: Product): Promise<{ line: GroupLine; resolvedSku: string | null; mapped: boolean } | null> {
  const [resolveLine, current] = await Promise.all([
    loadLineResolver(),
    prisma.orderLine.findMany({
      where: { id: { in: group.map(l => l.id) } },
      select: {
        id: true, productionOverrideJson: true, shopifyVariantId: true, shopifyProductType: true, variantOptions: true, shopifyProductId: true,
        resolvedSupplierId: true, resolvedSupplierSku: true, resolvedBaseCost: true, order: { select: { storeId: true, shippingCountry: true } },
      },
    }),
  ])
  for (const line of group) {
    const now = current.find(c => c.id === line.id)
    const resolved = now ? resolveLine(now) : null
    const mapped = resolved?.id === product.id
    if (!now || !mapped || now.resolvedSupplierId !== supplierId || now.resolvedSupplierSku !== product.sku || now.resolvedBaseCost == null) {
      return { line, resolvedSku: resolved?.sku ?? null, mapped }
    }
  }
  return null
}

function restoreData(s: LineSnapshot) {
  return {
    resolvedSupplierId: s.resolvedSupplierId, resolvedSupplierSku: s.resolvedSupplierSku, resolvedBaseCost: s.resolvedBaseCost,
    resolvedShipFirst: s.resolvedShipFirst, resolvedShipAdditional: s.resolvedShipAdditional, resolvedImportTax: s.resolvedImportTax,
    costSnapshotAt: s.costSnapshotAt ? new Date(s.costSnapshotAt) : null,
  }
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
    select: { id: true, sku: true, productName: true, productType: true, variant1Value: true, variant2Value: true, printTemplateId: true },
  })
  const { product, candidates } = findProduct(products, input.supplierSku, input.instruction)
  if (!product) {
    const offer = candidates.slice(0, MAX_CANDIDATES).map(p => p.sku)
    return refuse(`chưa xác định được sản phẩm của ${supplier.name}. Hãy ghi đúng SKU xưởng.${offer.length ? ` Gợi ý: ${offer.join(', ')}` : ' Không có SKU nào gần giống.'}`)
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
  const profileWhere = { storeId_shopifyProductId: { storeId, shopifyProductId } }
  const pin = await prisma.productProfile.findUnique({ where: profileWhere, select: { printTemplateId: true } })
  const template = await templateAfterChange({ orderId: named.orderId, shopifyProductId, shopifyProductType: named.shopifyProductType }, pin, supplier.id, product)
  if (!template.real) {
    if (!template.name || template.fallback) {
      return refuse(`SKU ${product.sku} của ${supplier.name} chưa có template in riêng (template mặc định của xưởng không được tính). Hãy tạo template cho SKU này trên tool rồi nhắn lại.`)
    }
    return refuse(template.pinned
      ? `SKU ${product.sku} của ${supplier.name} sẽ dùng template "${template.name}" đang ghim ở sản phẩm, không phải template riêng của SKU này. Hãy sửa template của sản phẩm trên tool rồi nhắn lại.`
      : `SKU ${product.sku} của ${supplier.name} sẽ dùng template "${template.name}", không phải template riêng của SKU này. Hãy gắn template cho SKU này trên tool rồi nhắn lại.`)
  }

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
    // Auto render has not started anything: a line waiting for its hourly pass moves like a free one.
    if (state?.kind !== 'FREE' && state?.kind !== 'AUTO') return refuse(`không chuyển được vì dòng cùng biến thể chưa rảnh — ${notFree(name(l), state, now)}`)
  }

  const orderIds = Array.from(new Set(group.map(l => l.orderId)))
  const prints = await prisma.designArtwork.findMany({
    where: { orderId: { in: orderIds }, kind: 'PRINT', removedAt: null },
    select: { orderId: true, shopifyLineId: true },
  })
  const printed = group.find(l => prints.some(p => sameLine(p, l)))
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
  let written: { changeId: string; before: ProductProfileOverride[]; createdProfileId: string | null }
  try {
    written = await prisma.$transaction(async tx => {
      const profile = await tx.productProfile.findUnique({ where: profileWhere })
      const before = parseProfileOverrides(profile?.overrides)
      const overrides = JSON.stringify(withOverride(before, combo, product.id))
      let createdProfileId: string | null = null
      if (profile) await tx.productProfile.update({ where: profileWhere, data: { overrides } })
      else createdProfileId = (await tx.productProfile.create({ data: { storeId, shopifyProductId, title: named.productTitle, imageUrl: safeHttpUrl(named.imageUrl), overrides } })).id
      const moved = await tx.orderLine.updateMany({
        where: { id: { in: group.map(l => l.id) }, exportedAt: null },
        data: { resolvedSupplierId: supplier.id, resolvedSupplierSku: product.sku, resolvedBaseCost: null },
      })
      // A line exported between the check and the write takes the whole change back.
      if (moved.count !== group.length) throw new LineMoved()
      const row = await tx.botMappingChange.create({
        data: {
          taskKey: key, profileKey: profileKey(storeId, shopifyProductId), comboJson: JSON.stringify(combo),
          beforeOverridesJson: JSON.stringify(before), afterSupplierProductId: product.id,
          lineSnapshotJson: JSON.stringify(snapshot), requestedBy: input.sender, createdAt: now,
        },
      })
      return { changeId: row.id, before, createdProfileId }
    })
  } catch (e) {
    if (e instanceof LineMoved) return refuse('không chuyển được — có dòng cùng biến thể vừa được xuất xưởng. Chưa đổi gì.')
    throw e
  }

  const errors = await settleOrders(orderIds)
  const stray = await firstNotLanded(group, supplier.id, product)
  if (stray) {
    await prisma.$transaction(async tx => {
      if (written.createdProfileId) await tx.productProfile.deleteMany({ where: { id: written.createdProfileId } })
      else {
        const profile = await tx.productProfile.findUnique({ where: profileWhere })
        if (profile) {
          const overrides = withoutOverride(parseProfileOverrides(profile.overrides), written.before, combo, product.id)
          await tx.productProfile.update({ where: profileWhere, data: { overrides: JSON.stringify(overrides) } })
        }
      }
      for (const s of snapshot) await tx.orderLine.updateMany({ where: { id: s.lineId }, data: restoreData(s) })
      await tx.botMappingChange.deleteMany({ where: { id: written.changeId } })
    })
    const undoErrors = await settleOrders(orderIds)
    const why = stray.mapped
      ? `chưa tính được giá vốn theo SKU ${product.sku}`
      : stray.resolvedSku
        ? `mapping của ${supplier.name} đưa dòng này về SKU ${stray.resolvedSku}, không phải ${product.sku}`
        : `mapping của ${supplier.name} không tìm được SKU đúng kích cỡ, màu của dòng này khi dùng ${product.sku}`
    const failed = [...errors, ...undoErrors]
    return { ...refuse(`không chuyển được — dòng ${name(stray.line)}: ${why}. Chưa đổi gì.`), ...(failed.length ? { error: failed.join('; ') } : {}) }
  }

  const oldNames = await supplierNames(snapshot.map(s => s.resolvedSupplierId))
  errors.push(...await noteOnTasks(group, line => {
    const prior = snapshot.find(s => sameLine(s, line))
    const old = prior?.resolvedSupplierId ? oldNames.get(prior.resolvedSupplierId) ?? NO_SUPPLIER : NO_SUPPLIER
    return `Chuyển xưởng theo yêu cầu của ${input.sender} trên Lark: ${old} sang ${supplier.name} (${product.sku})`
  }))
  return {
    changed: true,
    reply: `${key}: đã chuyển sang ${supplier.name}, SKU ${product.sku}, template ${template.name}. Đã đổi ${group.length} dòng cùng biến thể.${errors.length ? SETTLE_FAILED : ''}`,
    ...(errors.length ? { error: errors.join('; ') } : {}),
  }
}

function parseSnapshot(json: string): LineSnapshot[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter(s => s && typeof s.lineId === 'string') : []
  } catch { return [] }
}

export async function undoSupplierFromLark(input: { task: AgentTaskState; sender: string }): Promise<{ changed: boolean; reply: string; error?: string }> {
  const key = input.task.taskKey
  const refuse = (text: string) => ({ changed: false, reply: `${key}: ${text}` })
  const change = await prisma.botMappingChange.findFirst({ where: { taskKey: key, undoneAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  if (!change) return refuse('chưa có lần chuyển xưởng nào qua Lark để hoàn tác.')

  const combo = comboOf(change.comboJson)
  const signature = comboSignature(combo)
  const later = (await prisma.botMappingChange.findMany({
    where: { profileKey: change.profileKey, undoneAt: null, createdAt: { gt: change.createdAt }, id: { not: change.id } }, orderBy: { createdAt: 'desc' },
  })).find(c => comboSignature(comboOf(c.comboJson)) === signature)
  if (later) return refuse(`không hoàn tác được — biến thể này đã được chuyển xưởng lần nữa qua ${later.taskKey}. Hãy hoàn tác lần đó trước.`)

  const movedTo = await prisma.supplierProduct.findUnique({
    where: { id: change.afterSupplierProductId }, select: { sku: true, supplierId: true, supplier: { select: { name: true } } },
  })
  if (!movedTo) return refuse('không hoàn tác được — sản phẩm xưởng của lần chuyển không còn trong hệ thống. Hãy sửa mapping trên tool.')

  const [storeId, ...rest] = change.profileKey.split('|')
  const shopifyProductId = rest.join('|')
  const profileWhere = { storeId_shopifyProductId: { storeId, shopifyProductId } }
  const sameCombo = (o: ProductProfileOverride) => comboSignature(o.combo) === signature
  const pointsTo = parseProfileOverrides((await prisma.productProfile.findUnique({ where: profileWhere, select: { overrides: true } }))?.overrides).find(sameCombo)
  if (pointsTo && pointsTo.supplierProductId !== change.afterSupplierProductId) {
    const other = await prisma.supplierProduct.findUnique({ where: { id: pointsTo.supplierProductId }, select: { sku: true, supplier: { select: { name: true } } } })
    return refuse(`không hoàn tác được — mapping của biến thể này đã được sửa sau lần chuyển, hiện trỏ tới ${other ? `SKU ${other.sku} của ${other.supplier.name}` : 'một sản phẩm xưởng khác'}. Hãy sửa trên tool.`)
  }

  const snapshot = parseSnapshot(change.lineSnapshotJson)
  const lines = await prisma.orderLine.findMany({
    where: { id: { in: snapshot.map(s => s.lineId) } },
    select: { id: true, exportedAt: true, resolvedSupplierId: true, resolvedSupplierSku: true, order: { select: { pipelineStatus: true } } },
  })
  const lineOf = (s: LineSnapshot) => lines.find(l => l.id === s.lineId)
  const present = snapshot.filter(s => lineOf(s))
  const exported = present.find(s => lineOf(s)?.exportedAt)
  if (exported) return refuse(`không hoàn tác được — dòng ${exported.key} đã xuất xưởng sau lần chuyển.`)
  const prints = await prisma.designArtwork.findMany({
    where: { orderId: { in: Array.from(new Set(present.map(s => s.orderId))) }, kind: 'PRINT', removedAt: null, createdAt: { gt: change.createdAt } },
    select: { orderId: true, shopifyLineId: true },
  })
  const printed = present.find(s => prints.some(p => sameLine(p, s)))
  if (printed) return refuse(`không hoàn tác được — dòng ${printed.key} đã có file in làm sau lần chuyển.`)

  // A line whose order was closed since stays as it is: closed orders are never re-mapped.
  const open = present.filter(s => !FROZEN_PIPELINE_STATUSES.includes(lineOf(s)?.order.pipelineStatus ?? ''))
  const onTarget = { resolvedSupplierId: movedTo.supplierId, resolvedSupplierSku: movedTo.sku }
  const stillThere = (s: LineSnapshot) => lineOf(s)?.resolvedSupplierId === onTarget.resolvedSupplierId && lineOf(s)?.resolvedSupplierSku === onTarget.resolvedSupplierSku
  // A line somebody moved again since the change is theirs now: putting the old supplier back would undo their work.
  const restore = open.filter(stillThere)
  const leftAlone = open.filter(s => !stillThere(s))
  try {
    await prisma.$transaction(async tx => {
      const profile = await tx.productProfile.findUnique({ where: profileWhere })
      if (profile) {
        const current = parseProfileOverrides(profile.overrides)
        const edited = current.find(sameCombo)
        if (edited && edited.supplierProductId !== change.afterSupplierProductId) throw new LineMoved()
        const overrides = withoutOverride(current, parseProfileOverrides(change.beforeOverridesJson), combo, change.afterSupplierProductId)
        await tx.productProfile.update({ where: profileWhere, data: { overrides: JSON.stringify(overrides) } })
      }
      for (const s of restore) {
        const back = await tx.orderLine.updateMany({ where: { id: s.lineId, exportedAt: null, ...onTarget }, data: restoreData(s) })
        if (back.count !== 1) throw new LineMoved()
      }
      const marked = await tx.botMappingChange.updateMany({ where: { id: change.id, undoneAt: null }, data: { undoneAt: new Date() } })
      if (marked.count !== 1) throw new LineMoved()
    })
  } catch (e) {
    if (e instanceof LineMoved) return refuse('không hoàn tác được — có dòng hoặc mapping của biến thể vừa thay đổi. Chưa đổi gì, hãy thử lại.')
    throw e
  }

  const names = await supplierNames(snapshot.map(s => s.resolvedSupplierId))
  const oldName = (s: LineSnapshot | undefined) => (s?.resolvedSupplierId ? names.get(s.resolvedSupplierId) ?? NO_SUPPLIER : NO_SUPPLIER)
  const errors = await settleOrders(Array.from(new Set(restore.map(s => s.orderId))))
  errors.push(...await noteOnTasks(restore, line => {
    const prior = restore.find(s => sameLine(s, line))
    return `Hoàn tác chuyển xưởng theo yêu cầu của ${input.sender} trên Lark: ${movedTo.supplier.name} về ${oldName(prior)} (${prior?.resolvedSupplierSku ?? NO_SKU})`
  }))

  // Orders of the same variant that came in after the change were mapped by the override and are in no snapshot.
  const known = new Set(snapshot.map(s => s.lineId))
  const newer = (await groupOf(storeId, shopifyProductId, signature))
    .filter(l => !known.has(l.id) && l.resolvedSupplierId === onTarget.resolvedSupplierId && l.resolvedSupplierSku === onTarget.resolvedSupplierSku)
  const newerKeys = newer.length ? (await keysOf(newer)).keyOf : new Map<string, string>()
  const newerNames = newer.map(l => newerKeys.get(l.id) as string).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))

  const own = snapshot.find(s => s.lineId === input.task.lineId) ?? snapshot[0]
  const kept = leftAlone.length ? ` Giữ nguyên ${listed(leftAlone.map(s => s.key))} vì đã được đổi xưởng sau lần chuyển.` : ''
  const after = newer.length ? ` Còn ${newer.length} dòng cùng biến thể đến sau lần chuyển vẫn ở ${movedTo.supplier.name}: ${listed(newerNames)}. Hãy kiểm tra trên tool.` : ''
  return {
    changed: true,
    reply: `${key}: đã hoàn tác, trả về ${oldName(own)}, SKU ${own?.resolvedSupplierSku ?? NO_SKU}. Đã đổi lại ${restore.length} dòng cùng biến thể.${kept}${after}${errors.length ? SETTLE_FAILED : ''}`,
    ...(errors.length ? { error: errors.join('; ') } : {}),
  }
}
