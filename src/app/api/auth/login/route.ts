import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { signToken } from '@/lib/auth'
import { parsePermissions, UserRole } from '@/lib/roles'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { email, password } = await req.json()
  if (!email || !password) {
    return NextResponse.json({ error: 'Email hoặc password không đúng' }, { status: 401 })
  }

  const user = await prisma.appUser.findUnique({ where: { email: String(email).toLowerCase() } })
  if (!user || user.status !== 'ACTIVE' || !user.passwordHash) {
    return NextResponse.json({ error: 'Email hoặc password không đúng' }, { status: 401 })
  }

  const valid = await bcrypt.compare(String(password), user.passwordHash)
  if (!valid) {
    return NextResponse.json({ error: 'Email hoặc password không đúng' }, { status: 401 })
  }

  const token = await signToken({
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role as UserRole,
    permissions: parsePermissions(user.permissions),
  })

  const res = NextResponse.json({ ok: true })
  res.cookies.set('auth_token', token, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  })
  return res
}
