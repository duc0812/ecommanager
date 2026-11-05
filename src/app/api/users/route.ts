import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { DEFAULT_ROLE_PERMISSIONS, FeaturePermission, parsePermissions, UserRole } from '@/lib/roles'
import { requireSuperadmin } from '@/lib/api-auth'
import { ONLY_SELLER_HAS_STORES, parseStoreIds, replaceStoreAccess, storeIdsOf } from '@/lib/user-store-access'

export const dynamic = 'force-dynamic'

const ROLES: UserRole[] = ['ADMIN', 'SELLER', 'SUPPORT']
const STATUSES = ['ACTIVE', 'INACTIVE']

function normalizeUser<T extends { role: string; permissions: string; passwordHash?: string | null; storeAccess?: { storeId: string }[] }>(user: T, storeIds?: string[]) {
  const { passwordHash, storeAccess, ...rest } = user
  return {
    ...rest,
    hasPassword: Boolean(passwordHash),
    permissions: parsePermissions(user.permissions),
    storeIds: storeIds ?? (storeAccess ?? []).map(row => row.storeId).sort(),
  }
}

function permissionsFor(role: UserRole, permissions: unknown) {
  const parsed = parsePermissions(permissions)
  return parsed.length > 0 || Array.isArray(permissions) ? parsed : DEFAULT_ROLE_PERMISSIONS[role]
}

export async function GET(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const users = await prisma.appUser.findMany({ orderBy: { createdAt: 'desc' }, include: { storeAccess: { select: { storeId: true } } } })
  return NextResponse.json(users.map(user => normalizeUser(user)))
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({}))
  const name = String(body.name ?? '').trim()
  const email = String(body.email ?? '').trim().toLowerCase()
  const role = String(body.role ?? '').trim() as UserRole
  const status = body.status === undefined ? undefined : String(body.status).toUpperCase()
  if (!name || !email || !ROLES.includes(role)) {
    return NextResponse.json({ error: 'Valid name, email and role are required' }, { status: 400 })
  }
  if (status !== undefined && !STATUSES.includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  const existing = await prisma.appUser.findUnique({ where: { email } })
  if (existing?.role === 'SUPERADMIN') {
    return NextResponse.json({ error: 'Không thể sửa tài khoản Super Admin qua API này' }, { status: 400 })
  }

  let storeIds: string[] | undefined
  if (body.storeIds !== undefined) {
    const parsed = await parseStoreIds(body.storeIds)
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
    if (role !== 'SELLER' && parsed.ids.length > 0) return NextResponse.json({ error: ONLY_SELLER_HAS_STORES }, { status: 400 })
    storeIds = parsed.ids
  }

  const permissions = JSON.stringify(permissionsFor(role, body.permissions) satisfies FeaturePermission[])
  const samePermissions = !!existing && JSON.stringify([...parsePermissions(existing.permissions)].sort()) === JSON.stringify([...parsePermissions(permissions)].sort())
  const accessChanged = !!existing && (existing.role !== role || (status !== undefined && existing.status !== status) || !samePermissions)
  const user = existing
    ? await prisma.appUser.update({
        where: { id: existing.id },
        data: {
          name,
          role,
          permissions,
          ...(status !== undefined ? { status } : {}),
          ...(accessChanged ? { tokenVersion: { increment: 1 } } : {}),
        },
      })
    : await prisma.appUser.create({ data: { name, email, role, permissions, status: status ?? 'ACTIVE' } })
  if (role !== 'SELLER') await replaceStoreAccess(user.id, [])
  else if (storeIds) await replaceStoreAccess(user.id, storeIds)
  return NextResponse.json(normalizeUser(user, await storeIdsOf(user.id)))
}

export async function DELETE(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const { id } = await req.json().catch(() => ({}))
  if (!id || typeof id !== 'string') return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const user = await prisma.appUser.findUnique({ where: { id } })
  if (!user || user.role === 'SUPERADMIN' || user.id === auth.user.id) {
    return NextResponse.json({ error: 'Cannot delete this user' }, { status: 400 })
  }
  await prisma.appUser.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
