import { prisma } from '@/lib/db'
import { fetchSheetCsv, parseSheetCsv, csvExportUrl, parseSheetUrl } from './parse-sheet'
import { type SheetConfig } from './auto-fulfill-sheets'
import { groupByOrder, mergeSheetGroups, buildFulfillmentPlan, type OrderPlanStatus, type OrderRow } from './build-fulfill-plan'
import { fetchOrderFulfillmentOrdersByNames, createFulfillment } from '@/lib/shopify-orders'
import { isNonProductLine, lineKeysOf } from '@/lib/order-lines'
import { needsFileLines, pushedShopifyLineIds } from '@/lib/line-export'
import { sentFileLines } from '@/lib/repos/push-export'

export type FulfillmentDetail = { tracking: string; lineKeys: string[]; lineCount: number; addOn?: boolean }
export type OrderResultRow = { baseOrder: string; status: OrderPlanStatus; trackings: string[]; fulfilledLines: number; message?: string; fulfillments?: FulfillmentDetail[]; shop?: string; storeName?: string }
export type AutoFulfillSummary = {
  ordersChecked: number; fulfilled: number; tooRecent: number; alreadyFulfilled: number
  notFound: number; needsManual: number; errored: number; rows: OrderResultRow[]
}

export type AutoFulfillStage = 'sheets' | 'shopify' | 'pgprints'

