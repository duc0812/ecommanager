import { DEFAULT_ROLE_PERMISSIONS, FeaturePermission, UserRole } from '@/lib/roles'

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
type ApiAccess = 'PUBLIC' | 'ANY' | 'SUPERADMIN' | 'ADMIN' | FeaturePermission[]
type ApiRule = { prefix: string; exact?: boolean; methods?: ApiMethod[]; access: ApiAccess }

const READ: ApiMethod[] = ['GET']
const WRITE: ApiMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE']
const FULFILLMENT_READERS: FeaturePermission[] = [
  'fulfillment_dashboard', 'fulfillment_orders', 'fulfillment_export', 'fulfillment_suppliers',
  'fulfillment_mapping', 'fulfillment_tracking', 'fulfillment_design_library', 'need_to_fix',
]

export const API_ACCESS_RULES: ApiRule[] = [
  { prefix: '/api/auth/login', access: 'PUBLIC' },
  { prefix: '/api/auth/logout', access: 'ANY' },
  { prefix: '/api/auth/me', access: 'ANY' },
  { prefix: '/api/auth/shopify/callback', access: 'PUBLIC' },
  { prefix: '/api/auth/shopify-config', access: 'SUPERADMIN' },
  { prefix: '/api/auth/shopify', access: 'SUPERADMIN' },
  { prefix: '/api/auth/status', methods: READ, access: ['shopify', 'setup_store'] },
  { prefix: '/api/auth/status', methods: WRITE, access: 'SUPERADMIN' },
  { prefix: '/api/auto-sync', access: ['projects'] },
  { prefix: '/api/finance/other-bills', access: ['other_bills'] },
  { prefix: '/api/finance/fulfillment', access: ['fulfillment_dashboard'] },
  { prefix: '/api/fulfillment/auto-fulfill/config', methods: WRITE, access: 'SUPERADMIN' },
  { prefix: '/api/fulfillment/auto-fulfill', access: ['fulfillment_dashboard', 'fulfillment_tracking'] },
  { prefix: '/api/fulfillment/crawler', access: ['fulfillment_crawler'] },
  { prefix: '/api/fulfillment/design-', access: ['fulfillment_design_library', 'fulfillment_orders'] },
  { prefix: '/api/fulfillment/export', access: ['fulfillment_export'] },
  { prefix: '/api/fulfillment/mapping', access: ['fulfillment_mapping'] },
  { prefix: '/api/fulfillment/normalize', access: ['fulfillment_orders'] },
  { prefix: '/api/fulfillment/orders', access: ['fulfillment_orders', 'need_to_fix', 'fulfillment_suppliers'] },
  { prefix: '/api/fulfillment/pl-summary', access: ['fulfillment_orders'] },
  { prefix: '/api/fulfillment/status-counts', access: ['fulfillment_orders'] },
  { prefix: '/api/fulfillment/tracking/parcelpanel-config', methods: WRITE, access: 'SUPERADMIN' },
  { prefix: '/api/fulfillment/tracking', access: ['fulfillment_tracking'] },
  { prefix: '/api/fulfillment/supplier-performance', access: ['fulfillment_tracking'] },
  { prefix: '/api/fulfillment/task-fix', access: ['need_to_fix'] },
  { prefix: '/api/marketing', access: ['marketing_niche'] },
  { prefix: '/api/meta/accounts', methods: READ, access: ['meta_billing', 'setup_meta', 'marketing_niche'] },
  { prefix: '/api/meta/accounts', methods: WRITE, access: 'SUPERADMIN' },
  { prefix: '/api/meta/db-billing', access: ['meta_billing'] },
  { prefix: '/api/meta/import', access: ['meta_billing'] },
  { prefix: '/api/meta/exchange-rates', methods: READ, access: ['meta_billing', 'setup_meta', 'projects'] },
  { prefix: '/api/meta/exchange-rates', methods: WRITE, access: ['setup_meta'] },
  { prefix: '/api/meta/sync-campaign-insights', access: ['marketing_niche', 'setup_meta'] },
  { prefix: '/api/meta/sync', access: ['meta_billing', 'setup_meta', 'overview'] },
  { prefix: '/api/meta/verify-spend', access: ['setup_meta', 'meta_billing'] },
  { prefix: '/api/overview', access: ['overview'] },
  { prefix: '/api/projects/assign', access: ['setup_hr'] },
  { prefix: '/api/projects/seller-commission', access: 'SUPERADMIN' },
  { prefix: '/api/projects/analytics', access: ['projects'] },
  { prefix: '/api/projects/profit-chart', access: ['projects'] },
  { prefix: '/api/projects/snapshot', access: ['projects'] },
  { prefix: '/api/projects', exact: true, methods: READ, access: 'ANY' },
  { prefix: '/api/projects', exact: true, methods: WRITE, access: ['setup_projects'] },
  { prefix: '/api/projects/', access: ['projects'] },
  { prefix: '/api/shopify/orders/sync', access: ['shopify', 'fulfillment_orders', 'overview'] },
  { prefix: '/api/shopify', access: ['shopify'] },
  { prefix: '/api/spy/config', methods: READ, access: ['setup_store', 'tools_spy_idea'] },
  { prefix: '/api/spy/config', methods: WRITE, access: 'SUPERADMIN' },
  { prefix: '/api/spy/cron', methods: WRITE, access: 'SUPERADMIN' },
  { prefix: '/api/spy', access: ['tools_spy_idea'] },
  { prefix: '/api/staff', methods: READ, access: ['setup_hr', 'projects'] },
  { prefix: '/api/staff', methods: WRITE, access: ['setup_hr'] },
  { prefix: '/api/suppliers', methods: READ, access: FULFILLMENT_READERS },
  { prefix: '/api/suppliers', methods: WRITE, access: ['fulfillment_suppliers'] },
  { prefix: '/api/tools/resources', access: ['tools_resources'] },
  { prefix: '/api/tools/telegram', methods: READ, access: ['tools_resources'] },
  { prefix: '/api/tools/telegram', methods: WRITE, access: 'SUPERADMIN' },
  { prefix: '/api/tools/spy-idea', access: ['tools_spy_idea'] },
  { prefix: '/api/trello/config', methods: READ, access: ['setup_store'] },
  { prefix: '/api/trello/config', methods: WRITE, access: 'SUPERADMIN' },
  { prefix: '/api/trello', access: ['fulfillment_orders', 'overview'] },
  { prefix: '/api/users', access: 'SUPERADMIN' },
]

