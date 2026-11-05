import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { PrintwayError, listAllSkus } from '@/lib/printway'
import { getPrintwaySettings } from '@/lib/printway-settings'
import { findPrintwaySupplier } from '@/lib/repos/printway-push'
import { productsWithSuggestions } from '@/lib/repos/suppliers'

/** The tool's Printway SKUs next to Printway's own list, with a first guess to confirm. Saving goes through PATCH /api/suppliers/products/[id]. */
export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const supplier = await findPrintwaySupplier()
  if (!supplier) return NextResponse.json({ error: 'Chưa có xưởng mã "printway" trong danh sách xưởng' }, { status: 404 })
  const { token } = await getPrintwaySettings()
  if (!token) return NextResponse.json({ error: 'Chưa lưu token Printway' }, { status: 400 })
  let supplierSkus
  try {
    supplierSkus = await listAllSkus(token)
  } catch (e: any) {
    const upstream = e instanceof PrintwayError ? e.status : 0
    return NextResponse.json({ error: `Không đọc được danh sách SKU của Printway: ${e?.message ?? e}` }, { status: upstream === 0 ? 504 : 502 })
  }
  return NextResponse.json({ supplierSkus, products: await productsWithSuggestions(supplier.id, supplierSkus) })
}
