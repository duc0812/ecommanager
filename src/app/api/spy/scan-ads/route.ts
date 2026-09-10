import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { runPageAdScan, runDomainAdScan } from '@/lib/spy/scan-ads'
import { getSessionPayload } from '@/lib/api-auth'
import { SCAN_DAILY_LIMIT, isUnlimited, vnDay } from '@/lib/spy/scan-quota'
import { isJobRunning, runExclusive } from '@/lib/job-lock'

export const dynamic = 'force-dynamic'

async function consumeQuota(userId: string, day: string, units: number) {
  // Increment first and check the returned count so two parallel requests cannot
  // both pass a read-then-write check.
  const q = await prisma.spyScanQuota.upsert({
    where: { userId_day: { userId, day } },
    create: { userId, day, count: units },
    update: { count: { increment: units } },
  })
  if (q.count > SCAN_DAILY_LIMIT) {
    await prisma.spyScanQuota.update({ where: { userId_day: { userId, day } }, data: { count: { decrement: units } } })
    return { ok: false as const, used: q.count - units }
  }
  return { ok: true as const, used: q.count }
}

export async function POST(req: NextRequest) {
  const auth = await getSessionPayload(req)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const limited = !isUnlimited(auth.role)
  const day = vnDay()

  const b = await req.json().catch(() => ({}))
  if (b.domainId) {
    const d = await prisma.spyAdDomain.findUnique({ where: { id: b.domainId } })
    if (!d) return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
    if (limited) {
      const quota = await consumeQuota(auth.userId, day, 1)
      if (!quota.ok) return NextResponse.json({ error: 'Daily scan limit reached', used: quota.used, limit: SCAN_DAILY_LIMIT }, { status: 429 })
    }
    void runDomainAdScan({ id: d.id, searchTerm: d.searchTerm, country: d.country })
      .catch(err => console.error('[spy] domain ad scan failed for', d.domain, err))
    return NextResponse.json({ started: [{ domainId: d.id, domain: d.domain }] })
  }

  const targets = b.pageId
    ? await prisma.spyPageTarget.findMany({ where: { id: b.pageId } })
    : await prisma.spyPageTarget.findMany({ where: { active: true, excluded: false } })
  if (targets.length === 0) return NextResponse.json({ error: 'No page targets to scan' }, { status: 404 })

  if (!b.pageId && isJobRunning('spy:ad-scan')) {
    return NextResponse.json({ error: 'A scan of all page targets is already running' }, { status: 409 })
  }
  if (limited) {
    // Each target is a separate paid Apify run, so it costs one quota unit.
    const quota = await consumeQuota(auth.userId, day, targets.length)
    if (!quota.ok) return NextResponse.json({ error: 'Daily scan limit reached', used: quota.used, limit: SCAN_DAILY_LIMIT }, { status: 429 })
  }

  // Run targets one after another: parallel runs multiply Apify usage, SQLite
  // write contention and memory, and each one already takes minutes.
  const job = async () => {
    for (const t of targets) {
      try { await runPageAdScan({ id: t.id, storeId: t.storeId, pageUrl: t.pageUrl, adDomainId: t.adDomainId }) }
      catch (err) { console.error('[spy] ad scan failed for', t.pageUrl, err) }
    }
  }
  if (b.pageId) void job()
  else void runExclusive('spy:ad-scan', job)

  return NextResponse.json({ started: targets.map(t => ({ pageId: t.id, pageUrl: t.pageUrl })) })
}
