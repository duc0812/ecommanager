import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { runStoreProductScan, runStoreBestSellerScan } from '@/lib/spy/scan-runner'
import { verifyToken } from '@/lib/auth'
import { SCAN_DAILY_LIMIT, isUnlimited, vnDay } from '@/lib/spy/scan-quota'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value
  const auth = token ? await verifyToken(token) : null
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const stores = body.storeId
    ? await prisma.spyStore.findMany({ where: { id: body.storeId } })
    : await prisma.spyStore.findMany({ where: { status: 'active' } })
  if (stores.length === 0) return NextResponse.json({ error: 'No stores to scan' }, { status: 404 })

  const n = stores.length
  const limited = !isUnlimited(auth.role)
  const day = vnDay()
  if (limited) {
    const q = await prisma.spyScanQuota.findUnique({ where: { userId_day: { userId: auth.userId, day } } })
    const used = q?.count ?? 0
    if (used + n > SCAN_DAILY_LIMIT) return NextResponse.json({ error: 'Daily scan limit reached', used, limit: SCAN_DAILY_LIMIT }, { status: 429 })
  }

  const results = []
  for (const s of stores) {
    const r = await runStoreProductScan(s)
    await runStoreBestSellerScan(s)
    results.push({ store: s.domain, ...r })
  }
  if (limited) {
    await prisma.spyScanQuota.upsert({
      where: { userId_day: { userId: auth.userId, day } },
      create: { userId: auth.userId, day, count: n },
      update: { count: { increment: n } },
    })
  }
  return NextResponse.json({ results })
}
