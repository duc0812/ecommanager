import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { prisma } from '@/lib/db'
import { BondreError, listAllSkus, suggestSku } from '@/lib/bondre'
import { bondreSession, getBondreSettings, hasBondreAccount } from '@/lib/bondre-settings'
import { findBondreSupplier } from '@/lib/repos/bondre-push'

/** The tool's Bondre SKUs next to Bondre's own list, with a first guess to confirm. Saving goes through PATCH /api/suppliers/products/[id]. */
export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const supplier = await findBondreSupplier()
  if (!supplier) return NextResponse.json({ error: 'Chưa có xưởng mã "bondre" trong danh sách xưởng' }, { status: 404 })
  const settings = await getBondreSettings()
  if (!hasBondreAccount(settings)) return NextResponse.json({ error: 'Chưa lưu email / mật khẩu Bondre' }, { status: 400 })
  let bondreSkus
  try {
    bondreSkus = await listAllSkus(bondreSession(settings))
  } catch (e: any) {
    const upstream = e instanceof BondreError ? e.status : 0
    return NextResponse.json({ error: `Không đọc được danh sách SKU của Bondre: ${e?.message ?? e}` }, { status: upstream === 0 ? 504 : 502 })
  }
  const rows = await prisma.supplierProduct.findMany({
    where: { supplierId: supplier.id }, orderBy: [{ productName: 'asc' }, { sku: 'asc' }],
    select: { id: true, sku: true, productName: true, variant1Value: true, apiSku: true, apiShipClass: true },
  })
  return NextResponse.json({
    bondreSkus,
    products: rows.map(p => ({ ...p, suggestion: suggestSku(p, bondreSkus) })),
  })
}
