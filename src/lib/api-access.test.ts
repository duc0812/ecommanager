import { describe, expect, it } from 'vitest'
import { API_ACCESS_RULES, SELLER_API_PATHS, SELLER_API_PREFIXES, SELLER_READ_ONLY_PREFIXES, canCallApi, sellerMayReach } from './api-access'
import type { FeaturePermission, UserRole } from './roles'
import { DEFAULT_ROLE_PERMISSIONS } from './roles'

describe('canCallApi', () => {
  it('allows login without a session', () => {
    expect(canCallApi(null, [], '/api/auth/login', 'POST')).toBe('ok')
  })

  it('rejects unauthenticated callers on every other route', () => {
    expect(canCallApi(null, [], '/api/overview', 'GET')).toBe('unauthenticated')
    expect(canCallApi(null, [], '/api/users', 'GET')).toBe('unauthenticated')
  })

  it('superadmin can call anything', () => {
    expect(canCallApi('SUPERADMIN', [], '/api/users', 'DELETE')).toBe('ok')
    expect(canCallApi('SUPERADMIN', [], '/api/unknown', 'GET')).toBe('ok')
  })

  it('seller with default permissions cannot manage users, tokens or Meta accounts', () => {
    const perms = DEFAULT_ROLE_PERMISSIONS.SELLER
    expect(canCallApi('SELLER', perms, '/api/users', 'GET')).toBe('forbidden')
    expect(canCallApi('SELLER', perms, '/api/users/abc', 'PATCH')).toBe('forbidden')
    expect(canCallApi('SELLER', perms, '/api/trello/config', 'GET')).toBe('forbidden')
    expect(canCallApi('SELLER', perms, '/api/spy/config', 'POST')).toBe('forbidden')
    expect(canCallApi('SELLER', perms, '/api/meta/accounts', 'DELETE')).toBe('forbidden')
    expect(canCallApi('SELLER', perms, '/api/auth/status', 'DELETE')).toBe('forbidden')
    expect(canCallApi('SELLER', perms, '/api/fulfillment/auto-fulfill/run', 'POST')).toBe('forbidden')
  })

  it('seller cannot create projects', () => {
    expect(canCallApi('SELLER', DEFAULT_ROLE_PERMISSIONS.SELLER, '/api/projects', 'POST')).toBe('forbidden')
  })

  it('admin can read Meta accounts but not rewrite tokens', () => {
    const perms = DEFAULT_ROLE_PERMISSIONS.ADMIN
    expect(canCallApi('ADMIN', perms, '/api/meta/accounts', 'GET')).toBe('ok')
    expect(canCallApi('ADMIN', perms, '/api/meta/accounts', 'PATCH')).toBe('forbidden')
    expect(canCallApi('ADMIN', perms, '/api/shopify/orders/sync', 'POST')).toBe('ok')
  })

  it('support role reaches fulfillment endpoints only', () => {
    const perms = DEFAULT_ROLE_PERMISSIONS.SUPPORT
    expect(canCallApi('SUPPORT', perms, '/api/fulfillment/orders', 'GET')).toBe('ok')
    expect(canCallApi('SUPPORT', perms, '/api/suppliers', 'GET')).toBe('ok')
    expect(canCallApi('SUPPORT', perms, '/api/fulfillment/suppliers/s1/print-templates', 'GET')).toBe('ok')
    expect(canCallApi('SUPPORT', perms, '/api/overview', 'GET')).toBe('forbidden')
    expect(canCallApi('SUPPORT', perms, '/api/spy/ads', 'GET')).toBe('forbidden')
  })

  it('unknown API paths are denied for non-superadmins', () => {
    expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/does-not-exist', 'GET')).toBe('forbidden')
  })

  it('an explicitly empty permission list grants nothing', () => {
    expect(canCallApi('ADMIN', [], '/api/overview', 'GET')).toBe('forbidden')
  })
})

import { homePathFor } from './roles'

