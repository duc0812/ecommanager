import { prisma } from '@/lib/db'
import type { OrderContextOrder, OrderItem } from '@/lib/cs/order-context'
import { enabledChannelFor, getSheetChannels, tabNameFor, type SheetChannel } from '@/lib/sheet-channel'
import { readRange } from '@/lib/google-sheets'
import { searchOrders } from '@/lib/pgprints'
import { credentialsOf, getPgprintsSettings } from '@/lib/pgprints-settings'
import { findPgprintsSupplier } from '@/lib/repos/pgprints-push'

/** found null: the factory could not be read, so it decides nothing. */
export type FactoryLookup = { supplier: string; found: boolean | null; detail: string }
export type ItemVerdict = 'IN_PARCEL' | 'NOT_IN_PARCEL' | 'NOT_SENT' | 'UNKNOWN'
export type ItemCheck = { lineKey: string; lookups: FactoryLookup[]; verdict: ItemVerdict; conclusion: string }
export type LookupQuery = { orderNumber: string; lineKey: string; placedAt: Date }
export type LookupFn = (supplier: string, q: LookupQuery) => Promise<FactoryLookup>

function sentPart(sent: FactoryLookup | null, hasSend: boolean): string {
  if (!sent) return hasSend ? '' : '; không có thông tin gửi xưởng nào khác'
  if (sent.found === true) return `; sản phẩm đang ở ${sent.supplier}: ${sent.detail}`
  if (sent.found === false) return `; ${sent.supplier} cũng không có (${sent.detail}) — không tìm được sản phẩm ở xưởng nào`
  return `; chưa tra được ${sent.supplier} (${sent.detail})`
}

/** Owner 11/12 (LIT5554): the factory that owns the tracking decides whether the parcel holds the item. */
export function verdictOf(it: OrderItem, sent: FactoryLookup | null, parcel: FactoryLookup | null): { verdict: ItemVerdict; conclusion: string } {
  const t = it.parcel?.trackingNumber ?? '—'
  const key = it.lineKey ?? it.title
  const rest = sentPart(sent, !!it.send)
  if (parcel?.found === true) return { verdict: 'IN_PARCEL', conclusion: `Xưởng ${parcel.supplier} có ${key} (${parcel.detail}) → kiện ${t} có chứa sản phẩm này, fulfillment đúng` }
  if (parcel?.found === false && (!it.send || sent?.found === false)) {
    const where = [sent, parcel].filter((l): l is FactoryLookup => !!l).map(l => `${l.supplier}: ${l.detail}`).join('; ')
    return { verdict: 'NOT_SENT', conclusion: `Dự đoán gửi thiếu: không có thông tin gửi ${key} ở xưởng nào (${where}), kiện ${t} không chứa sản phẩm này` }
  }
  if (parcel?.found === false) return { verdict: 'NOT_IN_PARCEL', conclusion: `Fulfillment thiếu: xưởng ${parcel.supplier} không có ${key} (${parcel.detail}), kiện ${t} không chứa sản phẩm này${rest}` }
  const who = parcel ? `xưởng ${parcel.supplier} (${parcel.detail})` : 'xưởng của tracking'
  return { verdict: 'UNKNOWN', conclusion: `Chưa tra được ${who} nên chưa kết luận kiện ${t} có chứa sản phẩm này không${rest}` }
}

async function safe(lookup: LookupFn, supplier: string, q: LookupQuery): Promise<FactoryLookup> {
  try { return await lookup(supplier, q) } catch (e: any) { return { supplier, found: null, detail: `lỗi tra: ${e?.message ?? e}` } }
}

/** Items whose tracking may not be their parcel: the factory it was sent to first, then the factory that owns the tracking. */
export async function checkSuspectItems(order: Pick<OrderContextOrder, 'shopifyOrderNumber' | 'placedAt' | 'items'>, lookup: LookupFn = defaultLookup): Promise<ItemCheck[]> {
  const out: ItemCheck[] = []
  for (const it of order.items) {
    if (!it.warning || !it.parcel || !it.lineKey) continue
    const q = { orderNumber: order.shopifyOrderNumber, lineKey: it.lineKey, placedAt: order.placedAt }
    const parcelSup = it.parcel.fromSupplier
    const sent = it.send && it.send.supplier !== parcelSup ? await safe(lookup, it.send.supplier, q) : null
    const parcel = parcelSup ? await safe(lookup, parcelSup, q) : null
    out.push({ lineKey: it.lineKey, lookups: [sent, parcel].filter((x): x is FactoryLookup => !!x), ...verdictOf(it, sent, parcel) })
  }
  return out
}

export function withChecks(items: OrderItem[], checks: ItemCheck[] | null | undefined): OrderItem[] {
  if (!checks?.length) return items
  return items.map(it => ({ ...it, check: checks.find(c => c.lineKey === it.lineKey) ?? null }))
}

