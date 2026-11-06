export type UserRole = 'SUPERADMIN' | 'ADMIN' | 'SELLER' | 'SUPPORT'
export type FeaturePermission =
  | 'overview'
  | 'shopify'
  | 'meta_billing'
  | 'other_bills'
  | 'fulfillment_dashboard'
  | 'fulfillment_crawler'
  | 'fulfillment_clone'
  | 'fulfillment_orders'
  | 'fulfillment_export'
  | 'fulfillment_suppliers'
  | 'fulfillment_mapping'
  | 'fulfillment_tracking'
  | 'fulfillment_design_library'
  | 'design_tasks'
  | 'need_to_fix'
  | 'cs'
  | 'tools_spy_idea'
  | 'tools_resources'
  | 'tools_creative'
  | 'tools_scale'
  | 'projects'
  | 'marketing_niche'
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

// AppUser.role is a free string in the database; anything that gates on a role asks this first.
export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ROLE_LABELS, value)
}

export const FEATURE_LABELS: Record<FeaturePermission, string> = {
  overview: 'Overview',
  shopify: 'Shopify',
  meta_billing: 'Meta Billing',
  other_bills: 'Other Bills',
  fulfillment_dashboard: 'Fulfillment Dashboard',
  fulfillment_crawler: 'Product Crawler',
  fulfillment_clone: 'Clone từ link',
  fulfillment_orders: 'Orders & P/L',
  fulfillment_export: 'CSV Export',
  fulfillment_suppliers: 'Suppliers',
  fulfillment_mapping: 'Product Mapping',
  fulfillment_tracking: 'Tracking',
  fulfillment_design_library: 'Design Library',
  design_tasks: 'Design Tasks',
  need_to_fix: 'Need To Fix',
  cs: 'Customer Service',
  tools_spy_idea: 'Spy Idea',
  tools_resources: 'Resources',
  tools_creative: 'Creative',
  tools_scale: 'Scale sản phẩm',
  projects: 'Project Management',
  marketing_niche: 'Niche Performance',
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
      'fulfillment_clone',
      'fulfillment_orders',
      'fulfillment_export',
      'fulfillment_suppliers',
      'fulfillment_mapping',
      'fulfillment_tracking',
      'fulfillment_design_library',
      'design_tasks',
      'need_to_fix',
    ],
  },
  { label: 'Customer Service', permissions: ['cs'] },
  { label: 'Tools', permissions: ['tools_spy_idea', 'tools_resources', 'tools_creative', 'tools_scale'] },
  { label: 'Project Management', permissions: ['projects'] },
  { label: 'Marketing', permissions: ['marketing_niche'] },
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
    'fulfillment_clone',
    'fulfillment_orders',
    'fulfillment_export',
    'fulfillment_suppliers',
    'fulfillment_mapping',
    'fulfillment_tracking',
    'fulfillment_design_library',
    'design_tasks',
    'need_to_fix',
    'cs',
    'tools_spy_idea',
    'tools_resources',
    'tools_creative',
    'tools_scale',
    'projects',
    'marketing_niche',
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
    'fulfillment_tracking',
    'fulfillment_design_library',
    'design_tasks',
    'need_to_fix',
    'cs',
  ],
}

const FEATURE_PATHS: Record<FeaturePermission, string[]> = {
  overview: ['/'],
  shopify: ['/shopify'],
  meta_billing: ['/finance/meta'],
  other_bills: ['/finance/other-bills'],
  fulfillment_dashboard: ['/fulfillment', '/finance/fulfillment'],
  fulfillment_crawler: ['/fulfillment/crawler'],
  fulfillment_clone: ['/fulfillment/clone'],
  fulfillment_orders: ['/fulfillment/orders', '/orders'],
  fulfillment_export: ['/fulfillment/export', '/orders/export'],
  fulfillment_suppliers: ['/fulfillment/suppliers', '/setup/suppliers'],
  fulfillment_mapping: ['/fulfillment/mapping'],
  fulfillment_tracking: ['/fulfillment/tracking'],
  fulfillment_design_library: ['/fulfillment/design-library'],
  design_tasks: ['/design-studio'],
  need_to_fix: ['/task-fix'],
  cs: ['/cs'],
  tools_spy_idea: ['/tools/spy-idea'],
  tools_resources: ['/tools/resources'],
  tools_creative: ['/tools/creative'],
  tools_scale: ['/tools/scale'],
  projects: ['/projects'],
  marketing_niche: ['/marketing/niche-performance'],
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

// The feature whose configured path is the longest prefix of the page wins, so /fulfillment/orders is Orders & P/L and not the
// Fulfillment Dashboard (/fulfillment), and /orders/export is CSV Export and not Orders & P/L (/orders).
function featureForPath(pathname: string) {
  let best: { feature: FeaturePermission; length: number } | null = null
  for (const [feature, paths] of Object.entries(FEATURE_PATHS) as [FeaturePermission, string[]][]) {
    for (const path of paths) {
      const matches = pathname === path || (path !== '/' && pathname.startsWith(path))
      if (matches && (!best || path.length > best.length)) best = { feature, length: path.length }
    }
  }
  return best?.feature ?? null
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

const HOME_PRIORITY: FeaturePermission[] = [
  'overview',
  'projects',
  'fulfillment_dashboard',
  'fulfillment_orders',
  'need_to_fix',
  'cs',
  'shopify',
  'meta_billing',
  'other_bills',
  'marketing_niche',
  'tools_spy_idea',
  'tools_resources',
  'tools_creative',
  'tools_scale',
  'fulfillment_tracking',
  'fulfillment_export',
  'fulfillment_mapping',
  'fulfillment_suppliers',
  'fulfillment_design_library',
  'design_tasks',
  'fulfillment_crawler',
  'fulfillment_clone',
  'setup_store',
  'setup_meta',
  'setup_projects',
  'setup_hr',
  'setup_users',
]

export function homePathFor(role: UserRole, permissions?: FeaturePermission[]): string | null {
  if (role === 'SUPERADMIN') return '/'
  const granted = permissions ?? DEFAULT_ROLE_PERMISSIONS[role] ?? []
  const feature = HOME_PRIORITY.find(f => granted.includes(f)) ?? granted[0]
  return feature ? FEATURE_PATHS[feature][0] : null
}

function grantedFor(role: string, permissions?: FeaturePermission[]): FeaturePermission[] {
  return permissions ?? DEFAULT_ROLE_PERMISSIONS[role as UserRole] ?? []
}

export function isLeaderRole(role: string): boolean {
  return role === 'SUPERADMIN' || role === 'ADMIN'
}

/** REVIEW → DONE / REJECTED: a leader always, a design_tasks holder only while the designerCanApprove setting is on. */
export function canApproveDesign(role: string, permissions: FeaturePermission[] | undefined, designerCanApprove: boolean): boolean {
  if (isLeaderRole(role)) return true
  return designerCanApprove && grantedFor(role, permissions).includes('design_tasks')
}

/** Editing the CS note of a design task: a leader, or anyone holding design_tasks. */
export function canEditDesignNote(role: string, permissions: FeaturePermission[] | undefined): boolean {
  return isLeaderRole(role) || grantedFor(role, permissions).includes('design_tasks')
}

export function canHandoffToSupplier(role: string, permissions: FeaturePermission[] | undefined): boolean {
  return isLeaderRole(role) || grantedFor(role, permissions).includes('fulfillment_export')
}
