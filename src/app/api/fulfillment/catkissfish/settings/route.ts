import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess, requireSuperadmin } from '@/lib/api-auth'
import { shippingOf } from '@/lib/catkissfish'
import { CKF_AUTO_SHIPPING } from '@/lib/catkissfish-shipping'
import { getCatkissfishSettings, saveCatkissfishSettings, toCatkissfishSettingsView, type CatkissfishSettings, type CatkissfishSettingsPatch } from '@/lib/catkissfish-settings'
import { catkissfishSetupInfo } from '@/lib/repos/catkissfish-push'

const viewOf = async (settings: CatkissfishSettings) => ({ ...toCatkissfishSettingsView(settings), ...(await catkissfishSetupInfo()) })

export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  return NextResponse.json(await viewOf(await getCatkissfishSettings()))
}

function optionalText(value: unknown, field: string, max: number): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`${field} phải là chuỗi`)
  if (value.trim().length > max) throw new Error(`${field} quá dài`)
  return value.trim()
}

function carrier(value: unknown, field: string): string | null | undefined {
  const text = optionalText(value, field, 40)
  if (!text) return text === '' ? null : text
  if (text.toUpperCase() === CKF_AUTO_SHIPPING) return CKF_AUTO_SHIPPING
  const method = shippingOf(text)
  if (!method) throw new Error(`${field}: CatKissFish không có cách ship "${text}"`)
  return method.id
}

export async function PUT(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Body không hợp lệ' }, { status: 400 })

  const patch: CatkissfishSettingsPatch = {}
  try {
    // The form never receives the stored key, so a blank field means "keep it"; only an explicit null clears it.
    const clientId = optionalText(body.clientId, 'client_id', 500)
    const clientSecret = optionalText(body.clientSecret, 'client_secret', 500)
    if (clientId !== '') patch.clientId = clientId
    if (clientSecret !== '') patch.clientSecret = clientSecret
    patch.shippingId = carrier(body.shippingId, 'Cách ship đơn Mỹ')
    patch.shippingIdIntl = carrier(body.shippingIdIntl, 'Cách ship đơn ngoài Mỹ')
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }
  return NextResponse.json(await viewOf(await saveCatkissfishSettings(patch)))
}
