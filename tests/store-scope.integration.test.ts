import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import type { AuthUser } from '@/lib/api-auth'
import type { FeaturePermission, UserRole } from '@/lib/roles'
import { saveStoreCredential } from '@/lib/store-connections'
import {
  projectIdsOf, requireOrderInScope, requireStoreFilter, requireStoreInScope, storeScopeFor, storeWhere,
} from '@/lib/store-scope'
import { GET as listStores } from '@/app/api/stores/route'

const SHOP_A = 'ss-a.myshopify.com'
const SHOP_B = 'ss-b.myshopify.com'
const SHOP_C = 'ss-c.myshopify.com'
const PROJECT_A = 'ss-project-a'
const PROJECT_B = 'ss-project-b'
const ORDER_A = 'ss-order-a'
const ORDER_B = 'ss-order-b'
const EMAILS = ['ss-super@test.local', 'ss-admin@test.local', 'ss-support@test.local', 'ss-seller-a@test.local', 'ss-seller-none@test.local', 'ss-seller-ab@test.local', 'ss-lower@test.local']
const SECRET = 'ss-client-secret-value'
const TOKEN = 'shpat_ss_access_token_value'
const LAST_ERROR = 'ss-last-error-text-that-names-a-token'

let storeA = ''
let storeB = ''
let storeC = ''
const users: Record<string, AuthUser> = {}
const tokens: Record<string, string> = {}

function request(path: string, who: string | null) {
  return new NextRequest(`http://localhost${path}`, {
    headers: who ? { cookie: `${AUTH_COOKIE}=${tokens[who]}` } : {},
  })
}

async function makeUser(key: string, email: string, role: string, permissions: FeaturePermission[], stores: string[] = []) {
  const row = await prisma.appUser.create({
    data: { name: key, email, role, permissions: JSON.stringify(permissions), storeAccess: { create: stores.map(storeId => ({ storeId })) } },
  })
  users[key] = { id: row.id, email, name: key, role: role as UserRole, permissions, tokenVersion: row.tokenVersion }
  tokens[key] = await signToken({ userId: row.id, email, name: key, role: role as UserRole, permissions, tv: row.tokenVersion })
}

async function cleanup() {
  await prisma.order.deleteMany({ where: { id: { in: [ORDER_A, ORDER_B] } } })
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  const stores = await prisma.shopifyStore.findMany({ where: { shop: { in: [SHOP_A, SHOP_B, SHOP_C] } }, select: { id: true } })
  await prisma.shopifyStore.deleteMany({ where: { id: { in: stores.map(s => s.id) } } })
  await prisma.project.deleteMany({ where: { id: { in: [PROJECT_A, PROJECT_B] } } })
}

const order = (id: string, storeId: string, projectId: string, number: string) => prisma.order.create({ data: {
  id, storeId, projectId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD',
  grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-05T12:00:00Z'),
} })

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await cleanup()
  await prisma.project.create({ data: { id: PROJECT_A, name: 'SS Alpha', startDate: new Date('2026-01-01') } })
  await prisma.project.create({ data: { id: PROJECT_B, name: 'SS Beta', startDate: new Date('2026-01-01') } })
  storeA = (await prisma.shopifyStore.create({ data: { shop: SHOP_A, orderPrefix: 'SSA', projectId: PROJECT_A, lastError: LAST_ERROR, lastErrorAt: new Date() } })).id
  storeB = (await prisma.shopifyStore.create({ data: { shop: SHOP_B, orderPrefix: 'SSB', projectId: PROJECT_B } })).id
  storeC = (await prisma.shopifyStore.create({ data: { shop: SHOP_C } })).id
  await saveStoreCredential(storeA, { authMode: 'CLIENT_CREDENTIALS', clientId: 'ss-client-id', clientSecret: SECRET, accessToken: TOKEN, tokenExpiresAt: new Date(Date.now() + 86_400_000) })
  await saveStoreCredential(storeB, { authMode: 'TOKEN', accessToken: TOKEN })
  await order(ORDER_A, storeA, PROJECT_A, '#SSA1')
  await order(ORDER_B, storeB, PROJECT_B, '#SSB1')
  await makeUser('super', EMAILS[0], 'SUPERADMIN', ['overview'])
  await makeUser('admin', EMAILS[1], 'ADMIN', ['overview'])
  await makeUser('support', EMAILS[2], 'SUPPORT', ['cs', 'fulfillment_orders'])
  await makeUser('sellerA', EMAILS[3], 'SELLER', ['projects'], [storeA])
  await makeUser('sellerNone', EMAILS[4], 'SELLER', ['projects'])
  await makeUser('sellerAB', EMAILS[5], 'SELLER', ['projects'], [storeA, storeB])
  await makeUser('lowercase', EMAILS[6], 'seller', ['projects', 'overview'], [storeA])
})

