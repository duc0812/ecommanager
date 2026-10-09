import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, requireAdmin, unauthorized } from '@/lib/api-auth'
import { loadProduct, saveProfile, ValidationError } from '@/lib/repos/product-profiles'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { key: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const product = await loadProduct(params.key, { includeCost: user.role === 'SUPERADMIN' || user.role === 'ADMIN' })
  if (!product) return NextResponse.json({ error: 'Không tìm thấy sản phẩm' }, { status: 404 })
  return NextResponse.json(product, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PUT(req: NextRequest, { params }: { params: { key: string } }) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Body phải là JSON object' }, { status: 400 })
  try {
    return NextResponse.json(await saveProfile(params.key, body))
  } catch (e: any) {
    if (e instanceof ValidationError) return NextResponse.json({ error: e.message }, { status: 400 })
    throw e
  }
}
