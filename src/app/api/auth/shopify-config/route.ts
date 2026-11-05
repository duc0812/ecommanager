import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { saveStoreCredential } from '@/lib/store-connections'
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
  const store = await prisma.shopifyStore.upsert({
    where: { shop },
    create: { shop },
    update: {},
    include: { credential: true },
  })
  // A client-credentials token expires on its own and is not kept; a manual or OAuth token keeps working until OAuth replaces it.
  const keptToken = store.credential && store.credential.authMode !== 'CLIENT_CREDENTIALS' ? store.credential.accessToken : null
  await saveStoreCredential(store.id, { authMode: 'OAUTH', clientId: apiKey, clientSecret: apiSecret, accessToken: keptToken })
  return NextResponse.json({ ok: true, storeId: store.id })
}
