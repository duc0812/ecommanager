import { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { syncVnepacketTracking } from '@/lib/repos/vnepacket-tracking'

/**
 * Runs the Gỗ 3D tracking pull now; `orderNumber` limits it to one order and re-reads it even when delivered.
 * VNEpacket answers one line at a time (~3s each), so the answer streams: nginx drops a request silent for 60s.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({}))
  const orderNumber = typeof body?.orderNumber === 'string' && body.orderNumber.trim() ? body.orderNumber.trim().slice(0, 40) : undefined

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: any) => controller.enqueue(encoder.encode(JSON.stringify(o) + '\n'))
      send({ type: 'started' })
      const heartbeat = setInterval(() => { try { send({ type: 'heartbeat' }) } catch { clearInterval(heartbeat) } }, 15_000)
      try {
        send({ type: 'done', ...(await syncVnepacketTracking({ orderNumber, withLines: true })) })
      } catch (e: any) {
        send({ type: 'error', error: `Không đồng bộ được tracking Gỗ 3D: ${e?.message ?? e}` })
      } finally {
        clearInterval(heartbeat)
        controller.close()
      }
    },
  })
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } })
}
