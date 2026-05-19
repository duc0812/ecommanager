export type UserRole = 'SUPERADMIN' | 'ADMIN' | 'SELLER' | 'SUPPORT'

export const ROLE_LABELS: Record<UserRole, string> = {
  SUPERADMIN: 'Super Admin',
  ADMIN: 'Admin',
  SELLER: 'Seller',
  SUPPORT: 'Support',
}

export function canAccess(role: UserRole, pathname: string) {
  if (role === 'SUPERADMIN') return true
  if (role === 'ADMIN') return !pathname.startsWith('/setup')
  if (role === 'SELLER') return pathname === '/projects' || pathname.startsWith('/projects')
  if (role === 'SUPPORT') {
    return pathname.startsWith('/finance/fulfillment') || pathname.startsWith('/finance/other-bills') || pathname.startsWith('/orders')
  }
  return false
}

export function visibleFor(role: UserRole, href: string) {
  return canAccess(role, href)
}
