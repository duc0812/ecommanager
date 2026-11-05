import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { AuthUser, forbidden, requireApiAccess } from '@/lib/api-auth'
import { FeaturePermission } from '@/lib/roles'

export type StoreScope = { all: true } | { all: false; storeIds: string[] }

const NOT_YOUR_STORE = 'Bạn không có quyền xem store này.'

// Only SUPERADMIN, ADMIN and SUPPORT see every store (Support, `cs` included, until CS is split per store in stage 6;
// `feature` is already passed by callers so that change stays inside this function). A seller sees its assigned stores.
// AppUser.role is a free string, so any other value gets no store instead of all of them.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function storeScopeFor(user: AuthUser, feature?: FeaturePermission): Promise<StoreScope> {
  if (user.role === 'SUPERADMIN' || user.role === 'ADMIN' || user.role === 'SUPPORT') return { all: true }
  if (user.role !== 'SELLER') return { all: false, storeIds: [] }
  const rows = await prisma.userStoreAccess.findMany({ where: { userId: user.id }, select: { storeId: true } })
  return { all: false, storeIds: rows.map(r => r.storeId) }
}

function inScope(scope: StoreScope, storeId: string) {
  return scope.all || scope.storeIds.includes(storeId)
}

// storeIds null = no filter. `?storeId=` picks one store the caller may see; `all` or nothing means every store it may see.
export async function requireStoreFilter(req: NextRequest, feature?: FeaturePermission): Promise<{ user: AuthUser; storeIds: string[] | null } | { error: NextResponse }> {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth
  const scope = await storeScopeFor(auth.user, feature)
  const requested = req.nextUrl.searchParams.get('storeId')
  if (!requested || requested === 'all') return { user: auth.user, storeIds: scope.all ? null : scope.storeIds }
  if (!inScope(scope, requested)) return { error: forbidden(NOT_YOUR_STORE) }
  return { user: auth.user, storeIds: [requested] }
}

// An order outside the caller's scope answers exactly like a missing one, so a seller cannot tell which order ids exist in other stores.
export async function requireOrderInScope(req: NextRequest, orderId: string): Promise<{ user: AuthUser } | { error: NextResponse }> {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth
  const scope = await storeScopeFor(auth.user)
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { storeId: true } })
  if (!order || !inScope(scope, order.storeId)) return { error: NextResponse.json({ error: 'Không tìm thấy đơn' }, { status: 404 }) }
  return { user: auth.user }
}

export async function requireStoreInScope(req: NextRequest, storeId: string): Promise<{ user: AuthUser } | { error: NextResponse }> {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth
  if (!inScope(await storeScopeFor(auth.user), storeId)) return { error: forbidden(NOT_YOUR_STORE) }
  return { user: auth.user }
}

// Only null means no filter; a missing list must not widen a query to every store.
export function storeWhere(storeIds: string[] | null): { storeId?: { in: string[] } } {
  if (storeIds === null) return {}
  return { storeId: { in: storeIds ?? [] } }
}

export async function projectIdsOf(storeIds: string[]): Promise<string[]> {
  const stores = await prisma.shopifyStore.findMany({ where: { id: { in: storeIds }, projectId: { not: null } }, select: { projectId: true } })
  return stores.flatMap(s => (s.projectId ? [s.projectId] : []))
}
