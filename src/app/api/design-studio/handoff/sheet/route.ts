import { NextRequest, NextResponse } from 'next/server'
import { forbidden, getAuthUser, unauthorized } from '@/lib/api-auth'
import { canHandoffToSupplier } from '@/lib/roles'
import { previewSheetPush, pushToSheet, sheetErrorStatus } from '@/lib/repos/sheet-push'

function errorResponse(e: unknown) {
  const known = sheetErrorStatus(e)
  if (known) return NextResponse.json({ error: known.message, code: known.code }, { status: known.status })
  console.error('[sheet push]', e)
  return NextResponse.json({ error: (e as any)?.message ?? 'Lỗi không xác định', code: 'INTERNAL' }, { status: 500 })
}

const idsOf = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every(x => typeof x === 'string') ? v as string[] : undefined)

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  if (!canHandoffToSupplier(user.role, user.permissions)) return forbidden('Chỉ Admin hoặc người có quyền CSV Export được chuyển đơn sang xưởng.')
  const supplierId = req.nextUrl.searchParams.get('supplier')
  if (!supplierId) return NextResponse.json({ error: 'Thiếu xưởng', code: 'NO_SUPPLIER' }, { status: 400 })
  try {
    return NextResponse.json(await previewSheetPush(supplierId, req.nextUrl.searchParams.getAll('order').filter(Boolean).length ? req.nextUrl.searchParams.getAll('order') : undefined))
  } catch (e) {
    return errorResponse(e)
  }
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  if (!canHandoffToSupplier(user.role, user.permissions)) return forbidden('Chỉ Admin hoặc người có quyền CSV Export được chuyển đơn sang xưởng.')
  const body = await req.json().catch(() => null)
  if (!body || body.confirm !== true) return NextResponse.json({ error: 'Cần xác nhận (confirm: true)', code: 'NOT_CONFIRMED' }, { status: 400 })
  if (typeof body.supplierId !== 'string' || !body.supplierId) return NextResponse.json({ error: 'Thiếu xưởng', code: 'NO_SUPPLIER' }, { status: 400 })
  try {
    return NextResponse.json(await pushToSheet(body.supplierId, { orderIds: idsOf(body.orderIds), userId: user.id }))
  } catch (e) {
    return errorResponse(e)
  }
}
