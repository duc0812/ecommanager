import { prisma } from '@/lib/db'
import { isOrderClosed } from '@/lib/line-export'

export const ORDER_CLOSED = 'Đơn đã giao hoặc đã đóng — Agent không sửa nữa'

const ORDER_STATE = { pipelineStatus: true, financialStatus: true, fulfillmentStatus: true } as const

export async function isOrderOpen(orderId: string): Promise<boolean> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: ORDER_STATE })
  return !!order && !isOrderClosed(order)
}
