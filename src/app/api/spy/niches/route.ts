import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

function normKeywords(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(k => String(k).trim()).filter(Boolean)
  return String(v ?? '').split(/[\n,]/).map(k => k.trim()).filter(Boolean)
}

export async function GET() {
  const niches = await prisma.spyNiche.findMany({ orderBy: { name: 'asc' } })
  return NextResponse.json(niches)
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  const name = String(b.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
  const keywords = JSON.stringify(normKeywords(b.keywords))
  const niche = await prisma.spyNiche.upsert({
    where: { name },
    create: { name, keywords },
    update: { keywords },
  })
  return NextResponse.json(niche)
}

export async function PATCH(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const data: Record<string, unknown> = {}
  if ('name' in b) data.name = String(b.name).trim()
  if ('keywords' in b) data.keywords = JSON.stringify(normKeywords(b.keywords))
  if ('active' in b) data.active = Boolean(b.active)
  const niche = await prisma.spyNiche.update({ where: { id: b.id }, data })
  return NextResponse.json(niche)
}

export async function DELETE(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await prisma.spyNiche.delete({ where: { id: b.id } })
  return NextResponse.json({ ok: true })
}
