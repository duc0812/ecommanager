import { NextResponse } from 'next/server'
import { AUTH_COOKIE, clearedSessionCookieOptions } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set(AUTH_COOKIE, '', clearedSessionCookieOptions())
  return res
}
