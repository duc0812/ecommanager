import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { forbidden } from '@/lib/api-auth'
import { mayUseRow, requireFinanceScope } from '@/lib/finance-scope'

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const scope = await requireFinanceScope(req, 'other_bills')
  if ('error' in scope) return scope.error
  const bill = await prisma.otherBill.findUnique({ where: { id: params.id }, select: { projectId: true } })
  if (!bill) return NextResponse.json({ error: 'Không tìm thấy bill' }, { status: 404 })
  if (!mayUseRow(scope, bill.projectId)) return forbidden('Bạn không có quyền xóa bill của project này.')
  await prisma.otherBill.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
