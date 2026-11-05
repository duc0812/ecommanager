import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { AuthUser, forbidden, requireApiAccess } from '@/lib/api-auth'
import { FeaturePermission } from '@/lib/roles'

export type StoreScope = { all: true } | { all: false; storeIds: string[] }

const NOT_YOUR_STORE = 'Bạn không có quyền xem store này.'

// Only a seller is limited to its stores. Support sees every store, `cs` included, until CS is split per store (stage 6);
// `feature` is already passed by callers so that change stays inside this function.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function storeScopeFor(user: AuthUser, feature?: FeaturePermission): Promise<StoreScope> {
  if (user.role !== 'SELLER') return { all: true }
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

export async function requireOrderInScope(req: NextRequest, orderId: string): Promise<{ user: AuthUser } | { error: NextResponse }> {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { storeId: true } })
  if (!order) return { error: NextResponse.json({ error: 'Không tìm thấy đơn' }, { status: 404 }) }
  if (!inScope(await storeScopeFor(auth.user), order.storeId)) return { error: forbidden(NOT_YOUR_STORE) }
  return { user: auth.user }
}

export async function requireStoreInScope(req: NextRequest, storeId: string): Promise<{ user: AuthUser } | { error: NextResponse }> {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth
  if (!inScope(await storeScopeFor(auth.user), storeId)) return { error: forbidden(NOT_YOUR_STORE) }
  return { user: auth.user }
}

export function storeWhere(storeIds: string[] | null): { storeId?: { in: string[] } } {
  return storeIds ? { storeId: { in: storeIds } } : {}
}

export async function projectIdsOf(storeIds: string[]): Promise<string[]> {
  const stores = await prisma.shopifyStore.findMany({ where: { id: { in: storeIds }, projectId: { not: null } }, select: { projectId: true } })
  return stores.flatMap(s => (s.projectId ? [s.projectId] : []))
}
