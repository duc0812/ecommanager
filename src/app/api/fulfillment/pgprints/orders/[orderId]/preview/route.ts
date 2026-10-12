import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { buildPush } from '@/lib/repos/pgprints-push'
import { pushErrorResponse } from '@/lib/pgprints-http'
import { canHandoffToSupplier } from '@/lib/roles'

export async function GET(req: NextRequest, { params }: { params: { orderId: string } }) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  try {
    const built = await buildPush(params.orderId, { withBalance: true })
    if (!built) return NextResponse.json({ error: 'Không tìm thấy đơn' }, { status: 404 })
    const canAct = auth.user.role === 'SUPERADMIN' || auth.user.role === 'ADMIN'
    return NextResponse.json({ ...built.preview, canAct, canSend: canHandoffToSupplier(auth.user.role, auth.user.permissions) })
  } catch (e) {
    return pushErrorResponse(e)
  }
}
