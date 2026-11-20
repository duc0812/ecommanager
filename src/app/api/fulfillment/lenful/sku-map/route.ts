import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { LenfulError } from '@/lib/lenful'
import { lenfulSkuCandidates } from '@/lib/repos/lenful-push'
import { PushError } from '@/lib/repos/pgprints-push'

/** The tool's Lenful SKUs next to what Lenful's catalog search finds, with a first guess to confirm. Saving goes through PATCH /api/suppliers/products/[id]. */
export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const q = req.nextUrl.searchParams.get('q')
  if (q && q.length > 200) return NextResponse.json({ error: 'Từ khoá quá dài' }, { status: 400 })
  try {
    return NextResponse.json(await lenfulSkuCandidates(q))
  } catch (e: any) {
    if (e instanceof PushError) return NextResponse.json({ error: e.message }, { status: e.status })
    const upstream = e instanceof LenfulError ? e.status : 0
    return NextResponse.json({ error: `Không đọc được catalog Lenful: ${e?.message ?? e}` }, { status: upstream === 0 ? 504 : 502 })
  }
}
