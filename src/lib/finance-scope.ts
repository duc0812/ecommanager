import { NextRequest, NextResponse } from 'next/server'
import { AuthUser, forbidden, requireApiAccess } from '@/lib/api-auth'
import { FeaturePermission } from '@/lib/roles'
import { projectIdsOf, requireStoreFilter, storeScopeFor } from '@/lib/store-scope'

const NOT_YOUR_PROJECT = 'Bạn không có quyền xem project này.'
const NOT_FOR_SELLER = 'Thao tác này ảnh hưởng mọi store nên chỉ Admin được thực hiện.'

export type FinanceScope = {
  user: AuthUser
  storeIds: string[] | null
  projectIds: string[] | null
  includeUnassigned: boolean
}

export type ProjectRowsWhere = { OR?: Array<{ projectId: { in: string[] } } | { projectId: null }> }

// The finance numbers follow a Project, and a store has at most one. Rows with no project (an ad account,
// an other bill) belong to no store, so every caller who sees all of its stores sees them too; narrowing to
// one store of several leaves them out, and a caller with no store sees nothing.
export async function requireFinanceScope(req: NextRequest, feature?: FeaturePermission): Promise<FinanceScope | { error: NextResponse }> {
  const filter = await requireStoreFilter(req, feature)
  if ('error' in filter) return filter
  const { user, storeIds } = filter
  if (storeIds === null) return { user, storeIds, projectIds: null, includeUnassigned: true }
  const full = await storeScopeFor(user, feature)
  const narrowed = full.all || storeIds.length < full.storeIds.length
  return { user, storeIds, projectIds: await projectIdsOf(storeIds), includeUnassigned: storeIds.length > 0 && !narrowed }
}

export function projectWhere(scope: FinanceScope): { id?: { in: string[] } } {
  return scope.projectIds ? { id: { in: scope.projectIds } } : {}
}

// For a table whose projectId may be null (MetaAdAccount, OtherBill, FulfillmentCost).
export function projectRowsWhere(scope: FinanceScope): ProjectRowsWhere {
  if (!scope.projectIds) return {}
  return { OR: [{ projectId: { in: scope.projectIds } }, ...(scope.includeUnassigned ? [{ projectId: null }] : [])] }
}

export function ownsProject(scope: FinanceScope, projectId: string): boolean {
  return !scope.projectIds || scope.projectIds.includes(projectId)
}

export function mayUseRow(scope: FinanceScope, projectId: string | null | undefined): boolean {
  if (!scope.projectIds) return true
  return projectId ? scope.projectIds.includes(projectId) : scope.includeUnassigned
}

export async function requireProjectInScope(req: NextRequest, projectId: string, feature?: FeaturePermission): Promise<FinanceScope | { error: NextResponse }> {
  const scope = await requireFinanceScope(req, feature)
  if ('error' in scope) return scope
  if (!ownsProject(scope, projectId)) return { error: forbidden(NOT_YOUR_PROJECT) }
  return scope
}

// For a write that reaches every store (global rates, staff records, a sync of all stores): a seller never does it.
export async function requireUnrestricted(req: NextRequest): Promise<{ user: AuthUser } | { error: NextResponse }> {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth
  if (!(await storeScopeFor(auth.user)).all) return { error: forbidden(NOT_FOR_SELLER) }
  return auth
}

// One shop a payout view shows: the one named, else the first of the stores the caller may see.
export function firstStoreOf<T extends { id: string }>(stores: T[], storeIds: string[] | null): T | null {
  return (storeIds ? stores.filter(s => storeIds.includes(s.id)) : stores)[0] ?? null
}
