import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { addMetaRate, deleteMetaRate } from '@/lib/meta-exchange-rates'

export const dynamic = 'force-dynamic'

export async function GET() {
  const rows = await prisma.metaExchangeRate.findMany({ orderBy: { effectiveDate: 'desc' } })
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  const effectiveDate = String(b.effectiveDate ?? '').trim()
  const rate = Number(b.rate)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return NextResponse.json({ error: 'effectiveDate must be YYYY-MM-DD' }, { status: 400 })
  if (!Number.isFinite(rate) || rate <= 0) return NextResponse.json({ error: 'rate must be a positive number' }, { status: 400 })
  await addMetaRate(effectiveDate, rate)
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await deleteMetaRate(String(b.id))
  return NextResponse.json({ ok: true })
}