afterAll(async () => { await cleanup() })

describe('storeScopeFor', () => {
  it('seller scope is exactly the assigned stores', async () => {
    expect(await storeScopeFor(users.sellerA)).toEqual({ all: false, storeIds: [storeA] })
    const both = await storeScopeFor(users.sellerAB)
    expect(both.all).toBe(false)
    expect('storeIds' in both && [...both.storeIds].sort()).toEqual([storeA, storeB].sort())
  })

  it('a seller is limited in every feature, design and tracking included', async () => {
    const seller = { ...users.sellerA, permissions: ['design_tasks', 'fulfillment_tracking', 'cs'] as FeaturePermission[] }
    expect(await storeScopeFor(seller, 'design_tasks')).toEqual({ all: false, storeIds: [storeA] })
    expect(await storeScopeFor(seller, 'fulfillment_tracking')).toEqual({ all: false, storeIds: [storeA] })
    expect(await storeScopeFor(seller, 'cs')).toEqual({ all: false, storeIds: [storeA] })
  })

  it('admin and superadmin see all', async () => {
    expect(await storeScopeFor(users.admin)).toEqual({ all: true })
    expect(await storeScopeFor(users.super)).toEqual({ all: true })
  })

  it('support sees all, cs included until stage 6', async () => {
    expect(await storeScopeFor(users.support)).toEqual({ all: true })
    expect(await storeScopeFor(users.support, 'cs')).toEqual({ all: true })
  })

  it('a role that is not one of the four known roles gets an empty scope, whatever rows it has', async () => {
    expect(await storeScopeFor(users.lowercase)).toEqual({ all: false, storeIds: [] })
    for (const role of ['Seller', '', 'owner', 'constructor']) {
      expect(await storeScopeFor({ ...users.sellerAB, role: role as UserRole })).toEqual({ all: false, storeIds: [] })
    }
  })

  it('a lowercase seller role is refused on an ANY route and on a store-data route', async () => {
    const list = await listStores(request('/api/stores', 'lowercase'))
    expect(list.status).toBe(403)
    const filter = await requireStoreFilter(request(`/api/overview?storeId=${storeA}`, 'lowercase'))
    expect('error' in filter && filter.error.status).toBe(403)
    const order = await requireOrderInScope(request('/api/stores', 'lowercase'), ORDER_A)
    expect('error' in order && order.error.status).toBe(403)
  })

  it('seller with no store gets an empty list', async () => {
    const scope = await storeScopeFor(users.sellerNone)
    expect(scope).toEqual({ all: false, storeIds: [] })
    expect(storeWhere([])).toEqual({ storeId: { in: [] } })
    expect(await prisma.order.findMany({ where: storeWhere([]) })).toEqual([])
  })
})

describe('storeWhere and projectIdsOf', () => {
  it('null means no filter, a list means those stores', async () => {
    expect(storeWhere(null)).toEqual({})
    expect(storeWhere([storeA])).toEqual({ storeId: { in: [storeA] } })
    const rows = await prisma.order.findMany({ where: { ...storeWhere([storeA]), id: { in: [ORDER_A, ORDER_B] } } })
    expect(rows.map(r => r.id)).toEqual([ORDER_A])
  })

  it('only null means no filter: undefined behaves like an empty list', async () => {
    const undefinedList = undefined as unknown as string[]
    expect(storeWhere(undefinedList)).toEqual({ storeId: { in: [] } })
    expect(await prisma.order.findMany({ where: { ...storeWhere(undefinedList), id: { in: [ORDER_A, ORDER_B] } } })).toEqual([])
  })

  it('projectIdsOf gives the project of each store that has one', async () => {
    expect((await projectIdsOf([storeA, storeB, storeC])).sort()).toEqual([PROJECT_A, PROJECT_B])
    expect(await projectIdsOf([storeC])).toEqual([])
    expect(await projectIdsOf([])).toEqual([])
  })
})

