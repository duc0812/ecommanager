import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { VnepacketError, getTracking } from '@/lib/vnepacket'
import { getVnepacketSettings, hasVnepacketAccount, vnepacketSession } from '@/lib/vnepacket-settings'

/** Logs in again, and with `reference` asks VNEpacket for that one code as it is typed. */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({}))
  const reference = typeof body?.reference === 'string' ? body.reference.trim().slice(0, 80) : ''
  const settings = await getVnepacketSettings()
  if (!hasVnepacketAccount(settings)) return NextResponse.json({ error: 'Chưa lưu tài khoản VNEpacket' }, { status: 400 })
  const session = vnepacketSession(settings)
  try {
    await session.renew()
    if (!reference) return NextResponse.json({ ok: true, fullName: session.fullName() })
    const { tracking, message } = await getTracking(session, reference)
    return NextResponse.json({
      ok: true, fullName: session.fullName(), reference, found: !!tracking, message,
      tracking: tracking && { ...tracking, events: tracking.events.slice(0, 5), eventCount: tracking.events.length },
    })
  } catch (e: any) {
    const upstream = e instanceof VnepacketError ? e.status : 0
    return NextResponse.json({ error: `Kết nối VNEpacket thất bại: ${e?.message ?? e}` }, { status: upstream === 0 ? 504 : 502 })
  }
}
