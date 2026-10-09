import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { isProfileStatus, listProducts } from '@/lib/repos/product-profiles'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const q = req.nextUrl.searchParams.get('q') || undefined
  const status = req.nextUrl.searchParams.get('status')
  if (status && !isProfileStatus(status)) return NextResponse.json({ error: 'status không hợp lệ' }, { status: 400 })
  const result = await listProducts({ q, status: status && isProfileStatus(status) ? status : undefined })
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
