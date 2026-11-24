import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { requireOrderScope } from '@/lib/order-scope'
import { canHandoffToSupplier } from '@/lib/roles'
import { buildPrintpossPush } from '@/lib/repos/printposs-push'
import { printpossErrorResponse } from '@/lib/printposs-http'

export async function GET(req: NextRequest, { params }: { params: { orderId: string } }) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const scope = await requireOrderScope(req, params.orderId)
  if ('error' in scope) return scope.error
  try {
    const built = await buildPrintpossPush(params.orderId)
    if (!built) return NextResponse.json({ error: 'Không tìm thấy đơn' }, { status: 404 })
    return NextResponse.json({ ...built.preview, canAct: ['ADMIN', 'SUPERADMIN'].includes(auth.user.role), canSend: canHandoffToSupplier(auth.user.role, auth.user.permissions) })
  } catch (e) { return printpossErrorResponse(e) }
}
