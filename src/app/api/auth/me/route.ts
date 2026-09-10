import { NextRequest, NextResponse } from 'next/server'
import { AUTH_COOKIE, clearedSessionCookieOptions, sessionCookieOptions, signToken } from '@/lib/auth'
import { getAuthUser } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) {
    const res = NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    res.cookies.set(AUTH_COOKIE, '', clearedSessionCookieOptions())
    return res
  }

  const payload = {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    permissions: user.permissions,
    tv: user.tokenVersion,
  }
  const res = NextResponse.json(payload)
  res.cookies.set(AUTH_COOKIE, await signToken(payload), sessionCookieOptions())
  return res
}
