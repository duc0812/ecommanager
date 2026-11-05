import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { BondreError, getAccount } from '@/lib/bondre'
import { bondreSession, getBondreSettings, hasBondreAccount } from '@/lib/bondre-settings'

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const settings = await getBondreSettings()
  if (!hasBondreAccount(settings)) return NextResponse.json({ error: 'Chưa lưu email / mật khẩu Bondre' }, { status: 400 })
  try {
    return NextResponse.json({ ok: true, account: await getAccount(bondreSession(settings)) })
  } catch (e: any) {
    const upstream = e instanceof BondreError ? e.status : 0
    return NextResponse.json({ error: `Kết nối Bondre thất bại: ${e?.message ?? e}`, upstreamStatus: upstream }, { status: upstream === 0 ? 504 : 502 })
  }
}
