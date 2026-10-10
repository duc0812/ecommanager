import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { PgprintsError, getBalance } from '@/lib/pgprints'
import { credentialsOf, getPgprintsSettings } from '@/lib/pgprints-settings'

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const creds = credentialsOf(await getPgprintsSettings())
  if (!creds) return NextResponse.json({ error: 'Chưa lưu Store ID / Secret key PGprints' }, { status: 400 })
  try {
    return NextResponse.json({ ok: true, balance: await getBalance(creds) })
  } catch (e: any) {
    const upstream = e instanceof PgprintsError ? e.status : 0
    return NextResponse.json({ error: `Kết nối PGprints thất bại: ${e?.message ?? e}`, upstreamStatus: upstream }, { status: upstream === 0 ? 504 : 502 })
  }
}
