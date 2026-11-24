import { NextResponse } from 'next/server'
import { ToadditError } from '@/lib/toaddit'
import { PushError } from '@/lib/repos/pgprints-push'

export function toadditErrorResponse(e: unknown) {
  if (e instanceof PushError) return NextResponse.json({ error: e.message, code: e.code, issues: e.issues }, { status: e.status })
  if (e instanceof ToadditError) return NextResponse.json({ error: e.message, upstreamCode: e.code }, { status: e.status === 0 ? 504 : 502 })
  return NextResponse.json({ error: 'Không xử lý được yêu cầu Toaddit' }, { status: 500 })
}
