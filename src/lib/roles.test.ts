import { describe, expect, it } from 'vitest'
import { DEFAULT_ROLE_PERMISSIONS, canAccess, homePathFor, visibleFor } from './roles'
import type { FeaturePermission, UserRole } from './roles'

const can = (role: UserRole, path: string, features: FeaturePermission[]) => canAccess(role, path, features)

describe('canAccess picks the feature whose configured path is the longest prefix of the page', () => {
  it('Orders & P/L opens /fulfillment/orders and /orders without Fulfillment Dashboard', () => {
    expect(can('SELLER', '/fulfillment/orders', ['fulfillment_orders'])).toBe(true)
    expect(can('SELLER', '/orders', ['fulfillment_orders'])).toBe(true)
    expect(can('SELLER', '/fulfillment', ['fulfillment_orders'])).toBe(false)
  })

  it('Product Crawler opens /fulfillment/crawler without Fulfillment Dashboard', () => {
    expect(can('SELLER', '/fulfillment/crawler', ['fulfillment_crawler'])).toBe(true)
    expect(can('SELLER', '/fulfillment', ['fulfillment_crawler'])).toBe(false)
    expect(can('SELLER', '/fulfillment/orders', ['fulfillment_crawler'])).toBe(false)
  })

  it('Fulfillment Dashboard opens its own pages and nothing that has a feature of its own', () => {
    const dashboard: FeaturePermission[] = ['fulfillment_dashboard']
    expect(can('SUPPORT', '/fulfillment', dashboard)).toBe(true)
    expect(can('SUPPORT', '/finance/fulfillment', dashboard)).toBe(true)
    expect(can('SUPPORT', '/fulfillment/auto-fulfill', dashboard)).toBe(true)
    for (const owned of ['/fulfillment/orders', '/fulfillment/crawler', '/fulfillment/export', '/fulfillment/suppliers', '/fulfillment/mapping', '/fulfillment/tracking', '/fulfillment/design-library']) {
      expect([owned, can('SUPPORT', owned, dashboard)]).toEqual([owned, false])
    }
  })

  it('/orders/export belongs to CSV Export, not to Orders & P/L', () => {
    expect(can('SELLER', '/orders/export', ['fulfillment_orders'])).toBe(false)
    expect(can('SELLER', '/orders/export', ['fulfillment_export'])).toBe(true)
    expect(can('SELLER', '/orders/export', ['fulfillment_orders', 'fulfillment_export'])).toBe(true)
    expect(can('SELLER', '/orders', ['fulfillment_export'])).toBe(false)
    expect(can('SELLER', '/fulfillment/export', ['fulfillment_export'])).toBe(true)
    expect(can('SELLER', '/fulfillment/export', ['fulfillment_orders'])).toBe(false)
  })

  it('sub-pages go to the feature of their section', () => {
    expect(can('SUPPORT', '/fulfillment/suppliers/s1/templates', ['fulfillment_suppliers'])).toBe(true)
    expect(can('SUPPORT', '/setup/suppliers/s1/print-templates', ['fulfillment_suppliers'])).toBe(true)
    expect(can('SUPPORT', '/setup/suppliers/s1', ['setup_store'])).toBe(false)
    expect(can('SUPPORT', '/fulfillment/design-library', ['fulfillment_design_library'])).toBe(true)
    expect(can('SUPPORT', '/design-studio/library/fonts', ['design_tasks'])).toBe(true)
    expect(can('SUPPORT', '/design-studio', ['fulfillment_design_library'])).toBe(false)
    expect(can('SUPPORT', '/cs/cases', ['cs'])).toBe(true)
    expect(can('SELLER', '/tools/spy-idea/ads/a1', ['tools_spy_idea'])).toBe(true)
    expect(can('SELLER', '/projects/seller-profit', ['projects'])).toBe(true)
  })

  it('the Setup pages keep to their own features, and a page that shares a word with one still resolves to it', () => {
    expect(can('ADMIN', '/setup', ['setup_store'])).toBe(true)
    expect(can('ADMIN', '/setup/users', ['setup_store'])).toBe(false)
    expect(can('ADMIN', '/setup/users', ['setup_users'])).toBe(true)
    expect(can('ADMIN', '/setup/meta', ['setup_store'])).toBe(false)
    expect(can('ADMIN', '/setup/meta-rates', ['setup_meta'])).toBe(true)
    expect(can('ADMIN', '/setup/meta-rates', ['setup_store'])).toBe(false)
    expect(can('ADMIN', '/setup/hr', ['setup_hr'])).toBe(true)
    expect(can('ADMIN', '/setup/projects', ['setup_projects'])).toBe(true)
  })

  it('the Overview feature opens only the home page, and a page with no feature is closed', () => {
    expect(can('SELLER', '/', ['overview'])).toBe(true)
    expect(can('SELLER', '/shopify', ['overview'])).toBe(false)
    expect(can('SELLER', '/nowhere', ['overview'])).toBe(false)
  })

  it('a super admin opens everything and an empty list opens nothing', () => {
    expect(canAccess('SUPERADMIN', '/setup/users', [])).toBe(true)
    expect(can('ADMIN', '/fulfillment/orders', [])).toBe(false)
  })

  it('the default permissions of a role are used when none are passed', () => {
    expect(canAccess('SUPPORT', '/fulfillment/orders')).toBe(true)
    expect(canAccess('SELLER', '/fulfillment/orders')).toBe(false)
    expect(visibleFor('SUPPORT', '/orders/export')).toBe(true)
  })
})

