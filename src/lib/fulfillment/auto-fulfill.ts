import { prisma } from '@/lib/db'
import { fetchSheetCsv, parseSheetCsv, csvExportUrl, parseSheetUrl } from './parse-sheet'
import { type SheetConfig } from './auto-fulfill-sheets'
import { groupByOrder, buildFulfillmentPlan, type OrderPlanStatus } from './build-fulfill-plan'
import { fetchOrderFulfillmentOrdersByNames, createFulfillment } from '@/lib/shopify-orders'

export type FulfillmentDetail = { tracking: string; lineKeys: string[]; lineCount: number }
export type OrderResultRow = { baseOrder: string; status: OrderPlanStatus; trackings: string[]; fulfilledLines: number; message?: string; fulfillments?: FulfillmentDetail[] }
export type AutoFulfillSummary = {
  ordersChecked: number; fulfilled: number; tooRecent: number; alreadyFulfilled: number
  notFound: number; needsManual: number; errored: number; rows: OrderResultRow[]
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function runAutoFulfill(opts: {
  shop: string; accessToken: string; storeId: string
  sheets: SheetConfig[]
  minAgeDays: number; apply: boolean; now?: Date
  onProgress?: (done: number, total: number) => void
}): Promise<AutoFulfillSummary> {
  const now = opts.now ?? new Date()

  // 1) Read all enabled sheets, group rows by base order. First sheet wins on conflicts.
  const byOrder = new Map<string, { rows: Array<{ lineKey: string; tracking: string }>; storeBase: string }>()
  const sheetErrorRows: OrderResultRow[] = []
  for (const sheet of opts.sheets.filter(s => s.enabled)) {
    const ref = parseSheetUrl(sheet.url)
    if (!ref) continue
    let text: string
    try {
      text = await fetchSheetCsv(csvExportUrl(ref))
    } catch (e: any) {
      sheetErrorRows.push({
        baseOrder: `(sheet: ${sheet.name || sheet.url})`, status: 'error', trackings: [], fulfilledLines: 0,
        message: `Không tải được sheet: ${e?.message ?? 'lỗi'}`,
      })
      continue
    }
    const grouped = groupByOrder(parseSheetCsv(text))
    Array.from(grouped).forEach(([base, rows]) => { if (!byOrder.has(base)) byOrder.set(base, { rows, storeBase: sheet.storeBase }) })
  }

  const names = Array.from(byOrder.keys())
  const summary: AutoFulfillSummary = {
    ordersChecked: names.length, fulfilled: 0, tooRecent: 0, alreadyFulfilled: 0, notFound: 0, needsManual: 0,
    errored: sheetErrorRows.length, rows: [...sheetErrorRows],
  }
  if (names.length === 0) return summary

  const foMap = await fetchOrderFulfillmentOrdersByNames(opts.shop, opts.accessToken, names)
  const orders = await prisma.order.findMany({
    where: { storeId: opts.storeId, shopifyOrderNumber: { in: [...names, ...names.map(n => `#${n}`)] } },
    select: { id: true, shopifyOrderNumber: true, placedAt: true, pipelineStatus: true, shipments: { select: { id: true, lineKey: true, shopifyLineId: true } } },
  })
  const dbByName = new Map(orders.map(o => [o.shopifyOrderNumber.replace(/^#/, ''), o]))

  // 3) Evaluate every sheet order in-memory (the Shopify + DB fetches above already ran).
  type Evaluated = { base: string; plan: ReturnType<typeof buildFulfillmentPlan>; storeBase: string; db: (typeof orders)[number] | undefined; fulfilledLines: number }
  const evaluated: Evaluated[] = []
  let checked = 0
  for (const [base, { rows, storeBase }] of Array.from(byOrder)) {
    const db = dbByName.get(base)
    const fo = foMap.get(base)
    const plan = buildFulfillmentPlan({
      baseOrder: base, rows,
      shipments: db?.shipments ?? [],
      fulfillmentOrders: fo ? fo.fulfillmentOrders : null,
      displayFulfillmentStatus: fo?.displayFulfillmentStatus ?? null,
      placedAt: db?.placedAt ?? (fo ? new Date(fo.createdAt) : null),
      now, minAgeDays: opts.minAgeDays,
    })
    const plannedLines = plan.fulfillments.reduce((sum, f) => sum + f.lineItems.length, 0)
    evaluated.push({ base, plan, storeBase, db, fulfilledLines: opts.apply ? 0 : plannedLines })
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
          const url = `${e.storeBase.replace(/\/$/, '')}/apps/trackingorder?nums=${encodeURIComponent(f.tracking)}`
          const r = await createFulfillment(opts.shop, opts.accessToken, {
            fulfillmentOrderId: f.fulfillmentOrderId, lineItems: f.lineItems,
            trackingInfo: { company: 'Other', number: f.tracking, url }, notifyCustomer: true,
          })
          if (r.ok) {
            e.fulfilledLines += f.lineItems.length
            if (f.shipmentIds.length > 0) {
              await prisma.shipment.updateMany({
                where: { id: { in: f.shipmentIds } },
                data: { trackingNumber: f.tracking, trackingUrl: url, carrier: 'Other', shopifyFulfillmentId: r.fulfillmentId ?? undefined, status: 'FULFILLED' },
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
    }))
    summary.rows.push({ baseOrder: base, status: plan.status, trackings, fulfilledLines, message: plan.message, fulfillments })
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
