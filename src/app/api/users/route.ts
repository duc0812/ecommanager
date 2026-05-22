import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { DEFAULT_ROLE_PERMISSIONS, FeaturePermission, parsePermissions, UserRole } from '@/lib/roles'

const ROLES = ['ADMIN', 'SELLER', 'SUPPORT']

function normalizeUser<T extends { role: string; permissions: string }>(user: T) {
  return {
    ...user,
    permissions: parsePermissions(user.permissions),
  }
}

function permissionsFor(role: UserRole, permissions: unknown) {
  const parsed = parsePermissions(permissions)
  return parsed.length > 0 || Array.isArray(permissions) ? parsed : DEFAULT_ROLE_PERMISSIONS[role]
}

export async function GET() {
  const users = await prisma.appUser.findMany({ orderBy: { createdAt: 'desc' } })
  if (users.length === 0) {
    const superAdmin = await prisma.appUser.create({
      data: {
        name: 'Super Admin',
        email: 'superadmin@local',
        role: 'SUPERADMIN',
        permissions: JSON.stringify(DEFAULT_ROLE_PERMISSIONS.SUPERADMIN),
      },
    })
    return NextResponse.json([normalizeUser(superAdmin)])
  }
  return NextResponse.json(users.map(normalizeUser))
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const name = String(body.name ?? '').trim()
  const email = String(body.email ?? '').trim().toLowerCase()
  const role = String(body.role ?? '').trim() as UserRole
  if (!name || !email || !ROLES.includes(role)) {
    return NextResponse.json({ error: 'Valid name, email and role are required' }, { status: 400 })
  }
  const permissions = JSON.stringify(permissionsFor(role, body.permissions) satisfies FeaturePermission[])
  const user = await prisma.appUser.upsert({
    where: { email },
    create: { name, email, role, permissions },
    update: { name, role, permissions, status: body.status || 'ACTIVE' },
  })
  return NextResponse.json(normalizeUser(user))
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
