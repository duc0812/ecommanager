import { NextRequest, NextResponse } from 'next/server'
import { requireDeliveryWorker } from '@/lib/delivery/guard'
import { getDeliveryDrive } from '@/lib/delivery/drive'
import { commitDelivery } from '@/lib/delivery/commit'
import { runSerial, memoryPressure } from '@/lib/delivery/queue'
import type { CommitError, CommitResult } from '@/lib/delivery/types'

export const dynamic = 'force-dynamic'

function busy() {
  return NextResponse.json(
    { error: 'Máy chủ đang thiếu bộ nhớ, thử lại sau', code: 'busy' },
    { status: 503, headers: { 'Retry-After': '60' } },
  )
}

export async function POST(req: NextRequest, { params }: { params: { key: string } }) {
  const denied = await requireDeliveryWorker(req)
  if (denied) return denied

  let body: any
  try {
    body = await req.json()
  } catch {
    body = null
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body không hợp lệ', code: 'bad_request' }, { status: 400 })
  }

  if (memoryPressure()) return busy()

  const key = params.key
  let out: CommitResult | CommitError | 'busy'
  try {
    out = await runSerial(async () => (memoryPressure() ? 'busy' : commitDelivery(key, body, getDeliveryDrive())))
  } catch (e) {
    console.error('[delivery commit]', key, e instanceof Error ? e.message : String(e))
    throw e
  }
  if (out === 'busy') return busy()
  if (!out.ok) {
    return NextResponse.json(
      { error: out.error, code: out.code, ...(out.current ? { current: out.current } : {}) },
      { status: out.httpStatus },
    )
  }
  return NextResponse.json(out)
}
