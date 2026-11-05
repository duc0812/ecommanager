import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess, requireSuperadmin } from '@/lib/api-auth'
import { getPrintwaySettings, savePrintwayToken, toPrintwaySettingsView } from '@/lib/printway-settings'

export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  return NextResponse.json(toPrintwaySettingsView(await getPrintwaySettings()))
}

export async function PUT(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Body không hợp lệ' }, { status: 400 })
  const { token } = body
  if (token !== null && typeof token !== 'string') return NextResponse.json({ error: 'Token phải là chuỗi' }, { status: 400 })
  if (typeof token === 'string' && token.trim().length > 4000) return NextResponse.json({ error: 'Token quá dài' }, { status: 400 })
  // The form never receives the stored token, so a blank field means "keep it"; only an explicit null removes it.
  if (token === null || token.trim()) await savePrintwayToken(token)
  return NextResponse.json(toPrintwaySettingsView(await getPrintwaySettings()))
}
