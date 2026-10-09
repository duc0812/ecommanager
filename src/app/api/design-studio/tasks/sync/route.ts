import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { syncDesignTasks, pruneUntouchedTasksOutside } from '@/lib/design-tasks'
import { refreshMissingLineProps } from '@/lib/design-studio'

const DEFAULT_SCAN = 100

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const body = await req.json().catch(() => ({} as any))
  const orderId = typeof body?.orderId === 'string' && body.orderId ? body.orderId : undefined

  if (orderId) {
    const r = await syncDesignTasks(orderId)
    return NextResponse.json({ ...r, orders: 1 })
  }

  const limit = Math.min(500, Math.max(1, Number(body?.limit) || DEFAULT_SCAN))
  const orders = await prisma.order.findMany({
    orderBy: { placedAt: 'desc' },
    take: limit,
    select: {
      id: true, shopifyOrderNumber: true,
      store: { select: { shop: true } },
      lines: { select: { customAttributesJson: true, imageUrl: true } },
    },
  })
  const refresh = await refreshMissingLineProps(orders)
  const pruned = await pruneUntouchedTasksOutside(orders.map(o => o.id))
  let created = 0, cancelled = 0, completed = 0, reopened = 0
  const errors: string[] = []
  for (const o of orders) {
    try {
      const r = await syncDesignTasks(o.id)
      created += r.created
      cancelled += r.cancelled
      completed += r.completed
      reopened += r.reopened
    } catch (e: any) {
      errors.push(`${o.shopifyOrderNumber}: ${e.message}`)
    }
  }
  return NextResponse.json({ created, cancelled, completed, reopened, pruned, orders: orders.length, refresh, errors })
}
