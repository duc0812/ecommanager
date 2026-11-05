import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAccess } from '@/lib/api-auth'
import { storeScopeFor } from '@/lib/store-scope'

export const dynamic = 'force-dynamic'

// The stores the caller may see that are switched on: they feed the store filter. `?includeDisabled=1` also lists the
// disabled ones among them and marks every row with `enabled` (the Users page names a seller's stores with it).
export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const scope = await storeScopeFor(auth.user)
  const includeDisabled = req.nextUrl.searchParams.get('includeDisabled') === '1'
  const rows = await prisma.shopifyStore.findMany({
    where: { ...(scope.all ? {} : { id: { in: scope.storeIds } }), ...(includeDisabled ? {} : { enabled: true }) },
    select: { id: true, shop: true, orderPrefix: true, enabled: true, project: { select: { name: true } } },
    orderBy: { connectedAt: 'asc' },
  })
  const stores = rows.map(s => ({
    id: s.id, shop: s.shop, name: s.project?.name ?? s.shop, orderPrefix: s.orderPrefix,
    ...(includeDisabled ? { enabled: s.enabled } : {}),
  }))
  return NextResponse.json({ stores })
}
