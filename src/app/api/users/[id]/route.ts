import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { requireSuperadmin } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

const MIN_PASSWORD_LENGTH = 10

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({}))
  const password = String(body?.password ?? '')
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `Password phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự` }, { status: 400 })
  }
  const target = await prisma.appUser.findUnique({ where: { id: params.id }, select: { id: true, role: true } })
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (target.role === 'SUPERADMIN' && target.id !== auth.user.id) {
    return NextResponse.json({ error: 'Chỉ chính Super Admin mới đổi được password của mình' }, { status: 403 })
  }
  const passwordHash = await bcrypt.hash(password, 10)
  await prisma.appUser.update({
    where: { id: params.id },
    data: { passwordHash, tokenVersion: { increment: 1 } },
  })
  return NextResponse.json({ ok: true })
}
