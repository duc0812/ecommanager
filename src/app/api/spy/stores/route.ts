import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { normalizeDomain } from '@/lib/spy/shopify'

export const dynamic = 'force-dynamic'

export async function GET() {
  const stores = await prisma.spyStore.findMany({
    orderBy: { addedAt: 'desc' },
    include: { _count: { select: { products: true } } },
  })
  return NextResponse.json(stores)
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  let domain: string
  try { domain = normalizeDomain(String(body.domain ?? '')) }
  catch (e: unknown) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid domain' }, { status: 400 }) }
  const store = await prisma.spyStore.upsert({
    where: { domain },
    create: { domain, name: body.name || null },
    update: { name: body.name ?? undefined },
  })
  return NextResponse.json(store)
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const data: Record<string, unknown> = {}
  if ('name' in body) data.name = body.name || null
  if ('status' in body) data.status = body.status
  if ('tags' in body) data.tags = JSON.stringify(body.tags ?? [])
  const store = await prisma.spyStore.update({ where: { id: body.id }, data })
  return NextResponse.json(store)
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await prisma.spyStore.delete({ where: { id: body.id } })
  return NextResponse.json({ ok: true })
}
