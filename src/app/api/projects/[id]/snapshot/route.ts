import { NextRequest, NextResponse } from 'next/server'
import { snapshotProjectMonth } from '@/lib/cashflow-snapshot-scheduler'
import { prisma } from '@/lib/db'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}))
  const month = typeof body.month === 'string' && /^\d{4}-\d{2}$/.test(body.month) ? body.month : null
  if (!month) return NextResponse.json({ error: 'month (YYYY-MM) required' }, { status: 400 })
  const project = await prisma.project.findUnique({ where: { id: params.id }, select: { id: true } })
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  try {
    const snap = await snapshotProjectMonth(params.id, month)
    return NextResponse.json({ snapshot: snap })
  } catch (e: any) {
    console.error('[snapshot] failed:', e?.message ?? e)
    return NextResponse.json({ error: 'Failed to create snapshot' }, { status: 500 })
  }
}
