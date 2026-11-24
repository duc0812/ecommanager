import { NextResponse } from 'next/server'
import { PrintpossError } from '@/lib/printposs'
import { PushError } from '@/lib/repos/pgprints-push'

export function printpossErrorResponse(e: unknown) {
  if (e instanceof PushError) return NextResponse.json({ error: e.message, code: e.code, issues: e.issues }, { status: e.status })
  if (e instanceof PrintpossError) return NextResponse.json({ error: e.message }, { status: e.status === 0 ? 504 : 502 })
  return NextResponse.json({ error: 'Không xử lý được yêu cầu Printposs' }, { status: 500 })
}
