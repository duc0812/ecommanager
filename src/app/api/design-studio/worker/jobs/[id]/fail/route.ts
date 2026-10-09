import { NextRequest, NextResponse } from 'next/server'
import { recordJobFailure, verifyWorkerRequest } from '@/lib/artwork-worker'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await verifyWorkerRequest(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => null)
  const error = typeof body?.error === 'string' ? body.error : ''
  if (!error.trim()) return NextResponse.json({ error: 'error bắt buộc' }, { status: 400 })
  const r = await recordJobFailure(params.id, error, body?.permanent === true)
  if (!r) return NextResponse.json({ error: 'Job không còn ở trạng thái RUNNING' }, { status: 409 })
  return NextResponse.json({ ok: true, jobStatus: r.status, attempts: r.attempts })
}
