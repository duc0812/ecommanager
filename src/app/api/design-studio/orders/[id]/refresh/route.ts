import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getStoreConnection, tryStoreConnection } from '@/lib/store-connections'
import { connectionFailureResponse } from '@/lib/store-connection-response'
import { fetchOrderLinePropsByNames } from '@/lib/shopify-orders'
import { applyLineProps } from '@/lib/design-studio'
import { fillCustomallFields } from '@/lib/customall-fields'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const order = await prisma.order.findUnique({
    where: { id: params.id },
    select: { shopifyOrderNumber: true, storeId: true },
  })
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  const { conn, error } = await tryStoreConnection(() => getStoreConnection(order.storeId))
  if (!conn) return connectionFailureResponse(error, { error: 'Chưa kết nối Shopify. Vào /setup để connect trước.', status: 401 })
  let props
  try {
    props = (await fetchOrderLinePropsByNames(conn.shop, conn.token, [order.shopifyOrderNumber])).get(order.shopifyOrderNumber)
  } catch (e: any) {
    return NextResponse.json({ error: `Shopify: ${e.message}` }, { status: 502 })
  }
  if (!props) return NextResponse.json({ error: 'Shopify không trả về đơn này (quá 60 ngày hoặc sai store)' }, { status: 404 })
  const r = await applyLineProps(params.id, props)
  const customall = await fillCustomallFields([params.id], { force: true })
  return NextResponse.json({ ...r, customall: { filled: customall.filled, failed: customall.failed } })
}
