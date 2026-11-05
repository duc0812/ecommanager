import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess, requireSuperadmin } from '@/lib/api-auth'
import { getBondreSettings, saveBondreSettings, toBondreSettingsView, type BondreSettingsPatch } from '@/lib/bondre-settings'

export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  return NextResponse.json(toBondreSettingsView(await getBondreSettings()))
}

function optionalText(value: unknown, field: string, max: number): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`${field} phải là chuỗi`)
  if (value.trim().length > max) throw new Error(`${field} quá dài`)
  return value.trim()
}

export async function PUT(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Body không hợp lệ' }, { status: 400 })

  const patch: BondreSettingsPatch = {}
  try {
    patch.email = optionalText(body.email, 'Email', 320)
    const password = optionalText(body.password, 'Mật khẩu', 500)
    // The form never receives the stored password, so a blank field means "keep it"; only an explicit null clears it.
    if (password !== '') patch.password = password
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }
  if (patch.email && !patch.email.includes('@')) return NextResponse.json({ error: 'Email không hợp lệ' }, { status: 400 })
  return NextResponse.json(toBondreSettingsView(await saveBondreSettings(patch)))
}
