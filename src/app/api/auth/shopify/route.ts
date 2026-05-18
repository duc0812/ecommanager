import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { saveOAuthState, getShopifyAppCredentials } from '@/lib/token-store'

const SCOPES = 'read_analytics,read_orders,read_products,read_shopify_payments_payouts,read_shopify_payments_bank_accounts,read_shopify_payments_disputes,read_shopify_payments_accounts'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const shop = searchParams.get('shop')?.trim()

  if (!shop) {
    return NextResponse.json({ error: 'Missing shop parameter' }, { status: 400 })
  }

  const appCreds = await getShopifyAppCredentials()
  if (!appCreds?.apiKey) {
    return NextResponse.json({ error: 'Chưa có API Key. Vui lòng điền trên trang Setup.' }, { status: 400 })
  }

  const configuredAppUrl = process.env.NEXT_PUBLIC_APP_URL
  const requestAppUrl = `http://${req.headers.get('host')}`
  const appUrl = configuredAppUrl?.includes('localhost') ? requestAppUrl : configuredAppUrl || requestAppUrl
  const redirectUri = `${appUrl}/api/auth/shopify/callback`
  const state = crypto.randomBytes(16).toString('hex')

  saveOAuthState(state, shop)

  const params = new URLSearchParams({
    client_id: appCreds.apiKey,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
  })

  return NextResponse.redirect(`https://${shop}/admin/oauth/authorize?${params}`)
}
