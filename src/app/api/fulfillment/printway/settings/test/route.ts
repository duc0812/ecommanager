import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { PrintwayError, listAllSkus } from '@/lib/printway'
import { getPrintwaySettings } from '@/lib/printway-settings'

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const { token } = await getPrintwaySettings()
  if (!token) return NextResponse.json({ error: 'Chưa lưu token Printway' }, { status: 400 })
  try {
    return NextResponse.json({ ok: true, skuCount: (await listAllSkus(token)).length })
  } catch (e: any) {
    const upstream = e instanceof PrintwayError ? e.status : 0
    return NextResponse.json({ error: `Kết nối Printway thất bại: ${e?.message ?? e}`, upstreamStatus: upstream }, { status: upstream === 0 ? 504 : 502 })
  }
}
