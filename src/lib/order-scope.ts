import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { AuthUser, forbidden, getAuthUser, unauthorized } from '@/lib/api-auth'
import { canCallApi } from '@/lib/api-access'
import { FeaturePermission } from '@/lib/roles'
import { StoreScope, requireOrderInScope, requireStoreFilter, storeScopeFor } from '@/lib/store-scope'

// The routes of the order pipeline and of Design Studio only ever asked for a session; the middleware checks the feature.
// A caller who sees every store keeps exactly that. A caller limited to some stores is checked again here against the
// seller list and its features, because some of these routes are skipped by the middleware, and against its stores.
const NOT_FOR_SELLER = 'Thao tác này ảnh hưởng mọi store nên chỉ Admin được thực hiện.'
const notFound = (message: string) => ({ error: NextResponse.json({ error: message }, { status: 404 }) })

type Caller = { user: AuthUser; scope: StoreScope }

async function callerOf(req: NextRequest): Promise<Caller | { error: NextResponse }> {
  const user = await getAuthUser(req)
  if (!user) return { error: unauthorized() }
  const scope = await storeScopeFor(user)
  if (!scope.all && canCallApi(user.role, user.permissions, req.nextUrl.pathname, req.method) !== 'ok') return { error: forbidden() }
  return { user, scope }
}

// storeIds null = every store. `?storeId=` narrows to one store the caller may see, like requireStoreFilter.
// `limited` is about the caller, not the request: an admin who narrows to one store is not limited.
export async function requireScope(req: NextRequest, feature?: FeaturePermission): Promise<{ user: AuthUser; storeIds: string[] | null; limited: boolean } | { error: NextResponse }> {
  const caller = await callerOf(req)
  if ('error' in caller) return caller
  if (!caller.scope.all) {
    const filter = await requireStoreFilter(req, feature)
    return 'error' in filter ? filter : { ...filter, limited: true }
  }
  const requested = req.nextUrl.searchParams.get('storeId')
  return { user: caller.user, storeIds: requested && requested !== 'all' ? [requested] : null, limited: false }
}

// For a write that reaches every store: a caller limited to some stores never does it.
export async function requireEveryStore(req: NextRequest): Promise<{ user: AuthUser } | { error: NextResponse }> {
  const caller = await callerOf(req)
  if ('error' in caller) return caller
  if (!caller.scope.all) return { error: forbidden(NOT_FOR_SELLER) }
  return { user: caller.user }
}

// An id of another store answers like an id that does not exist, so a seller cannot tell which ids exist elsewhere.
async function requireStoreOf(req: NextRequest, missing: string, storeIdOf: () => Promise<string | null | undefined>): Promise<{ user: AuthUser } | { error: NextResponse }> {
  const caller = await callerOf(req)
  if ('error' in caller) return caller
  if (caller.scope.all) return { user: caller.user }
  const storeId = await storeIdOf()
  if (!storeId || !caller.scope.storeIds.includes(storeId)) return notFound(missing)
  return { user: caller.user }
}

export async function requireOrderScope(req: NextRequest, orderId: string): Promise<{ user: AuthUser } | { error: NextResponse }> {
  const caller = await callerOf(req)
  if ('error' in caller) return caller
  return caller.scope.all ? { user: caller.user } : requireOrderInScope(req, orderId)
}

// Every id must be an order of the caller; one that is not, or does not exist, refuses the whole request.
export async function requireOrdersScope(req: NextRequest, orderIds: string[]): Promise<{ user: AuthUser } | { error: NextResponse }> {
  const caller = await callerOf(req)
  if ('error' in caller) return caller
  if (caller.scope.all) return { user: caller.user }
  const { storeIds } = caller.scope
  const wanted = Array.from(new Set(orderIds))
  const rows = await prisma.order.findMany({ where: { id: { in: wanted } }, select: { storeId: true } })
  if (rows.length !== wanted.length || rows.some(r => !storeIds.includes(r.storeId))) return notFound('Không tìm thấy đơn')
  return { user: caller.user }
}

export function requireLineScope(req: NextRequest, lineId: string) {
  return requireStoreOf(req, 'Line not found', async () =>
    (await prisma.orderLine.findUnique({ where: { id: lineId }, select: { order: { select: { storeId: true } } } }))?.order.storeId)
}

export function requireTaskScope(req: NextRequest, taskKey: string) {
  return requireStoreOf(req, 'Task not found', async () =>
    (await prisma.designTask.findUnique({ where: { taskKey }, select: { order: { select: { storeId: true } } } }))?.order.storeId)
}

export function requireArtworkScope(req: NextRequest, artworkId: string) {
  return requireStoreOf(req, 'Not found', async () =>
    (await prisma.designArtwork.findUnique({ where: { id: artworkId }, select: { order: { select: { storeId: true } } } }))?.order.storeId)
}
