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
  if (Object.keys(body).some(key => !['apiKey', 'shippingMethod'].includes(key))) return NextResponse.json({ error: 'ROS chỉ nhận API key và phương thức ship; tải lại trang cài đặt' }, { status: 400 })
  const patch: Partial<ToadditSettings> = {}
  for (const key of ['apiKey'] as const) {
    const v = body[key]
    if (v === undefined) continue
    if (v !== null && (typeof v !== 'string' || v.length > 2000 || /[\r\n]/.test(v))) return NextResponse.json({ error: `${key} không hợp lệ` }, { status: 400 })
    const clean = v === null ? null : v.trim().replace(/^Bearer\s+/i, '')
    if (clean && /\s/.test(clean)) return NextResponse.json({ error: 'API key ROS không được chứa khoảng trắng' }, { status: 400 })
    if (clean === null || clean) patch[key] = clean
  }
  if (body.shippingMethod !== undefined) {
    if (!['1', '2', '3'].includes(body.shippingMethod)) return NextResponse.json({ error: 'Ship ROS chỉ nhận 1, 2 hoặc 3' }, { status: 400 })
    patch.shippingMethod = body.shippingMethod
  }
  return NextResponse.json(toadditSettingsView(await saveToadditSettings(patch)))
}
