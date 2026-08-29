import { NextRequest, NextResponse } from 'next/server'
import { getShopifyConnection } from '@/lib/token-store'
import { fetchVariantSkus } from '@/lib/shopify-orders'
import { recheckOrderTasks } from '@/lib/repos/order-tasks'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const conn = await getShopifyConnection(req.headers.get('cookie') ?? undefined)
  if (!conn) return NextResponse.json({ error: 'Not connected to Shopify.' }, { status: 400 })
  try {
    const result = await recheckOrderTasks(params.id, ids => fetchVariantSkus(conn.shop, conn.token, ids))
    return NextResponse.json(result)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Re-check failed' }, { status: 500 })
  }
}
