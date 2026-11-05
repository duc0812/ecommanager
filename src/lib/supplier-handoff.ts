import { prisma } from '@/lib/db'
import { isNonProductLine, lineKeysOf } from '@/lib/order-lines'
import { loadWorkspace, type Workspace } from '@/lib/design-studio'
import { requiredSlotsFor, templateForLine } from '@/lib/design-tasks'
import { templateViewFor } from '@/lib/print-template-resolve'
import { STATUS_LABELS, type PipelineStatus } from '@/lib/pipeline-status'
import { countryCodeOf, countryNameOf } from '@/lib/shipping-address'
import { credentialsOf, getPgprintsSettings } from '@/lib/pgprints-settings'
import { isPgprintsSupplier } from '@/lib/pgprints-shared'
import { isMerchizeSupplier, merchizeCredentials } from '@/lib/merchize'
import { isBondreSupplier } from '@/lib/bondre'
import { getBondreSettings, hasBondreAccount } from '@/lib/bondre-settings'
import { isPrintwaySupplier } from '@/lib/printway'
import { getPrintwaySettings } from '@/lib/printway-settings'
import { activePushByOrder, logHandoffEvent } from '@/lib/repos/push-export'
import { COOLING_OFF_HOURS, SUPPLIER_API_NAMES, UNMAPPED_TAB, type HandoffCard, type HandoffLine, type HandoffSent, type HandoffState, type HubChannel, type HubTab, type SentStage, type SupplierApiKind } from '@/lib/handoff-shared'
import { effectiveBaseCost } from '@/lib/order-profit'
import { enabledChannelFor, getSheetChannels, sheetProduct, sizeLabel, type SheetChannel } from '@/lib/sheet-channel'
import { CSV_LOCKED_MESSAGE, isCsvLocked } from '@/lib/csv-lock'
import { customNameOf } from '@/lib/custom-name'
import { loadLineResolver, recalculateMissingOrderLineCosts } from '@/lib/repos/order-costs'
import { printFileFit } from '@/lib/print-file-fit'
import { currentFiles, sameLabel } from '@/lib/task-files'
import { exportProgress, exportProgressLabel, exportedSupplierOf } from '@/lib/line-export'

export class HandoffError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = 'HandoffError'
  }
}

// These keep their CSV route until their key is saved, so a deploy alone changes nothing.
const KEYED_API_SUPPLIERS = [
  { kind: 'bondre' as const, matches: isBondreSupplier },
  { kind: 'printway' as const, matches: isPrintwaySupplier },
]

async function liveApiKeys(): Promise<Record<'bondre' | 'printway', boolean>> {
  const [bondre, printway] = await Promise.all([getBondreSettings(), getPrintwaySettings()])
  return { bondre: hasBondreAccount(bondre), printway: !!printway.token }
}

const OPEN_TASK = { status: { notIn: ['DONE', 'CANCELLED'] } }
const NOT_FULFILLED = { OR: [{ fulfillmentStatus: null }, { fulfillmentStatus: { notIn: ['fulfilled', 'FULFILLED'] } }] }
const CLOSED_FINANCIAL = ['REFUNDED', 'VOIDED']
const AFTER_EXPORT = ['EXPORTED', 'FULFILLED']
const MAX_CARDS = 60

/** "Chờ chuyển xưởng": the order went through Design Studio, every design is approved, nothing was handed to the supplier yet, and the order is still open. */
export function pendingHandoffWhere() {
  return {
    pipelineStatus: 'READY_TO_PRODUCTION',
    designReady: true,
    supplierHandoffAt: null,
    designTasks: { none: OPEN_TASK, some: { status: 'DONE' } },
    AND: [NOT_FULFILLED, { financialStatus: { notIn: [...CLOSED_FINANCIAL, ...CLOSED_FINANCIAL.map(s => s.toLowerCase())] } }],
  }
}

/** An order with a line no supplier is mapped to: shown in the hub's unmapped tab, so someone goes and maps it. */
function waitingForMappingWhere() {
  return {
    pipelineStatus: 'PENDING_MAPPING',
    lines: { some: { resolvedSupplierId: null } },
    AND: [NOT_FULFILLED, { financialStatus: { notIn: [...CLOSED_FINANCIAL, ...CLOSED_FINANCIAL.map(s => s.toLowerCase())] } }],
  }
}

export async function countPendingHandoff(): Promise<number> {
  return prisma.order.count({ where: pendingHandoffWhere() })
}

type StateOrder = {
  id: string; pipelineStatus: string; financialStatus: string; fulfillmentStatus: string | null; designReady: boolean
  supplierHandoffAt: Date | null; supplierHandoffMode: string | null; supplierHandoffById: string | null
  lines: Array<{ sku: string | null; productTitle: string; shopifyProductType: string | null; resolvedSupplierId: string | null; resolvedSupplierSku: string | null; exportedAt?: Date | null }>
  designTasks: Array<{ status: string }>
}

function blockedReason(o: StateOrder, openTasks: number): string {
  if (['CANCELLED', 'REFUNDED'].includes(o.pipelineStatus) || CLOSED_FINANCIAL.includes((o.financialStatus ?? '').toUpperCase())) return 'Đơn đã huỷ hoặc hoàn tiền'
  if (o.pipelineStatus === 'EXPORTED') return 'Đơn đã Exported'
  if (o.pipelineStatus === 'FULFILLED' || (o.fulfillmentStatus ?? '').toUpperCase() === 'FULFILLED') return 'Đơn đã giao'
  if (openTasks > 0) return `Còn ${openTasks} dòng chưa duyệt design`
  if (!o.designReady) return 'Còn dòng chưa có design được duyệt'
  return `Đơn đang ở trạng thái "${STATUS_LABELS[o.pipelineStatus as PipelineStatus] ?? o.pipelineStatus}"`
}

