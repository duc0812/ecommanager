import { NextRequest, NextResponse } from 'next/server'
import { setShopifyAppCredentials } from '@/lib/token-store'
import { requireSuperadmin } from '@/lib/api-auth'
import { isValidShopDomain } from '@/lib/shopify-shop'

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({}))
  const apiKey = String(body.apiKey ?? '').trim()
  const apiSecret = String(body.apiSecret ?? '').trim()
  const shop = String(body.shop ?? '').trim().toLowerCase()
  if (!apiKey || !apiSecret || !shop) {
    return NextResponse.json({ error: 'Thiếu apiKey, apiSecret hoặc shop' }, { status: 400 })
  }
  if (!isValidShopDomain(shop)) {
    return NextResponse.json({ error: 'Shop domain phải có dạng ten-shop.myshopify.com' }, { status: 400 })
  }
  await setShopifyAppCredentials(apiKey, apiSecret, shop)
  return NextResponse.json({ ok: true })
}
