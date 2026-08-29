import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getShopifyConnection } from '@/lib/token-store'
import { updateVariantSku } from '@/lib/shopify-orders'
import { detectOrderTasks } from '@/lib/order-tasks'

const LINE_SELECT = {
  id: true, sku: true, productTitle: true, shopifyProductType: true, shopifyVariantId: true,
  resolvedSupplierId: true, resolvedBaseCost: true, manualBaseCost: true,
} as const

type Fix = { lineId: string; sku?: string; baseCost?: number }

// Inline fix from the "Suggest" column:
//  - MISSING_SKU: write the SKU onto the Shopify variant, then backfill OrderLine.sku
//  - MISSING_BASE_COST: set OrderLine.manualBaseCost
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const orderId: string | undefined = body.orderId
  const taskType: string | undefined = body.taskType
  const fixes: Fix[] = Array.isArray(body.fixes) ? body.fixes : []
  if (!orderId || !taskType || fixes.length === 0) {
    return NextResponse.json({ error: 'orderId, taskType, fixes required' }, { status: 400 })
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { orderType: true, designReady: true, lines: { select: LINE_SELECT } },
  })
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

  const errors: string[] = []
  let applied = 0

  if (taskType === 'MISSING_SKU') {
    const conn = await getShopifyConnection(req.headers.get('cookie') ?? undefined)
    if (!conn) return NextResponse.json({ error: 'Chưa kết nối Shopify.' }, { status: 400 })
    for (const f of fixes) {
      const sku = (f.sku ?? '').trim()
      if (!sku) continue
      const line = order.lines.find(l => l.id === f.lineId)
      if (!line?.shopifyVariantId) { errors.push(`${f.lineId}: line không có variant Shopify`); continue }
      try {
        await updateVariantSku(conn.shop, conn.token, line.shopifyVariantId, sku)
        await prisma.orderLine.update({ where: { id: f.lineId }, data: { sku } })
        applied++
      } catch (e: any) {
        errors.push(`${line.productTitle}: ${e?.message ?? 'ghi SKU thất bại'}`)
      }
    }
  } else if (taskType === 'MISSING_BASE_COST') {
    for (const f of fixes) {
      const cost = Number(f.baseCost)
      if (!Number.isFinite(cost) || cost < 0) { errors.push(`${f.lineId}: giá không hợp lệ`); continue }
      await prisma.orderLine.update({ where: { id: f.lineId }, data: { manualBaseCost: cost } })
      applied++
    }
  } else {
    return NextResponse.json({ error: `Task ${taskType} không hỗ trợ fix inline` }, { status: 400 })
  }

  const fresh = await prisma.order.findUnique({
    where: { id: orderId },
    select: { orderType: true, designReady: true, lines: { select: LINE_SELECT } },
  })
  const remaining = fresh ? detectOrderTasks({ orderType: fresh.orderType, designReady: fresh.designReady, lines: fresh.lines }) : []
  return NextResponse.json({ applied, remaining, errors })
}
