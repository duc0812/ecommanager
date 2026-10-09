import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { syncDesignTasks } from '@/lib/design-tasks'

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const body = await req.json().catch(() => ({} as any))
  const orderId = typeof body?.orderId === 'string' && body.orderId ? body.orderId : undefined

  if (orderId) {
    const r = await syncDesignTasks(orderId)
    return NextResponse.json({ ...r, orders: 1 })
  }

  const orders = await prisma.order.findMany({
    where: {
      OR: [
        { pipelineStatus: { in: ['PENDING_DESIGN', 'DESIGN_REJECTED'] } },
        { designTasks: { some: { status: { notIn: ['DONE', 'CANCELLED'] } } } },
      ],
    },
    select: { id: true, shopifyOrderNumber: true },
  })
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
  return NextResponse.json({ created, cancelled, completed, reopened, orders: orders.length, errors })
}
