import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthUser, unauthorized, requireAdmin } from '@/lib/api-auth'
import { mapTemplate } from '@/lib/design-tasks'

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const supplierId = req.nextUrl.searchParams.get('supplierId') || undefined
  const templates = await prisma.printTemplate.findMany({
    where: supplierId ? { supplierId } : undefined,
    orderBy: { name: 'asc' },
    include: { supplier: { select: { name: true, code: true } } },
  })
  return NextResponse.json({
    templates: templates.map(t => ({
      ...mapTemplate(t),
      supplierId: t.supplierId, supplierSku: t.supplierSku, supplierName: t.supplier.name, supplierCode: t.supplier.code,
    })),
  })
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error

  const body = await req.json().catch(() => ({} as any))
  const { supplierId, supplierSku, name, widthPx, heightPx, dpi, bleedIn, safeIn, mirror, areas, guideImagePath, templateUrl } = body ?? {}

  if (typeof supplierId !== 'string' || !supplierId) return NextResponse.json({ error: 'supplierId is required' }, { status: 400 })
  if (typeof name !== 'string' || !name.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 })
  if (typeof widthPx !== 'number' || widthPx <= 0) return NextResponse.json({ error: 'widthPx must be > 0' }, { status: 400 })
  if (typeof heightPx !== 'number' || heightPx <= 0) return NextResponse.json({ error: 'heightPx must be > 0' }, { status: 400 })

  const sku = typeof supplierSku === 'string' && supplierSku.trim() ? supplierSku.trim() : null
  const data = {
    supplierId,
    supplierSku: sku,
    name: name.trim(),
    widthPx: Math.round(widthPx),
    heightPx: Math.round(heightPx),
    dpi: typeof dpi === 'number' && dpi > 0 ? Math.round(dpi) : 300,
    bleedIn: typeof bleedIn === 'number' && bleedIn >= 0 ? bleedIn : 0.125,
    safeIn: typeof safeIn === 'number' && safeIn >= 0 ? safeIn : 0.2,
    mirror: !!mirror,
    areas: JSON.stringify(Array.isArray(areas) ? areas : []),
    guideImagePath: typeof guideImagePath === 'string' && guideImagePath ? guideImagePath : null,
    templateUrl: typeof templateUrl === 'string' && templateUrl ? templateUrl : null,
  }

  try {
    const row = await prisma.$transaction(async tx => {
      const matches = await tx.printTemplate.findMany({ where: { supplierId, supplierSku: sku }, orderBy: { createdAt: 'asc' } })
      const existing = matches[0]
      return existing
        ? await tx.printTemplate.update({ where: { id: existing.id }, data })
        : await tx.printTemplate.create({ data })
    })
    return NextResponse.json({ template: mapTemplate(row) })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }
}
