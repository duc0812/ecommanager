import { prisma } from '@/lib/db'
import { fetchSheetCsv, parseSheetCsv, csvExportUrl, parseSheetUrl } from './parse-sheet'
import { type SheetConfig } from './auto-fulfill-sheets'
import { groupByOrder, buildFulfillmentPlan, type OrderPlanStatus } from './build-fulfill-plan'
import { fetchOrderFulfillmentOrdersByNames, createFulfillment } from '@/lib/shopify-orders'

export type OrderResultRow = { baseOrder: string; status: OrderPlanStatus; trackings: string[]; fulfilledLines: number; message?: string }
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
    select: { shopifyOrderNumber: true, placedAt: true, shipments: { select: { id: true, lineKey: true, shopifyLineId: true } } },
  })
  const dbByName = new Map(orders.map(o => [o.shopifyOrderNumber.replace(/^#/, ''), o]))

  let done = 0
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

    const trackings = Array.from(new Set(plan.fulfillments.map(f => f.tracking)))
    let fulfilledLines = 0
    let message = plan.message

    if (opts.apply && plan.status === 'will_fulfill') {
      try {
        for (const f of plan.fulfillments) {
          const url = `${storeBase.replace(/\/$/, '')}/apps/trackingorder?nums=${encodeURIComponent(f.tracking)}`
          const r = await createFulfillment(opts.shop, opts.accessToken, {
            fulfillmentOrderId: f.fulfillmentOrderId, lineItems: f.lineItems,
            trackingInfo: { company: 'Other', number: f.tracking, url }, notifyCustomer: true,
          })
          if (r.ok) {
            fulfilledLines += f.lineItems.length
            if (f.shipmentIds.length > 0) {
              await prisma.shipment.updateMany({
                where: { id: { in: f.shipmentIds } },
                data: { trackingNumber: f.tracking, trackingUrl: url, shopifyFulfillmentId: r.fulfillmentId ?? undefined, status: 'FULFILLED' },
              })
            }
          } else {
            plan.status = 'error'
            message = r.error
          }
          await sleep(300)
        }
      } catch (e: any) {
        plan.status = 'error'
        message = e?.message ?? 'fulfill failed'
      }
    }

    summary.rows.push({ baseOrder: base, status: plan.status, trackings, fulfilledLines, message })
    switch (plan.status) {
      case 'will_fulfill': summary.fulfilled += opts.apply ? 1 : 0; break
      case 'too_recent': summary.tooRecent++; break
      case 'already_fulfilled': summary.alreadyFulfilled++; break
      case 'not_found': summary.notFound++; break
      case 'needs_manual': summary.needsManual++; break
      case 'error': summary.errored++; break
    }
    done++
    opts.onProgress?.(done, names.length)
  }
  return summary
}
