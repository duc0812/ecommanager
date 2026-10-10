import { NextResponse } from 'next/server'
import { PushError } from '@/lib/repos/pgprints-push'

export function pushErrorResponse(e: unknown) {
  if (e instanceof PushError) {
    return NextResponse.json({ error: e.message, code: e.code, ...(e.issues.length > 0 ? { issues: e.issues } : {}) }, { status: e.status })
  }
  console.error('[pgprints]', e)
  return NextResponse.json({ error: (e as any)?.message ?? 'Lỗi không xác định', code: 'INTERNAL' }, { status: 500 })
}
