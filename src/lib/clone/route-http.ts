import { NextRequest, NextResponse } from 'next/server'
import { CloneInputError, NO_SKU_CODE } from '@/lib/clone/jobs'

export function badRequest(): NextResponse {
  return NextResponse.json({ error: 'Yêu cầu không hợp lệ.' }, { status: 400 })
}

export async function readJson(req: NextRequest): Promise<unknown> {
  return req.json().catch(() => null)
}

export function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null
}

// A CloneInputError is the lib's own answer. The SKU issuer giving up is the only other error with a text that is safe to show;
// anything else (a database error, say) is logged and answered with a fixed line.
export function cloneErrorResponse(e: unknown): NextResponse {
  if (e instanceof CloneInputError) return NextResponse.json({ error: e.message, ...e.extra }, { status: e.status })
  if (e instanceof Error && e.message === NO_SKU_CODE) return NextResponse.json({ error: e.message }, { status: 503 })
  console.error('[clone api]', e)
  return NextResponse.json({ error: 'Lỗi máy chủ.' }, { status: 500 })
}
