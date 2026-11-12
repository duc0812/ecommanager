import { NextRequest, NextResponse } from 'next/server'
import { receiveLarkEvent } from '@/lib/lark/events'
import { processLarkMessage } from '@/lib/lark/process'

export const dynamic = 'force-dynamic'

const MAX_BODY = 1_000_000

export async function POST(req: NextRequest) {
  const raw = await req.text()
  if (raw.length > MAX_BODY) return NextResponse.json({ error: 'bad request' }, { status: 400 })
  let result
  try {
    result = await receiveLarkEvent(raw, {
      timestamp: req.headers.get('x-lark-request-timestamp'),
      nonce: req.headers.get('x-lark-request-nonce'),
      signature: req.headers.get('x-lark-signature'),
    })
  } catch (e) {
    console.error('[lark] nhận sự kiện lỗi', (e as Error)?.message ?? e)
    return NextResponse.json({ error: 'server error' }, { status: 500 })
  }
  const { status, body, accepted } = result
  if (accepted) void processLarkMessage(accepted).catch(e => console.error('[lark] xử lý lỗi', e?.message ?? e))
  return NextResponse.json(body, { status })
}
