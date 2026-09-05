import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getShopifyConnection } from '@/lib/token-store'
import { syncParcelPanelTracking } from '@/lib/tracking/parcelpanel-sync'
import { getParcelPanelApiKey } from '@/lib/tracking/parcelpanel-config'

// One-time backfill: re-fetch ParcelPanel for shipments (INCLUDING delivered ones, which
// the normal sync skips) placed within `days`, so ppTimingJson is populated for the
// Supplier Performance report. Streams NDJSON progress.
export async function POST(req: NextRequest) {
  const daysRaw = Number(req.nextUrl.searchParams.get('days'))
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, Math.floor(daysRaw)) : 60

  const apiKey = await getParcelPanelApiKey()
  if (!apiKey) return NextResponse.json({ error: 'Chưa cấu hình ParcelPanel API key.' }, { status: 400 })
  const conn = await getShopifyConnection(req.headers.get('cookie') ?? undefined)
  const store = conn ? await prisma.shopifyStore.findUnique({ where: { shop: conn.shop } }) : null

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: any) => controller.enqueue(encoder.encode(JSON.stringify(o) + '\n'))
      try {
        const result = await syncParcelPanelTracking({
          apiKey, storeId: store?.id, includeDelivered: true, sinceDays: days,
          onProgress: (done, total) => send({ type: 'progress', done, total }),
        })
        send({ type: 'done', days, ...result })
      } catch (e: any) {
        send({ type: 'error', error: e?.message ?? 'backfill failed' })
      } finally { controller.close() }
    },
  })
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } })
}
