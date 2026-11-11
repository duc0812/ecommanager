import { prisma } from '@/lib/db'
import { lineKeysOf } from '@/lib/order-lines'
import { storeForOrderName } from '@/lib/order-prefix'
import { buildOrdersForCsv } from '@/lib/export-orders'
import { renderRow, type OrderForCsv } from '@/lib/csv-template'
import { HUB_WARNING_LABELS, hubView, type HubWarning } from '@/lib/handoff-hub'
import { listOrdersWithLines, markOrdersExported } from '@/lib/repos/orders'
import { logHandoffEvent } from '@/lib/repos/push-export'
import { pendingCardsForSupplier } from '@/lib/supplier-handoff'
import { SheetsError, addGridRows, listTabs, paintRow, readRange, readWrittenRange, rowColors, tabProperties, writeRows } from '@/lib/google-sheets'
import { DAY_SEPARATOR_COLOR, buildRow, collectKeys, enabledChannelFor, getSheetChannels, hasLine, lastDataRow, mapColumns, planRows, sameRow, sheetDate, sheetProduct, sizeLabel, tabNameFor, type SheetChannel, type SheetKeys } from '@/lib/sheet-channel'

/** Tabs read for lines already sent: rows get copied to the next month's tab, and a late order can sit in an older one. */
const TABS_BACK = 2

export class SheetPushError extends Error {
  constructor(message: string, public code: string, public status = 409) {
    super(message)
    this.name = 'SheetPushError'
  }
}

export type SheetLineStatus = 'WRITTEN' | 'ALREADY' | 'BLOCKED' | 'FAILED'
export type SheetLineResult = { lineKey: string; orderNumber: string; status: SheetLineStatus; message: string | null }
export type SheetPushResult = { tabName: string; results: SheetLineResult[] }
export type SheetPushPreview = { supplierName: string; tabName: string; ready: number; blocked: number; lines: { lineKey: string; supplierSku: string | null; sku: string | null; size: string; color: string; customName: string; blocked: boolean; message: string | null }[] }

declare global {
  // eslint-disable-next-line no-var
  var __sheetPushLocks: Set<string> | undefined
}

async function channelOf(supplierId: string): Promise<{ supplier: { id: string; name: string; code: string }; channel: SheetChannel }> {
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId }, select: { id: true, name: true, code: true } })
  if (!supplier) throw new SheetPushError('Không tìm thấy xưởng', 'NOT_FOUND', 404)
  const channel = enabledChannelFor(await getSheetChannels(), supplier)
  if (!channel) throw new SheetPushError(`${supplier.name} chưa bật kênh ghi sheet`, 'NO_CHANNEL')
  return { supplier, channel }
}

/** The tab and its columns as they are now. Anything off stops the whole send: nothing is written on a guess. */
async function openTab(channel: SheetChannel, at: Date) {
  const tabName = tabNameFor(channel.tabPattern, at)
  const tabs = await listTabs(channel.spreadsheetId)
  if (!tabs.includes(tabName)) throw new SheetPushError(`Sheet chưa có tab "${tabName}" — cần tạo tab đó trước, tool không tự tạo`, 'NO_TAB')
  const [headers = []] = await readRange(channel.spreadsheetId, tabName, '1:1')
  const { indexes, missing } = mapColumns(headers, channel.columns)
  if (missing.length > 0) throw new SheetPushError(`Tab "${tabName}" thiếu cột: ${missing.join(', ')} — sheet đã đổi cấu trúc, không ghi`, 'COLUMNS')
  return { tabName, tabs, headers, indexes }
}

async function existingKeys(channel: SheetChannel, tabs: string[], at: Date): Promise<SheetKeys> {
  const keys: SheetKeys = { lines: new Set(), orders: new Set() }
  // A sheet with one tab for good names it every time round: read it once.
  const names = new Set(Array.from({ length: TABS_BACK + 1 }, (_, back) => tabNameFor(channel.tabPattern, at, back)))
  for (const tab of Array.from(names)) {
    if (!tabs.includes(tab)) continue
    const rows = await readRange(channel.spreadsheetId, tab, '1:100000')
    const heads = (rows[0] ?? []).map(h => h.trim().toLowerCase())
    const number = heads.indexOf('order number')
    const vendor = heads.indexOf('order vendor')
    if (number < 0 || vendor < 0) throw new SheetPushError(`Tab "${tab}" không có cột Order Number và Order Vendor — không kiểm tra được trùng`, 'COLUMNS')
    collectKeys(rows.slice(1).map(r => ({ orderNumber: r[number] ?? '', vendor: r[vendor] ?? '' })), keys)
  }
  return keys
}