export function checksOf(outputJson: string | null | undefined): ItemCheck[] {
  try {
    const v = JSON.parse(outputJson || '{}').factoryChecks
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

const norm = (s: string | undefined) => (s ?? '').trim().replace(/^#/, '').toUpperCase()

/** A sheet the factory works from: the item is there when a row of the order carries its line key in Order Vendor. */
export function sheetLookupOf(supplier: string, tabs: { tab: string; rows: string[][] }[], orderNumber: string, lineKey: string): FactoryLookup {
  const orderKeys: string[] = []
  let orderRows = 0
  for (const { tab, rows } of tabs) {
    const h = rows.findIndex(r => r.some(c => /^order number$/i.test(c.trim())))
    if (h < 0) continue
    const oc = rows[h].findIndex(c => /^order number$/i.test(c.trim()))
    const vc = rows[h].findIndex(c => /^order vendor$/i.test(c.trim()))
    for (const r of rows.slice(h + 1)) {
      if (norm(r[oc]) !== norm(orderNumber)) continue
      orderRows++
      const v = vc >= 0 ? norm(r[vc]) : ''
      if (v === norm(lineKey)) return { supplier, found: true, detail: `dòng ${lineKey} ở tab ${tab}${r[0]?.trim() && oc !== 0 ? ` (${r[0].trim()})` : ''}` }
      if (v) orderKeys.push(v)
    }
  }
  if (orderKeys.length) return { supplier, found: false, detail: `chỉ có ${Array.from(new Set(orderKeys)).join(', ')}` }
  if (orderRows) return { supplier, found: null, detail: `có đơn ${orderNumber} nhưng dòng không ghi mã sản phẩm — cần xem tay` }
  return { supplier, found: false, detail: `không có đơn ${orderNumber} trong tab ${tabs.map(t => t.tab).join(', ')}` }
}

declare global {
  // eslint-disable-next-line no-var
  var __csSheetCache: Map<string, { at: number; rows: string[][] }> | undefined
}
const SHEET_TTL_MS = 10 * 60_000

async function tabRows(spreadsheetId: string, tab: string): Promise<string[][]> {
  const cache = (global.__csSheetCache ??= new Map())
  const k = `${spreadsheetId}|${tab}`
  const hit = cache.get(k)
  if (hit && Date.now() - hit.at < SHEET_TTL_MS) return hit.rows
  const rows = await readRange(spreadsheetId, tab, 'A1:Z')
  cache.set(k, { at: Date.now(), rows })
  return rows
}

async function sheetLookup(supplier: string, ch: SheetChannel, q: LookupQuery): Promise<FactoryLookup> {
  const names = ch.tabPattern.includes('{M}') ? [0, 1, 2].map(b => tabNameFor(ch.tabPattern, new Date(), b)) : [ch.tabPattern]
  const tabs: { tab: string; rows: string[][] }[] = []
  for (const tab of names) {
    try { tabs.push({ tab, rows: await tabRows(ch.spreadsheetId, tab) }) } catch { /* a month with no tab yet */ }
  }
  if (!tabs.length) return { supplier, found: null, detail: `không đọc được sheet ${names.join(', ')}` }
  return sheetLookupOf(supplier, tabs, q.orderNumber, q.lineKey)
}

async function pgprintsLookup(supplier: string, q: LookupQuery): Promise<FactoryLookup> {
  const o = await prisma.order.findFirst({ where: { shopifyOrderNumber: q.orderNumber }, select: { storeId: true } })
  const creds = credentialsOf(await getPgprintsSettings(o?.storeId))
  if (!creds) return { supplier, found: null, detail: 'chưa có key PGprints' }
  const base = norm(q.orderNumber)
  const found = (await searchOrders(creds, { fromTime: q.placedAt.getTime() - 2 * 86400_000, toTime: Date.now(), searchKey: base }))
    .filter(r => norm(r.orderId ?? '').startsWith(base) && !/^\d/.test(norm(r.orderId ?? '').slice(base.length)))
  if (!found.length) return { supplier, found: false, detail: `API không có đơn ${base}` }
  return {
    supplier, found: true,
    detail: found.map(r => {
      const tr = Array.from(new Set(r.items.map(i => i.trackingNumber).filter(Boolean)))
      return `${r.pgcOrderId ?? r.orderId} ${r.itemStatuses.join('/') || '—'}${tr.length ? `, tracking ${tr.join(', ')}` : ', chưa có tracking'}`
    }).join('; '),
  }
}

export const defaultLookup: LookupFn = async (supplier, q) => {
  const s = await prisma.supplier.findFirst({ where: { name: supplier }, select: { id: true, code: true } })
  if (!s) return { supplier, found: null, detail: 'không rõ xưởng' }
  const pg = await findPgprintsSupplier()
  if (pg && pg.id === s.id) return pgprintsLookup(supplier, q)
  const ch = enabledChannelFor(await getSheetChannels(), s)
  if (ch) return sheetLookup(supplier, ch, q)
  return { supplier, found: null, detail: 'chưa có cách tra tự động xưởng này' }
}