describe('homePathFor', () => {
  it('sends each role to the first page it can open', () => {
    expect(homePathFor('SUPERADMIN')).toBe('/')
    expect(homePathFor('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN)).toBe('/')
    expect(homePathFor('SUPPORT', DEFAULT_ROLE_PERMISSIONS.SUPPORT)).toBe('/fulfillment')
    expect(homePathFor('SELLER', DEFAULT_ROLE_PERMISSIONS.SELLER)).toBe('/projects')
    expect(homePathFor('SELLER', [])).toBeNull()
  })

  it('supplier print templates: readers may list, only fulfillment_suppliers may write', () => {
    expect(canCallApi('SUPPORT', ['design_tasks'], '/api/fulfillment/suppliers/s1/print-templates', 'GET')).toBe('ok')
    expect(canCallApi('SUPPORT', ['design_tasks'], '/api/fulfillment/suppliers/s1/print-templates', 'POST')).toBe('forbidden')
    expect(canCallApi('ADMIN', ['fulfillment_suppliers'], '/api/fulfillment/suppliers/s1/products/print-template', 'PATCH')).toBe('ok')
    expect(canCallApi('ADMIN', [], '/api/fulfillment/suppliers/s1/print-templates', 'GET')).toBe('forbidden')
  })
})

describe('PGprints API access', () => {
  const token = 'a'.repeat(64)

  it('the two public routes need no session, and nothing else under /api/public does', () => {
    expect(canCallApi(null, [], `/api/public/artwork/${token}/main.png`, 'GET')).toBe('ok')
    expect(canCallApi(null, [], '/api/public/pgprints/tracking', 'POST')).toBe('ok')
    expect(canCallApi(null, [], '/api/public/pgprints/tracking', 'GET')).toBe('unauthenticated')
    expect(canCallApi(null, [], '/api/public/pgprints/tracking/extra', 'POST')).toBe('unauthenticated')
    expect(canCallApi(null, [], '/api/public/pgprints/settings', 'GET')).toBe('unauthenticated')
    expect(canCallApi(null, [], '/api/public/artwork', 'GET')).toBe('unauthenticated')
    expect(canCallApi(null, [], '/api/public', 'GET')).toBe('unauthenticated')
    expect(canCallApi('SELLER', [], '/api/public/other', 'GET')).toBe('forbidden')
  })

  it.each(['bondre', 'printway'])('%s: only a superadmin saves the key, an admin may test it and see the SKU map', supplier => {
    const path = `/api/fulfillment/${supplier}/settings`
    expect(canCallApi('ADMIN', [], path, 'PUT')).toBe('forbidden')
    expect(canCallApi('SUPERADMIN', [], path, 'PUT')).toBe('ok')
    expect(canCallApi('ADMIN', [], path, 'GET')).toBe('ok')
    expect(canCallApi('SUPPORT', DEFAULT_ROLE_PERMISSIONS.SUPPORT, path, 'GET')).toBe('forbidden')
    expect(canCallApi('ADMIN', [], `${path}/test`, 'POST')).toBe('ok')
    expect(canCallApi('SUPPORT', DEFAULT_ROLE_PERMISSIONS.SUPPORT, `${path}/test`, 'POST')).toBe('forbidden')
    expect(canCallApi('ADMIN', [], `/api/fulfillment/${supplier}/sku-map`, 'GET')).toBe('ok')
    expect(canCallApi('SUPPORT', DEFAULT_ROLE_PERMISSIONS.SUPPORT, `/api/fulfillment/${supplier}/sku-map`, 'GET')).toBe('forbidden')
  })

  it.each(['pgprints', 'merchize', 'bondre', 'printway'])('%s: order readers may preview; admins and CSV Export holders may push; only admins cancel or refresh', supplier => {
    const path = `/api/fulfillment/${supplier}/orders/o1`
    expect(canCallApi('SUPPORT', ['fulfillment_orders'], `${path}/preview`, 'GET')).toBe('ok')
    expect(canCallApi('SUPPORT', ['fulfillment_export'], `${path}/preview`, 'GET')).toBe('ok')
    expect(canCallApi('SUPPORT', ['design_tasks'], `${path}/preview`, 'GET')).toBe('forbidden')
    expect(canCallApi('SUPPORT', DEFAULT_ROLE_PERMISSIONS.SUPPORT, `${path}/push`, 'POST')).toBe('ok')
    expect(canCallApi('SUPPORT', ['fulfillment_export'], `${path}/push`, 'POST')).toBe('ok')
    expect(canCallApi('SUPPORT', ['fulfillment_orders', 'design_tasks'], `${path}/push`, 'POST')).toBe('forbidden')
    expect(canCallApi('SUPPORT', DEFAULT_ROLE_PERMISSIONS.SUPPORT, `${path}/cancel`, 'POST')).toBe('forbidden')
    expect(canCallApi('SUPPORT', DEFAULT_ROLE_PERMISSIONS.SUPPORT, `${path}/refresh`, 'POST')).toBe('forbidden')
    expect(canCallApi('ADMIN', [], `${path}/preview`, 'GET')).toBe('ok')
    expect(canCallApi('ADMIN', [], `${path}/push`, 'POST')).toBe('ok')
    expect(canCallApi('ADMIN', [], `${path}/refresh`, 'POST')).toBe('ok')
    expect(canCallApi(null, [], `${path}/push`, 'POST')).toBe('unauthenticated')
  })

  it('settings writes are superadmin-only; the connection test is admin', () => {
    const perms = DEFAULT_ROLE_PERMISSIONS.ADMIN
    expect(canCallApi('ADMIN', perms, '/api/fulfillment/pgprints/settings', 'PUT')).toBe('forbidden')
    expect(canCallApi('ADMIN', perms, '/api/fulfillment/pgprints/settings', 'GET')).toBe('ok')
    expect(canCallApi('ADMIN', perms, '/api/fulfillment/pgprints/settings/test', 'POST')).toBe('ok')
    expect(canCallApi('SUPPORT', DEFAULT_ROLE_PERMISSIONS.SUPPORT, '/api/fulfillment/pgprints/settings/test', 'POST')).toBe('forbidden')
    expect(canCallApi('SUPERADMIN', [], '/api/fulfillment/pgprints/settings', 'PUT')).toBe('ok')
    expect(canCallApi('SUPPORT', ['fulfillment_suppliers'], '/api/fulfillment/pgprints/catalog', 'GET')).toBe('ok')
    expect(canCallApi('SUPPORT', ['fulfillment_orders'], '/api/fulfillment/pgprints/catalog', 'GET')).toBe('forbidden')
  })
  it('proxy and account writes and the password reveal are superadmin-only; the Resources list stays a feature read', () => {
    const admin = DEFAULT_ROLE_PERMISSIONS.ADMIN
    expect(canCallApi('ADMIN', admin, '/api/tools/resources', 'GET')).toBe('ok')
    for (const method of ['POST', 'PATCH', 'DELETE']) expect(canCallApi('ADMIN', admin, '/api/tools/resources', method)).toBe('forbidden')
    expect(canCallApi('ADMIN', admin, '/api/tools/resources/reveal', 'POST')).toBe('forbidden')
    expect(canCallApi('SUPPORT', [...DEFAULT_ROLE_PERMISSIONS.SUPPORT, 'tools_resources'], '/api/tools/resources/reveal', 'POST')).toBe('forbidden')
    expect(canCallApi('SUPERADMIN', [], '/api/tools/resources/reveal', 'POST')).toBe('ok')
    expect(canCallApi('SUPERADMIN', [], '/api/tools/resources', 'DELETE')).toBe('ok')
  })

  it('a seller reads the shared supplier list with a fulfillment feature and cannot change or open anything under it', () => {
    expect(canCallApi('SELLER', ['fulfillment_orders'], '/api/suppliers', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['projects'], '/api/suppliers', 'GET')).toBe('forbidden')
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(canCallApi('SELLER', ['fulfillment_orders', 'fulfillment_suppliers'], '/api/suppliers', method)).toBe('forbidden')
    }
    expect(canCallApi('SELLER', ['fulfillment_orders', 'fulfillment_suppliers'], '/api/suppliers/s1', 'GET')).toBe('forbidden')
  })

  it('creative tool routes follow the tools_creative permission; the token write is superadmin-only', () => {
    expect(canCallApi('ADMIN', ['tools_creative'], '/api/tools/creative/jobs', 'GET')).toBe('ok')
    expect(canCallApi('ADMIN', ['tools_creative'], '/api/tools/creative/jobs', 'POST')).toBe('ok')
    expect(canCallApi('SELLER', ['tools_creative'], '/api/tools/creative/models', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['tools_creative'], '/api/tools/creative/settings', 'GET')).toBe('ok')
    expect(canCallApi('ADMIN', ['tools_creative'], '/api/tools/creative/settings', 'POST')).toBe('forbidden')
    expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/tools/creative/jobs', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', DEFAULT_ROLE_PERMISSIONS.SELLER, '/api/tools/creative/models', 'GET')).toBe('forbidden')
    expect(canCallApi('SUPERADMIN', [], '/api/tools/creative/settings', 'POST')).toBe('ok')
  })
})

