import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, AuthPayload, verifyToken } from '@/lib/auth'
import { FeaturePermission, UserRole, parsePermissions } from '@/lib/roles'

export type AuthUser = {
  id: string
  email: string
  name: string
  role: UserRole
  permissions: FeaturePermission[]
  tokenVersion: number
}

export async function getSessionPayload(req: NextRequest): Promise<AuthPayload | null> {
  const token = req.cookies.get(AUTH_COOKIE)?.value
  return token ? verifyToken(token) : null
}

export async function getAuthUser(req: NextRequest): Promise<AuthUser | null> {
  const payload = await getSessionPayload(req)
  if (!payload) return null
  const user = await prisma.appUser.findUnique({
    where: { id: payload.userId },
    select: { id: true, email: true, name: true, role: true, status: true, permissions: true, tokenVersion: true },
  })
  if (!user || user.status !== 'ACTIVE') return null
  if ((payload.tv ?? 0) !== user.tokenVersion) return null
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as UserRole,
    permissions: parsePermissions(user.permissions),
    tokenVersion: user.tokenVersion,
  }
}

export function unauthorized(message = 'Unauthorized') {
  return NextResponse.json({ error: message }, { status: 401 })
}

export function forbidden(message = 'Forbidden') {
  return NextResponse.json({ error: message }, { status: 403 })
}

export async function requireRole(req: NextRequest, roles: UserRole[]): Promise<{ user: AuthUser } | { error: NextResponse }> {
  const user = await getAuthUser(req)
  if (!user) return { error: unauthorized() }
  if (!roles.includes(user.role)) return { error: forbidden('Bạn không có quyền thực hiện thao tác này.') }
  return { user }
}

export function requireSuperadmin(req: NextRequest) {
  return requireRole(req, ['SUPERADMIN'])
}

export function requireAdmin(req: NextRequest) {
  return requireRole(req, ['SUPERADMIN', 'ADMIN'])
}
