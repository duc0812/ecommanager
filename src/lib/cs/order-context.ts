import { prisma } from '@/lib/db'
import { lineKeysOf, productLinesOnly } from '@/lib/order-lines'
import type { ItemCheck } from '@/lib/cs/factory-check'

export type FactoryState = 'NOT_SENT' | 'AT_FACTORY' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED'
export type OrderMatch = 'EXACT' | 'BY_EMAIL' | 'AMBIGUOUS' | 'NONE'

export type OrderContextOrder = {
  id: string
  shopifyOrderNumber: string
  placedAt: Date
  customerName: string | null
  customerEmail: string | null
  shipTo: string
  factoryState: FactoryState
  supplierHandoffAt: Date | null
  pipelineStatus: string
  lines: { title: string; variant: string | null; qty: number; customized: boolean; personalization: string | null }[]
  shipments: { trackingNumber: string | null; carrier: string | null; status: string; lastCheckpointAt: Date | null; trackingUrl: string | null }[]
  designTaskStatuses: string[]
  items: OrderItem[]
}

export type OrderItemSend = { supplier: string; via: 'API' | 'SHEET' | 'CSV'; ref: string | null; sentAt: Date | null; factoryStatus: string | null; checkedAt: Date | null }
export type OrderItemParcel = {
  trackingNumber: string; carrier: string | null; status: string; lastEvent: string | null; lastEventAt: Date | null; deliveredAt: Date | null
  trackingUrl: string | null; fromSupplier: string | null; sharedWith: string[]
}
export type OrderItem = { lineKey: string | null; title: string; variant: string | null; qty: number; send: OrderItemSend | null; parcel: OrderItemParcel | null; warning: string | null; check?: ItemCheck | null }

export type OrderContext = { match: OrderMatch; order: OrderContextOrder | null; candidates: string[] }

const TRACKING_PAGE = 'https://litzzy.com/apps/trackingorder?nums='

export function extractOrderNumbers(text: string): string[] {
  const out: string[] = []
  const re = /#?\bLIT\s?(\d{3,6})\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const n = `#LIT${m[1]}`
    if (!out.includes(n)) out.push(n)
  }
  return out
}

type KV = { key: string; value: string }

function parseKv(json: string | null): KV[] {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.filter((x): x is KV => x && typeof x.key === 'string' && typeof x.value === 'string') : []
  } catch { return [] }
}

const showValue = (v: string) => (v !== v.trim() ? JSON.stringify(v) : v)

function designPayloadTexts(attrs: KV[]): string[] {
  const raw = attrs.find(a => a.key === '_design')?.value
  if (!raw) return []
  try {
    const data = JSON.parse(raw)?.data
    if (!data || typeof data !== 'object') return []
    return Object.values(data as Record<string, any>).map(f => f?.text).filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(t => `text: ${showValue(t)}`)
  } catch { return [] }
}

export function personalizationOf(l: { customAttributesJson: string | null; customallFieldsJson: string | null; designNote: string | null }): string | null {
  const attrs = parseKv(l.customAttributesJson)
  const seen = new Set<string>()
  const parts: string[] = []
  for (const kv of [...attrs.filter(a => !a.key.startsWith('_')), ...parseKv(l.customallFieldsJson)]) {
    const k = kv.key.trim().toLowerCase()
    if (seen.has(k) || kv.value.trim() === '') continue
    seen.add(k)
    parts.push(`${kv.key.trim()}: ${showValue(kv.value)}`)
  }
  if (!parts.length) parts.push(...designPayloadTexts(attrs))
  if (l.designNote?.trim()) parts.push(`note: ${l.designNote.trim()}`)
  return parts.length ? parts.join('; ') : null
}

export function factoryStateOf(o: {
  supplierHandoffAt: Date | null
  pipelineStatus: string
  fulfillmentStatus: string | null
  supplierPushes: { status: string }[]
  shipments: { status: string }[]
}): FactoryState {
  if (o.pipelineStatus === 'CANCELLED' || o.pipelineStatus === 'REFUNDED') return 'CANCELLED'
  const moving = o.shipments.filter(s => s.status !== 'PENDING')
  if (moving.length && moving.every(s => s.status === 'DELIVERED')) return 'DELIVERED'
  if (moving.length || o.pipelineStatus === 'FULFILLED' || o.fulfillmentStatus === 'FULFILLED') return 'SHIPPED'
  if (o.supplierHandoffAt || o.pipelineStatus === 'EXPORTED' || o.supplierPushes.some(p => p.status === 'SENDING' || p.status === 'CREATED')) return 'AT_FACTORY'
  return 'NOT_SENT'
}

