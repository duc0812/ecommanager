import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { requireOrderScope } from '@/lib/order-scope'
import { pushPrintpossOrder } from '@/lib/repos/printposs-push'
import { printpossErrorResponse } from '@/lib/printposs-http'

export async function POST(req: NextRequest, { params }: { params: { orderId: string } }) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const scope = await requireOrderScope(req, params.orderId)
  if ('error' in scope) return scope.error
  const body = await req.json().catch(() => null)
  if (body?.confirm !== true || typeof body.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.payloadHash)) return NextResponse.json({ error: 'Cần xác nhận gửi và payloadHash của bản xem trước' }, { status: 400 })
  try { return NextResponse.json(await pushPrintpossOrder(params.orderId, { payloadHash: body.payloadHash, userId: auth.user.id })) }
  catch (e) { return printpossErrorResponse(e) }
}
