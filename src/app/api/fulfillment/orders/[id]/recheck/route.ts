import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getStoreConnection, tryStoreConnection } from '@/lib/store-connections'
import { connectionFailureResponse } from '@/lib/store-connection-response'
import { fetchVariantSkus } from '@/lib/shopify-orders'
import { recheckOrderTasks } from '@/lib/repos/order-tasks'
import { requireOrderScope } from '@/lib/order-scope'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const scope = await requireOrderScope(req, params.id)
  if ('error' in scope) return scope.error
  const order = await prisma.order.findUnique({ where: { id: params.id }, select: { storeId: true } })
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  const { conn, error } = await tryStoreConnection(() => getStoreConnection(order.storeId))
  if (!conn) return connectionFailureResponse(error, { error: 'Not connected to Shopify.', status: 400 })
  try {
    const result = await recheckOrderTasks(params.id, ids => fetchVariantSkus(conn.shop, conn.token, ids))
    return NextResponse.json(result)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Re-check failed' }, { status: 500 })
  }
}
