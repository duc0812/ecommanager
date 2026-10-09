import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/api-auth'
import {
  assertSupplierProducts, fieldsOf, loadSupplierTemplate, parseIdList, readTemplateRequest, removeStoredFile, removeTemplateDir,
  resyncOpenOrdersForSkus, setTemplateLinks, storeTemplateFiles, templateDto, validateTemplateFields,
} from '@/lib/print-templates'

type Ctx = { params: { id: string; templateId: string } }

const truthy = (v: unknown) => v === true || v === '1' || v === 'true'

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const existing = await loadSupplierTemplate(params.id, params.templateId)
  if (!existing) return NextResponse.json({ error: 'Không tìm thấy template' }, { status: 404 })

  const parsed = await readTemplateRequest(req)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status })
  const { fields } = parsed.value
  const v = validateTemplateFields(fields, fieldsOf(existing))
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
  const productIds = parseIdList(fields.supplierProductIds)
  if (productIds === 'invalid') return NextResponse.json({ error: 'supplierProductIds không hợp lệ' }, { status: 400 })
  if (productIds && !(await assertSupplierProducts(params.id, productIds))) return NextResponse.json({ error: 'Variant không thuộc xưởng này' }, { status: 400 })

  let stored
  try {
    stored = await storeTemplateFiles(existing.id, parsed.value)
  } catch (e: any) {
    stored = { ok: false as const, error: e?.message ?? 'Không lưu được file' }
  }
  if (!stored.ok) return NextResponse.json({ error: stored.error }, { status: 400 })
  const data: Record<string, unknown> = { ...v.fields, areas: JSON.stringify(v.fields.areas), ...stored.data }
  if (truthy(fields.removeGuide) && !('guideImagePath' in stored.data)) {
    await removeStoredFile(existing.guideImagePath)
    data.guideImagePath = null
  }
  if (truthy(fields.removeSource) && !('sourceFilePath' in stored.data)) {
    await removeStoredFile(existing.sourceFilePath)
    data.sourceFilePath = null
    data.sourceFileName = null
  }
  await prisma.printTemplate.update({ where: { id: existing.id }, data })
  const sync = productIds
    ? await setTemplateLinks(params.id, existing.id, productIds)
    : await resyncOpenOrdersForSkus(params.id, (await prisma.supplierProduct.findMany({ where: { printTemplateId: existing.id }, select: { sku: true } })).map(p => p.sku))
  const fresh = await prisma.printTemplate.findUniqueOrThrow({ where: { id: existing.id }, include: { supplierProducts: { select: { id: true } } } })
  return NextResponse.json({ template: templateDto(fresh), tasksTouched: sync.tasksTouched })
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const existing = await loadSupplierTemplate(params.id, params.templateId)
  if (!existing) return NextResponse.json({ error: 'Không tìm thấy template' }, { status: 404 })
  const skus = (await prisma.supplierProduct.findMany({ where: { printTemplateId: existing.id }, select: { sku: true } })).map(p => p.sku)
  await prisma.printTemplate.delete({ where: { id: existing.id } })
  await removeTemplateDir(existing.id)
  const sync = await resyncOpenOrdersForSkus(params.id, skus)
  return NextResponse.json({ ok: true, unlinked: skus.length, tasksTouched: sync.tasksTouched })
}
