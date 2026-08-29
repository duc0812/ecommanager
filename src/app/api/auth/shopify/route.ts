import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { saveOAuthState, getShopifyAppCredentials } from '@/lib/token-store'
import { getShopifyRedirectUri } from '@/lib/public-url'

const SCOPES = [
  'read_analytics',
  'read_orders',
  'read_customers',
  'read_customer_payment_methods',
  'read_products', 'write_products',
  'read_product_listings', 'write_product_listings',
  'read_product_feeds', 'write_product_feeds',
  'read_fulfillments', 'write_fulfillments',
  'read_assigned_fulfillment_orders', 'write_assigned_fulfillment_orders',
  'read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders',
  'read_custom_fulfillment_services', 'write_custom_fulfillment_services',
  'read_discounts', 'write_discounts',
  'read_price_rules', 'write_price_rules',
  'read_content', 'write_content',
  'read_themes', 'write_themes', 'write_theme_code',
  'read_shopify_payments_payouts',
  'read_shopify_payments_bank_accounts',
  'read_shopify_payments_disputes',
  'read_shopify_payments_accounts',
  'customer_read_orders', 'customer_write_orders',
].join(',')

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

  const redirectUri = getShopifyRedirectUri(req)
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
