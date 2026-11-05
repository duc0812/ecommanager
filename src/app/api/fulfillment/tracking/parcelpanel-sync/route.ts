import { NextResponse } from 'next/server'
import { syncParcelPanelForStore } from '@/lib/tracking/parcelpanel-store-sync'
import { getParcelPanelApiKey } from '@/lib/tracking/parcelpanel-config'
import { listConnectedStores } from '@/lib/store-connections'
import { failedResults, forEachConnectedStore, mergeStoreResults, storeRunSummary } from '@/lib/store-jobs'

// Manual trigger for the ParcelPanel tracking status sync (same as the daily cron), store by store, each under its own key.
// Streams NDJSON so the tool can show live progress:
//   {"type":"progress","done":N,"total":M}
//   {"type":"done", ...result}   |   {"type":"error","error":"..."}
export async function POST() {
  const stores = await listConnectedStores()
  const keys = await Promise.all(stores.map(s => getParcelPanelApiKey(s.id)))
  if (stores.length > 0 && !keys.some(Boolean)) return NextResponse.json({ error: 'Chưa cấu hình ParcelPanel API key. Nhập key ở nút cấu hình trên trang Tracking.' }, { status: 400 })

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
      try {
        // Progress counts orders across stores: each store starts where the finished ones ended.
        let finishedTotal = 0
        const results = await forEachConnectedStore('parcelpanel-sync', async (conn) => {
          let storeTotal = 0
          const result = await syncParcelPanelForStore(conn, {
            onProgress: (done, total) => { storeTotal = total; send({ type: 'progress', done: finishedTotal + done, total: finishedTotal + total }) },
          })
          finishedTotal += storeTotal
          return result
        })
        const merged = mergeStoreResults(results, { sum: ['ordersChecked', 'shipmentsUpdated', 'delivered'], concat: ['errors'] })
        if (results.length === 0) send({ type: 'error', error: 'Not connected to Shopify.' })
        else if (!merged) send({ type: 'error', error: failedResults(results)[0].error })
        else send({ type: 'done', ...merged, stores: storeRunSummary(results) })
      } catch (e: any) {
        send({ type: 'error', error: e?.message ?? 'sync failed' })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no', // tell nginx on the VPS not to buffer the stream
    },
  })
}
