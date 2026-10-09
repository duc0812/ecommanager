import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { deleteSettings, saveSetting } from '@/lib/token-store'
import { GOOGLE_KEYS, getGoogleConfig, googleRedirectUri } from '@/lib/google-oauth'
import { driveFolderUrl, resetDriveCache } from '@/lib/google-drive'

export const dynamic = 'force-dynamic'

function mask(value: string) {
  if (!value) return ''
  return value.length <= 8 ? '••••' : `${value.slice(0, 4)}…${value.slice(-4)}`
}

export async function GET(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error

  const cfg = await getGoogleConfig()
  const configured = Boolean(cfg.clientId && cfg.clientSecret)
  return NextResponse.json({
    configured,
    connected: configured && Boolean(cfg.refreshToken),
    email: cfg.email || null,
    rootFolderId: cfg.rootFolderId || null,
    rootFolderUrl: cfg.rootFolderId ? driveFolderUrl(cfg.rootFolderId) : null,
    needsReconnect: cfg.needsReconnect,
    clientIdMasked: mask(cfg.clientId),
    hasClientSecret: Boolean(cfg.clientSecret),
    redirectUri: googleRedirectUri(),
  })
}

export async function PUT(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Body không hợp lệ.' }, { status: 400 })

  const fields = [['clientId', GOOGLE_KEYS.clientId], ['clientSecret', GOOGLE_KEYS.clientSecret]] as const
  for (const [field] of fields) {
    if (body[field] !== undefined && typeof body[field] !== 'string') {
      return NextResponse.json({ error: `${field} phải là chuỗi.` }, { status: 400 })
    }
  }
  for (const [field, key] of fields) {
    if (body[field] === undefined) continue
    const value = (body[field] as string).trim()
    if (value) await saveSetting(key, value)
    else await deleteSettings([key])
  }
  resetDriveCache()

  const cfg = await getGoogleConfig()
  return NextResponse.json({ ok: true, configured: Boolean(cfg.clientId && cfg.clientSecret), clientIdMasked: mask(cfg.clientId), hasClientSecret: Boolean(cfg.clientSecret) })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error

  await deleteSettings([GOOGLE_KEYS.refreshToken, GOOGLE_KEYS.email, GOOGLE_KEYS.rootFolderId, GOOGLE_KEYS.needsReconnect])
  resetDriveCache()
  return NextResponse.json({ ok: true })
}
