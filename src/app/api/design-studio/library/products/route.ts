import { NextRequest, NextResponse } from 'next/server'
import { listLibraryProducts } from '@/lib/repos/artwork-library'
import { LIBRARY_PRODUCT_STATUSES, type LibraryProductStatus } from '@/lib/artwork-fields'

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const statusParam = sp.get('status')
  const status = statusParam && (LIBRARY_PRODUCT_STATUSES as string[]).includes(statusParam) ? statusParam as LibraryProductStatus : undefined
  if (statusParam && !status) return NextResponse.json({ error: 'status không hợp lệ' }, { status: 400 })
  return NextResponse.json(await listLibraryProducts({ q: sp.get('q') ?? undefined, status }))
}
