import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

const REF_TYPES = new Set(['AD','PRODUCT','ADVERTISER','STORE','KEYWORD','NONE'])
const STATUSES = new Set(['NEW','EXPLORING','TESTING','ARCHIVED'])

export async function GET(req: NextRequest) {
  const status = new URL(req.url).searchParams.get('status') || undefined
  const ideas = await prisma.spyIdea.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json(ideas)
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.title || !String(b.title).trim()) return NextResponse.json({ error: 'title required' }, { status: 400 })
  const refType = REF_TYPES.has(b.refType) ? b.refType : 'NONE'
  const idea = await prisma.spyIdea.create({
    data: {
      title: String(b.title).trim(), note: b.note || null,
      tags: JSON.stringify(b.tags ?? []), refType,
      refAdId: b.refAdId || null, refProductId: b.refProductId || null,
      refStoreId: b.refStoreId || null, refKeywordId: b.refKeywordId || null,
      snapshotJson: b.snapshotJson ? JSON.stringify(b.snapshotJson) : null,
    },
  })
  return NextResponse.json(idea)
}

export async function PATCH(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const data: Record<string, unknown> = {}
  if ('title' in b) data.title = String(b.title).trim()
  if ('note' in b) data.note = b.note || null
  if ('tags' in b) data.tags = JSON.stringify(b.tags ?? [])
  if ('status' in b && STATUSES.has(b.status)) data.status = b.status
  const idea = await prisma.spyIdea.update({ where: { id: b.id }, data })
  return NextResponse.json(idea)
}

export async function DELETE(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await prisma.spyIdea.delete({ where: { id: b.id } })
  return NextResponse.json({ ok: true })
}
