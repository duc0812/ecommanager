import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/api-auth'
import { assertSupplierProducts, linkProducts, parseIdList } from '@/lib/print-templates'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Body không hợp lệ' }, { status: 400 })
  const ids = parseIdList(body.supplierProductIds)
  if (ids === 'invalid' || !ids || ids.length === 0) return NextResponse.json({ error: 'supplierProductIds phải là mảng id' }, { status: 400 })
  const templateId = body.printTemplateId
  if (templateId !== null && (typeof templateId !== 'string' || !templateId)) return NextResponse.json({ error: 'printTemplateId phải là id hoặc null' }, { status: 400 })
  if (!(await assertSupplierProducts(params.id, ids))) return NextResponse.json({ error: 'Variant không thuộc xưởng này' }, { status: 400 })
  if (templateId) {
    const t = await prisma.printTemplate.findUnique({ where: { id: templateId }, select: { supplierId: true } })
    if (!t || t.supplierId !== params.id) return NextResponse.json({ error: 'Template thuộc xưởng khác' }, { status: 400 })
  }
  const r = await linkProducts(params.id, ids, templateId)
  return NextResponse.json({ updated: r.updated, tasksTouched: r.tasksTouched })
}
