import { NextRequest, NextResponse } from 'next/server'
import { clearShopifyConnection, getShopifyConnection } from '@/lib/token-store'

export async function GET(req: NextRequest) {
  const conn = await getShopifyConnection(req.headers.get('cookie') ?? undefined)
  return NextResponse.json({
    shopify: conn
      ? { connected: true, shop: conn.shop, connectedAt: conn.connectedAt }
      : { connected: false },
  })
}

export async function DELETE() {
  await clearShopifyConnection()
  const response = NextResponse.json({ ok: true })
  response.cookies.set('shopify_shop', '', { httpOnly: true, path: '/', maxAge: 0 })
  response.cookies.set('shopify_token', '', { httpOnly: true, path: '/', maxAge: 0 })
  return response
}
