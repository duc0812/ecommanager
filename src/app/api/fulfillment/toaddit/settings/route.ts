import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess, requireSuperadmin } from '@/lib/api-auth'
import { getToadditSettings, saveToadditSettings, toadditSettingsView, type ToadditSettings } from '@/lib/toaddit-settings'

export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  return NextResponse.json(toadditSettingsView(await getToadditSettings()))
}

export async function PUT(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Body không hợp lệ' }, { status: 400 })
  const patch: Partial<ToadditSettings> = {}
  for (const key of ['appKey', 'appSecret'] as const) {
    const v = body[key]
    if (v === undefined) continue
    if (v !== null && (typeof v !== 'string' || v.length > 2000 || /[\r\n]/.test(v))) return NextResponse.json({ error: `${key} không hợp lệ` }, { status: 400 })
    if (v === null || v.trim()) patch[key] = v === null ? null : v.trim()
  }
  if (body.environment !== undefined) {
    if (!['production', 'sandbox'].includes(body.environment)) return NextResponse.json({ error: 'Môi trường chỉ nhận production hoặc sandbox' }, { status: 400 })
    patch.environment = body.environment
  }
  if (body.shippingMethod !== undefined) {
    if (!['1', '2'].includes(body.shippingMethod)) return NextResponse.json({ error: 'Ship chỉ nhận 1 (standard) hoặc 2 (express)' }, { status: 400 })
    patch.shippingMethod = body.shippingMethod
  }
  if (body.payOnCreate !== undefined) {
    if (typeof body.payOnCreate !== 'boolean') return NextResponse.json({ error: 'payOnCreate phải là boolean' }, { status: 400 })
    patch.payOnCreate = body.payOnCreate
  }
  return NextResponse.json(toadditSettingsView(await saveToadditSettings(patch)))
}