type ItemLine = {
  id: string; shopifyLineId: string; productTitle: string; variantTitle: string | null; qty: number; linePosition: number; sku: string | null
  shopifyProductType: string | null; resolvedSupplierId: string | null; exportedToSupplierId: string | null; exportedAt: Date | null
}
type ItemPush = { supplierId: string; status: string; supplierOrderCode: string | null; pushedAt: Date; remoteStatus: string | null; lastSyncedAt: Date | null; prevExportJson: string | null }
type ItemSheetWrite = { orderLineId: string; lineKey: string; supplierId: string; tabName: string; status: string; createdAt: Date }
type ItemShipment = {
  shopifyLineId: string | null; lineKey: string | null; trackingNumber: string | null; carrier: string | null; detectedCarrier: string | null; lastMileCarrier: string | null
  status: string; supplierId: string | null; lastCheckpointAt: Date | null; checkpointsJson: string | null; ppTimingJson: string | null; trackingUrl: string | null
}

function jsonOf(s: string | null): any {
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

const dateOf = (v: unknown): Date | null => {
  if (typeof v !== 'string' || !v.trim()) return null
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

function newestScan(s: ItemShipment): { desc: string | null; at: Date | null } {
  const cps = (jsonOf(s.checkpointsJson) ?? []) as { time?: string; desc?: string }[]
  const newest = (Array.isArray(cps) ? cps : [])
    .map(c => ({ desc: typeof c?.desc === 'string' ? c.desc.trim() : null, at: dateOf(c?.time) }))
    .filter(c => c.desc)
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0))[0]
  return newest ?? { desc: null, at: s.lastCheckpointAt }
}

// Which push carried a line: the Shopify line ids it recorded, else a push from before sends went by line, which carried every
// line of its supplier.
function pushCarries(p: ItemPush, l: ItemLine): boolean {
  const stored = jsonOf(p.prevExportJson)
  const ids: unknown = stored?.shopifyLineIds ?? null
  if (Array.isArray(ids)) return ids.includes(l.shopifyLineId)
  if (Array.isArray(stored?.lineIds)) return stored.lineIds.includes(l.id) || l.exportedToSupplierId === p.supplierId
  return (l.exportedToSupplierId ?? l.resolvedSupplierId) === p.supplierId
}

/**
 * Owner 11/12 (LIT4987): per product line, which factory got it, how and when, and where its parcel is. A line with no send
 * record says so; a tracking that may not hold the line (no send record, or another factory's parcel) carries a warning.
 */
