import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { syncVnepacketTracking } from '@/lib/repos/vnepacket-tracking'

/** Runs the Gỗ 3D tracking pull now; `orderNumber` limits it to one order and re-reads it even when delivered. */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({}))
  const orderNumber = typeof body?.orderNumber === 'string' && body.orderNumber.trim() ? body.orderNumber.trim().slice(0, 40) : undefined
  try {
    return NextResponse.json(await syncVnepacketTracking({ orderNumber, withLines: true }))
  } catch (e: any) {
    return NextResponse.json({ error: `Không đồng bộ được tracking Gỗ 3D: ${e?.message ?? e}` }, { status: 500 })
  }
}
