import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

function normKeywords(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(k => String(k).trim()).filter(Boolean)
  return String(v ?? '').split(/[\n,]/).map(k => k.trim()).filter(Boolean)
}

export async function GET() {
  const rows = await prisma.spyProductType.findMany({ orderBy: { name: 'asc' } })
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  const name = String(b.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
  const keywords = JSON.stringify(normKeywords(b.keywords))
  const row = await prisma.spyProductType.upsert({
    where: { name },
    create: { name, keywords },
    update: { keywords },
  })
  return NextResponse.json(row)
}

export async function PATCH(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const data: Record<string, unknown> = {}
  if ('name' in b) data.name = String(b.name).trim()
  if ('keywords' in b) data.keywords = JSON.stringify(normKeywords(b.keywords))
  if ('active' in b) data.active = Boolean(b.active)
  const row = await prisma.spyProductType.update({ where: { id: b.id }, data })
  return NextResponse.json(row)
}

export async function DELETE(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await prisma.spyProductType.delete({ where: { id: b.id } })
  return NextResponse.json({ ok: true })
}
