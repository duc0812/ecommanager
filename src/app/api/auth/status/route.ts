import { NextRequest, NextResponse } from 'next/server'
import { clearShopifyConnection, getShopifyConnection } from '@/lib/token-store'
import { requireSuperadmin } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

export async function GET() {
  const conn = await getShopifyConnection()
  return NextResponse.json({
    shopify: conn
      ? { connected: true, shop: conn.shop, connectedAt: conn.connectedAt }
      : { connected: false },
  })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  await clearShopifyConnection()
  const response = NextResponse.json({ ok: true })
  response.cookies.set('shopify_shop', '', { httpOnly: true, path: '/', maxAge: 0 })
  response.cookies.set('shopify_token', '', { httpOnly: true, path: '/', maxAge: 0 })
  return response
}
