import { NextRequest, NextResponse } from 'next/server'
import { forbidden } from '@/lib/api-auth'
import { requireTaskScope } from '@/lib/order-scope'
import { editLineProduction, productionEditView, ProductionEditError } from '@/lib/repos/line-production'

async function access(req: NextRequest, key: string) {
  const scope = await requireTaskScope(req, key)
  if ('error' in scope) return scope
  if (!['ADMIN', 'SUPERADMIN'].includes(scope.user.role)) return { error: forbidden('Chỉ Admin được chỉnh thông tin sản xuất') }
  return scope
}

export async function GET(req: NextRequest, { params }: { params: { key: string } }) {
  const scope = await access(req, params.key)
  if ('error' in scope) return scope.error
  try { return NextResponse.json(await productionEditView(params.key)) }
  catch (e) { if (e instanceof ProductionEditError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e }
}

export async function PATCH(req: NextRequest, { params }: { params: { key: string } }) {
  const scope = await access(req, params.key)
  if ('error' in scope) return scope.error
  const body = await req.json().catch(() => ({}))
  try { return NextResponse.json(await editLineProduction(params.key, body, scope.user)) }
  catch (e) { if (e instanceof ProductionEditError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e }
}
