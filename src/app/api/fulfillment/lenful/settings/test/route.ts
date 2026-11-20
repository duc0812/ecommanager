import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { LenfulError } from '@/lib/lenful'
import { getLenfulSettings } from '@/lib/lenful-settings'
import { checkLenfulConnection } from '@/lib/repos/lenful-push'
import { safeErrorText } from '@/lib/store-jobs'

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const settings = await getLenfulSettings()
  if (!settings.apiKey) return NextResponse.json({ error: 'Chưa lưu API key Lenful' }, { status: 400 })
  try {
    return NextResponse.json({ ok: true, ...(await checkLenfulConnection()) })
  } catch (e) {
    const upstream = e instanceof LenfulError ? e.status : 0
    const reason = safeErrorText(e, [settings.apiKey])
    return NextResponse.json({ error: `Kết nối Lenful thất bại: ${reason}`, upstreamStatus: upstream }, { status: upstream === 0 ? 504 : 502 })
  }
}
