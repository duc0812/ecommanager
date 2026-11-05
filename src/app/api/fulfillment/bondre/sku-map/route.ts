import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { BondreError, listAllSkus } from '@/lib/bondre'
import { productsWithSuggestions } from '@/lib/repos/suppliers'
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
  let supplierSkus
  try {
    supplierSkus = await listAllSkus(bondreSession(settings))
  } catch (e: any) {
    const upstream = e instanceof BondreError ? e.status : 0
    return NextResponse.json({ error: `Không đọc được danh sách SKU của Bondre: ${e?.message ?? e}` }, { status: upstream === 0 ? 504 : 502 })
  }
  return NextResponse.json({ supplierSkus, products: await productsWithSuggestions(supplier.id, supplierSkus) })
}
