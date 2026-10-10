import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { pushOrder } from '@/lib/repos/pgprints-push'
import { pushErrorResponse } from '@/lib/pgprints-http'

export async function POST(req: NextRequest, { params }: { params: { orderId: string } }) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  if (!body || body.confirm !== true) return NextResponse.json({ error: 'Cần xác nhận gửi đơn (confirm: true)', code: 'NOT_CONFIRMED' }, { status: 400 })
  if (typeof body.payloadHash !== 'string' || !body.payloadHash) {
    return NextResponse.json({ error: 'Thiếu payloadHash của bản xem trước', code: 'NO_HASH' }, { status: 400 })
  }
  try {
    return NextResponse.json(await pushOrder(params.orderId, { payloadHash: body.payloadHash, userId: auth.user.id }))
  } catch (e) {
    return pushErrorResponse(e)
  }
}
