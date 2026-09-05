import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getShopifyConnection } from '@/lib/token-store'
import { getSheets, getMinAgeDays } from '@/lib/fulfillment/auto-fulfill-sheets'
import { runAutoFulfill } from '@/lib/fulfillment/auto-fulfill'

export async function POST(req: NextRequest) {
  const apply = req.nextUrl.searchParams.get('apply') === '1'
  const conn = await getShopifyConnection(req.headers.get('cookie') ?? undefined)
  if (!conn) return NextResponse.json({ error: 'Chưa kết nối Shopify. Vào /setup để kết nối.' }, { status: 401 })
  const store = await prisma.shopifyStore.findUnique({ where: { shop: conn.shop } })
  if (!store) return NextResponse.json({ error: 'Store chưa có trong DB.' }, { status: 404 })
  const [sheets, minAgeDays] = await Promise.all([getSheets(), getMinAgeDays()])

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: any) => controller.enqueue(encoder.encode(JSON.stringify(o) + '\n'))
      try {
        const result = await runAutoFulfill({
          shop: conn.shop, accessToken: conn.token, storeId: store.id,
          sheets, minAgeDays, apply,
          onProgress: (done, total) => send({ type: 'progress', done, total }),
        })
        send({ type: 'done', apply, ...result })
      } catch (e: any) {
        send({ type: 'error', error: e?.message ?? 'failed' })
      } finally { controller.close() }
    },
  })
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } })
}
