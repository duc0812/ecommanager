import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

const ROLES = ['ADMIN', 'SELLER', 'SUPPORT']

export async function GET() {
  const users = await prisma.appUser.findMany({ orderBy: { createdAt: 'desc' } })
  if (users.length === 0) {
    const superAdmin = await prisma.appUser.create({
      data: { name: 'Super Admin', email: 'superadmin@local', role: 'SUPERADMIN' },
    })
    return NextResponse.json([superAdmin])
  }
  return NextResponse.json(users)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const name = String(body.name ?? '').trim()
  const email = String(body.email ?? '').trim().toLowerCase()
  const role = String(body.role ?? '').trim()
  if (!name || !email || !ROLES.includes(role)) {
    return NextResponse.json({ error: 'Valid name, email and role are required' }, { status: 400 })
  }
  const user = await prisma.appUser.upsert({
    where: { email },
    create: { name, email, role },
    update: { name, role, status: body.status || 'ACTIVE' },
  })
  return NextResponse.json(user)
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json()
  const user = await prisma.appUser.findUnique({ where: { id } })
  if (!user || user.role === 'SUPERADMIN') {
    return NextResponse.json({ error: 'Cannot delete this user' }, { status: 400 })
  }
  await prisma.appUser.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
