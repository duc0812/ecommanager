import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { requireOrderScope } from '@/lib/order-scope'
import { pushToadditOrder, parseToadditSelection } from '@/lib/repos/toaddit-push'
import { toadditErrorResponse } from '@/lib/toaddit-http'

export async function POST(req: NextRequest, { params }: { params: { orderId: string } }) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const scope = await requireOrderScope(req, params.orderId)
  if ('error' in scope) return scope.error
  const body = await req.json().catch(() => null)
  if (body?.confirm !== true || typeof body.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.payloadHash)) return NextResponse.json({ error: 'Cần xác nhận gửi đơn và payloadHash bản xem trước' }, { status: 400 })
  try { return NextResponse.json(await pushToadditOrder(params.orderId, { payloadHash: body.payloadHash, userId: auth.user.id, variantIds: parseToadditSelection(body.variantIds) })) }
  catch (e) { return toadditErrorResponse(e) }
}