describe('seller API allow-list', () => {
  it('lists only routes that carry no store data or filter it to the stores of the seller', () => {
    expect(SELLER_API_PATHS).toEqual(['/api/auth/me', '/api/auth/logout', '/api/stores', '/api/suppliers', '/api/shopify/orders/sync', '/api/fulfillment/normalize'])
    expect(SELLER_API_PREFIXES).toEqual([
      '/api/spy',
      '/api/tools/spy-idea',
      '/api/tools/creative',
      '/api/fulfillment/crawler',
      '/api/overview',
      '/api/projects',
      '/api/shopify/db-payouts',
      '/api/shopify/payouts',
      '/api/meta/db-billing',
      '/api/meta/accounts',
      '/api/meta/reserve',
      '/api/meta/exchange-rates',
      '/api/finance/other-bills',
      '/api/marketing/niche-performance',
      '/api/marketing/niches',
      '/api/sync/daily',
      '/api/staff',
      '/api/auto-sync',
      '/api/fulfillment/orders',
      '/api/fulfillment/pl-summary',
      '/api/fulfillment/status-counts',
      '/api/fulfillment/task-fix',
      '/api/design-studio/tasks',
      '/api/design-studio/lines',
      '/api/design-studio/orders',
      '/api/design-studio/file',
      '/api/design-studio/artwork',
    ])
  })

  it('seller is denied a store-data route that is not in SELLER_API_PREFIXES even with the feature', () => {
    expect(canCallApi('SELLER', ['meta_billing'], '/api/meta/sync', 'POST')).toBe('forbidden')
    expect(canCallApi('SELLER', ['meta_billing'], '/api/meta/import', 'POST')).toBe('forbidden')
    expect(canCallApi('SELLER', ['shopify'], '/api/shopify/orders', 'GET')).toBe('forbidden')
    expect(canCallApi('SELLER', ['fulfillment_tracking'], '/api/fulfillment/tracking', 'GET')).toBe('forbidden')
    expect(canCallApi('SELLER', ['cs'], '/api/cs/tickets', 'GET')).toBe('forbidden')
  })

  it('seller reaches the order and Design Studio routes that filter by store, still only with the feature', () => {
    const orders: FeaturePermission[] = ['fulfillment_orders']
    expect(canCallApi('SELLER', orders, '/api/fulfillment/orders', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', orders, '/api/fulfillment/orders/o1/status', 'PATCH')).toBe('ok')
    expect(canCallApi('SELLER', orders, '/api/fulfillment/orders/bulk-status', 'POST')).toBe('ok')
    expect(canCallApi('SELLER', orders, '/api/fulfillment/pl-summary', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', orders, '/api/fulfillment/status-counts', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', orders, '/api/fulfillment/normalize', 'POST')).toBe('ok')
    expect(canCallApi('SELLER', orders, '/api/shopify/orders/sync', 'POST')).toBe('ok')
    expect(canCallApi('SELLER', ['need_to_fix'], '/api/fulfillment/task-fix', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['need_to_fix'], '/api/fulfillment/task-fix/fix', 'POST')).toBe('ok')
    expect(canCallApi('SELLER', ['design_tasks'], '/api/design-studio/tasks', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['design_tasks'], '/api/design-studio/tasks/K1/transition', 'POST')).toBe('ok')
    expect(canCallApi('SELLER', ['design_tasks'], '/api/design-studio/tasks/K1/artwork', 'PUT')).toBe('ok')
    expect(canCallApi('SELLER', ['design_tasks'], '/api/design-studio/orders', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['design_tasks'], '/api/design-studio/file/a1', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['design_tasks'], '/api/design-studio/artwork/a1', 'DELETE')).toBe('ok')
    expect(canCallApi('SELLER', ['design_tasks'], '/api/design-studio/lines/l1/artwork', 'POST')).toBe('ok')
    expect(canCallApi('SELLER', ['projects'], '/api/fulfillment/orders', 'GET')).toBe('forbidden')
    expect(canCallApi('SELLER', ['projects'], '/api/design-studio/tasks', 'GET')).toBe('forbidden')
  })

  it('seller stays out of the shared or all-store parts that sit beside those routes', () => {
    const all = DEFAULT_ROLE_PERMISSIONS.ADMIN
    for (const [path, method] of [
      ['/api/suppliers/products', 'GET'], ['/api/suppliers/templates', 'GET'], ['/api/suppliers/s1', 'GET'], ['/api/suppliers', 'POST'], ['/api/shopify/orders', 'GET'],
      ['/api/trello/sync', 'POST'], ['/api/trello/backfill-custom-info', 'POST'], ['/api/trello/config', 'GET'],
      ['/api/fulfillment/design-diagnose', 'GET'], ['/api/fulfillment/design-library', 'GET'], ['/api/fulfillment/export', 'POST'],
      ['/api/fulfillment/pgprints/orders/o1/preview', 'GET'], ['/api/fulfillment/pgprints/orders/o1/push', 'POST'],
      ['/api/design-studio/settings', 'GET'], ['/api/design-studio/templates', 'GET'], ['/api/design-studio/handoff', 'GET'],
      ['/api/design-studio/handoff/sheet', 'POST'], ['/api/design-studio/drive-health', 'GET'], ['/api/design-studio/products', 'GET'],
      ['/api/design-studio/library/products', 'GET'], ['/api/design-studio/external-preview', 'GET'],
    ] as const) {
      expect([path, method, canCallApi('SELLER', all, path, method)]).toEqual([path, method, 'forbidden'])
    }
  })

  it('seller is denied the store connection list, which names every store and its last error', () => {
    expect(canCallApi('SELLER', ['shopify', 'setup_store'], '/api/auth/status', 'GET')).toBe('forbidden')
  })

  it('seller allowed on a listed route with the feature, and still needs the feature', () => {
    expect(canCallApi('SELLER', ['tools_spy_idea'], '/api/spy/ads', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['tools_spy_idea'], '/api/tools/spy-idea', 'POST')).toBe('ok')
    expect(canCallApi('SELLER', ['tools_creative'], '/api/tools/creative/jobs', 'POST')).toBe('ok')
    expect(canCallApi('SELLER', ['fulfillment_crawler'], '/api/fulfillment/crawler', 'POST')).toBe('ok')
    expect(canCallApi('SELLER', ['projects'], '/api/spy/ads', 'GET')).toBe('forbidden')
    expect(canCallApi('SELLER', ['projects'], '/api/tools/creative/jobs', 'GET')).toBe('forbidden')
    expect(canCallApi('SELLER', ['projects'], '/api/fulfillment/crawler', 'POST')).toBe('forbidden')
  })

  it('seller reaches the finance routes that filter by store, still only with the feature', () => {
    expect(canCallApi('SELLER', ['overview'], '/api/overview', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['projects'], '/api/projects', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['projects'], '/api/projects/analytics', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['projects'], '/api/projects/p1/pl', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['projects'], '/api/auto-sync', 'POST')).toBe('ok')
    expect(canCallApi('SELLER', ['shopify'], '/api/shopify/db-payouts', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['shopify'], '/api/shopify/payouts/12', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['meta_billing'], '/api/meta/db-billing', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['other_bills'], '/api/finance/other-bills', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['marketing_niche'], '/api/marketing/niche-performance', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['projects'], '/api/staff', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['meta_billing'], '/api/sync/daily', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['projects'], '/api/overview', 'GET')).toBe('forbidden')
    expect(canCallApi('SELLER', ['overview'], '/api/projects', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', [], '/api/staff', 'GET')).toBe('forbidden')
  })

  it('seller keeps writes that need a setup permission it was not given, and cannot touch the superadmin parts', () => {
    expect(canCallApi('SELLER', ['projects'], '/api/projects', 'DELETE')).toBe('forbidden')
    expect(canCallApi('SELLER', ['projects'], '/api/projects/assign', 'POST')).toBe('forbidden')
    expect(canCallApi('SELLER', ['projects'], '/api/projects/seller-commission', 'GET')).toBe('forbidden')
    expect(canCallApi('SELLER', ['projects'], '/api/staff', 'POST')).toBe('forbidden')
    expect(canCallApi('SELLER', ['meta_billing'], '/api/meta/accounts', 'PATCH')).toBe('forbidden')
    expect(canCallApi('SELLER', ['meta_billing'], '/api/meta/exchange-rates', 'POST')).toBe('forbidden')
  })

  it('seller keeps its session routes and the store list, whatever its features', () => {
    expect(canCallApi('SELLER', [], '/api/auth/me', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', [], '/api/auth/logout', 'POST')).toBe('ok')
    expect(canCallApi('SELLER', [], '/api/stores', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', [], '/api/stores', 'POST')).toBe('forbidden')
    expect(canCallApi('SELLER', [], '/api/stores/abc', 'GET')).toBe('forbidden')
  })

  it('a listed prefix matches whole path segments only', () => {
    expect(canCallApi('SELLER', ['tools_spy_idea'], '/api/spying', 'GET')).toBe('forbidden')
    expect(canCallApi('SELLER', [], '/api/auth/me-too', 'GET')).toBe('forbidden')
    expect(canCallApi('SELLER', [], '/api/storesx', 'GET')).toBe('forbidden')
  })

  it('the exact paths do not open anything below them', () => {
    expect(sellerMayReach('/api/stores')).toBe(true)
    expect(sellerMayReach('/api/suppliers')).toBe(true)
    expect(sellerMayReach('/api/auth/me')).toBe(true)
    expect(sellerMayReach('/api/auth/logout')).toBe(true)
    for (const below of ['/api/stores/abc', '/api/stores/abc/settings', '/api/stores/connect', '/api/auth/me/x', '/api/auth/logout/x', '/api/stores/', '/api/suppliers/s1', '/api/suppliers/templates', '/api/suppliers/products', '/api/suppliers/']) {
      expect(sellerMayReach(below)).toBe(false)
    }
    expect(sellerMayReach('/api/projects/p1/pl')).toBe(true)
    expect(sellerMayReach('/api/spy/ads')).toBe(true)
  })

  it('seller is forbidden on /api/stores/abc/settings even if a permissive rule existed', () => {
    const permissive = { prefix: '/api/stores/', access: 'ANY' as const }
    API_ACCESS_RULES.unshift(permissive)
    try {
      expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/stores/abc/settings', 'GET')).toBe('ok')
      expect(canCallApi('SELLER', ['projects'], '/api/stores/abc/settings', 'GET')).toBe('forbidden')
      expect(canCallApi('SELLER', ['projects'], '/api/stores/connect', 'POST')).toBe('forbidden')
    } finally {
      API_ACCESS_RULES.splice(API_ACCESS_RULES.indexOf(permissive), 1)
    }
  })

  it('public routes stay reachable without a session', () => {
    expect(canCallApi(null, [], '/api/auth/login', 'POST')).toBe('ok')
    expect(canCallApi(null, [], '/api/auth/shopify/callback', 'GET')).toBe('ok')
    expect(canCallApi(null, [], '/api/stores', 'GET')).toBe('unauthenticated')
  })

  it('a role that is not one of the four known roles is forbidden everywhere except public routes', () => {
    for (const role of ['seller', 'Seller', 'ADMINISTRATOR', 'constructor', ' SELLER'] as unknown as UserRole[]) {
      expect(canCallApi(role, ['overview', 'projects'], '/api/overview', 'GET')).toBe('forbidden')
      expect(canCallApi(role, ['projects'], '/api/projects', 'GET')).toBe('forbidden')
      expect(canCallApi(role, [], '/api/stores', 'GET')).toBe('forbidden')
      expect(canCallApi(role, [], '/api/auth/me', 'GET')).toBe('forbidden')
      expect(canCallApi(role, [], '/api/auth/logout', 'POST')).toBe('forbidden')
      expect(canCallApi(role, [], '/api/does-not-exist', 'GET')).toBe('forbidden')
      expect(canCallApi(role, [], '/api/auth/login', 'POST')).toBe('ok')
    }
    expect(canCallApi('' as unknown as UserRole, [], '/api/stores', 'GET')).toBe('unauthenticated')
  })

  it('admin, support and superadmin are unaffected', () => {
    const admin = DEFAULT_ROLE_PERMISSIONS.ADMIN
    expect(canCallApi('ADMIN', admin, '/api/overview', 'GET')).toBe('ok')
    expect(canCallApi('ADMIN', admin, '/api/projects/analytics', 'GET')).toBe('ok')
    expect(canCallApi('ADMIN', admin, '/api/design-studio/orders', 'GET')).toBe('ok')
    expect(canCallApi('ADMIN', admin, '/api/stores', 'GET')).toBe('ok')
    expect(canCallApi('ADMIN', ['shopify'], '/api/auth/status', 'GET')).toBe('ok')
    const support = DEFAULT_ROLE_PERMISSIONS.SUPPORT
    expect(canCallApi('SUPPORT', support, '/api/fulfillment/orders', 'GET')).toBe('ok')
    expect(canCallApi('SUPPORT', support, '/api/cs/tickets', 'GET')).toBe('ok')
    expect(canCallApi('SUPPORT', support, '/api/stores', 'GET')).toBe('ok')
    expect(canCallApi('SUPERADMIN', [], '/api/overview', 'GET')).toBe('ok')
  })
})

describe('billing is read-only for a seller', () => {
  const EVERY_BILLING_FEATURE: FeaturePermission[] = ['meta_billing', 'other_bills', 'shopify', 'overview', 'projects', 'setup_meta', 'setup_hr', 'setup_projects']
  const OPEN_TO_SELLER_READS = ['/api/meta/db-billing', '/api/meta/reserve', '/api/meta/accounts', '/api/meta/exchange-rates', '/api/finance/other-bills', '/api/sync/daily', '/api/shopify/payouts', '/api/shopify/db-payouts', '/api/projects']
  const CLOSED_TO_SELLER = ['/api/meta/sync', '/api/meta/import', '/api/shopify/sync']

  it('lists the billing prefixes, so a new one is a deliberate change', () => {
    expect(SELLER_READ_ONLY_PREFIXES).toEqual([
      '/api/meta/sync',
      '/api/meta/import',
      '/api/meta/db-billing',
      '/api/meta/reserve',
      '/api/meta/accounts',
      '/api/meta/exchange-rates',
      '/api/finance/other-bills',
      '/api/sync/daily',
      '/api/shopify/sync',
      '/api/shopify/payouts',
      '/api/shopify/db-payouts',
      '/api/projects',
      '/api/suppliers',
    ])
  })

  it.each(SELLER_READ_ONLY_PREFIXES)('%s: a seller holding every billing feature gets forbidden on POST, PUT, PATCH and DELETE, on the path and below it', prefix => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      expect(canCallApi('SELLER', EVERY_BILLING_FEATURE, prefix, method)).toBe('forbidden')
      expect(canCallApi('SELLER', EVERY_BILLING_FEATURE, `${prefix}/x1`, method)).toBe('forbidden')
    }
  })

  it.each(OPEN_TO_SELLER_READS)('%s: the same seller still reads with GET', prefix => {
    expect(canCallApi('SELLER', EVERY_BILLING_FEATURE, prefix, 'GET')).toBe('ok')
  })

  it('the three billing routes that are not opened to a seller stay closed to reads as well', () => {
    for (const prefix of CLOSED_TO_SELLER) expect(canCallApi('SELLER', EVERY_BILLING_FEATURE, prefix, 'GET')).toBe('forbidden')
  })

  it('HEAD counts as a read where the route table has a rule for it', () => {
    expect(canCallApi('SELLER', EVERY_BILLING_FEATURE, '/api/finance/other-bills', 'HEAD')).toBe('ok')
    expect(canCallApi('SELLER', EVERY_BILLING_FEATURE, '/api/meta/db-billing', 'head')).toBe('ok')
  })

  it('is decided by the path, not by the feature: it holds even for a route the table would let through', () => {
    expect(canCallApi('SELLER', ['other_bills'], '/api/finance/other-bills/b1', 'DELETE')).toBe('forbidden')
    expect(canCallApi('SELLER', ['meta_billing'], '/api/meta/reserve', 'POST')).toBe('forbidden')
    expect(canCallApi('SELLER', ['meta_billing'], '/api/sync/daily', 'POST')).toBe('forbidden')
    expect(canCallApi('SELLER', ['shopify'], '/api/shopify/sync', 'POST')).toBe('forbidden')
  })

  it('does not touch the order sync or the routes that merely share a word with a billing prefix', () => {
    expect(canCallApi('SELLER', ['projects'], '/api/auto-sync', 'POST')).toBe('ok')
    expect(canCallApi('SELLER', ['fulfillment_orders'], '/api/shopify/orders/sync', 'POST')).toBe('ok')
    expect(canCallApi('SELLER', ['meta_billing'], '/api/meta/syncing', 'POST')).toBe('forbidden')
    expect(canCallApi('SELLER', ['projects'], '/api/projectsx', 'GET')).toBe('forbidden')
  })

  it('a seller reads every project route with GET but writes nothing under /api/projects: no month close, no backfill', () => {
    for (const path of ['/api/projects', '/api/projects/analytics', '/api/projects/profit-chart', '/api/projects/p1/pl', '/api/projects/p1/snapshots']) {
      expect([path, canCallApi('SELLER', ['projects'], path, 'GET')]).toEqual([path, 'ok'])
    }
    for (const [path, method] of [
      ['/api/projects/p1/snapshot', 'POST'], ['/api/projects/p1/snapshots', 'PATCH'], ['/api/projects/snapshot/backfill', 'POST'],
      ['/api/projects', 'POST'], ['/api/projects', 'PATCH'], ['/api/projects', 'DELETE'], ['/api/projects/assign', 'POST'],
    ] as const) {
      expect([path, method, canCallApi('SELLER', EVERY_BILLING_FEATURE, path, method)]).toEqual([path, method, 'forbidden'])
    }
    expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/projects/snapshot/backfill', 'POST')).toBe('ok')
    expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/projects/p1/snapshot', 'POST')).toBe('ok')
    expect(canCallApi('SUPERADMIN', [], '/api/projects/p1/snapshots', 'PATCH')).toBe('ok')
  })

  it('admin, super admin and support are unchanged', () => {
    const features: FeaturePermission[] = ['meta_billing', 'other_bills', 'shopify', 'overview']
    for (const method of ['POST', 'DELETE']) {
      expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/finance/other-bills', method)).toBe('ok')
      expect(canCallApi('SUPPORT', features, '/api/finance/other-bills', method)).toBe('ok')
      expect(canCallApi('SUPERADMIN', [], '/api/meta/import', method)).toBe('ok')
    }
    expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/meta/sync', 'POST')).toBe('ok')
    expect(canCallApi('SUPPORT', features, '/api/meta/reserve', 'POST')).toBe('ok')
    expect(canCallApi('SUPPORT', features, '/api/sync/daily', 'POST')).toBe('ok')
    expect(canCallApi('SUPPORT', features, '/api/meta/sync', 'GET')).toBe('ok')
  })
})
