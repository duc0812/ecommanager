import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { parsePermissions } from '@/lib/roles'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const payload = await verifyToken(token)
  if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Read role/permissions live from the DB so permission changes apply on next
  // page load without requiring the user to log out and back in.
  const user = await prisma.appUser
    .findUnique({ where: { id: (payload as any).userId }, select: { name: true, email: true, role: true, status: true, permissions: true } })
    .catch(() => null)

  if (!user) return NextResponse.json(payload)
  if (user.status && user.status !== 'ACTIVE') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  return NextResponse.json({
    ...payload,
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: parsePermissions(user.permissions),
  })
}
