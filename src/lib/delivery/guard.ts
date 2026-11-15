import { NextResponse, type NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyWorkerRequest } from '@/lib/artwork-worker'

export const DELIVERY_SWITCH_KEY = 'delivery.api.enabled'

export async function requireDeliveryWorker(req: NextRequest): Promise<NextResponse | null> {
  if (!(await verifyWorkerRequest(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const row = await prisma.appSetting.findUnique({ where: { key: DELIVERY_SWITCH_KEY } })
  if (row?.value !== 'true') {
    return NextResponse.json({ error: 'Giao file qua API đang tắt', code: 'disabled' }, { status: 503 })
  }
  return null
}
