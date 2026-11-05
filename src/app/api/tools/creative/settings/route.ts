import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess, requireSuperadmin } from '@/lib/api-auth'
import { creativeSettingsView, saveCreativeSecrets } from '@/lib/creative/settings'
import { maskedForSuperadminOnly } from '@/lib/secret-view'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  return NextResponse.json(maskedForSuperadminOnly(auth.user, await creativeSettingsView(), ['kieMasked', 'replicateMasked']))
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({}))
  const kieApiKey = String(body.kieApiKey ?? '').trim()
  const replicateToken = String(body.replicateToken ?? '').trim()
  const clearKieApiKey = body.clearKieApiKey === true
  if (!kieApiKey && !replicateToken && !clearKieApiKey) return NextResponse.json({ error: 'Chưa nhập key nào' }, { status: 400 })
  await saveCreativeSecrets({ kieApiKey, replicateToken, clearKieApiKey })
  return NextResponse.json(await creativeSettingsView())
}
