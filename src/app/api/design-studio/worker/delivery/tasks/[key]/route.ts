import { NextRequest, NextResponse } from 'next/server'
import { requireDeliveryWorker } from '@/lib/delivery/guard'
import { getDeliveryDrive } from '@/lib/delivery/drive'
import { deliveryTaskState, DeliveryLineMissingError } from '@/lib/delivery/task-state'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { key: string } }) {
  const denied = await requireDeliveryWorker(req)
  if (denied) return denied
  try {
    const state = await deliveryTaskState(params.key, getDeliveryDrive())
    if (!state) return NextResponse.json({ error: 'Không tìm thấy task' }, { status: 404 })
    return NextResponse.json(state)
  } catch (e) {
    if (e instanceof DeliveryLineMissingError) return NextResponse.json({ error: e.message }, { status: 409 })
    throw e
  }
}
