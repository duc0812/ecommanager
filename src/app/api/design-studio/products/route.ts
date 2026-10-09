import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { isLibraryProductStatus } from '@/lib/artwork-fields'
import { listLibraryProducts } from '@/lib/repos/artwork-library'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const q = req.nextUrl.searchParams.get('q') || undefined
  const status = req.nextUrl.searchParams.get('status')
  if (status && !isLibraryProductStatus(status)) return NextResponse.json({ error: 'status không hợp lệ' }, { status: 400 })
  const result = await listLibraryProducts({ q, status: isLibraryProductStatus(status) ? status : undefined })
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
