import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/api-auth'
import {
  assertSupplierProducts, parseIdList, readTemplateRequest, removeTemplateDir, setTemplateLinks, storeTemplateFiles,
  templateDto, validateTemplateFields,
} from '@/lib/print-templates'

type Ctx = { params: { id: string } }

export async function GET(_req: NextRequest, { params }: Ctx) {
  const supplier = await prisma.supplier.findUnique({ where: { id: params.id }, select: { id: true } })
  if (!supplier) return NextResponse.json({ error: 'Không tìm thấy xưởng' }, { status: 404 })
  const rows = await prisma.printTemplate.findMany({
    where: { supplierId: params.id },
    orderBy: { name: 'asc' },
    include: { supplierProducts: { select: { id: true } } },
  })
  return NextResponse.json({ templates: rows.map(templateDto) })
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const supplier = await prisma.supplier.findUnique({ where: { id: params.id }, select: { id: true } })
  if (!supplier) return NextResponse.json({ error: 'Không tìm thấy xưởng' }, { status: 404 })

  const parsed = await readTemplateRequest(req)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status })
  const v = validateTemplateFields(parsed.value.fields)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
  const productIds = parseIdList(parsed.value.fields.supplierProductIds)
  if (productIds === 'invalid') return NextResponse.json({ error: 'supplierProductIds không hợp lệ' }, { status: 400 })
  if (productIds && !(await assertSupplierProducts(params.id, productIds))) return NextResponse.json({ error: 'Variant không thuộc xưởng này' }, { status: 400 })

  const { areas, ...rest } = v.fields
  const row = await prisma.printTemplate.create({ data: { ...rest, areas: JSON.stringify(areas), supplierId: params.id } })
  let stored
  try {
    stored = await storeTemplateFiles(row.id, parsed.value)
  } catch (e: any) {
    stored = { ok: false as const, error: e?.message ?? 'Không lưu được file' }
  }
  if (!stored.ok) {
    await prisma.printTemplate.delete({ where: { id: row.id } })
    await removeTemplateDir(row.id)
    return NextResponse.json({ error: stored.error }, { status: 400 })
  }
  if (Object.keys(stored.data).length > 0) await prisma.printTemplate.update({ where: { id: row.id }, data: stored.data })
  const sync = productIds ? await setTemplateLinks(params.id, row.id, productIds) : null
  const fresh = await prisma.printTemplate.findUniqueOrThrow({ where: { id: row.id }, include: { supplierProducts: { select: { id: true } } } })
  return NextResponse.json({ template: templateDto(fresh), ...(sync ? { tasksTouched: sync.tasksTouched } : {}) }, { status: 201 })
}