function warningMessage(warnings: HubWarning[], lineKey: string): string | null {
  return warnings.filter(w => w.lineKey === lineKey).map(w => `${w.lineKey}: ${HUB_WARNING_LABELS[w.code]}`).join('; ') || null
}

/** What a send would do, for the confirm box. Counts are per line, including orders with both valid and blocked lines. */
export async function previewSheetPush(supplierId: string, orderIds?: string[]): Promise<SheetPushPreview> {
  const { supplier, channel } = await channelOf(supplierId)
  const { tabName } = await openTab(channel, new Date())
  const cards = await pendingCardsForSupplier(supplierId, orderIds)
  const views = cards.map(c => hubView(c, supplierId))
  const lines = views.flatMap(v => v.lines.map(l => {
    const message = warningMessage(v.warnings, l.lineKey)
    return { lineKey: l.lineKey, supplierSku: l.line.supplierSku, ...l.send, blocked: !!message, message }
  }))
  const blocked = lines.filter(l => l.blocked).length
  return { supplierName: supplier.name, tabName, ready: lines.length - blocked, blocked, lines }
}

async function run(supplierId: string, orderIds: string[] | undefined, userId: string | null, at: Date): Promise<SheetPushResult> {
  const { channel } = await channelOf(supplierId)
  const { tabName, tabs, indexes } = await openTab(channel, at)
  const keys = await existingKeys(channel, tabs, at)
  const cards = await pendingCardsForSupplier(supplierId, orderIds)

  const results: SheetLineResult[] = []
  const sendOrders = new Set<string>()
  const already = new Map<string, string[]>()
  const customNames = new Map<string, string>()
  const orderIdsToLoad: string[] = []

  for (const c of cards) {
    const view = hubView(c, supplierId)
    for (const l of view.lines) {
      const message = warningMessage(view.warnings, l.lineKey)
      if (message) results.push({ lineKey: l.lineKey, orderNumber: c.order.orderNumber, status: 'BLOCKED', message })
    }
    if (view.sendableLines.length === 0) continue
    orderIdsToLoad.push(c.order.id)
    for (const l of view.sendableLines) customNames.set(l.line.id, l.send.customName)
  }

  const orders = orderIdsToLoad.length ? await listOrdersWithLines({ ids: orderIdsToLoad, limit: orderIdsToLoad.length }) : []
  // The channel is shared by every store that is on; a store that is switched off keeps its orders out of the sheet.
  // Rows read back from the sheet find their store by the order-name prefix (storeForOrderName), and a written row cannot
  // be taken back, so an order whose name does not carry its own store's prefix stays out as well.
  const switchedOff = new Set((await prisma.shopifyStore.findMany({ where: { enabled: false, id: { in: orders.map(o => o.storeId) } }, select: { id: true } })).map(s => s.id))
  const blockReason = (o: (typeof orders)[number]) => {
    if (switchedOff.has(o.storeId)) return `Store ${o.store.shop} đang tắt, đơn của store này không được ghi vào sheet`
    if (storeForOrderName(o.shopifyOrderNumber, [o.store])?.id === o.storeId) return null
    return o.store.orderPrefix
      ? `Tên đơn ${o.shopifyOrderNumber} không bắt đầu bằng tiền tố ${o.store.orderPrefix} của store ${o.store.shop}: dòng trong sheet sẽ không tìm lại được store, không ghi`
      : `Store ${o.store.shop} chưa có tiền tố đơn: dòng trong sheet sẽ không tìm lại được store, không ghi`
  }
  const allowed = orders.filter(o => {
    const reason = blockReason(o)
    if (!reason) return true
    const keys = lineKeysOf(o.shopifyOrderNumber, o.lines)
    for (const l of o.lines.filter(l => customNames.has(l.id))) {
      const key = keys.get(l.shopifyLineId)
      if (key) results.push({ lineKey: key, orderNumber: o.shopifyOrderNumber, status: 'BLOCKED', message: reason })
    }
    return false
  })

  const included = new Set<string>()
  const lineIdByKey = new Map<string, { orderId: string; lineId: string; orderNumber: string; baseCost: number | null }>()
  for (const o of allowed) {
    const lineKeys = lineKeysOf(o.shopifyOrderNumber, o.lines)
    const card = cards.find(c => c.order.id === o.id)!
    const costByKey = new Map(card.lines.map(l => [l.lineKey, l.baseCost]))
    for (const l of o.lines) {
      const key = lineKeys.get(l.shopifyLineId)
      // Only the lines the card holds as ready; a sibling still in design stays out.
      if (!key || !customNames.has(l.id)) continue
      lineIdByKey.set(key, { orderId: o.id, lineId: l.id, orderNumber: o.shopifyOrderNumber, baseCost: costByKey.get(key) ?? null })
      if (hasLine(keys, key)) {
        results.push({ lineKey: key, orderNumber: o.shopifyOrderNumber, status: 'ALREADY', message: 'Dòng đã có sẵn trong sheet, không ghi lại' })
        already.set(o.id, [...(already.get(o.id) ?? []), l.id])
        continue
      }
      included.add(l.id)
      sendOrders.add(o.id)
    }
  }

  const sending = allowed.filter(o => sendOrders.has(o.id))
  const linesOf = (o: (typeof orders)[number]) => o.lines.filter(l => included.has(l.id))
  let built = await buildOrdersForCsv({ orders: sending, supplierId, columns: channel.columns, perOrder: false, linesOf })
  if (built.problems.length > 0) {
    const bad = new Set(built.problems.map(p => p.orderNumber))
    for (const p of built.problems) {
      for (const k of Array.from(lineIdByKey.entries())) {
        if (k[1].orderNumber === p.orderNumber && included.has(k[1].lineId)) results.push({ lineKey: k[0], orderNumber: p.orderNumber, status: 'BLOCKED', message: p.reason })
      }
    }
    const rest = sending.filter(o => !bad.has(o.shopifyOrderNumber))
    built = await buildOrdersForCsv({ orders: rest, supplierId, columns: channel.columns, perOrder: false, linesOf })
  }

  const date = sheetDate(at, channel.dateFormat)
  const outgoing: { lineKey: string; orderNumber: string; orderId: string; lineId: string; baseCost: number | null; row: string[] }[] = []
  for (const o of built.ordersForCsv) {
    for (const line of o.lines) {
      const key = line.lineKey ?? ''
      const ref = lineIdByKey.get(key)
      if (!ref) continue
      const order: OrderForCsv = { ...o, sentDate: date, orderCode: o.shopifyOrderNumber.replace(/^#/, '') }
      const product = sheetProduct(channel, { baseSku: line.supplierBaseSku, productName: line.supplierProductName, color: line.supplierVariant2Value, variantTitle: line.variantTitle })
      // The wrong code is the wrong product, so a colour with no known code waits.
      if (product.noCodeForColor) {
        results.push({ lineKey: key, orderNumber: ref.orderNumber, status: 'BLOCKED', message: `${product.baseSku} màu "${product.color}" chưa có mã trong kênh sheet — không ghi` })
        continue
      }
      const values = renderRow(channel.columns, order, {
        ...line, lineRef: `#${key}`, customName: customNames.get(ref.lineId) ?? '', sizeLabel: sizeLabel(line.supplierVariant1Value, line.variantTitle),
        supplierBaseSku: product.baseSku, supplierProductName: product.productName, supplierVariant2Value: product.color,
      })
      outgoing.push({ lineKey: key, orderNumber: ref.orderNumber, orderId: ref.orderId, lineId: ref.lineId, baseCost: ref.baseCost, row: buildRow(indexes, values) })
    }
  }

  // Lines the sheet already holds are marked sent: a person pasted them, or an earlier send died before its mark.
  for (const [orderId, lineIds] of Array.from(already.entries())) {
    await markOrdersExported([orderId], supplierId, at, { mode: 'SHEET', byId: userId }, { lineIds })
    await logHandoffEvent(orderId, `Dòng đã có sẵn trong sheet tab ${tabName} — đánh dấu đã gửi, không ghi lại`, userId)
  }

  if (outgoing.length === 0) return { tabName, results }

  const logged = await prisma.$transaction(outgoing.map(o => prisma.supplierSheetWrite.create({
    data: {
      supplierId, orderId: o.orderId, orderLineId: o.lineId, lineKey: o.lineKey, spreadsheetId: channel.spreadsheetId, tabName,
      status: 'WRITING', baseCost: o.baseCost, createdById: userId,
    },
  })))
  const failAll = async (message: string) => {
    await prisma.supplierSheetWrite.updateMany({ where: { id: { in: logged.map(l => l.id) } }, data: { status: 'FAILED', error: message } })
    for (const o of outgoing) results.push({ lineKey: o.lineKey, orderNumber: o.orderNumber, status: 'FAILED', message })
    return { tabName, results }
  }

  let range: string
  let firstRow: number
  try {
    // Read last, so a row someone pasted a moment ago is not written over.
    const rows = await readRange(channel.spreadsheetId, tabName, '1:100000')
    const lastRow = lastDataRow(rows)
    if (lastRow < 1) throw new SheetPushError(`Tab "${tabName}" không có hàng tiêu đề — không ghi`, 'COLUMNS')
    const { sheetId, rowCount } = await tabProperties(channel.spreadsheetId, tabName)
    const colors = lastRow < rowCount ? await rowColors(channel.spreadsheetId, tabName, lastRow + 1, Math.min(lastRow + 3, rowCount)) : []
    const plan = planRows({ lastRow, lastDate: rows[lastRow - 1]?.[0] ?? '', today: date, colors })
    firstRow = plan.startRow
    const lastWritten = firstRow + outgoing.length - 1
    if (lastWritten > rowCount) await addGridRows(channel.spreadsheetId, sheetId, lastWritten - rowCount)
    if (plan.separatorRow) await paintRow(channel.spreadsheetId, sheetId, plan.separatorRow, DAY_SEPARATOR_COLOR)
    const mapped = new Set(indexes)
    // Quantity stays a number, or the sheet's own sums skip it. Everything else is text: a zip keeps its leading zero.
    const numeric = new Set(indexes.filter((_, i) => channel.columns[i].source === 'line.qty'))
    range = await writeRows(channel.spreadsheetId, tabName, firstRow, outgoing.map(o => o.row.map((v, col) => (!mapped.has(col) ? null : numeric.has(col) && /^\d+$/.test(v) ? Number(v) : v))))
  } catch (e: any) {
    return failAll(e?.message ?? 'Không ghi được vào sheet')
  }

  let written: string[][]
  try {
    written = await readWrittenRange(channel.spreadsheetId, range)
  } catch (e: any) {
    // The rows may be there. They stay unmarked, and the next send finds them in the sheet and does not write them again.
    return failAll(`Đã gửi lệnh ghi nhưng không đọc lại được (${e?.message ?? e}) — kiểm tra sheet vùng ${range}, lần gửi sau tool sẽ tự nhận dòng đã có`)
  }

  const good = new Map<string, string[]>()
  for (let i = 0; i < outgoing.length; i++) {
    const o = outgoing[i]
    const ok = sameRow(o.row, written[i])
    const rowNumber = firstRow + i
    await prisma.supplierSheetWrite.update({
      where: { id: logged[i].id },
      data: ok ? { status: 'WRITTEN', rowRange: `A${rowNumber}` } : { status: 'FAILED', error: `Dòng đọc lại khác dữ liệu đã gửi (${range})` },
    })
    results.push(ok
      ? { lineKey: o.lineKey, orderNumber: o.orderNumber, status: 'WRITTEN', message: `Hàng ${rowNumber}` }
      : { lineKey: o.lineKey, orderNumber: o.orderNumber, status: 'FAILED', message: `Dòng đọc lại khác dữ liệu đã gửi — kiểm tra sheet vùng ${range}` })
    if (ok) good.set(o.orderId, [...(good.get(o.orderId) ?? []), o.lineId])
  }
  for (const [orderId, lineIds] of Array.from(good.entries())) {
    await markOrdersExported([orderId], supplierId, at, { mode: 'SHEET', byId: userId }, { lineIds })
    await logHandoffEvent(orderId, `Ghi ${lineIds.length} dòng vào sheet tab ${tabName}`, userId)
  }
  return { tabName, results }
}

/** Writes the supplier's waiting lines to its sheet, one send at a time per supplier. */
export async function pushToSheet(supplierId: string, opts: { orderIds?: string[]; userId: string | null; at?: Date }): Promise<SheetPushResult> {
  const locks = (global.__sheetPushLocks ??= new Set())
  if (locks.has(supplierId)) throw new SheetPushError('Đang có một lượt ghi sheet của xưởng này, chờ xong rồi thử lại', 'BUSY')
  locks.add(supplierId)
  try {
    return await run(supplierId, opts.orderIds, opts.userId, opts.at ?? new Date())
  } finally {
    locks.delete(supplierId)
  }
}

export function sheetErrorStatus(e: unknown): { status: number; code: string; message: string } | null {
  if (e instanceof SheetPushError || e instanceof SheetsError) return { status: e.status, code: e.code, message: e.message }
  return null
}
