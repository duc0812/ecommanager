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
