import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { getCsSettings } from '@/lib/cs/settings'
import { resendAlerts } from '@/lib/cs/actions'
import { sendTelegramMessage } from '@/lib/telegram'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const settings = await getCsSettings()
  const result = await resendAlerts(async text => {
    const r = await sendTelegramMessage(text)
    if ('error' in r || r.skipped) throw new Error('error' in r ? String(r.error) : 'telegram not configured')
  }, process.env.NEXT_PUBLIC_APP_URL ?? '', settings)
  return NextResponse.json(result)
}
