import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { requireOrderScope } from '@/lib/order-scope'
import { canHandoffToSupplier } from '@/lib/roles'
import { buildToadditPush, parseToadditSelection } from '@/lib/repos/toaddit-push'
import { toadditErrorResponse } from '@/lib/toaddit-http'

export async function GET(req: NextRequest, { params }: { params: { orderId: string } }) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const scope = await requireOrderScope(req, params.orderId)
  if ('error' in scope) return scope.error
  const raw = req.nextUrl.searchParams.get('variantIds')
  if (raw && raw.length > 20_000) return NextResponse.json({ error: 'Danh sách sản phẩm quá dài' }, { status: 400 })
  let value: unknown
  try { value = raw ? JSON.parse(raw) : undefined }
  catch { return NextResponse.json({ error: 'Danh sách sản phẩm không phải JSON hợp lệ' }, { status: 400 }) }
  try {
    const built = await buildToadditPush(params.orderId, parseToadditSelection(value), req.nextUrl.searchParams.get('catalog') === '1')
    if (!built) return NextResponse.json({ error: 'Không tìm thấy đơn' }, { status: 404 })
    return NextResponse.json({ ...built.preview, canAct: ['ADMIN', 'SUPERADMIN'].includes(auth.user.role), canSend: canHandoffToSupplier(auth.user.role, auth.user.permissions) })
  } catch (e) { return toadditErrorResponse(e) }
}
