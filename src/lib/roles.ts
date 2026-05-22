export type UserRole = 'SUPERADMIN' | 'ADMIN' | 'SELLER' | 'SUPPORT'
export type FeaturePermission =
  | 'overview'
  | 'shopify'
  | 'meta_billing'
  | 'other_bills'
  | 'fulfillment_dashboard'
  | 'fulfillment_crawler'
  | 'fulfillment_orders'
  | 'fulfillment_export'
  | 'fulfillment_suppliers'
  | 'fulfillment_mapping'
  | 'tools_spy_idea'
  | 'tools_resources'
  | 'projects'
  | 'setup_store'
  | 'setup_meta'
  | 'setup_projects'
  | 'setup_hr'
  | 'setup_users'

export const ROLE_LABELS: Record<UserRole, string> = {
  SUPERADMIN: 'Super Admin',
  ADMIN: 'Admin',
  SELLER: 'Seller',
  SUPPORT: 'Support',
}

export const FEATURE_LABELS: Record<FeaturePermission, string> = {
  overview: 'Overview',
  shopify: 'Shopify',
  meta_billing: 'Meta Billing',
  other_bills: 'Other Bills',
  fulfillment_dashboard: 'Fulfillment Dashboard',
  fulfillment_crawler: 'Product Crawler',
  fulfillment_orders: 'Orders & P/L',
  fulfillment_export: 'CSV Export',
  fulfillment_suppliers: 'Suppliers',
  fulfillment_mapping: 'Product Mapping',
  tools_spy_idea: 'Spy Idea',
  tools_resources: 'Resources',
  projects: 'Project Management',
  setup_store: 'Setup Store',
  setup_meta: 'Setup Meta',
  setup_projects: 'Setup Projects',
  setup_hr: 'Setup HR',
  setup_users: 'Users & Roles',
}

export const FEATURE_GROUPS: { label: string; permissions: FeaturePermission[] }[] = [
  { label: 'Overview', permissions: ['overview'] },
  { label: 'Finance', permissions: ['shopify', 'meta_billing', 'other_bills'] },
  {
    label: 'Fulfillment',
    permissions: [
      'fulfillment_dashboard',
      'fulfillment_crawler',
      'fulfillment_orders',
      'fulfillment_export',
      'fulfillment_suppliers',
      'fulfillment_mapping',
    ],
  },
  { label: 'Tools', permissions: ['tools_spy_idea', 'tools_resources'] },
  { label: 'Project Management', permissions: ['projects'] },
  { label: 'Setup', permissions: ['setup_store', 'setup_meta', 'setup_projects', 'setup_hr', 'setup_users'] },
]

export const DEFAULT_ROLE_PERMISSIONS: Record<UserRole, FeaturePermission[]> = {
  SUPERADMIN: Object.keys(FEATURE_LABELS) as FeaturePermission[],
  ADMIN: [
    'overview',
    'shopify',
    'meta_billing',
    'other_bills',
    'fulfillment_dashboard',
    'fulfillment_crawler',
    'fulfillment_orders',
    'fulfillment_export',
    'fulfillment_suppliers',
    'fulfillment_mapping',
    'tools_spy_idea',
    'tools_resources',
    'projects',
  ],
  SELLER: ['projects'],
  SUPPORT: [
    'other_bills',
    'fulfillment_dashboard',
    'fulfillment_crawler',
    'fulfillment_orders',
    'fulfillment_export',
    'fulfillment_suppliers',
    'fulfillment_mapping',
  ],
}

const FEATURE_PATHS: Record<FeaturePermission, string[]> = {
  overview: ['/'],
  shopify: ['/shopify'],
  meta_billing: ['/finance/meta'],
  other_bills: ['/finance/other-bills'],
  fulfillment_dashboard: ['/fulfillment', '/finance/fulfillment'],
  fulfillment_crawler: ['/fulfillment/crawler'],
  fulfillment_orders: ['/fulfillment/orders', '/orders'],
  fulfillment_export: ['/fulfillment/export', '/orders/export'],
  fulfillment_suppliers: ['/fulfillment/suppliers', '/setup/suppliers'],
  fulfillment_mapping: ['/fulfillment/mapping'],
  tools_spy_idea: ['/tools/spy-idea'],
  tools_resources: ['/tools/resources'],
  projects: ['/projects'],
  setup_store: ['/setup'],
  setup_meta: ['/setup/meta'],
  setup_projects: ['/setup/projects'],
  setup_hr: ['/setup/hr'],
  setup_users: ['/setup/users'],
}

export function parsePermissions(value: unknown): FeaturePermission[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is FeaturePermission => typeof item === 'string' && item in FEATURE_LABELS)
  }
  if (typeof value !== 'string') return []
  try {
    return parsePermissions(JSON.parse(value))
  } catch {
    return []
  }
}

function featureForPath(pathname: string) {
  const ordered = Object.entries(FEATURE_PATHS).sort((a, b) => {
    const longestA = Math.max(...a[1].map(path => path.length))
    const longestB = Math.max(...b[1].map(path => path.length))
    return longestB - longestA
  }) as [FeaturePermission, string[]][]

  return ordered.find(([, paths]) => paths.some(path => pathname === path || (path !== '/' && pathname.startsWith(path))))?.[0] ?? null
}

export function canAccess(role: UserRole, pathname: string, permissions?: FeaturePermission[]) {
  if (role === 'SUPERADMIN') return true
  const feature = featureForPath(pathname)
  if (!feature) return false
  const granted = permissions ?? DEFAULT_ROLE_PERMISSIONS[role] ?? []
  return granted.includes(feature)
}

export function visibleFor(role: UserRole, href: string, permissions?: FeaturePermission[]) {
  return canAccess(role, href, permissions)
}

export function accessSummary(role: UserRole, permissions: FeaturePermission[]) {
  if (role === 'SUPERADMIN') return 'All features'
  if (permissions.length === 0) return 'No features'
  return permissions.map(permission => FEATURE_LABELS[permission]).join(', ')
}