const STATE_INCLUDE = {
  lines: { select: { sku: true, productTitle: true, shopifyProductType: true, resolvedSupplierId: true, resolvedSupplierSku: true, exportedAt: true } },
  designTasks: { select: { status: true } },
} as const

export async function handoffStates(orders: StateOrder[]): Promise<Map<string, HandoffState>> {
  const out = new Map<string, HandoffState>()
  if (orders.length === 0) return out
  const [suppliers, settings, liveKeys, pushes, channels, csvLocked] = await Promise.all([
    prisma.supplier.findMany({ select: { id: true, code: true, apiType: true, isActive: true } }),
    getPgprintsSettings(),
    liveApiKeys(),
    activePushByOrder(orders.map(o => o.id)),
    getSheetChannels(),
    isCsvLocked(),
  ])
  const sheetSupplierIds = new Set(suppliers.filter(s => enabledChannelFor(channels, s)).map(s => s.id))
  const pgHits = suppliers.filter(isPgprintsSupplier)
  const pg = pgHits.find(s => s.isActive) ?? pgHits[0] ?? null
  const mzHits = suppliers.filter(isMerchizeSupplier)
  const mz = mzHits.find(s => s.isActive) ?? mzHits[0] ?? null
  const hasMerchizeCredentials = !!merchizeCredentials()
  const keyed = KEYED_API_SUPPLIERS.map(k => {
    const hits = suppliers.filter(k.matches)
    return { kind: k.kind, supplier: hits.find(s => s.isActive) ?? hits[0] ?? null, live: liveKeys[k.kind] }
  })
  const hasCredentials = !!credentialsOf(settings)
  const pgSkus = pg
    ? Array.from(new Set(orders.flatMap(o => o.lines.filter(l => l.resolvedSupplierId === pg.id).map(l => l.resolvedSupplierSku).filter((x): x is string => !!x))))
    : []
  const products = pg && pgSkus.length
    ? await prisma.supplierProduct.findMany({ where: { supplierId: pg.id, sku: { in: pgSkus } }, select: { sku: true, apiSku: true } })
    : []
  const apiSkuBySku = new Map(products.map(p => [p.sku, p.apiSku?.trim() || null]))
  const userIds = Array.from(new Set(orders.map(o => o.supplierHandoffById).filter((x): x is string => !!x)))
  const users = userIds.length ? await prisma.appUser.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : []
  const nameById = new Map(users.map(u => [u.id, u.name]))

  for (const o of orders) {
    const productLines = o.lines.filter(l => !isNonProductLine(l))
    const allPg = !!pg && productLines.length > 0 && productLines.every(l => l.resolvedSupplierId === pg.id)
    const mzLines = mz ? productLines.filter(l => l.resolvedSupplierId === mz.id) : []
    const merchizeOpen = mzLines.some(l => !l.exportedAt)
    const keyedLines = keyed.map(k => {
      const lines = k.supplier ? productLines.filter(l => l.resolvedSupplierId === k.supplier!.id) : []
      const apiLines = k.live ? lines : []
      return { ...k, lines, apiLines, open: apiLines.some(l => !l.exportedAt) }
    })
    const sheetOpen = productLines.some(l => !!l.resolvedSupplierId && sheetSupplierIds.has(l.resolvedSupplierId) && !l.exportedAt)
    // Merchize has no CSV route (owner 11/04/2026): its lines go by API, and only another supplier's lines can wait for an export.
    const isApiLine = (l: { resolvedSupplierId: string | null }) => l.resolvedSupplierId === mz?.id || keyedLines.some(k => k.live && l.resolvedSupplierId === k.supplier?.id)
    const csvRemainder = (mzLines.length > 0 || keyedLines.some(k => k.apiLines.length > 0)) && productLines.some(l => !isApiLine(l) && !l.exportedAt)
    const missingApiSku = allPg ? productLines.filter(l => !l.resolvedSupplierSku || !apiSkuBySku.get(l.resolvedSupplierSku)).map(l => l.resolvedSupplierSku ?? '—') : []
    const pgApi = allPg && hasCredentials && missingApiSku.length === 0
    const mzApi = mzLines.length > 0 && (merchizeOpen || !csvRemainder)
    const keyedApi = keyedLines.find(k => k.apiLines.length > 0 && (k.open || !csvRemainder))
    const api = pgApi || mzApi || !!keyedApi
    const apiNote = mzApi ? (!hasMerchizeCredentials ? 'Server chưa có khoá API Merchize — chưa gửi được đơn này'
        : csvRemainder ? 'Đơn nhiều xưởng — dòng Merchize gửi qua API, các dòng còn lại lưu chờ xuất CSV' : null)
      : keyedApi ? (csvRemainder ? `Đơn nhiều xưởng — dòng ${SUPPLIER_API_NAMES[keyedApi.kind]} gửi qua API, các dòng còn lại lưu chờ xuất CSV` : null)
      : !allPg || api ? null
      : !hasCredentials ? 'Xưởng PGprints chưa có Store ID / Secret key — lưu chờ xuất CSV'
      : `SKU xưởng ${Array.from(new Set(missingApiSku)).join(', ')} chưa có "SKU API" — lưu chờ xuất CSV`
    const openTasks = o.designTasks.filter(t => t.status !== 'DONE' && t.status !== 'CANCELLED').length
    const closed = CLOSED_FINANCIAL.includes((o.financialStatus ?? '').toUpperCase()) || (o.fulfillmentStatus ?? '').toUpperCase() === 'FULFILLED'
    const handedOff = o.supplierHandoffAt
      ? {
          at: o.supplierHandoffAt.toISOString(), mode: o.supplierHandoffMode === 'API' ? 'API' as const : o.supplierHandoffMode === 'SHEET' ? 'SHEET' as const : 'CSV' as const,
          byName: o.supplierHandoffById ? (nameById.get(o.supplierHandoffById) ?? null) : null,
        }
      : null
    const pending = !handedOff && o.pipelineStatus === 'READY_TO_PRODUCTION' && o.designReady && openTasks === 0 && !closed
    const push = pushes.get(o.id) ?? null
    const apiOpenKind = keyedLines.find(k => k.open)?.kind ?? null
    const apiKind: SupplierApiKind = merchizeOpen ? 'merchize' : apiOpenKind ?? (mzLines.length > 0 ? 'merchize' : keyedLines.find(k => k.lines.length > 0)?.kind ?? 'pgprints')
    out.set(o.id, {
      pending,
      blocked: pending || handedOff ? null : blockedReason(o, openTasks),
      mode: api ? 'API' : 'CSV',
      apiName: api ? SUPPLIER_API_NAMES[apiKind] : null,
      apiKind,
      merchizeOpen,
      apiOpenKind,
      csvRemainder,
      sheetOpen,
      csvLocked,
      apiNote,
      handedOff,
      canUndo: !!handedOff && handedOff.mode === 'CSV' && !AFTER_EXPORT.includes(o.pipelineStatus),
      push: push ? { status: push.status, supplierOrderCode: push.supplierOrderCode, externalOrderId: push.externalOrderId } : null,
    })
  }
  return out
}

