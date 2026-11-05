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
  const existing = store.credential
  if (existing?.authMode === 'CLIENT_CREDENTIALS') {
    // The store keeps minting its own tokens; only the OAuth callback flips it to OAUTH. A token minted with
    // other credentials is dropped so the next call mints with the new ones.
    const same = existing.clientId === apiKey && existing.clientSecret === apiSecret
    await saveStoreCredential(store.id, {
      authMode: 'CLIENT_CREDENTIALS',
      clientId: apiKey,
      clientSecret: apiSecret,
      accessToken: same ? existing.accessToken : null,
      tokenExpiresAt: same ? existing.tokenExpiresAt : null,
    })
  } else {
    // A manual or OAuth token keeps working until OAuth replaces it.
    await saveStoreCredential(store.id, { authMode: 'OAUTH', clientId: apiKey, clientSecret: apiSecret, accessToken: existing?.accessToken ?? null })
  }
  return NextResponse.json({ ok: true, storeId: store.id })
}
