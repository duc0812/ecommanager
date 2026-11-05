import { NextRequest, NextResponse } from 'next/server'
import { bulkUpdateOrderStatus } from '@/lib/repos/orders'
import { isValidPipelineStatus } from '@/lib/pipeline-status'
import { syncDesignTasksForOrders } from '@/lib/design-tasks'
import { requireOrdersScope } from '@/lib/order-scope'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || !Array.isArray(body.orderIds) || !body.orderIds.every((id: unknown) => typeof id === 'string') || typeof body.status !== 'string') {
    return NextResponse.json({ error: 'orderIds[] and status required' }, { status: 400 })
  }
  const orderIds: string[] = body.orderIds
  if (!isValidPipelineStatus(body.status)) {
    return NextResponse.json({ error: 'Invalid status value' }, { status: 400 })
  }
  if (orderIds.length === 0) {
    return NextResponse.json({ count: 0 })
  }
  if (orderIds.length > 500) {
    return NextResponse.json({ error: 'Max 500 orders per bulk update' }, { status: 400 })
  }
  const scope = await requireOrdersScope(req, orderIds)
  if ('error' in scope) return scope.error
  const result = await bulkUpdateOrderStatus(orderIds, body.status)
  const designTaskErrors = await syncDesignTasksForOrders(orderIds)
  return NextResponse.json(designTaskErrors.length > 0 ? { ...result, designTaskErrors } : result)
}