export async function handoffStateFor(orderId: string): Promise<HandoffState | null> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: STATE_INCLUDE })
  if (!order) return null
  return (await handoffStates([order])).get(orderId) ?? null
}

function matches(card: HandoffCard, q: string): boolean {
  const haystacks = [
    card.order.orderNumber, card.order.customerName ?? '', ...card.suppliers.map(s => s.name),
    ...card.lines.flatMap(l => [l.taskKey, l.line.sku ?? '', l.line.productTitle, ...l.line.personalization.map(p => p.value)]),
  ]
  return haystacks.some(h => h.toLowerCase().includes(q))
}

/** What the card shows is what the sheet will get: the same rules as the send. */
function sendOf(line: { variantTitle: string | null; personalization: Parameters<typeof customNameOf>[0] }, product: { baseSku: string | null; variant1Value: string | null; variant2Value: string | null } | undefined, channel: SheetChannel | null): HandoffLine['send'] {
  const named = sheetProduct(channel, { baseSku: product?.baseSku, color: product?.variant2Value, variantTitle: line.variantTitle })
  return { sku: named.baseSku || null, size: sizeLabel(product?.variant1Value, line.variantTitle), color: named.color, customName: customNameOf(line.personalization) }
}

async function buildCards(where: any, orderBy: any, opts: { checks?: boolean; sent?: Map<string, HandoffSent>; withUnmapped?: boolean } = {}): Promise<HandoffCard[]> {
  const orders = await prisma.order.findMany({
    where, orderBy, take: MAX_CARDS,
    include: { ...STATE_INCLUDE, store: { include: { project: { select: { name: true } } } } },
  })
  if (orders.length === 0) return []
  const [states, workspaces] = await Promise.all([
    handoffStates(orders),
    Promise.all(orders.map(o => loadWorkspace(o.id))),
  ])
  const wsById = new Map(workspaces.filter((w): w is Workspace => !!w).map(w => [w.order.id, w]))
  const lineRows = await prisma.orderLine.findMany({
    where: { orderId: { in: orders.map(o => o.id) } },
    select: {
      id: true, orderId: true, shopifyLineId: true, resolvedSupplierId: true, resolvedSupplierSku: true, shopifyProductId: true, customAttributesJson: true,
      sku: true, productTitle: true, shopifyProductType: true, linePosition: true, exportedAt: true, exportedToSupplierId: true,
      qty: true, manualBaseCost: true, resolvedBaseCost: true,
    },
  })
  const rowById = new Map(lineRows.map(l => [l.id, l]))
  const exportSupplierIds = Array.from(new Set(lineRows.flatMap(l => [l.resolvedSupplierId, l.exportedToSupplierId]).filter((x): x is string => !!x)))
  const exportSuppliers = exportSupplierIds.length ? await prisma.supplier.findMany({ where: { id: { in: exportSupplierIds } }, select: { id: true, name: true } }) : []
  const supplierNameById = new Map(exportSuppliers.map(s => [s.id, s.name]))
  const folders = await prisma.designTask.findMany({
    where: { orderId: { in: orders.map(o => o.id) }, driveFolderUrl: { not: null } }, select: { orderId: true, shopifyLineId: true, driveFolderUrl: true },
  })
  const folderByLine = new Map(folders.map(t => [`${t.orderId}\u0000${t.shopifyLineId}`, t.driveFolderUrl]))
  const skuPairs = lineRows.filter(l => l.resolvedSupplierId && l.resolvedSupplierSku)
  const products = skuPairs.length
    ? await prisma.supplierProduct.findMany({
        where: { supplierId: { in: Array.from(new Set(skuPairs.map(l => l.resolvedSupplierId as string))) }, sku: { in: Array.from(new Set(skuPairs.map(l => l.resolvedSupplierSku as string))) } },
        select: { supplierId: true, sku: true, apiSku: true, baseSku: true, variant1Value: true, variant2Value: true },
      })
    : []
  const apiSkuByKey = new Map(products.map(p => [`${p.supplierId}::${p.sku}`, p.apiSku?.trim() || null]))
  const productByKey = new Map(products.map(p => [`${p.supplierId}::${p.sku}`, p]))
  const sheetChannels = await getSheetChannels()
  const resolveNow = opts.checks ? await loadLineResolver() : null
  const resolvable = opts.checks
    ? await prisma.orderLine.findMany({
        where: { orderId: { in: orders.map(o => o.id) } },
        select: { id: true, shopifyVariantId: true, shopifyProductType: true, variantOptions: true, shopifyProductId: true },
      })
    : []

  const cards: HandoffCard[] = []
  for (const o of orders) {
    const ws = wsById.get(o.id)
    const state = states.get(o.id)
    if (!ws || !state) continue
    const exportOrder = { pipelineStatus: o.pipelineStatus, exportedAt: o.exportedAt, exportedToSupplierId: o.exportedToSupplierId, lines: lineRows.filter(l => l.orderId === o.id) }
    const lineKeys = lineKeysOf(o.shopifyOrderNumber, exportOrder.lines)
    const lines: HandoffLine[] = []
    for (const line of ws.lines) {
      if (line.isNonProduct || (!line.supplier && !opts.withUnmapped)) continue
      const row = rowById.get(line.id)
      const sentTo = row ? exportedSupplierOf(exportOrder, row) : null
      const template = row ? templateViewFor(await templateForLine(row), line.artworks) : null
      const slots = requiredSlotsFor(template)
      const wrongSizeAreas = opts.checks
        ? currentFiles(line.artworks, 'PRINT').filter(a => slots.some(s => sameLabel(s, a.printArea)) && printFileFit(template, a.printArea, a).state === 'bad').map(a => a.printArea)
        : []
      const r = resolveNow ? resolvable.find(x => x.id === line.id) : null
      const now = r && resolveNow && !sentTo ? resolveNow({ ...r, order: { storeId: o.storeId, shippingCountry: o.shippingCountry } }) : null
      const mappingNow = now && (now.supplierId !== line.supplier?.id || now.sku !== (line.supplierSku ?? null))
        ? { supplierName: now.supplier.name, sku: now.sku }
        : null
      const unitCost = row ? effectiveBaseCost(row) : null
      const product = line.supplier && line.supplierSku ? productByKey.get(`${line.supplier.id}::${line.supplierSku}`) : undefined
      lines.push({
        line,
        slots,
        baseCost: row && unitCost != null ? unitCost * row.qty : null,
        productType: row?.shopifyProductType ?? null,
        send: sendOf(line, product, line.supplier ? enabledChannelFor(sheetChannels, line.supplier) : null),
        wrongSizeAreas,
        mappingNow,
        taskKey: lineKeys.get(line.shopifyLineId) ?? '',
        driveFolderUrl: folderByLine.get(`${o.id}\u0000${line.shopifyLineId}`) ?? null,
        apiSku: line.supplier && line.supplierSku ? (apiSkuByKey.get(`${line.supplier.id}::${line.supplierSku}`) ?? null) : null,
        exportedTo: sentTo ? (supplierNameById.get(sentTo) ?? 'xưởng không rõ') : null,
      })
    }
    const progress = exportProgress(exportOrder)
    // A partly sent order stays in the queue for the suppliers whose lines are still waiting.
    const exportNote = progress.partial
      ? `${exportProgressLabel(progress)} — còn chờ: ${progress.groups.filter(g => !g.done).map(g => supplierNameById.get(g.supplierId) ?? 'xưởng không rõ').join(', ')}`
      : null
    const suppliers = Array.from(new Map(lines.flatMap(l => l.line.supplier ? [[l.line.supplier.id, { id: l.line.supplier.id, name: l.line.supplier.name, code: l.line.supplier.code }] as const] : [])).values())
    const countryCode = countryCodeOf(o.shippingCountry)
    cards.push({
      order: {
        id: o.id, orderNumber: o.shopifyOrderNumber, placedAt: o.placedAt.toISOString(), storeName: o.store.project?.name ?? o.store.shop,
        pipelineStatus: o.pipelineStatus, customerName: o.shippingName ?? o.customerName,
        country: o.shippingCountry, countryCode, countryName: countryCode ? countryNameOf(countryCode) : null,
        shipTo: [o.shippingCity, o.shippingStateCode ?? o.shippingState].filter(Boolean).join(', ') || null,
      },
      suppliers, lines, state, exportNote, sent: opts.sent?.get(o.id) ?? null,
    })
  }
  return cards
}

