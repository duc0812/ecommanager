import { NextRequest, NextResponse } from 'next/server'
import { listOrdersWithLines } from '@/lib/repos/orders'
import { requireScope } from '@/lib/order-scope'

export async function GET(req: NextRequest) {
  const scope = await requireScope(req, 'shopify')
  if ('error' in scope) return scope.error
  const { searchParams } = new URL(req.url)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '100', 10), 500)
  const projectId = searchParams.get('projectId') ?? undefined
  const orders = await listOrdersWithLines({ projectId, storeIds: scope.storeIds, limit })
  return NextResponse.json({ orders, count: orders.length })
}
