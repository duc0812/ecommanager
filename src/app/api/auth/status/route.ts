import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSuperadmin } from '@/lib/api-auth'
import { LITZZY_SHOP } from '@/lib/shopify-shop'
import { hasReadAllOrders, deleteGrantedScopes, loadGrantedScopes } from '@/lib/store-connect'
import { hasUsableCredential } from '@/lib/store-connections'

export const dynamic = 'force-dynamic'

export async function GET() {
  const rows = await prisma.shopifyStore.findMany({
    include: { credential: true, project: { select: { name: true } } },
    orderBy: { connectedAt: 'asc' },
  })
  const grantedScopes = await loadGrantedScopes(rows.map(s => s.id))
  const stores = rows.map(s => {
    const c = s.credential
    const scopes = grantedScopes.get(s.id) ?? null
    const connected = hasUsableCredential(c)
    return {
      id: s.id,
      shop: s.shop,
      projectName: s.project?.name ?? null,
      enabled: s.enabled,
      connected,
      authMode: c?.authMode ?? null,
      connectedAt: c?.connectedAt ?? null,
      lastError: s.lastError,
      lastErrorAt: s.lastErrorAt,
      lastSyncAt: s.lastSyncAt,
      orderPrefix: s.orderPrefix,
      ianaTimezone: s.ianaTimezone,
      trackingPageUrl: s.trackingPageUrl,
      payoutStartDate: s.payoutStartDate,
      scopes,
      readAllOrders: scopes ? hasReadAllOrders(scopes) : null,
    }
  })
  const litzzy = stores.find(s => s.shop === LITZZY_SHOP && s.enabled && s.connected)
  return NextResponse.json({
    shopify: litzzy ? { connected: true, shop: litzzy.shop, connectedAt: litzzy.connectedAt } : { connected: false },
    stores,
  })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const storeId = new URL(req.url).searchParams.get('storeId')
  if (!storeId) return NextResponse.json({ error: 'Thiếu storeId' }, { status: 400 })
  const store = await prisma.shopifyStore.findUnique({ where: { id: storeId }, select: { id: true } })
  if (!store) return NextResponse.json({ error: 'Không tìm thấy store' }, { status: 404 })
  await prisma.shopifyStoreCredential.deleteMany({ where: { storeId } })
  await deleteGrantedScopes(storeId)
  const response = NextResponse.json({ ok: true })
  response.cookies.set('shopify_shop', '', { httpOnly: true, path: '/', maxAge: 0 })
  response.cookies.set('shopify_token', '', { httpOnly: true, path: '/', maxAge: 0 })
  return response
}
