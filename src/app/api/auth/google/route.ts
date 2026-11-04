import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { requireSuperadmin } from '@/lib/api-auth'
import { SHEETS_STATE_PREFIX, buildGoogleConsentUrl, getGoogleConfig, googleAppUrl, saveGoogleOAuthState } from '@/lib/google-oauth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error

  const cfg = await getGoogleConfig()
  if (!cfg.clientId || !cfg.clientSecret) {
    return NextResponse.redirect(`${googleAppUrl()}/setup?google=error&reason=not_configured`)
  }

  const nonce = crypto.randomBytes(16).toString('hex')
  const state = req.nextUrl.searchParams.get('target') === 'sheets' ? `${SHEETS_STATE_PREFIX}${nonce}` : nonce
  saveGoogleOAuthState(state)
  return NextResponse.redirect(buildGoogleConsentUrl(cfg.clientId, state))
}
