import { NextRequest, NextResponse } from 'next/server'
import { bulkUpdateOrderStatus } from '@/lib/repos/orders'
import { isValidPipelineStatus } from '@/lib/pipeline-status'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || !Array.isArray(body.orderIds) || typeof body.status !== 'string') {
    return NextResponse.json({ error: 'orderIds[] and status required' }, { status: 400 })
  }
  if (!isValidPipelineStatus(body.status)) {
    return NextResponse.json({ error: 'Invalid status value' }, { status: 400 })
  }
  if (body.orderIds.length === 0) {
    return NextResponse.json({ count: 0 })
  }
  if (body.orderIds.length > 500) {
    return NextResponse.json({ error: 'Max 500 orders per bulk update' }, { status: 400 })
  }
  const result = await bulkUpdateOrderStatus(body.orderIds, body.status)
  return NextResponse.json(result)
}
