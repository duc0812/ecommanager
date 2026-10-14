import { NextRequest, NextResponse } from 'next/server'
import { deleteSettings, saveSetting } from '@/lib/token-store'
import {
  DRIVE_SCOPES, GOOGLE_KEYS, GoogleOAuthError, consumeGoogleOAuthState, exchangeGoogleCode, fetchGoogleEmail,
  getGoogleConfig, googleAppUrl,
} from '@/lib/google-oauth'
import { ROOT_FOLDER_NAME, ensureFolder, primeAccessToken, refreshDriveQuota, resetDriveCache } from '@/lib/google-drive'

export const dynamic = 'force-dynamic'

function back(result: 'connected' | 'error', reason?: string) {
  const params = new URLSearchParams({ google: result })
  if (reason) params.set('reason', reason.replace(/[^a-z0-9_]/gi, '').slice(0, 40) || 'unknown')
  return NextResponse.redirect(`${googleAppUrl()}/setup?${params}`)
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  if (!consumeGoogleOAuthState(searchParams.get('state') ?? '')) {
    return NextResponse.json({ error: 'State không hợp lệ hoặc đã hết hạn. Hãy bấm Kết nối lại từ trang Setup.' }, { status: 400 })
  }
  if (searchParams.get('error')) return back('error', searchParams.get('error') ?? 'denied')
  const code = searchParams.get('code')
  if (!code) return back('error', 'missing_code')

  const cfg = await getGoogleConfig()
  if (!cfg.clientId || !cfg.clientSecret) return back('error', 'not_configured')

  let tokens
  try {
    tokens = await exchangeGoogleCode(code, cfg.clientId, cfg.clientSecret)
  } catch (err) {
    const reason = err instanceof GoogleOAuthError ? err.code : 'token_exchange'
    console.error('[google oauth] token exchange failed:', reason)
    return back('error', reason)
  }

  // Google's consent screen lets the user untick the Drive permission; without it nothing can be uploaded.
  const granted = String(tokens.scope ?? '').split(/\s+/)
  if (!granted.some(s => DRIVE_SCOPES.includes(s))) return back('error', 'no_drive_scope')

  const refreshToken = tokens.refresh_token || cfg.refreshToken
  if (!refreshToken) return back('error', 'no_refresh_token')
  if (tokens.refresh_token) await saveSetting(GOOGLE_KEYS.refreshToken, tokens.refresh_token)

  const email = await fetchGoogleEmail(tokens.access_token)
  if (email) await saveSetting(GOOGLE_KEYS.email, email)
  else await deleteSettings([GOOGLE_KEYS.email])
  await deleteSettings([GOOGLE_KEYS.needsReconnect, GOOGLE_KEYS.quota, GOOGLE_KEYS.testFileId])

  resetDriveCache()
  primeAccessToken(tokens.access_token, Number(tokens.expires_in) || 3600, refreshToken)
  try {
    const rootId = await ensureFolder('root', ROOT_FOLDER_NAME)
    await saveSetting(GOOGLE_KEYS.rootFolderId, rootId)
  } catch (err: any) {
    console.error('[google oauth] root folder failed:', err?.message ?? err)
    await deleteSettings([GOOGLE_KEYS.rootFolderId, GOOGLE_KEYS.refreshToken, GOOGLE_KEYS.email])
    return back('error', 'root_folder')
  }
  await refreshDriveQuota().catch(() => {})

  return back('connected')
}
