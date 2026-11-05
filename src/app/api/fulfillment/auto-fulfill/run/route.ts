import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getStoreConnectionByShop, tryStoreConnection } from '@/lib/store-connections'
import { connectionFailureResponse } from '@/lib/store-connection-response'
import { LITZZY_SHOP } from '@/lib/shopify-shop'
import { getSheets, getMinAgeDays } from '@/lib/fulfillment/auto-fulfill-sheets'
import { runAutoFulfill } from '@/lib/fulfillment/auto-fulfill'
import { syncPgprintsTracking } from '@/lib/repos/pgprints-push'
import { syncApiSupplierTracking } from '@/lib/repos/supplier-tracking-sync'

export async function POST(req: NextRequest) {
  const apply = req.nextUrl.searchParams.get('apply') === '1'
  const { conn, error } = await tryStoreConnection(() => getStoreConnectionByShop(LITZZY_SHOP))
  if (!conn) return connectionFailureResponse(error, { error: 'Chưa kết nối Shopify. Vào /setup để kết nối.', status: 401 })
  const store = await prisma.shopifyStore.findUnique({ where: { shop: conn.shop } })
  if (!store) return NextResponse.json({ error: 'Store chưa có trong DB.' }, { status: 404 })
  const [sheets, minAgeDays] = await Promise.all([getSheets(), getMinAgeDays()])

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: any) => controller.enqueue(encoder.encode(JSON.stringify(o) + '\n'))
      // First bytes go out before any slow work, so the proxy sees a response straight away.
      send({ type: 'stage', stage: 'pgprints', done: 0, total: 1 })
      try {
        const pg = await syncPgprintsTracking().catch((e: any) => ({ error: e?.message ?? String(e) }))
        send({ type: 'pgprints', ...pg })
        for (const r of await syncApiSupplierTracking()) send({ type: 'supplier-tracking', ...r })
        const result = await runAutoFulfill({
          shop: conn.shop, accessToken: conn.token, storeId: store.id,
          sheets, minAgeDays, apply,
          onProgress: (done, total) => send({ type: 'progress', done, total }),
          onStage: (stage, done, total) => send({ type: 'stage', stage, done, total }),
        })
        send({ type: 'done', apply, ...result })
      } catch (e: any) {
        send({ type: 'error', error: e?.message ?? 'failed' })
      } finally { controller.close() }
    },
  })
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } })
}
