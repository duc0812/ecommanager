import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, sessionCookieOptions, signToken } from '@/lib/auth'
import { parsePermissions, UserRole } from '@/lib/roles'
import { clearLoginFailures, clientIp, loginBlocked, recordLoginFailure } from '@/lib/login-rate-limit'

export const dynamic = 'force-dynamic'

const INVALID = 'Email hoặc password không đúng'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const email = String(body?.email ?? '').trim().toLowerCase()
  const password = String(body?.password ?? '')
  if (!email || !password) {
    return NextResponse.json({ error: INVALID }, { status: 401 })
  }

  const ip = clientIp(req.headers)
  const keys = [`ip:${ip}`, `email:${email}`]
  if (keys.some(loginBlocked)) {
    return NextResponse.json({ error: 'Quá nhiều lần đăng nhập sai. Thử lại sau 15 phút.' }, { status: 429 })
  }

  const user = await prisma.appUser.findUnique({ where: { email } })
  const valid = !!user && user.status === 'ACTIVE' && !!user.passwordHash && await bcrypt.compare(password, user.passwordHash)
  if (!user || !valid) {
    keys.forEach(k => recordLoginFailure(k))
    return NextResponse.json({ error: INVALID }, { status: 401 })
  }
  keys.forEach(clearLoginFailures)

  const token = await signToken({
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role as UserRole,
    permissions: parsePermissions(user.permissions),
    tv: user.tokenVersion,
  })

  const res = NextResponse.json({ ok: true })
  res.cookies.set(AUTH_COOKIE, token, sessionCookieOptions())
  return res
}
