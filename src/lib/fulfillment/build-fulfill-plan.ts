import type { SheetRow } from './parse-sheet'

export function orderLineKey(token: string): string {
  return token.trim().replace(/^#/, '')
}

// Revision tokens like "R"/"R1" (e.g. "#LIT2362R1", "#LIT2736R") are DISTINCT Shopify
// order names, not sub-order suffixes — do not fold them into the base order, or this
// could end up fulfilling the wrong order.
export function normalizeBaseOrder(token: string): string {
  // Strip leading #, then all trailing _<token> sub-order suffixes ("_2", "_2_1").
  return orderLineKey(token).replace(/(_[A-Za-z0-9]+)+$/, '')
}

export function groupByOrder(rows: SheetRow[]): Map<string, OrderRow[]> {
  const g = new Map<string, OrderRow[]>()
  for (const r of rows) {
    const base = normalizeBaseOrder(r.orderToken)
    const arr = g.get(base) ?? []
    arr.push({ lineKey: orderLineKey(r.orderToken), tracking: r.tracking.trim(), ...(r.byOrderNumber ? { byOrderNumber: true } : {}) })
    g.set(base, arr)
  }
  return g
}

// sheets: the read-back sheets that wrote the row (each one is a supplier's). pushed: the row is the tracking an API push
// brought back, already tied to the push's supplier. byOrderNumber: the sheet wrote the bare order number, so the line is
// found by its key among the order's own lines (an open order has no Shipment row yet).
export type OrderRow = { lineKey: string; tracking: string; sheets?: string[]; pushed?: boolean; byOrderNumber?: boolean }

// Merge one sheet's grouped rows into the accumulator. A multi-supplier order lists its
// sub-orders across DIFFERENT supplier sheets, so rows must be MERGED — dropping an order
// already seen in an earlier sheet silently loses the other supplier's lines (they then
// never get fulfilled). Identical (lineKey, tracking) pairs dedupe, keeping every sheet that wrote them; a real conflict
// (same line, two trackings) is kept so buildFulfillmentPlan can flag it as needs_manual. A row written by the bare order
// number stays apart from one that names its line key, as it did when it read as the whole order.
export function mergeSheetGroups(
  target: Map<string, { rows: OrderRow[] }>,
  grouped: Map<string, OrderRow[]>,
  sheet?: string,
): void {
  for (const [base, rows] of Array.from(grouped)) {
    const entry = target.get(base) ?? { rows: [] }
    target.set(base, entry)
    for (const row of rows) {
      const r: OrderRow = sheet ? { ...row, sheets: [sheet] } : { ...row }
      const same = entry.rows.find(x => x.lineKey === r.lineKey && x.tracking === r.tracking && !x.byOrderNumber === !r.byOrderNumber)
      if (!same) {
        entry.rows.push(r)
        continue
      }
      if (r.sheets) same.sheets = Array.from(new Set([...(same.sheets ?? []), ...r.sheets]))
      if (r.pushed) same.pushed = true
    }
  }
}

export type FOLineItem = { id: string; remainingQuantity: number; shopifyLineId: string; sku: string | null }
export type FulfillmentOrderRef = { id: string; status: string; lineItems: FOLineItem[] }
// addOn: non-product lines (Shipping protection / Tip / Custom Text) closed with no tracking.
export type PlannedFulfillment = { fulfillmentOrderId: string; lineItems: Array<{ id: string; quantity: number }>; tracking: string; shipmentIds: string[]; addOn?: boolean }
export type OrderPlanStatus = 'will_fulfill' | 'too_recent' | 'already_fulfilled' | 'not_found' | 'needs_manual' | 'error'
export type OrderPlan = { baseOrder: string; status: OrderPlanStatus; fulfillments: PlannedFulfillment[]; message?: string; ageDays?: number; openLineCount?: number; hasHeldLines?: boolean }

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export function buildFulfillmentPlan(input: {
  baseOrder: string
  rows: OrderRow[]
  shipments: Array<{ id: string; lineKey: string; shopifyLineId: string | null }>
  fulfillmentOrders: FulfillmentOrderRef[] | null
  displayFulfillmentStatus: string | null
  // Shopify line ids of the order's non-product lines (isNonProductLine), which no supplier
  // ships and no sheet ever lists. Omitted when the order isn't in the DB → nothing extra
  // is ever fulfilled, so a missing/stale mapping can never over-fulfill.
  addOnLineIds?: string[]
  // The order's product lines in the DB, each with its line key, whether it went to a supplier and the name of the supplier
  // it went to. A product line that would be fulfilled but was not sent (or is unknown to the DB) holds the whole order: a
  // fulfilment emails the customer about an item no supplier makes. Omitted when the order isn't in the DB → nothing is
  // found by its key, and the checks on sent lines and suppliers are not made.
  productLines?: Array<{ shopifyLineId: string; lineKey: string; sent: boolean; supplier?: string | null }>
  placedAt: Date | null
  now: Date
  minAgeDays: number
}): OrderPlan {
  const { baseOrder } = input
  const done = (status: OrderPlanStatus, message?: string, ageDays?: number): OrderPlan =>
    ({ baseOrder, status, fulfillments: [], message, ageDays })

  if (input.fulfillmentOrders === null) return done('not_found')

  if (!input.placedAt) return done('needs_manual', 'Không có ngày đặt để kiểm tra tuổi đơn')
  const ageDays = Math.floor((input.now.getTime() - input.placedAt.getTime()) / 86_400_000)
  if (ageDays < input.minAgeDays) return done('too_recent', `Mới ${ageDays} ngày`, ageDays)

  if ((input.displayFulfillmentStatus ?? '').toUpperCase() === 'FULFILLED') return done('already_fulfilled', undefined, ageDays)

  // Open fulfillment-order line items keyed by the underlying order line id.
  // Only FOs that are actually open for fulfillment count — ON_HOLD/SCHEDULED/
  // CANCELLED/INCOMPLETE/CLOSED FOs are not fulfillable right now.
  const OPEN_FO_STATUSES = new Set(['OPEN', 'IN_PROGRESS'])
  const openByLineId = new Map<string, { foId: string; foLineItemId: string; quantity: number }>()
  input.fulfillmentOrders.forEach(fo => {
    if (!OPEN_FO_STATUSES.has(fo.status)) return
    fo.lineItems.forEach(li => {
      if (li.remainingQuantity > 0) openByLineId.set(li.shopifyLineId, { foId: fo.id, foLineItemId: li.id, quantity: li.remainingQuantity })
    })
  })
  if (openByLineId.size === 0) {
    if ((input.displayFulfillmentStatus ?? '').toUpperCase() === 'FULFILLED') return done('already_fulfilled', undefined, ageDays)
    // FOs exist but none are OPEN/IN_PROGRESS (all on hold/scheduled/etc) → needs a human.
    // If an OPEN/IN_PROGRESS FO exists but simply has no remaining quantity, that's just
    // already fulfilled, not a manual case.
    const hasOpenFO = input.fulfillmentOrders.some(fo => OPEN_FO_STATUSES.has(fo.status))
    if (input.fulfillmentOrders.length > 0 && !hasOpenFO) return done('needs_manual', 'Fulfillment order chưa mở (on hold/scheduled)', ageDays)
    return done('already_fulfilled', undefined, ageDays)
  }

  const addOnLineIds = new Set(input.addOnLineIds ?? [])
  const shipmentByLineKey = new Map(input.shipments.filter(s => s.shopifyLineId).map(s => [s.lineKey, s]))
  const shipmentIdByLineId = new Map(input.shipments.filter(s => s.shopifyLineId).map(s => [s.shopifyLineId as string, s.id]))

  // Lines that exist but sit on a FO a human must release (on hold / scheduled / incomplete)
  // — a listed line that maps here is NOT "already fulfilled"; it needs a human.
  // CLOSED/CANCELLED are terminal (shipped, or moved/cancelled): a listed line there is just
  // done, so it is skipped — counting those as "held" would both flag shipped orders as
  // needs_manual and stop the caller from ever marking a split order FULFILLED.
  const HELD_FO_STATUSES = new Set(['ON_HOLD', 'SCHEDULED', 'INCOMPLETE'])
  const heldLineIds = new Set<string>()
  input.fulfillmentOrders.forEach(fo => {
    if (HELD_FO_STATUSES.has(fo.status)) fo.lineItems.forEach(li => heldLineIds.add(li.shopifyLineId))
  })

  const isWholeOrderRow = (lineKey: string) => lineKey === baseOrder

  // key: `${foId} ${tracking}` -> PlannedFulfillment
  const groups = new Map<string, PlannedFulfillment>()
  const lineTracking = new Map<string, string>() // foLineItemId -> tracking, to catch conflicts
  const addLine = (tracking: string, foId: string, foLineItemId: string, quantity: number, shipmentId?: string, addOn?: boolean) => {
    const key = `${foId} ${tracking}`
    const g = groups.get(key) ?? { fulfillmentOrderId: foId, lineItems: [], tracking, shipmentIds: [], ...(addOn ? { addOn: true } : {}) }
    if (!g.lineItems.some(li => li.id === foLineItemId)) g.lineItems.push({ id: foLineItemId, quantity })
    if (shipmentId && !g.shipmentIds.includes(shipmentId)) g.shipmentIds.push(shipmentId)
    groups.set(key, g)
  }
  // Lines the rows put into a fulfilment, with the key and the sheets of the row that named them.
  const planned: Array<{ lineId: string; lineKey: string; sheets?: string[] }> = []

  // Owner 2026-11-06: a fulfilment covers exactly the line a row names, never the whole order. Fulfil ONLY the listed
  // sub-orders, grouped by tracking:
  //  - all listed sub-orders share one tracking → merge into ONE fulfillment;
  //  - different trackings → one fulfillment per tracking (split shipment);
  //  - only some items listed (the rest not shipped yet) → fulfill the listed lines and
  //    leave the others untouched (partial). A line NOT listed is never fulfilled.
  // Anything ambiguous → needs_manual (never guess — this feature emails customers).
  let rows = input.rows
  const whole = rows.filter(r => isWholeOrderRow(r.lineKey))
  const byNumber = rows.filter(r => r.byOrderNumber).length
  // A whole-order (unsuffixed) row mixed with per-line (suffixed) rows is contradictory. A row written by the bare order
  // number with its key in Order Vendor still counts as written by the order number here, as it was before that key was read.
  if ((whole.length > 0 && whole.length < rows.length) || (byNumber > 0 && byNumber + whole.length < rows.length)) {
    return done('needs_manual', 'Sheet vừa có dòng cả đơn vừa có dòng lẻ cho cùng đơn', ageDays)
  }
  if (whole.length > 0) {
    if (new Set(whole.map(r => r.tracking)).size > 1) return done('needs_manual', 'Dòng cả đơn nhưng nhiều tracking khác nhau', ageDays)
    // A push records its tracking per line; one under the bare order number is a row nobody can tie to a line.
    if (whole.some(r => r.pushed)) return done('needs_manual', `Tracking xưởng API của ${baseOrder} không có mã dòng — không fulfill cả đơn`, ageDays)
    // The bare order number stands for the order's line only when the order has exactly one product line (add-ons aside),
    // in the tool and open in Shopify alike.
    const productIds = new Set([
      ...(input.productLines ?? []).map(l => l.shopifyLineId),
      ...Array.from(openByLineId.keys()).filter(id => !addOnLineIds.has(id)),
    ])
    const only = input.productLines?.length === 1 && productIds.size === 1 ? input.productLines[0] : null
    if (!only) {
      const sheets = Array.from(new Set(whole.flatMap(r => r.sheets ?? [])))
      const sheet = sheets.length ? `Sheet ${sheets.join(', ')}` : 'Sheet'
      if (!input.productLines) return done('needs_manual', `${sheet} ghi số đơn ${baseOrder} không có mã dòng và tool không có đơn này — không biết fulfill dòng nào`, ageDays)
      const keys = input.productLines.map(l => l.lineKey)
      return done('needs_manual', `${sheet} ghi số đơn ${baseOrder} không có mã dòng mà đơn có ${productIds.size} dòng sản phẩm${keys.length ? ` (${keys.join(', ')})` : ''} — xưởng/người fulfill phải ghi mã dòng (vd #${baseOrder}_2), không fulfill cả đơn`, ageDays)
    }
    rows = [{ ...whole[0], lineKey: only.lineKey, byOrderNumber: true }]
  }

  // A row the sheet wrote by the bare order number finds its line by key among the order's own lines; any other row maps
  // through the Shipment row of its key, as before. Today's numbering can differ from the one the key was written with (a
  // line reclassified since): a Shipment row of that key naming another line holds the order.
  const lineIdByKey = new Map((input.productLines ?? []).map(l => [l.lineKey, l.shopifyLineId]))
  for (const row of rows) {
    const ship = row.byOrderNumber ? undefined : shipmentByLineKey.get(row.lineKey)
    const lineId = row.byOrderNumber ? lineIdByKey.get(row.lineKey) : ship?.shopifyLineId
    if (!lineId) return done('needs_manual', `Không map được ${row.lineKey} sang line Shopify`, ageDays)
    const recorded = row.byOrderNumber ? shipmentByLineKey.get(row.lineKey) : undefined
    if (recorded && recorded.shopifyLineId !== lineId) {
      return done('needs_manual', `Mã ${row.lineKey} giờ là dòng khác với dòng Shipment đã ghi cho mã này — kiểm tra tay trước khi fulfill`, ageDays)
    }
    const open = openByLineId.get(lineId)
    if (!open) {
      // Listed line isn't open: on hold → needs a human; otherwise already fulfilled → skip (idempotent).
      if (heldLineIds.has(lineId)) return done('needs_manual', `Line ${row.lineKey} đang on-hold/scheduled`, ageDays)
      continue
    }
    const prev = lineTracking.get(open.foLineItemId)
    if (prev && prev !== row.tracking) return done('needs_manual', `Line ${row.lineKey} có 2 tracking khác nhau`, ageDays)
    lineTracking.set(open.foLineItemId, row.tracking)
    addLine(row.tracking, open.foId, open.foLineItemId, open.quantity, ship ? ship.id : shipmentIdByLineId.get(lineId))
    planned.push({ lineId, lineKey: row.lineKey, ...(row.sheets && !row.pushed ? { sheets: row.sheets } : {}) })
  }

  if (input.productLines) {
    const known = new Map(input.productLines.map(l => [l.shopifyLineId, l]))
    const products = planned.filter(p => !addOnLineIds.has(p.lineId))
    // Owner 2026-11-06: a line not exported to a supplier is never fulfilled (the customer would claim an item nobody
    // makes). Hold the whole order rather than fulfil the rest and silently drop that line.
    const unsent = Array.from(new Set(products.filter(p => !known.get(p.lineId)?.sent).map(p => p.lineKey)))
    if (unsent.length) return done('needs_manual', `Dòng ${unsent.join(', ')} chưa export sang xưởng — không fulfill để tránh khách claim`, ageDays)
    // A sheet row fulfils a line only from the supplier the line was sent to: each read-back sheet is one supplier's.
    const foreign = products.filter(p => {
      const supplier = known.get(p.lineId)?.supplier
      return p.sheets && !(supplier && p.sheets.some(s => sameName(s, supplier)))
    })
    if (foreign.length) {
      const which = foreign.map(p => `dòng ${p.lineKey} gửi xưởng ${known.get(p.lineId)?.supplier ?? 'chưa rõ'} mà tracking ở sheet ${p.sheets!.join(', ')}`)
      return done('needs_manual', `${Array.from(new Set(which)).join('; ')} — chỉ fulfill theo sheet của xưởng đã nhận dòng`, ageDays)
    }
  }

  // Non-product add-on lines (Shipping protection, Tip, Custom Text) are never listed in a
  // supplier sheet — nobody ships them — yet Shopify keeps them as OPEN fulfillment-order
  // lines, usually on a fulfillment order of their own. Left behind they hold the order at
  // PARTIALLY_FULFILLED forever. So once every real product line of the order is accounted
  // for (shipped now, or shipped earlier), close the add-on lines as well.
  const plannedFoLineIds = new Set<string>()
  groups.forEach(g => g.lineItems.forEach(li => plannedFoLineIds.add(li.id)))
  const openAddOns: Array<{ foId: string; foLineItemId: string; quantity: number }> = []
  let uncoveredProductLines = 0
  openByLineId.forEach((open, lineId) => {
    if (plannedFoLineIds.has(open.foLineItemId)) return
    if (addOnLineIds.has(lineId)) openAddOns.push(open)
    else uncoveredProductLines++
  })
  // A product line parked on a non-open FO (on hold/scheduled) also means the order is not
  // done shipping, so the add-ons keep waiting too.
  const hasHeldProductLine = Array.from(heldLineIds).some(id => !addOnLineIds.has(id))
  if (openAddOns.length > 0 && uncoveredProductLines === 0 && !hasHeldProductLine) {
    for (const a of openAddOns) {
      // Same fulfillment order as goods going out now → ride along on that fulfillment (one
      // shipping email, one tracking). Its own fulfillment order → close it with NO tracking
      // and no customer email: nothing physical ships, and repeating the tracking number
      // would create a duplicate shipment in ParcelPanel.
      const sameFo = Array.from(groups.values()).find(g => g.fulfillmentOrderId === a.foId)
      addLine(sameFo ? sameFo.tracking : '', a.foId, a.foLineItemId, a.quantity, undefined, !sameFo)
    }
  }

  const fulfillments = Array.from(groups.values()).filter(f => f.lineItems.length > 0)
  if (fulfillments.length === 0) return done('already_fulfilled', undefined, ageDays)
  // openLineCount lets the caller tell a FULL fulfillment (every open line covered) from a
  // partial one, so it can mark the order FULFILLED only when nothing remains open.
  // hasHeldLines: the order also has lines on non-open (on-hold/scheduled) FOs, so even
  // fulfilling every OPEN line does not complete the order — the caller must not mark it
  // fully FULFILLED in that case.
  return { baseOrder, status: 'will_fulfill', fulfillments, ageDays, openLineCount: openByLineId.size, hasHeldLines: heldLineIds.size > 0 }
}
