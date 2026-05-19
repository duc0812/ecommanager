import { NextRequest, NextResponse } from 'next/server'
import { updateOrderStatus } from '@/lib/repos/orders'
import { isValidPipelineStatus } from '@/lib/pipeline-status'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body.status !== 'string' || !isValidPipelineStatus(body.status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }
  try {
    const updated = await updateOrderStatus(params.id, body.status)
    return NextResponse.json(updated)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
