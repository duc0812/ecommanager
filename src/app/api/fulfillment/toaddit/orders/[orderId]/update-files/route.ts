import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { requireOrderScope } from '@/lib/order-scope'
import { previewToadditFileUpdate, updateToadditFiles } from '@/lib/repos/toaddit-push'
import { toadditErrorResponse } from '@/lib/toaddit-http'

export async function POST(req: NextRequest, { params }: { params: { orderId: string } }) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const scope = await requireOrderScope(req, params.orderId)
  if ('error' in scope) return scope.error
  const body = await req.json().catch(() => null)
  try {
    if (body?.dryRun === true) return NextResponse.json(await previewToadditFileUpdate(params.orderId))
    if (body?.confirm !== true || typeof body.changeHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.changeHash)) return NextResponse.json({ error: 'Cần xem trước rồi xác nhận cập nhật file (confirm + changeHash)' }, { status: 400 })
    return NextResponse.json(await updateToadditFiles(params.orderId, { changeHash: body.changeHash, userId: auth.user.id }))
  } catch (e) { return toadditErrorResponse(e) }
}
