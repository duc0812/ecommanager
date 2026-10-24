import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { creativeSettingsView, saveCreativeSecrets } from '@/lib/creative/settings'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await creativeSettingsView())
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
