import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { cancelMerchizePush } from '@/lib/repos/merchize-push'
import { pushErrorResponse } from '@/lib/pgprints-http'

export async function POST(req: NextRequest, { params }: { params: { orderId: string } }) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  if (!body || body.confirm !== true) return NextResponse.json({ error: 'Cần xác nhận huỷ đơn (confirm: true)', code: 'NOT_CONFIRMED' }, { status: 400 })
  try {
    return NextResponse.json(await cancelMerchizePush(params.orderId))
  } catch (e) {
    return pushErrorResponse(e)
  }
}