/** "Duyệt sản xuất": every design approved, nothing handed to the supplier yet. Each line is checked against today's mapping and its template. */
export async function listHandoffCards(f: { q?: string } = {}): Promise<{ pending: HandoffCard[] }> {
  const pending = await buildCards(pendingHandoffWhere(), { placedAt: 'asc' }, { checks: true })
  const q = f.q?.trim().toLowerCase()
  return { pending: q ? pending.filter(c => matches(c, q)) : pending }
}

/** The waiting cards of one supplier for a send: oldest first, MAX_CARDS at a time. */
export async function pendingCardsForSupplier(supplierId: string, orderIds?: string[]): Promise<HandoffCard[]> {
  const where = {
    ...pendingHandoffWhere(),
    ...(orderIds ? { id: { in: orderIds } } : {}),
    lines: { some: { resolvedSupplierId: supplierId, exportedAt: null } },
  }
  const cards = await buildCards(where, { placedAt: 'asc' }, { checks: true, withUnmapped: true })
  return cards.filter(c => c.lines.some(l => l.line.supplier?.id === supplierId && !l.exportedTo))
}

/** One order's card with today's checks, also when a line has no supplier; the task screen shows its warnings. */
export async function handoffCardFor(orderId: string): Promise<HandoffCard | null> {
  const cards = await buildCards({ id: orderId }, { placedAt: 'asc' }, { checks: true, withUnmapped: true })
  return cards[0] ?? null
}

