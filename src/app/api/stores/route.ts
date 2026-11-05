import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAccess } from '@/lib/api-auth'
import { storeScopeFor } from '@/lib/store-scope'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const scope = await storeScopeFor(auth.user)
  const rows = await prisma.shopifyStore.findMany({
    where: scope.all ? {} : { id: { in: scope.storeIds } },
    select: { id: true, shop: true, orderPrefix: true, project: { select: { name: true } } },
    orderBy: { connectedAt: 'asc' },
  })
  const stores = rows.map(s => ({ id: s.id, shop: s.shop, name: s.project?.name ?? s.shop, orderPrefix: s.orderPrefix }))
  return NextResponse.json({ stores })
}
