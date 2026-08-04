import { NextRequest, NextResponse } from 'next/server'
import { syncMetaInsights } from '@/lib/sync-meta-insights'
import { verifyToken } from '@/lib/auth'

const ADMIN_ROLES = new Set(['ADMIN', 'SUPERADMIN'])

export async function POST(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value
  const user = token ? await verifyToken(token) : null
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!ADMIN_ROLES.has(user.role)) {
    return NextResponse.json({ error: 'Chỉ Admin mới có quyền backfill Meta insights.' }, { status: 403 })
  }

  try {
    const { searchParams } = new URL(req.url)
    const body = await req.json().catch(() => ({} as Record<string, unknown>))

    const since = searchParams.get('since') ?? (body.since as string | undefined) ?? null
    const until = searchParams.get('until') ?? (body.until as string | undefined) ?? null
    const accountId = searchParams.get('accountId') ?? (body.accountId as string | undefined) ?? null
    const daysRaw = searchParams.get('days') ?? (body.days as string | number | undefined)
    const days = daysRaw != null && Number.isFinite(Number(daysRaw)) ? Number(daysRaw) : undefined
    const fromProjectStartRaw = searchParams.get('fromProjectStart') ?? (body.fromProjectStart as unknown)
    const fromProjectStart = fromProjectStartRaw === '1' || fromProjectStartRaw === 'true' || fromProjectStartRaw === true

    const result = await syncMetaInsights({ since, until, accountId, fromProjectStart, ...(days ? { days } : {}) })
    return NextResponse.json({ success: true, ...result })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