/** The hub's search: the order number of a line key ("LIT123_1"), or a name, SKU, title or custom value. */
function hubSearchWhere(q: string) {
  const text = q.replace(/^#/, '').replace(/_\d+$/, '')
  return {
    OR: [
      { shopifyOrderNumber: { contains: text } }, { shippingName: { contains: text } }, { customerName: { contains: text } },
      { lines: { some: { OR: [{ sku: { contains: text } }, { productTitle: { contains: text } }, { customAttributesJson: { contains: text } }] } } },
    ],
  }
}

/** A supplier with an order this recent keeps its tab at 0 waiting; older orders still in design are not "coming next". */
const HUB_ACTIVE_DAYS = 30

/** The active suppliers of the last HUB_ACTIVE_DAYS days, and how many of their orders are still in design. */
async function recentSupplierActivity(): Promise<{ active: Set<string>; design: Map<string, number> }> {
  const since = new Date(Date.now() - HUB_ACTIVE_DAYS * 24 * 3600 * 1000)
  const [used, inDesign] = await Promise.all([
    prisma.orderLine.findMany({
      where: { resolvedSupplierId: { not: null }, order: { placedAt: { gte: since } } },
      distinct: ['resolvedSupplierId'],
      select: { resolvedSupplierId: true },
    }),
    prisma.order.findMany({
      where: { pipelineStatus: 'PENDING_DESIGN', placedAt: { gte: since }, AND: [NOT_FULFILLED] },
      select: { id: true, lines: { select: { productTitle: true, shopifyProductType: true, resolvedSupplierId: true, exportedAt: true } } },
    }),
  ])
  const design = new Map<string, number>()
  for (const o of inDesign) {
    const ids = new Set(o.lines.filter(l => !isNonProductLine(l) && !l.exportedAt && l.resolvedSupplierId).map(l => l.resolvedSupplierId as string))
    ids.forEach(id => design.set(id, (design.get(id) ?? 0) + 1))
  }
  return { active: new Set(used.map(l => l.resolvedSupplierId as string)), design }
}

/**
 * Every active supplier, biggest queue first, so an empty one is seen to be empty; a search shows only the suppliers it found.
 * The count and the cost are not limited by MAX_CARDS.
 */
export async function listHandoffTabs(f: { q?: string } = {}): Promise<HubTab[]> {
  const q = f.q?.trim()
  const where = { OR: [pendingHandoffWhere(), waitingForMappingWhere()] }
  const orders = await prisma.order.findMany({
    where: q ? { AND: [where, hubSearchWhere(q)] } : where,
    select: { id: true, pipelineStatus: true, lines: { select: { productTitle: true, shopifyProductType: true, resolvedSupplierId: true, exportedAt: true, qty: true, manualBaseCost: true, resolvedBaseCost: true } } },
  })
  const tally = new Map<string, { orders: Set<string>; cost: number }>()
  for (const o of orders) {
    for (const l of o.lines) {
      if (isNonProductLine(l) || l.exportedAt) continue
      // An order waiting for mapping counts in the unmapped tab only: it cannot go to any supplier yet.
      if (o.pipelineStatus === 'PENDING_MAPPING' && l.resolvedSupplierId) continue
      const id = l.resolvedSupplierId ?? UNMAPPED_TAB
      const t = tally.get(id) ?? { orders: new Set<string>(), cost: 0 }
      t.orders.add(o.id)
      t.cost += (effectiveBaseCost(l) ?? 0) * l.qty
      tally.set(id, t)
    }
  }
  if (q && tally.size === 0) return []
  const activity = q ? null : await recentSupplierActivity()
  const [suppliers, settings, liveKeys, channels] = await Promise.all([
    prisma.supplier.findMany({
      where: { OR: [{ id: { in: Array.from(tally.keys()) } }, { id: { in: Array.from(activity?.active ?? []) }, isActive: true }] },
      select: { id: true, name: true, code: true, apiType: true },
    }),
    getPgprintsSettings(),
    liveApiKeys(),
    getSheetChannels(),
  ])
  const byId = new Map(suppliers.map(s => [s.id, s]))
  const channelOf = (s: { code: string; apiType: string | null }): HubChannel =>
    enabledChannelFor(channels, s) ? 'SHEET'
      : isMerchizeSupplier(s) || (isPgprintsSupplier(s) && !!credentialsOf(settings)) || KEYED_API_SUPPLIERS.some(k => k.matches(s) && liveKeys[k.kind]) ? 'API' : 'CSV'
  const ids = Array.from(new Set([...Array.from(tally.keys()), ...suppliers.map(s => s.id)]))
  const tabs = ids.map((id): HubTab => {
    const s = byId.get(id)
    const t = tally.get(id)
    return {
      id, name: s?.name ?? 'Chưa map xưởng', channel: s ? channelOf(s) : null,
      orderCount: t?.orders.size ?? 0, baseCostTotal: t?.cost ?? 0, designCount: activity?.design.get(id) ?? 0,
    }
  })
  return tabs.sort((a, b) => Number(a.id === UNMAPPED_TAB) - Number(b.id === UNMAPPED_TAB) || b.orderCount - a.orderCount || b.designCount - a.designCount || a.name.localeCompare(b.name))
}

/** "Duyệt sản xuất" by supplier: the tabs, and the cards of the asked tab, or of the first one when that tab holds nothing. */
export async function listHandoffHub(f: { q?: string; supplier?: string | null } = {}): Promise<{ tabs: HubTab[]; selected: string | null; pending: HandoffCard[] }> {
  const q = f.q?.trim()
  const tabs = await listHandoffTabs({ q })
  const asked = tabs.find(t => t.id === f.supplier)
  // A search lands on a tab that holds a result; a tab picked by hand stays open even when it is empty.
  const selected = (asked && (!q || asked.orderCount > 0) ? asked.id : tabs[0]?.id) ?? null
  if (!selected) return { tabs, selected, pending: [] }
  const supplierId = selected === UNMAPPED_TAB ? null : selected
  const inTab = { lines: { some: { resolvedSupplierId: supplierId, exportedAt: null } } }
  const scope = supplierId === null ? { OR: [pendingHandoffWhere(), waitingForMappingWhere()] } : pendingHandoffWhere()
  const where = { AND: [scope, inTab, ...(q ? [hubSearchWhere(q)] : [])] }
  const cards = await buildCards(where, { placedAt: 'asc' }, { checks: true, withUnmapped: true })
  // A null supplier also matches add-on lines, which have no card line.
  const held = cards.filter(c => c.lines.some(l => (l.line.supplier?.id ?? null) === supplierId && !l.exportedTo))
  return { tabs, selected, pending: held }
}

export const SENT_WINDOW_DAYS = 14
const SENT_SCAN = 400
const SENT_PAGE_MAX = 100

function sentWhere(since: Date | null, q: string | null) {
  const after = since ? { gte: since } : { not: null }
  const sent = { OR: [{ supplierHandoffAt: after }, { exportedAt: after }, { lines: { some: { exportedAt: after } } }] }
  const text = q
    ? {
        OR: [
          { shopifyOrderNumber: { contains: q } }, { shippingName: { contains: q } }, { customerName: { contains: q } },
          { lines: { some: { OR: [{ sku: { contains: q } }, { productTitle: { contains: q } }, { customAttributesJson: { contains: q } }] } } },
        ],
      }
    : {}
  return { designTasks: { some: {} }, AND: [sent, text] }
}

function latest(dates: (Date | null | undefined)[]): Date | null {
  const ms = dates.filter((d): d is Date => !!d).map(d => d.getTime())
  return ms.length ? new Date(Math.max(...ms)) : null
}

export type SentList = {
  sent: HandoffCard[]; windowDays: number; total: number
  /** Orders matching the stage and supplier chips, across every page. */
  matched: number
  stageCounts: Partial<Record<SentStage, number>>; suppliers: { id: string; name: string; count: number }[]
}

/**
 * "Đã chuyển xưởng": orders that went through the studio and were handed to a supplier — saved for CSV, exported, or pushed
 * by API — newest first. Without a search it covers the last SENT_WINDOW_DAYS days; a search looks at every order.
 * Stage and supplier filters run here, over every matching order, so a big CSV batch never hides the API pushes.
 */
export async function listSentCards(f: { q?: string; stage?: SentStage | null; supplierId?: string | null; page?: number; pageSize?: number } = {}): Promise<SentList> {
  const pageSize = Math.min(Math.max(f.pageSize ?? MAX_CARDS, 1), SENT_PAGE_MAX)
  const page = Math.max(f.page ?? 1, 1)
  const q = f.q?.trim().replace(/^#/, '') || null
  const since = q ? null : new Date(Date.now() - SENT_WINDOW_DAYS * 24 * 3600 * 1000)
  const rows = await prisma.order.findMany({
    where: sentWhere(since, q), orderBy: { placedAt: 'desc' }, take: SENT_SCAN,
    select: {
      id: true, pipelineStatus: true, fulfillmentStatus: true, exportedAt: true,
      supplierHandoffAt: true, supplierHandoffMode: true, supplierHandoffById: true,
      lines: { select: { exportedAt: true, resolvedSupplierId: true } },
    },
  })
  const info = await sentInfo(rows, rows.flatMap(r => r.lines.map(l => ({ orderId: r.id, exportedAt: l.exportedAt }))))
  const supplierIds = (r: typeof rows[number]) => Array.from(new Set(r.lines.map(l => l.resolvedSupplierId).filter((x): x is string => !!x)))
  const supplierCount = new Map<string, number>()
  for (const r of rows) for (const id of supplierIds(r)) supplierCount.set(id, (supplierCount.get(id) ?? 0) + 1)
  const names = supplierCount.size
    ? await prisma.supplier.findMany({ where: { id: { in: Array.from(supplierCount.keys()) } }, select: { id: true, name: true } })
    : []
  const ofSupplier = f.supplierId ? rows.filter(r => supplierIds(r).includes(f.supplierId!)) : rows
  const stageCounts: Partial<Record<SentStage, number>> = {}
  for (const r of ofSupplier) {
    const stage = info.get(r.id)!.stage
    stageCounts[stage] = (stageCounts[stage] ?? 0) + 1
  }
  const at = (id: string) => { const v = info.get(id)?.at; return v ? new Date(v).getTime() : 0 }
  const matching = ofSupplier.filter(r => !f.stage || info.get(r.id)!.stage === f.stage).map(r => r.id).sort((x, y) => at(y) - at(x))
  const chosen = matching.slice((page - 1) * pageSize, page * pageSize)
  const cards = await buildCards({ id: { in: chosen } }, { placedAt: 'desc' }, { sent: info })
  cards.sort((x, y) => at(y.order.id) - at(x.order.id))
  return {
    sent: cards, windowDays: SENT_WINDOW_DAYS, total: ofSupplier.length, matched: matching.length, stageCounts,
    suppliers: names.map(n => ({ id: n.id, name: n.name, count: supplierCount.get(n.id) ?? 0 })).sort((x, y) => y.count - x.count),
  }
}

type SentOrder = {
  id: string; pipelineStatus: string; fulfillmentStatus: string | null; exportedAt: Date | null
  supplierHandoffAt: Date | null; supplierHandoffMode: string | null; supplierHandoffById: string | null
}

async function sentInfo(orders: SentOrder[], lineExports: { orderId: string; exportedAt: Date | null }[]): Promise<Map<string, HandoffSent>> {
  const ids = orders.map(o => o.id)
  const [pushes, shipments] = await Promise.all([
    prisma.supplierOrderPush.findMany({
      where: { orderId: { in: ids }, status: { in: ['SENDING', 'CREATED'] } }, orderBy: { pushedAt: 'desc' },
      select: { orderId: true, status: true, supplierOrderCode: true, externalOrderId: true, remoteStatus: true, pushedAt: true, pushedById: true },
    }),
    prisma.shipment.findMany({
      where: { orderId: { in: ids }, trackingNumber: { not: null } },
      select: { orderId: true, trackingNumber: true, carrier: true, trackingUrl: true },
    }),
  ])
  const userIds = Array.from(new Set([...pushes.map(p => p.pushedById), ...orders.map(o => o.supplierHandoffById)].filter((x): x is string => !!x)))
  const users = userIds.length ? await prisma.appUser.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : []
  const nameById = new Map(users.map(u => [u.id, u.name]))
  const now = Date.now()
  const out = new Map<string, HandoffSent>()
  for (const o of orders) {
    const push = pushes.find(p => p.orderId === o.id) ?? null
    const tracking = Array.from(new Map(shipments.filter(s => s.orderId === o.id && s.trackingNumber)
      .map(s => [s.trackingNumber as string, { number: s.trackingNumber as string, carrier: s.carrier, url: s.trackingUrl }])).values())
    const lineSent = lineExports.filter(l => l.orderId === o.id)
    const exportedAt = latest([o.exportedAt, ...lineSent.map(l => l.exportedAt)])
    const cancelUntil = push ? new Date(push.pushedAt.getTime() + COOLING_OFF_HOURS * 3600 * 1000) : null
    const cooling = !!push && !!cancelUntil && cancelUntil.getTime() > now && (!push.remoteStatus || /cool/i.test(push.remoteStatus))
    let stage: SentStage
    if (o.pipelineStatus === 'FULFILLED' || (o.fulfillmentStatus ?? '').toUpperCase() === 'FULFILLED') stage = 'FULFILLED'
    else if (tracking.length > 0) stage = 'TRACKING'
    else if (push) stage = push.status === 'SENDING' ? 'API_SENDING' : cooling ? 'API_COOLING' : 'API_SENT'
    else if (!exportedAt && o.supplierHandoffMode === 'CSV' && o.pipelineStatus === 'READY_TO_PRODUCTION') stage = 'CSV_WAITING'
    else if (o.supplierHandoffMode === 'SHEET') stage = 'SHEET_SENT'
    else stage = 'CSV_EXPORTED'
    const byId = push?.pushedById ?? o.supplierHandoffById
    out.set(o.id, {
      stage, via: push || o.supplierHandoffMode === 'API' ? 'API' : o.supplierHandoffMode === 'SHEET' ? 'SHEET' : 'CSV',
      at: (push?.pushedAt ?? exportedAt ?? o.supplierHandoffAt)?.toISOString() ?? null,
      byName: byId ? (nameById.get(byId) ?? null) : null,
      code: push ? (push.supplierOrderCode ?? push.externalOrderId) : null,
      remoteStatus: push?.remoteStatus ?? null,
      cancelUntil: cooling && cancelUntil ? cancelUntil.toISOString() : null,
      tracking,
    })
  }
  return out
}

/**
 * Re-picks the supplier of every line of an order that has not gone to a supplier yet, by today's mapping — for an order
 * that arrived before its product was mapped the way it is now. Refused once anything was handed off, pushed or exported.
 */
export async function remapOrderSuppliers(orderId: string, userId: string | null): Promise<{ changed: string[]; state: HandoffState }> {
  const state = await handoffStateFor(orderId)
  if (!state) throw new HandoffError('Không tìm thấy đơn', 404, 'NOT_FOUND')
  if (state.handedOff || state.push) throw new HandoffError('Đơn đã chuyển xưởng — không đổi xưởng được nữa', 409, 'ALREADY_HANDED_OFF')
  const before = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      pipelineStatus: true, shopifyOrderNumber: true,
      lines: { select: { shopifyLineId: true, linePosition: true, exportedAt: true, resolvedSupplierId: true, resolvedSupplierSku: true } },
    },
  })
  if (!before) throw new HandoffError('Không tìm thấy đơn', 404, 'NOT_FOUND')
  if (AFTER_EXPORT.includes(before.pipelineStatus) || before.lines.some(l => l.exportedAt)) {
    throw new HandoffError('Đơn đã xuất cho xưởng — không đổi xưởng được nữa', 409, 'EXPORTED')
  }
  await recalculateMissingOrderLineCosts({ orderIds: [orderId], refreshExisting: true, preserveUnchangedSnapshot: true })
  const after = await prisma.orderLine.findMany({
    where: { orderId }, select: { shopifyLineId: true, linePosition: true, productTitle: true, shopifyProductType: true, resolvedSupplierId: true, resolvedSupplierSku: true },
  })
  const lineKeys = lineKeysOf(before.shopifyOrderNumber, after)
  const suppliers = await prisma.supplier.findMany({
    where: { id: { in: Array.from(new Set(after.map(l => l.resolvedSupplierId).filter((x): x is string => !!x))) } }, select: { id: true, name: true },
  })
  const nameById = new Map(suppliers.map(s => [s.id, s.name]))
  const changed: string[] = []
  for (const l of after) {
    const old = before.lines.find(b => b.shopifyLineId === l.shopifyLineId)
    if (!old || (old.resolvedSupplierId === l.resolvedSupplierId && old.resolvedSupplierSku === l.resolvedSupplierSku)) continue
    changed.push(`${lineKeys.get(l.shopifyLineId) ?? l.shopifyLineId}: ${old.resolvedSupplierSku ?? '—'} → ${l.resolvedSupplierSku ?? 'chưa map'}`)
    const name = l.resolvedSupplierId ? (nameById.get(l.resolvedSupplierId) ?? null) : null
    await prisma.designTask.updateMany({ where: { orderId, shopifyLineId: l.shopifyLineId }, data: { supplierSnapshot: name } })
  }
  if (changed.length > 0) await logHandoffEvent(orderId, `Cập nhật xưởng theo mapping hiện tại — ${changed.join('; ')}`, userId)
  return { changed, state: (await handoffStateFor(orderId))! }
}

