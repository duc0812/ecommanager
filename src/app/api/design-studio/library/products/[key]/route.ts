import { NextRequest, NextResponse } from 'next/server'
import { loadLibraryProduct } from '@/lib/repos/artwork-library'

export async function GET(_req: NextRequest, { params }: { params: { key: string } }) {
  const detail = await loadLibraryProduct(params.key)
  if (!detail) return NextResponse.json({ error: 'Không tìm thấy sản phẩm' }, { status: 404 })
  return NextResponse.json(detail)
}
