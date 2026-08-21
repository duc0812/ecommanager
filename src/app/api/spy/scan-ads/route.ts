import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { runPageAdScan } from '@/lib/spy/scan-ads'

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  const targets = b.pageId
    ? await prisma.spyPageTarget.findMany({ where: { id: b.pageId } })
    : await prisma.spyPageTarget.findMany({ where: { active: true } })
  if (targets.length === 0) return NextResponse.json({ error: 'No page targets to scan' }, { status: 404 })

  // Fire-and-forget: kick off scans without blocking the HTTP response.
  for (const t of targets) {
    void runPageAdScan({ id: t.id, storeId: t.storeId, pageUrl: t.pageUrl })
      .catch(err => console.error('[spy] ad scan failed for', t.pageUrl, err))
  }
  return NextResponse.json({ started: targets.map(t => ({ pageId: t.id, pageUrl: t.pageUrl })) })
}