/** Saves "design handed over, waiting for the CSV export". Nothing else moves: the order stays READY_TO_PRODUCTION for the export page. */
export async function handoffOrderCsv(orderId: string, userId: string | null): Promise<HandoffState> {
  const state = await handoffStateFor(orderId)
  if (!state) throw new HandoffError('Không tìm thấy đơn', 404, 'NOT_FOUND')
  if (state.handedOff) throw new HandoffError(state.handedOff.mode === 'API' ? 'Đơn đã chuyển supplier qua API' : 'Đơn đã lưu chờ xuất CSV', 409, 'ALREADY_HANDED_OFF')
  if (state.sheetOpen) throw new HandoffError('Đơn có dòng của xưởng ghi sheet — bấm Sản xuất ở tab xưởng đó trước, không lưu chờ xuất CSV', 409, 'SHEET_ONLY')
  if (state.merchizeOpen) throw new HandoffError('Dòng Merchize chỉ gửi qua API — gửi Merchize trước, không lưu chờ xuất CSV', 409, 'MERCHIZE_API_ONLY')
  if (state.apiOpenKind) {
    const name = SUPPLIER_API_NAMES[state.apiOpenKind]
    throw new HandoffError(`Dòng ${name} gửi qua API — gửi ${name} trước, không lưu chờ xuất CSV`, 409, `${state.apiOpenKind.toUpperCase()}_API_ONLY`)
  }
  if (state.push && !state.csvRemainder) {
    throw new HandoffError(`Đơn đã có lần gửi PGprints đang hiệu lực (${state.push.supplierOrderCode ?? state.push.externalOrderId}) — không lưu chờ xuất CSV`, 409, 'ACTIVE_PUSH')
  }
  if (!state.pending) throw new HandoffError(state.blocked ?? 'Đơn chưa đủ điều kiện chuyển xưởng', 409, 'NOT_READY')
  if (state.csvLocked) throw new HandoffError(CSV_LOCKED_MESSAGE, 409, 'CSV_LOCKED')
  const r = await prisma.order.updateMany({
    where: { id: orderId, ...pendingHandoffWhere() },
    data: { supplierHandoffAt: new Date(), supplierHandoffMode: 'CSV', supplierHandoffById: userId },
  })
  if (r.count !== 1) throw new HandoffError('Đơn vừa đổi trạng thái — tải lại rồi thử lại', 409, 'CHANGED')
  await logHandoffEvent(orderId, 'Chuyển supplier — lưu chờ xuất CSV', userId)
  return (await handoffStateFor(orderId))!
}

