import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getShopifyConnection } from '@/lib/token-store'
import { syncParcelPanelTracking } from '@/lib/tracking/parcelpanel-sync'
import { getParcelPanelApiKey } from '@/lib/tracking/parcelpanel-config'

// Manual trigger for the ParcelPanel tracking status sync (same as the daily cron).
// Streams NDJSON so the tool can show live progress:
//   {"type":"progress","done":N,"total":M}
//   {"type":"done", ...result}   |   {"type":"error","error":"..."}
export async function POST() {
  const apiKey = await getParcelPanelApiKey()
  if (!apiKey) return NextResponse.json({ error: 'Chưa cấu hình ParcelPanel API key. Nhập key ở nút cấu hình trên trang Tracking.' }, { status: 400 })

  const conn = await getShopifyConnection()
  const store = conn ? await prisma.shopifyStore.findUnique({ where: { shop: conn.shop } }) : null

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
      try {
        const result = await syncParcelPanelTracking({
          apiKey,
          storeId: store?.id,
          onProgress: (done, total) => send({ type: 'progress', done, total }),
        })
        send({ type: 'done', ...result })
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