function matchRule(rule: ApiRule, pathname: string, method: string) {
  const pathOk = rule.exact ? pathname === rule.prefix : pathname === rule.prefix || pathname.startsWith(rule.prefix)
  if (!pathOk) return false
  return !rule.methods || rule.methods.includes(method.toUpperCase() as ApiMethod)
}

export function apiAccessFor(pathname: string, method: string): ApiAccess | null {
  return API_ACCESS_RULES.find(rule => matchRule(rule, pathname, method))?.access ?? null
}

export type ApiDecision = 'ok' | 'unauthenticated' | 'forbidden'

export function canCallApi(
  role: UserRole | null,
  permissions: FeaturePermission[],
  pathname: string,
  method: string,
): ApiDecision {
  const access = apiAccessFor(pathname, method)
  if (access === 'PUBLIC') return 'ok'
  if (!role) return 'unauthenticated'
  if (role === 'SUPERADMIN') return 'ok'
  if (access === null || access === 'SUPERADMIN') return 'forbidden'
  if (access === 'ANY') return 'ok'
  if (access === 'ADMIN') return role === 'ADMIN' ? 'ok' : 'forbidden'
  const granted = permissions ?? DEFAULT_ROLE_PERMISSIONS[role] ?? []
  return access.some(feature => granted.includes(feature)) ? 'ok' : 'forbidden'
}