describe('requireStoreFilter', () => {
  const ok = (r: Awaited<ReturnType<typeof requireStoreFilter>>) => {
    if ('error' in r) throw new Error(`unexpected ${r.error.status}`)
    return r
  }

  it('?storeId of an unassigned store is 403', async () => {
    const r = await requireStoreFilter(request(`/api/stores?storeId=${storeB}`, 'sellerA'))
    expect('error' in r && r.error.status).toBe(403)
    const none = await requireStoreFilter(request(`/api/stores?storeId=${storeA}`, 'sellerNone'))
    expect('error' in none && none.error.status).toBe(403)
  })

  it('?storeId of an assigned store narrows to it', async () => {
    expect(ok(await requireStoreFilter(request(`/api/stores?storeId=${storeB}`, 'sellerAB'))).storeIds).toEqual([storeB])
    expect(ok(await requireStoreFilter(request(`/api/stores?storeId=${storeA}`, 'sellerA'))).storeIds).toEqual([storeA])
  })

  it('with no storeId a seller gets the assigned list and ?storeId=all does the same', async () => {
    const none = ok(await requireStoreFilter(request('/api/stores', 'sellerNone')))
    expect(none.storeIds).toEqual([])
    expect(ok(await requireStoreFilter(request('/api/stores', 'sellerA'))).storeIds).toEqual([storeA])
    expect(ok(await requireStoreFilter(request('/api/stores?storeId=all', 'sellerA'))).storeIds).toEqual([storeA])
    expect(ok(await requireStoreFilter(request('/api/stores?storeId=', 'sellerA'))).storeIds).toEqual([storeA])
    expect([...ok(await requireStoreFilter(request('/api/stores', 'sellerAB'))).storeIds!].sort()).toEqual([storeA, storeB].sort())
  })

  it('?storeId=all for admin gives null, so no filter', async () => {
    expect(ok(await requireStoreFilter(request('/api/stores?storeId=all', 'admin'))).storeIds).toBeNull()
    expect(ok(await requireStoreFilter(request('/api/stores', 'admin'))).storeIds).toBeNull()
    expect(ok(await requireStoreFilter(request('/api/stores', 'super'))).storeIds).toBeNull()
    expect(ok(await requireStoreFilter(request('/api/stores', 'support'), 'cs')).storeIds).toBeNull()
  })

  it('an admin may narrow to any one store', async () => {
    const r = ok(await requireStoreFilter(request(`/api/stores?storeId=${storeB}`, 'admin')))
    expect(r.storeIds).toEqual([storeB])
    expect(r.user.id).toBe(users.admin.id)
  })

  it('no session is 401', async () => {
    const r = await requireStoreFilter(request('/api/stores', null))
    expect('error' in r && r.error.status).toBe(401)
  })

  it('goes through the API rules: a seller is 403 on a route that is not on its list', async () => {
    const r = await requireStoreFilter(request(`/api/overview?storeId=${storeA}`, 'sellerA'))
    expect('error' in r && r.error.status).toBe(403)
  })
})

