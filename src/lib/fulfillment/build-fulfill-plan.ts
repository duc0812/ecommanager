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

export function groupByOrder(rows: SheetRow[]): Map<string, Array<{ lineKey: string; tracking: string }>> {
  const g = new Map<string, Array<{ lineKey: string; tracking: string }>>()
  for (const r of rows) {
    const base = normalizeBaseOrder(r.orderToken)
    const arr = g.get(base) ?? []
    arr.push({ lineKey: orderLineKey(r.orderToken), tracking: r.tracking.trim() })
    g.set(base, arr)
  }
  return g
}

export type FOLineItem = { id: string; remainingQuantity: number; shopifyLineId: string; sku: string | null }
export type FulfillmentOrderRef = { id: string; status: string; lineItems: FOLineItem[] }
export type PlannedFulfillment = { fulfillmentOrderId: string; lineItems: Array<{ id: string; quantity: number }>; tracking: string; shipmentIds: string[] }
export type OrderPlanStatus = 'will_fulfill' | 'too_recent' | 'already_fulfilled' | 'not_found' | 'needs_manual' | 'error'
export type OrderPlan = { baseOrder: string; status: OrderPlanStatus; fulfillments: PlannedFulfillment[]; message?: string; ageDays?: number; openLineCount?: number; hasHeldLines?: boolean }

export function buildFulfillmentPlan(input: {
  baseOrder: string
  rows: Array<{ lineKey: string; tracking: string }>
  shipments: Array<{ id: string; lineKey: string; shopifyLineId: string | null }>
  fulfillmentOrders: FulfillmentOrderRef[] | null
  displayFulfillmentStatus: string | null
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

  const shipmentByLineKey = new Map(input.shipments.filter(s => s.shopifyLineId).map(s => [s.lineKey, s]))
  const shipmentIdByLineId = new Map(input.shipments.filter(s => s.shopifyLineId).map(s => [s.shopifyLineId as string, s.id]))

  // Lines that exist but sit on a non-open FO (on hold / scheduled) — so a listed line
  // that maps here is NOT "already fulfilled"; it needs a human.
  const heldLineIds = new Set<string>()
  input.fulfillmentOrders.forEach(fo => {
    if (!OPEN_FO_STATUSES.has(fo.status)) fo.lineItems.forEach(li => heldLineIds.add(li.shopifyLineId))
  })

  const isWholeOrderRow = (lineKey: string) => lineKey === baseOrder

  // key: `${foId} ${tracking}` -> PlannedFulfillment
  const groups = new Map<string, PlannedFulfillment>()
  const lineTracking = new Map<string, string>() // foLineItemId -> tracking, to catch conflicts
  const addLine = (tracking: string, foId: string, foLineItemId: string, quantity: number, shipmentId?: string) => {
    const key = `${foId} ${tracking}`
    const g = groups.get(key) ?? { fulfillmentOrderId: foId, lineItems: [], tracking, shipmentIds: [] }
    if (!g.lineItems.some(li => li.id === foLineItemId)) g.lineItems.push({ id: foLineItemId, quantity })
    if (shipmentId && !g.shipmentIds.includes(shipmentId)) g.shipmentIds.push(shipmentId)
    groups.set(key, g)
  }

  // Fulfill ONLY the sub-orders listed in the sheet, grouped by tracking:
  //  - all listed sub-orders share one tracking → merge into ONE fulfillment (whole order);
  //  - different trackings → one fulfillment per tracking (split shipment);
  //  - only some items listed (the rest not shipped yet) → fulfill the listed lines and
  //    leave the others untouched (partial). A line NOT listed is never fulfilled.
  // Anything ambiguous → needs_manual (never guess — this feature emails customers).
  const hasWhole = input.rows.some(r => isWholeOrderRow(r.lineKey))
  const hasSuffixed = input.rows.some(r => !isWholeOrderRow(r.lineKey))

  if (hasWhole && hasSuffixed) {
    // A whole-order (unsuffixed) row mixed with per-line (suffixed) rows is contradictory.
    return done('needs_manual', 'Sheet vừa có dòng cả đơn vừa có dòng lẻ cho cùng đơn', ageDays)
  }

  if (hasWhole) {
    // Only unsuffixed row(s): whole order. They must agree on one tracking.
    const wholeTrackings = new Set(input.rows.map(r => r.tracking))
    if (wholeTrackings.size > 1) return done('needs_manual', 'Dòng cả đơn nhưng nhiều tracking khác nhau', ageDays)
    const tracking = input.rows[0].tracking
    openByLineId.forEach((open, lineId) => addLine(tracking, open.foId, open.foLineItemId, open.quantity, shipmentIdByLineId.get(lineId)))
  } else {
    for (const row of input.rows) {
      const ship = shipmentByLineKey.get(row.lineKey)
      if (!ship || !ship.shopifyLineId) return done('needs_manual', `Không map được ${row.lineKey} sang line Shopify`, ageDays)
      const open = openByLineId.get(ship.shopifyLineId)
      if (!open) {
        // Listed line isn't open: on hold → needs a human; otherwise already fulfilled → skip (idempotent).
        if (heldLineIds.has(ship.shopifyLineId)) return done('needs_manual', `Line ${row.lineKey} đang on-hold/scheduled`, ageDays)
        continue
      }
      const prev = lineTracking.get(open.foLineItemId)
      if (prev && prev !== row.tracking) return done('needs_manual', `Line ${row.lineKey} có 2 tracking khác nhau`, ageDays)
      lineTracking.set(open.foLineItemId, row.tracking)
      addLine(row.tracking, open.foId, open.foLineItemId, open.quantity, ship.id)
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