// The link the customer gets for a parcel comes from the order's own store (the page + "nums=" it was
// set up with), never from the sheet the row was read from. No page set up, no link.
export function trackingUrlFor(store: { trackingPageUrl: string | null }, tracking: string): string | undefined {
  const page = store.trackingPageUrl?.trim()
  return page ? `${page}${encodeURIComponent(tracking)}` : undefined
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Same verdicts buildFulfillmentPlan reaches first (too_recent, then already_fulfilled), taken
// from the DB copy of Shopify's displayFulfillmentStatus. Anything else returns null → ask Shopify.
export function settleFromDb(
  baseOrder: string,
  db: { placedAt: Date | null; fulfillmentStatus: string | null } | undefined,
  now: Date, minAgeDays: number,
): ReturnType<typeof buildFulfillmentPlan> | null {
  if (!db?.placedAt) return null
  const ageDays = Math.floor((now.getTime() - db.placedAt.getTime()) / 86_400_000)
  if (ageDays < minAgeDays) return { baseOrder, status: 'too_recent', fulfillments: [], message: `Mới ${ageDays} ngày`, ageDays }
  if ((db.fulfillmentStatus ?? '').toUpperCase() === 'FULFILLED') return { baseOrder, status: 'already_fulfilled', fulfillments: [], ageDays }
  return null
}

// Orders pushed to a supplier by API (PGprints) get their tracking on Shipment rows from the
// supplier sync rather than a sheet. Those trackings exist only once the parcel shipped, so
// these orders skip the min-age gate that protects pre-printed sheet trackings. Each row is one
// Shipment, so one line: a row under the bare order number is held by the plan, never read as the whole order.
export async function pushedShipmentRows(storeId: string): Promise<Map<string, OrderRow[]>> {
  const pushes = await prisma.supplierOrderPush.findMany({
    where: { status: 'CREATED', order: { storeId } },
    select: {
      supplierId: true,
      order: { select: { shopifyOrderNumber: true, shipments: { where: { trackingNumber: { not: null }, shopifyFulfillmentId: null }, select: { lineKey: true, trackingNumber: true, supplierId: true } } } },
    },
  })
  const out = new Map<string, OrderRow[]>()
  for (const p of pushes) {
    const rows = p.order.shipments
      .filter(s => s.supplierId === p.supplierId && !!s.trackingNumber?.trim())
      .map(s => ({ lineKey: s.lineKey, tracking: (s.trackingNumber as string).trim() }))
    if (rows.length === 0) continue
    const base = p.order.shopifyOrderNumber.replace(/^#/, '')
    out.set(base, [...(out.get(base) ?? []), ...rows])
  }
  return out
}

// A product line went to a supplier when it was exported (CSV, sheet push, hand-off, or an API push that marked it), or
// when a push that landed (CREATED) carried it: a push made while the order could not be marked exported stays unmarked.
// What a push carried is read as the tracking pull reads it (pushedShopifyLineIds), so it outlives the order sync.
function isSentToSupplier(
  line: { shopifyLineId: string; resolvedSupplierId: string | null; exportedAt: Date | null },
  carriedByPush: Array<{ supplierId: string; carried: string[] | null }>,
): boolean {
  if (line.exportedAt) return true
  return carriedByPush.some(p => p.supplierId === line.resolvedSupplierId && (!p.carried || p.carried.includes(line.shopifyLineId)))
}

export type SheetData = { name: string; groups: Map<string, OrderRow[]> }

// Each enabled sheet is downloaded once, however many stores then take their own rows from it.
export async function readAutoFulfillSheets(
  sheets: SheetConfig[],
  onStage?: (stage: AutoFulfillStage, done: number, total: number) => void,
): Promise<{ sheets: SheetData[]; errorRows: OrderResultRow[] }> {
  const data: SheetData[] = []
  const errorRows: OrderResultRow[] = []
  const enabledSheets = sheets.filter(s => s.enabled)
  let sheetsRead = 0
  for (const sheet of enabledSheets) {
    onStage?.('sheets', sheetsRead++, enabledSheets.length)
    const ref = parseSheetUrl(sheet.url)
    if (!ref) continue
    let text: string
    try {
      text = await fetchSheetCsv(csvExportUrl(ref))
    } catch (e: any) {
      errorRows.push({
        baseOrder: `(sheet: ${sheet.name || sheet.url})`, status: 'error', trackings: [], fulfilledLines: 0,
        message: `Không tải được sheet: ${e?.message ?? 'lỗi'}`,
      })
      continue
    }
    data.push({ name: sheet.name, groups: groupByOrder(parseSheetCsv(text)) })
  }
  return { sheets: data, errorRows }
}

export async function runAutoFulfill(opts: {
  shop: string; accessToken: string; storeId: string
  // What a result row shows as its store (the project name, or the shop).
  storeName?: string
  // The store's tracking page ("https://litzzy.com/apps/trackingorder?nums="); null or missing = fulfil without a link.
  trackingPageUrl?: string | null
  // Either the sheets to download, or sheets already downloaded (and narrowed to this store's rows).
  sheets: SheetConfig[]
  sheetData?: SheetData[]
  minAgeDays: number; apply: boolean; now?: Date
  onProgress?: (done: number, total: number) => void
  // Fires during the slow read phase (sheets, then ~1 Shopify request per 25 orders) so a
  // streaming caller can keep sending bytes; nginx drops a request that is silent for 60s.
  onStage?: (stage: AutoFulfillStage, done: number, total: number) => void
}): Promise<AutoFulfillSummary> {
  const now = opts.now ?? new Date()

  // 1) Group rows of the sheets by base order. Rows for the same order are
  //    MERGED across sheets — a multi-supplier order lists its sub-orders in each supplier's
  //    own sheet, so keeping only the first sheet's rows would silently skip the others.
  //    Each row keeps the sheet it came from: a sheet row fulfils a line only from the supplier the line was sent to.
  const byOrder = new Map<string, { rows: OrderRow[] }>()
  const read = opts.sheetData ? { sheets: opts.sheetData, errorRows: [] as OrderResultRow[] } : await readAutoFulfillSheets(opts.sheets, opts.onStage)
  const sheetErrorRows = read.errorRows
  for (const sheet of read.sheets) mergeSheetGroups(byOrder, sheet.groups, sheet.name)
  const pushed = await pushedShipmentRows(opts.storeId)
  mergeSheetGroups(byOrder, new Map(Array.from(pushed, ([base, rows]) => [base, rows.map(r => ({ ...r, pushed: true }))])))
  const minAgeFor = (base: string) => (pushed.has(base) ? 0 : opts.minAgeDays)

  const names = Array.from(byOrder.keys())
  const summary: AutoFulfillSummary = {
    ordersChecked: names.length, fulfilled: 0, tooRecent: 0, alreadyFulfilled: 0, notFound: 0, needsManual: 0,
    errored: sheetErrorRows.length, rows: [...sheetErrorRows],
  }
  if (names.length === 0) return summary

  const orders = await prisma.order.findMany({
    where: { storeId: opts.storeId, shopifyOrderNumber: { in: [...names, ...names.map(n => `#${n}`)] } },
    select: {
      id: true, shopifyOrderNumber: true, placedAt: true, pipelineStatus: true, fulfillmentStatus: true,
      shipments: { select: { id: true, lineKey: true, shopifyLineId: true } },
      // Non-product lines (Shipping protection / Tip / Custom Text) have no Shipment row and
      // never appear in a supplier sheet, but Shopify still waits for them to be fulfilled.
      lines: { select: { id: true, shopifyLineId: true, sku: true, productTitle: true, shopifyProductType: true, linePosition: true, resolvedSupplierId: true, exportedToSupplierId: true, exportedAt: true } },
      // Pushes that landed, for isSentToSupplier. No orderBy in these relations: every sheet order is read here (thousands),
      // and Prisma cannot split an ordered relation under SQLite's bind limit.
      supplierPushes: { where: { status: 'CREATED' }, select: { id: true, supplierId: true, prevExportJson: true } },
    },
  })
  const dbByName = new Map(orders.map(o => [o.shopifyOrderNumber.replace(/^#/, ''), o]))

  // The sheets keep every order ever shipped, so most rows are long done. Settle those from the
  // DB and only ask Shopify (needed anyway for fulfillment-order ids) about the rest.
  const settled = new Map<string, ReturnType<typeof buildFulfillmentPlan>>()
  for (const base of names) {
    const plan = settleFromDb(base, dbByName.get(base), now, minAgeFor(base))
    if (plan) settled.set(base, plan)
  }
  const foMap = await fetchOrderFulfillmentOrdersByNames(opts.shop, opts.accessToken, names.filter(n => !settled.has(n)), undefined,
    (done, total) => opts.onStage?.('shopify', done, total))

  // A read-back sheet is named after its supplier: a line's supplier is the one it was exported to, else the one it maps to.
  const suppliers = names.some(n => !settled.has(n) && dbByName.has(n)) ? await prisma.supplier.findMany({ select: { id: true, name: true } }) : []
  const supplierName = new Map(suppliers.map(s => [s.id, s.name]))
  // A push stored before Shopify line ids were recorded, whose OrderLine ids the order sync replaced, is read by the files it
  // sent. Only those few pushes have their request loaded.
  const stale = names.filter(n => !settled.has(n)).flatMap(n => {
    const db = dbByName.get(n)
    return db ? db.supplierPushes.filter(p => needsFileLines(p, db.lines)).map(p => p.id) : []
  })
  const fileLinesOf = new Map<string, string[]>()
  if (stale.length) {
    for (const p of await prisma.supplierOrderPush.findMany({ where: { id: { in: stale } }, select: { id: true, orderId: true, requestJson: true } })) {
      fileLinesOf.set(p.id, await sentFileLines(p))
    }
  }
  const productLinesFor = (db: (typeof orders)[number]) => {
    const keys = lineKeysOf(db.shopifyOrderNumber, db.lines)
    const carriedByPush = db.supplierPushes.map(p => ({ supplierId: p.supplierId, carried: pushedShopifyLineIds(p, db.lines, fileLinesOf.get(p.id)) }))
    return db.lines.filter(l => !isNonProductLine(l)).map(l => ({
      shopifyLineId: l.shopifyLineId, lineKey: keys.get(l.shopifyLineId) as string, sent: isSentToSupplier(l, carriedByPush),
      supplier: supplierName.get(l.exportedToSupplierId ?? l.resolvedSupplierId ?? '') ?? null,
    }))
  }

  // 3) Evaluate every sheet order in-memory (the Shopify + DB fetches above already ran).
  type Evaluated = { base: string; plan: ReturnType<typeof buildFulfillmentPlan>; db: (typeof orders)[number] | undefined; fulfilledLines: number }
  const evaluated: Evaluated[] = []
  let checked = 0
  for (const [base, { rows }] of Array.from(byOrder)) {
    const db = dbByName.get(base)
    const fo = foMap.get(base)
    const plan = settled.get(base) ?? buildFulfillmentPlan({
      baseOrder: base, rows,
      shipments: db?.shipments ?? [],
      fulfillmentOrders: fo ? fo.fulfillmentOrders : null,
      displayFulfillmentStatus: fo?.displayFulfillmentStatus ?? null,
      addOnLineIds: (db?.lines ?? []).filter(l => isNonProductLine(l)).map(l => l.shopifyLineId),
      productLines: db ? productLinesFor(db) : undefined,
      placedAt: db?.placedAt ?? (fo ? new Date(fo.createdAt) : null),
      now, minAgeDays: minAgeFor(base),
    })
    const plannedLines = plan.fulfillments.reduce((sum, f) => sum + f.lineItems.length, 0)
    evaluated.push({ base, plan, db, fulfilledLines: opts.apply ? 0 : plannedLines })
    checked++
    if (!opts.apply) opts.onProgress?.(checked, names.length) // Preview: progress over all orders checked
  }

  // 4) Apply creates fulfillments ONLY for the will_fulfill orders; progress reflects
  //    that subset (not every order checked). Per-order errors don't abort the batch.
  if (opts.apply) {
    const toFulfill = evaluated.filter(e => e.plan.status === 'will_fulfill')
    let done = 0
    for (const e of toFulfill) {
      try {
        for (const f of e.plan.fulfillments) {
          // Add-on fulfillment (Shipping protection & co on their own fulfillment order):
          // no tracking and no email — nothing ships, and the customer already got the
          // shipping notice for the real parcel.
          const url = trackingUrlFor({ trackingPageUrl: opts.trackingPageUrl ?? null }, f.tracking)
          const r = await createFulfillment(opts.shop, opts.accessToken, {
            fulfillmentOrderId: f.fulfillmentOrderId, lineItems: f.lineItems,
            trackingInfo: f.addOn ? undefined : { company: 'Other', number: f.tracking, ...(url ? { url } : {}) },
            notifyCustomer: !f.addOn,
          })
          if (r.ok) {
            e.fulfilledLines += f.lineItems.length
            if (f.shipmentIds.length > 0) {
              await prisma.shipment.updateMany({
                where: { id: { in: f.shipmentIds } },
                data: { trackingNumber: f.tracking, trackingUrl: url ?? null, carrier: 'Other', shopifyFulfillmentId: r.fulfillmentId ?? undefined, status: 'FULFILLED' },
              })
            }
          } else {
            e.plan.status = 'error'
            e.plan.message = r.error
          }
          await sleep(300)
        }
      } catch (err: any) {
        e.plan.status = 'error'
        e.plan.message = err?.message ?? 'fulfill failed'
      }
      // If EVERY open line of this order was fulfilled (a full, not partial, fulfillment)
      // and nothing errored, sync the DB order so Order P/L + late-fulfillment views reflect
      // FULFILLED right away instead of waiting for the next Shopify tracking sync.
      if (e.plan.status === 'will_fulfill' && e.db && !e.plan.hasHeldLines && e.plan.openLineCount != null && e.fulfilledLines >= e.plan.openLineCount) {
        const ps = (e.db.pipelineStatus ?? '').toUpperCase()
        if (ps !== 'CANCELLED' && ps !== 'REFUNDED') {
          try {
            await prisma.order.update({ where: { id: e.db.id }, data: { fulfillmentStatus: 'FULFILLED', pipelineStatus: 'FULFILLED' } })
          } catch { /* non-fatal: the daily tracking sync reconciles order status from Shopify */ }
        }
      }
      done++
      opts.onProgress?.(done, toFulfill.length)
    }
  }

  // 5) Build result rows + counters from every evaluated order.
  for (const e of evaluated) {
    const { base, plan, db, fulfilledLines } = e
    const trackings = Array.from(new Set(plan.fulfillments.map(f => f.tracking)))
    // Per-fulfillment breakdown so the UI can show each sub-order line ↔ its tracking.
    const lineKeyByShipmentId = new Map((db?.shipments ?? []).map(s => [s.id, s.lineKey]))
    const fulfillments: FulfillmentDetail[] = plan.fulfillments.map(f => ({
      tracking: f.tracking,
      lineKeys: f.shipmentIds.map(id => lineKeyByShipmentId.get(id)).filter((k): k is string => !!k),
      lineCount: f.lineItems.length,
      ...(f.addOn ? { addOn: true } : {}),
    }))
    summary.rows.push({ baseOrder: base, status: plan.status, trackings, fulfilledLines, message: plan.message, fulfillments, shop: opts.shop, storeName: opts.storeName })
    switch (plan.status) {
      case 'will_fulfill': summary.fulfilled++; break
      case 'too_recent': summary.tooRecent++; break
      case 'already_fulfilled': summary.alreadyFulfilled++; break
      case 'not_found': summary.notFound++; break
      case 'needs_manual': summary.needsManual++; break
      case 'error': summary.errored++; break
    }
  }
  return summary
}
