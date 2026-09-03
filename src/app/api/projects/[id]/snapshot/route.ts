import { NextRequest, NextResponse } from 'next/server'
import { snapshotProjectMonth } from '@/lib/cashflow-snapshot-scheduler'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}))
  const month = typeof body.month === 'string' && /^\d{4}-\d{2}$/.test(body.month) ? body.month : null
  if (!month) return NextResponse.json({ error: 'month (YYYY-MM) required' }, { status: 400 })
  try {
    const snap = await snapshotProjectMonth(params.id, month)
    return NextResponse.json({ snapshot: snap })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
