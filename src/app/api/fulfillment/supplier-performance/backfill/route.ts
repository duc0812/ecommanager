import { NextRequest, NextResponse } from 'next/server'
import { forEachParcelPanelStore, partitionByParcelPanelKey, syncParcelPanelForStore } from '@/lib/tracking/parcelpanel-store-sync'
import { failedResults, mergeStoreResults, storeRunSummary } from '@/lib/store-jobs'

// One-time backfill: re-fetch ParcelPanel for shipments (INCLUDING delivered ones, which
// the normal sync skips) placed within `days`, so ppTimingJson is populated for the
// Supplier Performance report. Streams NDJSON progress, store by store.
export async function POST(req: NextRequest) {
  const daysRaw = Number(req.nextUrl.searchParams.get('days'))
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, Math.floor(daysRaw)) : 60

  const { keyed, keyless } = await partitionByParcelPanelKey()
  if (keyed.length === 0 && keyless.length > 0) return NextResponse.json({ error: 'Chưa cấu hình ParcelPanel API key.' }, { status: 400 })

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: any) => controller.enqueue(encoder.encode(JSON.stringify(o) + '\n'))
      try {
        let finishedTotal = 0
        const results = await forEachParcelPanelStore('parcelpanel-backfill', async (conn) => {
          let storeTotal = 0
          const result = await syncParcelPanelForStore(conn, {
            includeDelivered: true, sinceDays: days,
            onProgress: (done, total) => { storeTotal = total; send({ type: 'progress', done: finishedTotal + done, total: finishedTotal + total }) },
          })
          finishedTotal += storeTotal
          return result
        })
        const merged = mergeStoreResults(results, { sum: ['ordersChecked', 'shipmentsUpdated', 'delivered'], concat: ['errors'] })
        if (results.length === 0) send({ type: 'error', error: 'Not connected to Shopify.' })
        else if (!merged) send({ type: 'error', error: failedResults(results)[0].error })
        else send({ type: 'done', days, ...merged, stores: storeRunSummary(results) })
      } catch (e: any) {
        send({ type: 'error', error: e?.message ?? 'backfill failed' })
      } finally { controller.close() }
    },
  })
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } })
}
