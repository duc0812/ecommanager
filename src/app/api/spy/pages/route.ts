import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { normalizeFbPageUrl } from '@/lib/spy/fb-url'

export async function GET(req: NextRequest) {
  const adDomainId = new URL(req.url).searchParams.get('adDomainId') || undefined
  const pages = await prisma.spyPageTarget.findMany({
    where: adDomainId ? { adDomainId } : undefined,
    orderBy: { createdAt: 'desc' },
    include: { store: { select: { domain: true } } },
  })
  return NextResponse.json(pages)
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  const pageUrl = normalizeFbPageUrl(String(b.pageUrl ?? ''))
  if (!pageUrl) return NextResponse.json({ error: 'A facebook.com page URL is required' }, { status: 400 })
  const page = await prisma.spyPageTarget.upsert({
    where: { pageUrl },
    create: { pageUrl, storeId: b.storeId || null, label: b.label || null, adDomainId: b.adDomainId || null },
    update: { storeId: b.storeId ?? undefined, label: b.label ?? undefined, adDomainId: b.adDomainId || null },
  })
  return NextResponse.json(page)
}

export async function PATCH(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const data: Record<string, unknown> = {}
  if ('active' in b) data.active = Boolean(b.active)
  if ('excluded' in b) data.excluded = Boolean(b.excluded)
  if ('label' in b) data.label = b.label || null
  if ('storeId' in b) data.storeId = b.storeId || null
  const page = await prisma.spyPageTarget.update({ where: { id: b.id }, data })
  return NextResponse.json(page)
}

export async function DELETE(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await prisma.spyPageTarget.delete({ where: { id: b.id } })
  return NextResponse.json({ ok: true })
}
