import { NextRequest, NextResponse } from 'next/server'
import { countByStatus, countPartiallyExported, countWarnings } from '@/lib/repos/orders'
import { requireScope } from '@/lib/order-scope'

export async function GET(req: NextRequest) {
  const scope = await requireScope(req, 'fulfillment_orders')
  if ('error' in scope) return scope.error
  const { storeIds } = scope
  const projectId = req.nextUrl.searchParams.get('projectId') ?? undefined
  const [counts, warnings, partiallyExported] = await Promise.all([
    countByStatus({ projectId, storeIds }),
    countWarnings({ projectId, storeIds }),
    countPartiallyExported({ projectId, storeIds }),
  ])
  // EXPORTED counts only fully sent orders; a partly sent one stays in READY_TO_PRODUCTION and is also counted here.
  return NextResponse.json({ ...counts, warnings, partiallyExported })
}