export function orderItemsOf(i: { orderNumber: string; lines: ItemLine[]; pushes: ItemPush[]; sheetWrites: ItemSheetWrite[]; shipments: ItemShipment[]; supplierNames: Map<string, string> }): OrderItem[] {
  const keys = lineKeysOf(i.orderNumber, i.lines)
  const name = (id: string | null) => (id ? i.supplierNames.get(id) ?? id : null)
  const products = productLinesOnly(i.lines).sort((a, b) => a.linePosition - b.linePosition)
  const built = products.map(l => {
    const lineKey = keys.get(l.shopifyLineId) ?? null
    const push = i.pushes.filter(p => (p.status === 'CREATED' || p.status === 'SENDING') && pushCarries(p, l)).sort((a, b) => b.pushedAt.getTime() - a.pushedAt.getTime())[0]
    const sheet = i.sheetWrites.filter(w => w.status === 'WRITTEN' && (w.orderLineId === l.id || (!!lineKey && w.lineKey === lineKey))).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
    let send: OrderItemSend | null = null
    let sentTo: string | null = null
    if (push) {
      sentTo = push.supplierId
      send = { supplier: name(push.supplierId)!, via: 'API', ref: push.supplierOrderCode, sentAt: push.pushedAt, factoryStatus: push.remoteStatus, checkedAt: push.lastSyncedAt }
    } else if (sheet) {
      sentTo = sheet.supplierId
      send = { supplier: name(sheet.supplierId)!, via: 'SHEET', ref: sheet.tabName, sentAt: sheet.createdAt, factoryStatus: null, checkedAt: null }
    } else if (l.exportedToSupplierId) {
      sentTo = l.exportedToSupplierId
      send = { supplier: name(l.exportedToSupplierId)!, via: 'CSV', ref: null, sentAt: l.exportedAt, factoryStatus: null, checkedAt: null }
    }
    const ship = i.shipments
      .filter(s => !!s.trackingNumber?.trim() && (s.shopifyLineId === l.shopifyLineId || (!s.shopifyLineId && !!lineKey && s.lineKey === lineKey)))
      .sort((a, b) => (b.lastCheckpointAt?.getTime() ?? 0) - (a.lastCheckpointAt?.getTime() ?? 0))[0]
    return { l, lineKey, send, sentTo, ship }
  })
  return built.map(({ l, lineKey, send, sentTo, ship }) => {
    let parcel: OrderItemParcel | null = null
    let warning: string | null = null
    if (ship) {
      const scan = newestScan(ship)
      const delivered = dateOf(jsonOf(ship.ppTimingJson)?.deliveryDate) ?? (ship.status === 'DELIVERED' ? scan.at : null)
      parcel = {
        trackingNumber: ship.trackingNumber!.trim(),
        carrier: ship.lastMileCarrier ?? ship.detectedCarrier ?? ship.carrier,
        status: ship.status,
        lastEvent: scan.desc,
        lastEventAt: scan.at,
        deliveredAt: delivered,
        trackingUrl: ship.trackingUrl ?? `${TRACKING_PAGE}${ship.trackingNumber!.trim()}`,
        fromSupplier: name(ship.supplierId),
        sharedWith: built.filter(b => b.l !== l && b.ship?.trackingNumber?.trim() === ship.trackingNumber!.trim()).map(b => b.lineKey ?? b.l.productTitle),
      }
      if (!send) warning = `Không tìm được thông tin gửi xưởng mà sản phẩm đã gắn tracking ${parcel.trackingNumber} — kiện này có thể không chứa sản phẩm này`
      else if (ship.supplierId && sentTo && ship.supplierId !== sentTo) warning = `Tracking ${parcel.trackingNumber} của xưởng ${name(ship.supplierId)} nhưng sản phẩm gửi xưởng ${send.supplier} — kiện này có thể không chứa sản phẩm này`
    }
    return { lineKey, title: l.productTitle, variant: l.variantTitle, qty: l.qty, send, parcel, warning }
  })
}

const fmtUs = (d: Date | null) => (d ? d.toLocaleDateString('en-US', { timeZone: 'UTC', month: '2-digit', day: '2-digit', year: 'numeric' }) : '—')
const VIA_VI = { API: 'API', SHEET: 'sheet', CSV: 'CSV' } as const

/** One line per item for staff: sent or not (factory, way, date) and where its parcel is. */
export function itemSummaryVi(it: OrderItem): string {
  const head = `${it.lineKey ?? '—'} ${it.title}${it.variant ? ` (${it.variant})` : ''}${it.qty > 1 ? ` ×${it.qty}` : ''}`
  const s = it.send
  const sent = s
    ? `gửi ${s.supplier} qua ${VIA_VI[s.via]}${s.ref ? ` ${s.ref}` : ''} ngày ${fmtUs(s.sentAt)}${s.factoryStatus ? `, xưởng báo ${s.factoryStatus} (${fmtUs(s.checkedAt)})` : ''}`
    : 'không tìm được thông tin gửi xưởng'
  const p = it.parcel
  const parcel = p
    ? `${p.trackingNumber} ${p.carrier ?? ''} ${p.status}${p.deliveredAt ? `, giao ${fmtUs(p.deliveredAt)}` : ''}${p.lastEvent ? `, scan ${fmtUs(p.lastEventAt)} "${p.lastEvent}"` : ''}${p.sharedWith.length ? `, chung kiện với ${p.sharedWith.join(', ')}` : ''}`
    : 'chưa có tracking'
  return `${head}: ${sent} · ${parcel}${it.warning ? ` · ⚠ ${it.warning}` : ''}${it.check ? ` · Kết luận: ${it.check.conclusion}` : ''}`
}

