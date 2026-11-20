import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess, requireSuperadmin } from '@/lib/api-auth'
import { methodCodeOf } from '@/lib/lenful'
import { getLenfulSettings, saveLenfulSettings, toLenfulSettingsView, type LenfulSettings, type LenfulSettingsPatch } from '@/lib/lenful-settings'
import { lenfulSetupInfo } from '@/lib/repos/lenful-push'

const viewOf = async (settings: LenfulSettings) => ({ ...toLenfulSettingsView(settings), ...(await lenfulSetupInfo()) })

export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  return NextResponse.json(await viewOf(await getLenfulSettings()))
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

  const patch: LenfulSettingsPatch = {}
  try {
    // The form never receives the stored key, so a blank field means "keep it"; only an explicit null clears it.
    const apiKey = optionalText(body.apiKey, 'API key', 500)
    if (apiKey !== '') patch.apiKey = apiKey
    const storeId = optionalText(body.storeId, 'Store', 100)
    if (storeId && !/^[0-9a-f-]{8,64}$/i.test(storeId)) throw new Error('Store Lenful phải là id dạng uuid')
    patch.storeId = storeId === '' ? null : storeId
    const method = optionalText(body.shippingMethodCode, 'Mã cách ship', 10)
    if (method && methodCodeOf(method) === null) throw new Error('Mã cách ship phải là số trong danh sách Orders › Import của Lenful')
    patch.shippingMethodCode = method === '' ? null : method
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }
  return NextResponse.json(await viewOf(await saveLenfulSettings(patch)))
}
