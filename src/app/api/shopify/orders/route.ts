import { NextRequest, NextResponse } from 'next/server'
import { listOrdersWithLines } from '@/lib/repos/orders'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '100', 10), 500)
  const projectId = searchParams.get('projectId') ?? undefined
  const orders = await listOrdersWithLines({ projectId, limit })
  return NextResponse.json({ orders, count: orders.length })
}
