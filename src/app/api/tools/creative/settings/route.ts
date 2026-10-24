import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { creativeSettingsView, saveReplicateToken } from '@/lib/creative/settings'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(await creativeSettingsView())
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({}))
  const token = String(body.replicateToken ?? '').trim()
  if (!token) return NextResponse.json({ error: 'Thiếu Replicate token' }, { status: 400 })
  await saveReplicateToken(token)
  return NextResponse.json(await creativeSettingsView())
}