type Account = { role: UserRole; features: FeaturePermission[]; opens: string[]; closed: string[] }

// The production accounts: what each one opens among the pages that exist, by feature set.
const ACCOUNTS: Record<string, Account> = {
  'ADMIN A.H': {
    role: 'ADMIN',
    features: ['overview', 'shopify', 'meta_billing', 'other_bills', 'fulfillment_dashboard', 'fulfillment_crawler', 'fulfillment_orders', 'fulfillment_export', 'fulfillment_suppliers', 'fulfillment_mapping', 'tools_spy_idea', 'tools_resources', 'projects', 'setup_store', 'setup_meta', 'setup_projects', 'setup_hr', 'fulfillment_tracking', 'fulfillment_design_library', 'need_to_fix', 'cs'],
    opens: ['/', '/fulfillment', '/fulfillment/orders', '/fulfillment/crawler', '/fulfillment/export', '/orders', '/orders/export', '/setup', '/setup/meta-rates', '/setup/suppliers/s1', '/cs/cases', '/task-fix'],
    closed: ['/setup/users', '/design-studio', '/marketing/niche-performance', '/tools/creative'],
  },
  'SELLER Nghia': {
    role: 'SELLER',
    features: ['projects', 'overview', 'meta_billing', 'other_bills', 'fulfillment_orders', 'tools_spy_idea', 'fulfillment_crawler', 'need_to_fix', 'marketing_niche', 'tools_creative'],
    opens: ['/', '/projects', '/finance/meta', '/finance/other-bills', '/fulfillment/orders', '/fulfillment/crawler', '/orders', '/task-fix', '/marketing/niche-performance', '/tools/spy-idea', '/tools/creative'],
    closed: ['/fulfillment', '/orders/export', '/fulfillment/export', '/shopify', '/setup', '/cs'],
  },
  'SELLER Tùng': {
    role: 'SELLER',
    features: ['tools_spy_idea'],
    opens: ['/tools/spy-idea', '/tools/spy-idea/niches'],
    closed: ['/', '/projects', '/orders', '/fulfillment/orders'],
  },
  'SUPPORT Huong': {
    role: 'SUPPORT',
    features: ['design_tasks', 'fulfillment_design_library', 'cs'],
    opens: ['/design-studio', '/design-studio/dashboard', '/fulfillment/design-library', '/cs'],
    closed: ['/fulfillment', '/fulfillment/orders', '/orders/export'],
  },
  'SUPPORT Huyền': {
    role: 'SUPPORT',
    features: ['fulfillment_tracking', 'cs'],
    opens: ['/fulfillment/tracking', '/cs'],
    closed: ['/fulfillment', '/fulfillment/orders', '/design-studio'],
  },
  'SUPPORT Trang': {
    role: 'SUPPORT',
    features: ['other_bills', 'fulfillment_dashboard', 'fulfillment_crawler', 'fulfillment_orders', 'fulfillment_export', 'fulfillment_suppliers', 'fulfillment_mapping', 'fulfillment_tracking', 'fulfillment_design_library', 'need_to_fix', 'design_tasks', 'cs'],
    opens: ['/fulfillment', '/fulfillment/orders', '/fulfillment/crawler', '/fulfillment/export', '/orders', '/orders/export', '/fulfillment/suppliers/s1/templates', '/design-studio', '/finance/other-bills'],
    closed: ['/', '/projects', '/setup', '/shopify'],
  },
}

describe('production accounts', () => {
  it.each(Object.entries(ACCOUNTS))('%s opens what its features give and nothing else', (_name, account) => {
    for (const path of account.opens) expect([path, can(account.role, path, account.features)]).toEqual([path, true])
    for (const path of account.closed) expect([path, can(account.role, path, account.features)]).toEqual([path, false])
  })

  it('each account lands on a page it can open', () => {
    for (const account of Object.values(ACCOUNTS)) {
      const home = homePathFor(account.role, account.features)
      expect(home).not.toBeNull()
      expect(can(account.role, home as string, account.features)).toBe(true)
    }
  })

  it('every default feature of a role opens at least the first page of that feature', () => {
    for (const role of ['ADMIN', 'SELLER', 'SUPPORT'] as const) {
      for (const feature of DEFAULT_ROLE_PERMISSIONS[role]) {
        expect(homePathFor(role, [feature])).not.toBeNull()
        expect(can(role, homePathFor(role, [feature]) as string, [feature])).toBe(true)
      }
    }
  })
})
