import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess, requireSuperadmin } from '@/lib/api-auth'
import { getPgprintsSettings, savePgprintsSettings, toSettingsView, type PgprintsSettings, type PgprintsSettingsPatch } from '@/lib/pgprints-settings'
import { PublicUrlError, requirePublicBaseUrl } from '@/lib/public-artwork'

const WEBHOOK_PATH = '/api/public/pgprints/tracking'

function respond(settings: PgprintsSettings) {
  let webhookUrl: string | null = null
  let publicUrlError: string | null = null
  try {
    webhookUrl = `${requirePublicBaseUrl()}${WEBHOOK_PATH}`
  } catch (e: any) {
    publicUrlError = e instanceof PublicUrlError ? e.message : 'Không xác định được địa chỉ public của app'
  }
  return NextResponse.json({ ...toSettingsView(settings), webhookUrl, webhookPath: WEBHOOK_PATH, publicUrlError })
}

export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  return respond(await getPgprintsSettings())
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

  const patch: PgprintsSettingsPatch = {}
  try {
    patch.storeId = optionalText(body.storeId, 'Store ID', 200)
    patch.defaultShipClass = optionalText(body.defaultShipClass, 'Ship class mặc định', 200)
    const secret = optionalText(body.secretKey, 'Secret key', 500)
    // The form never receives the stored secret, so a blank field means "keep it"; only an explicit null clears it.
    if (secret !== '') patch.secretKey = secret
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }
  if (body.pushEnabled !== undefined) {
    if (typeof body.pushEnabled !== 'boolean') return NextResponse.json({ error: 'pushEnabled phải là true/false' }, { status: 400 })
    patch.pushEnabled = body.pushEnabled
  }

  const current = await getPgprintsSettings()
  const storeId = patch.storeId !== undefined ? patch.storeId : current.storeId
  const secretKey = patch.secretKey !== undefined ? patch.secretKey : current.secretKey
  const pushEnabled = patch.pushEnabled !== undefined ? patch.pushEnabled : current.pushEnabled
  if (pushEnabled && (!storeId || !secretKey)) {
    if (patch.pushEnabled === true) return NextResponse.json({ error: 'Nhập Store ID và Secret key trước khi bật gửi đơn' }, { status: 400 })
    patch.pushEnabled = false
  }
  return respond(await savePgprintsSettings(patch))
}
