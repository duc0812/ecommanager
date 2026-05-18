import { NextRequest, NextResponse } from 'next/server'
import { setShopifyAppCredentials } from '@/lib/token-store'

export async function POST(req: NextRequest) {
  const { apiKey, apiSecret, shop } = await req.json()
  if (!apiKey || !apiSecret || !shop) {
    return NextResponse.json({ error: 'Thiếu apiKey, apiSecret hoặc shop' }, { status: 400 })
  }
  await setShopifyAppCredentials(apiKey.trim(), apiSecret.trim(), shop.trim())
  return NextResponse.json({ ok: true })
}
