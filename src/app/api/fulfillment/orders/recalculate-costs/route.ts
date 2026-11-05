import { NextRequest, NextResponse } from 'next/server'
import { recalculateMissingOrderLineCosts } from '@/lib/repos/order-costs'
import { requireScope } from '@/lib/order-scope'

export async function POST(req: NextRequest) {
  const scope = await requireScope(req, 'fulfillment_orders')
  if ('error' in scope) return scope.error
  const body = await req.json().catch(() => ({}))
  const dateFrom = typeof body.dateFrom === 'string' && body.dateFrom
    ? new Date(`${body.dateFrom}T00:00:00.000Z`)
    : undefined
  const dateTo = typeof body.dateTo === 'string' && body.dateTo
    ? new Date(`${body.dateTo}T23:59:59.999Z`)
    : undefined

  const result = await recalculateMissingOrderLineCosts({ dateFrom, dateTo, refreshExisting: true, ...(scope.storeIds ? { storeIds: scope.storeIds } : {}) })
  return NextResponse.json(result)
}
