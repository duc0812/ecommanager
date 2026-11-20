import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { requireTaskScope } from '@/lib/order-scope'
import { moveUnsentLine, MoveLineError } from '@/lib/repos/line-move-supplier'

export async function POST(req: NextRequest, { params }: { params: { key: string } }) {
  const admin = await requireSuperadmin(req)
  if ('error' in admin) return admin.error
  const scope = await requireTaskScope(req, params.key)
  if ('error' in scope) return scope.error
  const body = await req.json().catch(() => ({}))
  try {
    return NextResponse.json(await moveUnsentLine(params.key, { supplierProductId: body?.supplierProductId, reason: body?.reason }, scope.user))
  } catch (e) {
    if (e instanceof MoveLineError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
