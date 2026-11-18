import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { CatkissfishError } from '@/lib/catkissfish'
import { getCatkissfishSettings, hasCatkissfishAccount } from '@/lib/catkissfish-settings'
import { checkCatkissfishConnection } from '@/lib/repos/catkissfish-push'
import { safeErrorText } from '@/lib/store-jobs'

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const settings = await getCatkissfishSettings()
  if (!hasCatkissfishAccount(settings)) return NextResponse.json({ error: 'Chưa lưu client_id / client_secret CatKissFish' }, { status: 400 })
  try {
    return NextResponse.json({ ok: true, ...(await checkCatkissfishConnection()) })
  } catch (e) {
    const upstream = e instanceof CatkissfishError ? e.status : 0
    const reason = safeErrorText(e, [settings.clientSecret!, settings.clientId!])
    return NextResponse.json({ error: `Kết nối CatKissFish thất bại: ${reason}`, upstreamStatus: upstream }, { status: upstream === 0 ? 504 : 502 })
  }
}
