import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { normalizeDomain } from '@/lib/spy/shopify'
import { isNewAd } from '@/lib/spy/ad-signals'

export const dynamic = 'force-dynamic'

function defaultSearchTerm(domain: string): string {
  return domain.replace(/^www\./, '').split('.')[0]
}

export async function GET() {
  const domains = await prisma.spyAdDomain.findMany({ orderBy: { createdAt: 'desc' } })
  const now = new Date()
  const result = await Promise.all(domains.map(async d => {
    const pageCount = await prisma.spyPageTarget.count({ where: { adDomainId: d.id } })
    const ads = await prisma.spyAd.findMany({ where: { advertiser: { adDomainId: d.id } }, select: { startDate: true } })
    const newAdCount = ads.filter(a => isNewAd(a.startDate, now)).length
    return { ...d, pageCount, adCount: ads.length, newAdCount }
  }))
  return NextResponse.json(result)
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  let domain: string
  try { domain = normalizeDomain(String(b.domain ?? '')) }
  catch (e: unknown) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid domain' }, { status: 400 }) }
  const searchTerm = (b.searchTerm && String(b.searchTerm).trim()) || defaultSearchTerm(domain)
  const d = await prisma.spyAdDomain.upsert({
    where: { domain },
    create: { domain, searchTerm, label: b.label || null, country: b.country || 'ALL' },
    update: { searchTerm, label: b.label ?? undefined, country: b.country ?? undefined },
  })
  return NextResponse.json(d)
}

export async function PATCH(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const data: Record<string, unknown> = {}
  if ('searchTerm' in b) data.searchTerm = String(b.searchTerm)
  if ('label' in b) data.label = b.label || null
  if ('country' in b) data.country = b.country || 'ALL'
  if ('active' in b) data.active = Boolean(b.active)
  const d = await prisma.spyAdDomain.update({ where: { id: b.id }, data })
  return NextResponse.json(d)
}

export async function DELETE(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await prisma.spyAdDomain.delete({ where: { id: b.id } })
  return NextResponse.json({ ok: true })
}
