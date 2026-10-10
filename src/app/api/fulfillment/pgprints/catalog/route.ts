import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { PgprintsError, searchProducts } from '@/lib/pgprints'
import { credentialsOf, getPgprintsSettings } from '@/lib/pgprints-settings'

export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  if (!q) return NextResponse.json({ error: 'Nhập SKU hoặc tên sản phẩm cần tra' }, { status: 400 })
  if (q.length > 100) return NextResponse.json({ error: 'Từ khoá quá dài' }, { status: 400 })
  const creds = credentialsOf(await getPgprintsSettings())
  if (!creds) return NextResponse.json({ error: 'Chưa lưu Store ID / Secret key PGprints' }, { status: 400 })
  try {
    return NextResponse.json({ products: await searchProducts(creds, { searchKey: q, page: 1, size: 20 }) })
  } catch (e: any) {
    const upstream = e instanceof PgprintsError ? e.status : 0
    return NextResponse.json({ error: `Không tra được catalogue PGprints: ${e?.message ?? e}`, upstreamStatus: upstream }, { status: upstream === 0 ? 504 : 502 })
  }
}
