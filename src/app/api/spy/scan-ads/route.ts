import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { runPageAdScan, runDomainAdScan } from '@/lib/spy/scan-ads'
import { verifyToken } from '@/lib/auth'
import { SCAN_DAILY_LIMIT, isUnlimited, vnDay } from '@/lib/spy/scan-quota'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value
  const auth = token ? await verifyToken(token) : null
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const limited = !isUnlimited(auth.role)
  const day = vnDay()
  if (limited) {
    const q = await prisma.spyScanQuota.findUnique({ where: { userId_day: { userId: auth.userId, day } } })
    if ((q?.count ?? 0) + 1 > SCAN_DAILY_LIMIT) return NextResponse.json({ error: 'Daily scan limit reached', used: q?.count ?? 0, limit: SCAN_DAILY_LIMIT }, { status: 429 })
  }

  const b = await req.json().catch(() => ({}))
  if (b.domainId) {
    const d = await prisma.spyAdDomain.findUnique({ where: { id: b.domainId } })
    if (!d) return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
    void runDomainAdScan({ id: d.id, searchTerm: d.searchTerm, country: d.country })
      .catch(err => console.error('[spy] domain ad scan failed for', d.domain, err))
    if (limited) await prisma.spyScanQuota.upsert({ where: { userId_day: { userId: auth.userId, day } }, create: { userId: auth.userId, day, count: 1 }, update: { count: { increment: 1 } } })
    return NextResponse.json({ started: [{ domainId: d.id, domain: d.domain }] })
  }
  const targets = b.pageId
    ? await prisma.spyPageTarget.findMany({ where: { id: b.pageId } })
    : await prisma.spyPageTarget.findMany({ where: { active: true } })
  if (targets.length === 0) return NextResponse.json({ error: 'No page targets to scan' }, { status: 404 })

  for (const t of targets) {
    void runPageAdScan({ id: t.id, storeId: t.storeId, pageUrl: t.pageUrl, adDomainId: t.adDomainId })
      .catch(err => console.error('[spy] ad scan failed for', t.pageUrl, err))
  }
  if (limited) await prisma.spyScanQuota.upsert({ where: { userId_day: { userId: auth.userId, day } }, create: { userId: auth.userId, day, count: 1 }, update: { count: { increment: 1 } } })
  return NextResponse.json({ started: targets.map(t => ({ pageId: t.id, pageUrl: t.pageUrl })) })
}