export async function undoCsvHandoff(orderId: string, userId: string | null): Promise<HandoffState> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { pipelineStatus: true, supplierHandoffAt: true, supplierHandoffMode: true } })
  if (!order) throw new HandoffError('Không tìm thấy đơn', 404, 'NOT_FOUND')
  if (!order.supplierHandoffAt) throw new HandoffError('Đơn chưa được chuyển supplier', 409, 'NOT_HANDED_OFF')
  if (order.supplierHandoffMode !== 'CSV') throw new HandoffError('Đơn đã chuyển qua API — huỷ bên PGprints trong cửa sổ "Gửi PGprints"', 409, 'NOT_CSV')
  if (AFTER_EXPORT.includes(order.pipelineStatus)) throw new HandoffError('Đơn đã Exported — không hoàn tác được', 409, 'EXPORTED')
  const r = await prisma.order.updateMany({
    where: { id: orderId, supplierHandoffMode: 'CSV', supplierHandoffAt: { not: null }, pipelineStatus: { notIn: AFTER_EXPORT } },
    data: { supplierHandoffAt: null, supplierHandoffMode: null, supplierHandoffById: null },
  })
  if (r.count !== 1) throw new HandoffError('Đơn vừa đổi trạng thái — tải lại rồi thử lại', 409, 'CHANGED')
  await logHandoffEvent(orderId, 'Hoàn tác chuyển supplier (chưa xuất CSV)', userId)
  return (await handoffStateFor(orderId))!
}