describe('requireOrderInScope', () => {
  it('answers a seller 404 for another store\'s order and for a missing order, with the same body', async () => {
    const other = await requireOrderInScope(request('/api/stores', 'sellerA'), ORDER_B)
    const missing = await requireOrderInScope(request('/api/stores', 'sellerA'), 'ss-no-such-order')
    if (!('error' in other) || !('error' in missing)) throw new Error('a seller must not pass')
    expect(other.error.status).toBe(404)
    expect(missing.error.status).toBe(404)
    expect(await other.error.json()).toEqual(await missing.error.json())
    const none = await requireOrderInScope(request('/api/stores', 'sellerNone'), ORDER_A)
    expect('error' in none && none.error.status).toBe(404)
  })

  it('answers a missing order 404 for admin, which sees every store', async () => {
    const adminMissing = await requireOrderInScope(request('/api/stores', 'admin'), 'ss-no-such-order')
    expect('error' in adminMissing && adminMissing.error.status).toBe(404)
  })

  it('lets a seller through to an order of an assigned store, and an admin to any', async () => {
    const own = await requireOrderInScope(request('/api/stores', 'sellerA'), ORDER_A)
    expect('user' in own && own.user.id).toBe(users.sellerA.id)
    const both = await requireOrderInScope(request('/api/stores', 'sellerAB'), ORDER_B)
    expect('user' in both).toBe(true)
    const admin = await requireOrderInScope(request('/api/stores', 'admin'), ORDER_B)
    expect('user' in admin).toBe(true)
    const support = await requireOrderInScope(request('/api/stores', 'support'), ORDER_B)
    expect('user' in support).toBe(true)
  })

  it('no session is 401', async () => {
    const r = await requireOrderInScope(request('/api/stores', null), ORDER_A)
    expect('error' in r && r.error.status).toBe(401)
  })
})

describe('requireStoreInScope', () => {
  it('rejects an unassigned store with 403 and accepts an assigned one', async () => {
    const other = await requireStoreInScope(request('/api/stores', 'sellerA'), storeB)
    expect('error' in other && other.error.status).toBe(403)
    const none = await requireStoreInScope(request('/api/stores', 'sellerNone'), storeA)
    expect('error' in none && none.error.status).toBe(403)
    const own = await requireStoreInScope(request('/api/stores', 'sellerA'), storeA)
    expect('user' in own && own.user.id).toBe(users.sellerA.id)
  })

  it('lets admin and support reach any store, and refuses no session', async () => {
    expect('user' in await requireStoreInScope(request('/api/stores', 'admin'), storeB)).toBe(true)
    expect('user' in await requireStoreInScope(request('/api/stores', 'support'), storeB)).toBe(true)
    const r = await requireStoreInScope(request('/api/stores', null), storeA)
    expect('error' in r && r.error.status).toBe(401)
  })
})

describe('GET /api/stores', () => {
  const mine = (list: { shop: string }[]) => list.filter(s => [SHOP_A, SHOP_B, SHOP_C].includes(s.shop))

  it('returns only the stores the caller may see', async () => {
    const seller = await (await listStores(request('/api/stores', 'sellerA'))).json()
    expect(seller.stores.map((s: { shop: string }) => s.shop)).toEqual([SHOP_A])
    const none = await (await listStores(request('/api/stores', 'sellerNone'))).json()
    expect(none.stores).toEqual([])
    const admin = await (await listStores(request('/api/stores', 'admin'))).json()
    expect(mine(admin.stores).map((s: { shop: string }) => s.shop).sort()).toEqual([SHOP_A, SHOP_B, SHOP_C])
    const support = await (await listStores(request('/api/stores', 'support'))).json()
    expect(mine(support.stores)).toHaveLength(3)
  })

  it('names a store by its project and falls back to the shop', async () => {
    const admin = await (await listStores(request('/api/stores', 'admin'))).json()
    const byShop = Object.fromEntries(mine(admin.stores).map((s: { shop: string }) => [s.shop, s]))
    expect(byShop[SHOP_A]).toEqual({ id: storeA, shop: SHOP_A, name: 'SS Alpha', orderPrefix: 'SSA' })
    expect(byShop[SHOP_C]).toEqual({ id: storeC, shop: SHOP_C, name: SHOP_C, orderPrefix: null })
  })

  it('GET /api/stores never returns credential fields', async () => {
    for (const who of ['admin', 'super', 'support', 'sellerAB']) {
      const text = await (await listStores(request('/api/stores', who))).text()
      for (const secret of [SECRET, TOKEN, 'ss-client-id', LAST_ERROR]) expect(text).not.toContain(secret)
      for (const field of ['clientSecret', 'clientId', 'accessToken', 'credential', 'lastError', 'authMode', 'tokenExpiresAt']) expect(text).not.toContain(field)
      for (const s of JSON.parse(text).stores) expect(Object.keys(s).sort()).toEqual(['id', 'name', 'orderPrefix', 'shop'])
    }
  })

  it('refuses a request without a session', async () => {
    expect((await listStores(request('/api/stores', null))).status).toBe(401)
  })
})
