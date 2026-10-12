import { describe, expect, it } from 'vitest'
import { canCallApi } from './api-access'
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

  it('seller can use project APIs and the shared project list', () => {
    const perms = DEFAULT_ROLE_PERMISSIONS.SELLER
    expect(canCallApi('SELLER', perms, '/api/projects', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', perms, '/api/projects/analytics', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', perms, '/api/auto-sync', 'POST')).toBe('ok')
    expect(canCallApi('SELLER', perms, '/api/projects', 'POST')).toBe('forbidden')
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
    expect(canCallApi('SELLER', ['design_tasks'], '/api/fulfillment/suppliers/s1/print-templates', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['design_tasks'], '/api/fulfillment/suppliers/s1/print-templates', 'POST')).toBe('forbidden')
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

  it('order readers may preview; admins and CSV Export holders may push; only admins cancel or refresh', () => {
    const path = '/api/fulfillment/pgprints/orders/o1'
    expect(canCallApi('SUPPORT', ['fulfillment_orders'], `${path}/preview`, 'GET')).toBe('ok')
    expect(canCallApi('SUPPORT', ['fulfillment_export'], `${path}/preview`, 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['design_tasks'], `${path}/preview`, 'GET')).toBe('forbidden')
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
    expect(canCallApi('SELLER', ['fulfillment_suppliers'], '/api/fulfillment/pgprints/catalog', 'GET')).toBe('ok')
    expect(canCallApi('SELLER', ['fulfillment_orders'], '/api/fulfillment/pgprints/catalog', 'GET')).toBe('forbidden')
  })
})