const include = { lines: { orderBy: { linePosition: 'asc' as const } }, shipments: true, designTasks: true, supplierPushes: true }
type Loaded = NonNullable<Awaited<ReturnType<typeof loadByNumber>>>

function loadByNumber(shopifyOrderNumber: string) {
  return prisma.order.findFirst({ where: { shopifyOrderNumber }, include })
}

type Extra = { sheetWrites: ItemSheetWrite[]; supplierNames: Map<string, string> }

async function extraFor(o: Loaded): Promise<Extra> {
  const sheetWrites = await prisma.supplierSheetWrite.findMany({ where: { orderId: o.id }, select: { orderLineId: true, lineKey: true, supplierId: true, tabName: true, status: true, createdAt: true } })
  const ids = Array.from(new Set([...o.supplierPushes.map(p => p.supplierId), ...sheetWrites.map(w => w.supplierId), ...o.lines.flatMap(l => [l.exportedToSupplierId, l.resolvedSupplierId]), ...o.shipments.map(s => s.supplierId)].filter((x): x is string => !!x)))
  const suppliers = ids.length ? await prisma.supplier.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []
  return { sheetWrites, supplierNames: new Map(suppliers.map(s => [s.id, s.name])) }
}

function toContextOrder(o: Loaded, extra: Extra): OrderContextOrder {
  const shipTo = [o.shippingName, o.shippingAddress1, o.shippingAddress2, [o.shippingCity, o.shippingStateCode ?? o.shippingState, o.shippingZip].filter(Boolean).join(' '), o.shippingCountry]
    .filter(Boolean).join(', ')
  return {
    id: o.id,
    shopifyOrderNumber: o.shopifyOrderNumber,
    placedAt: o.placedAt,
    customerName: o.customerName,
    customerEmail: o.customerEmail,
    shipTo,
    factoryState: factoryStateOf(o),
    supplierHandoffAt: o.supplierHandoffAt,
    pipelineStatus: o.pipelineStatus,
    lines: o.lines.map(l => ({ title: l.productTitle, variant: l.variantTitle, qty: l.qty, customized: l.customized, personalization: personalizationOf(l) })),
    shipments: o.shipments.map(s => ({
      trackingNumber: s.trackingNumber,
      carrier: s.lastMileCarrier ?? s.detectedCarrier ?? s.carrier,
      status: s.status,
      lastCheckpointAt: s.lastCheckpointAt,
      trackingUrl: s.trackingUrl ?? (s.trackingNumber ? `${TRACKING_PAGE}${s.trackingNumber}` : null),
    })),
    designTaskStatuses: o.designTasks.map(t => t.status),
    items: orderItemsOf({ orderNumber: o.shopifyOrderNumber, lines: o.lines, pushes: o.supplierPushes, sheetWrites: extra.sheetWrites, shipments: o.shipments, supplierNames: extra.supplierNames }),
  }
}

export async function buildOrderContext(input: { subject: string; texts: string[]; cfOrderId?: string | null; email?: string | null }): Promise<OrderContext> {
  const numbers = extractOrderNumbers([input.cfOrderId ?? '', input.subject, ...input.texts].join('\n'))
  for (const n of numbers) {
    const o = await loadByNumber(n)
    if (o) return { match: 'EXACT', order: toContextOrder(o, await extraFor(o)), candidates: numbers }
  }
  const email = input.email?.trim().toLowerCase()
  if (!email) return { match: 'NONE', order: null, candidates: [] }
  const byEmail = await prisma.order.findMany({ where: { customerEmail: email }, include, orderBy: { placedAt: 'desc' }, take: 5 })
  if (byEmail.length === 1) return { match: 'BY_EMAIL', order: toContextOrder(byEmail[0], await extraFor(byEmail[0])), candidates: [byEmail[0].shopifyOrderNumber] }
  if (byEmail.length > 1) return { match: 'AMBIGUOUS', order: null, candidates: byEmail.map(o => o.shopifyOrderNumber) }
  return { match: 'NONE', order: null, candidates: [] }
}
