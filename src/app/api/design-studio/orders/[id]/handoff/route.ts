import { NextRequest, NextResponse } from 'next/server'
import { forbidden, getAuthUser, unauthorized, type AuthUser } from '@/lib/api-auth'
import { canHandoffToSupplier } from '@/lib/roles'
import { HandoffError, handoffOrderCsv, remapOrderSuppliers, undoCsvHandoff } from '@/lib/supplier-handoff'

async function requireHandoff(req: NextRequest): Promise<{ user: AuthUser } | { error: NextResponse }> {
  const user = await getAuthUser(req)
  if (!user) return { error: unauthorized() }
  if (!canHandoffToSupplier(user.role, user.permissions)) return { error: forbidden('Chỉ Admin hoặc người có quyền CSV Export được chuyển đơn sang xưởng.') }
  return { user }
}

function errorResponse(e: unknown) {
  if (e instanceof HandoffError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
  console.error('[handoff]', e)
  return NextResponse.json({ error: (e as any)?.message ?? 'Lỗi không xác định', code: 'INTERNAL' }, { status: 500 })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireHandoff(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  if (!body || body.mode !== 'CSV') {
    return NextResponse.json({ error: 'mode phải là "CSV" — chuyển qua API đi qua cửa sổ "Gửi PGprints"', code: 'BAD_MODE' }, { status: 400 })
  }
  try {
    return NextResponse.json({ handoff: await handoffOrderCsv(params.id, auth.user.id) })
  } catch (e) {
    return errorResponse(e)
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireHandoff(req)
  if ('error' in auth) return auth.error
  try {
    return NextResponse.json({ handoff: await undoCsvHandoff(params.id, auth.user.id) })
  } catch (e) {
    return errorResponse(e)
  }
}

/** { action: 'REMAP' }: re-pick each line's supplier by today's mapping, before anything went to a supplier. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireHandoff(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  if (!body || body.action !== 'REMAP') return NextResponse.json({ error: 'action phải là "REMAP"', code: 'BAD_ACTION' }, { status: 400 })
  try {
    return NextResponse.json(await remapOrderSuppliers(params.id, auth.user.id))
  } catch (e) {
    return errorResponse(e)
  }
}
