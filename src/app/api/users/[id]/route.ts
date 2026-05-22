import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { password } = await req.json()
  if (!password || String(password).length < 6) {
    return NextResponse.json({ error: 'Password phải có ít nhất 6 ký tự' }, { status: 400 })
  }
  const passwordHash = await bcrypt.hash(String(password), 10)
  await prisma.appUser.update({ where: { id: params.id }, data: { passwordHash } })
  return NextResponse.json({ ok: true })
}
