import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { getStoreConnection, saveStoreCredential } from '@/lib/store-connections'
import { saveOAuthState } from '@/lib/token-store'
import { DEFAULT_ROLE_PERMISSIONS, type FeaturePermission, type UserRole } from '@/lib/roles'
import { POST as connectRoute } from '@/app/api/stores/connect/route'
import { PATCH as patchStore } from '@/app/api/stores/[id]/route'
import { GET as listStores } from '@/app/api/stores/route'
import { GET as getStatus, DELETE as deleteStatus } from '@/app/api/auth/status/route'
import { GET as oauthCallback } from '@/app/api/auth/shopify/callback/route'
import { GET as startOAuth } from '@/app/api/auth/shopify/route'
import { POST as syncOrders } from '@/app/api/shopify/orders/sync/route'

const CLIENT_ID = 'test-client-id-abc123'
const SECRET = 'test-secret-xyz'
const PASTED = 'test-pasted-token-777'
const MINTED = 'shpat_test_minted_001'
const OTHER_SECRET = 'test-other-store-secret-555'
const OTHER_TOKEN = 'test-other-store-token-555'
const OLD_TOKEN = 'test-old-token-888'
const STALE = 'shpat_test_stale_001'
const REPLACED_ID = 'test-replaced-id-444'
const REPLACED_SECRET = 'test-replaced-secret-444'
const ALL_SECRETS = [CLIENT_ID, SECRET, PASTED, MINTED, OTHER_SECRET, OTHER_TOKEN, 'test-other-client-555', OLD_TOKEN, STALE, REPLACED_ID, REPLACED_SECRET]

const shopOf = (key: string) => `sct-${key}.myshopify.com`
const EMAILS = ['super', 'admin', 'support', 'seller'].map(k => `sct-${k}@test.local`)
const tokens: Record<string, string> = {}
const realFetch = global.fetch
let calls: Array<{ url: string; init: RequestInit }> = []
let mintReply: () => Response | Promise<Response>
let graphReply: () => Response | Promise<Response>
let errorSpy: ReturnType<typeof vi.spyOn>

const json = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const mintOk = (token = MINTED) => json(200, { access_token: token, expires_in: 86399 })

function snapshot(over: { name?: string; tz?: string | null; scopes?: string[] | null; orders?: string[] } = {}) {
  const { name = 'Sct Shop', tz = 'America/New_York', scopes = ['read_orders', 'read_products'], orders = ['#SCTNEW1010'] } = over
  return json(200, { data: {
    shop: { name, ianaTimezone: tz },
    currentAppInstallation: scopes ? { accessScopes: scopes.map(handle => ({ handle })) } : null,
    orders: { nodes: orders.map(n => ({ name: n })) },
  } })
}

function installFetch() {
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    calls.push({ url: href, init: init ?? {} })
    if (href.includes('/admin/oauth/access_token')) return mintReply()
    if (href.includes('/graphql.json')) return graphReply()
    throw new Error(`unexpected fetch ${href}`)
  }) as unknown as typeof fetch
}

const mintCalls = () => calls.filter(c => c.url.includes('/admin/oauth/access_token'))
const graphCalls = () => calls.filter(c => c.url.includes('/graphql.json'))

function request(url: string, who: string | null, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {}
  if (who) headers.cookie = `${AUTH_COOKIE}=${tokens[who]}`
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
}

// Every answer of these helpers, 4xx and 5xx included, is checked for the fake secrets.
async function connect(body: unknown, who: string | null = 'super') {
  const res = await connectRoute(request('/api/stores/connect', who, { method: 'POST', body }))
  const text = await res.text()
  expectNoSecrets(text)
  return { status: res.status, text, body: JSON.parse(text || 'null') as any }
}

async function patch(id: string, body: unknown, who: string | null = 'super') {
  const res = await patchStore(request(`/api/stores/${id}`, who, { method: 'PATCH', body }), { params: { id } })
  const text = await res.text()
  expectNoSecrets(text)
  return { status: res.status, text, body: JSON.parse(text || 'null') as any }
}

async function disconnect(storeId: string) {
  const res = await deleteStatus(request(`/api/auth/status?storeId=${storeId}`, 'super', { method: 'DELETE' }))
  expect(res.status).toBe(200)
}

function callbackRequest(shop: string, state: string, secret: string) {
  const params: Record<string, string> = { code: 'code-1', shop, state, timestamp: '1700000000' }
  const message = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&')
  const hmac = crypto.createHmac('sha256', secret).update(message).digest('hex')
  return new NextRequest(`http://localhost/api/auth/shopify/callback?${new URLSearchParams({ ...params, hmac })}`)
}

const scopesOf = async (storeId: string) => (await prisma.appSetting.findUnique({ where: { key: `store.scopes.${storeId}` } }))?.value ?? null

const ccBody = (key: string, extra: Record<string, unknown> = {}) => ({ shop: shopOf(key), clientId: CLIENT_ID, clientSecret: SECRET, ...extra })
const storeOf = (key: string) => prisma.shopifyStore.findUnique({ where: { shop: shopOf(key) }, include: { credential: true, project: true } })
const projectsMade = () => prisma.project.count({ where: { name: { startsWith: 'SCT ' } } })

function expectNoSecrets(text: string) {
  for (const secret of ALL_SECRETS) expect(text).not.toContain(secret)
}

async function makeUser(key: string, role: UserRole, permissions: FeaturePermission[]) {
  const email = `sct-${key}@test.local`
  const row = await prisma.appUser.create({ data: { name: key, email, role, permissions: JSON.stringify(permissions) } })
  tokens[key] = await signToken({ userId: row.id, email, name: key, role, permissions, tv: row.tokenVersion })
}

async function cleanup() {
  const stores = await prisma.shopifyStore.findMany({ where: { shop: { startsWith: 'sct-' } }, select: { id: true } })
  await prisma.appSetting.deleteMany({ where: { key: { in: stores.map(s => `store.scopes.${s.id}`) } } })
  await prisma.shopifyStore.deleteMany({ where: { shop: { startsWith: 'sct-' } } })
  await prisma.project.deleteMany({ where: { name: { startsWith: 'SCT ' } } })
}

beforeAll(async () => {
  process.env.AUTH_SECRET ||= 'test-secret-that-is-long-enough-32chars'
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  await cleanup()
  await makeUser('super', 'SUPERADMIN', DEFAULT_ROLE_PERMISSIONS.SUPERADMIN)
  await makeUser('admin', 'ADMIN', [...DEFAULT_ROLE_PERMISSIONS.ADMIN, 'setup_store'])
  await makeUser('support', 'SUPPORT', DEFAULT_ROLE_PERMISSIONS.SUPPORT)
  await makeUser('seller', 'SELLER', ['fulfillment_orders'])
})

beforeEach(() => {
  calls = []
  mintReply = () => mintOk()
  graphReply = () => snapshot()
  installFetch()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  const logged = JSON.stringify(errorSpy.mock.calls.map((args: unknown[]) => args.map((a: unknown) => (a instanceof Error ? a.message : String(a)))))
  errorSpy.mockRestore()
  global.fetch = realFetch
  try {
    for (const secret of ALL_SECRETS) expect(logged).not.toContain(secret)
  } finally {
    await cleanup()
  }
})

afterAll(async () => {
  await cleanup()
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
})

describe('POST /api/stores/connect: client credentials', () => {
  it('saves the token, timezone, prefix and links the project', async () => {
    const res = await connect(ccBody('new', {
      shop: 'HTTPS://SCT-NEW.myshopify.com/', projectName: 'SCT Reminiso', payoutStartDate: '2026-10-06', trackingPageUrl: 'https://remi.example.com/track?nums=',
    }))
    expect(res.status).toBe(200)
    const store = (await storeOf('new'))!
    expect(res.body).toEqual({
      status: 'CONNECTED', storeId: store.id, shopName: 'Sct Shop', timezone: 'America/New_York', orderPrefix: 'SCTNEW',
      scopes: ['read_orders', 'read_products'], readAllOrders: false,
    })
    expect(store).toMatchObject({
      shop: shopOf('new'), ianaTimezone: 'America/New_York', orderPrefix: 'SCTNEW', payoutStartDate: '2026-10-06',
      trackingPageUrl: 'https://remi.example.com/track?nums=', enabled: true, lastError: null,
    })
    expect(store.project).toMatchObject({ name: 'SCT Reminiso' })
    expect(store.project!.startDate.toISOString()).toBe('2026-10-06T00:00:00.000Z')
    expect(store.credential).toMatchObject({ authMode: 'CLIENT_CREDENTIALS', clientId: CLIENT_ID, clientSecret: SECRET, accessToken: MINTED })
    expect(store.credential!.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000)

    expect(mintCalls()).toHaveLength(1)
    expect(mintCalls()[0].url).toBe(`https://${shopOf('new')}/admin/oauth/access_token`)
    expect(new URLSearchParams(String(mintCalls()[0].init.body)).get('client_secret')).toBe(SECRET)
    expect(graphCalls()).toHaveLength(1)
    expect(graphCalls()[0].url).toBe(`https://${shopOf('new')}/admin/api/2024-10/graphql.json`)
    expect((graphCalls()[0].init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(MINTED)
    expectNoSecrets(res.text)
  })

  it('reports read_all_orders when the app has the scope', async () => {
    graphReply = () => snapshot({ scopes: ['read_orders', 'read_all_orders'] })
    const res = await connect(ccBody('new', { projectName: 'SCT Scoped' }))
    expect(res.body).toMatchObject({ status: 'CONNECTED', readAllOrders: true, scopes: ['read_orders', 'read_all_orders'] })
  })

  it('shows the scopes and store settings on the status list, with no secret', async () => {
    const res = await connect(ccBody('new', { projectName: 'SCT Status', payoutStartDate: '2026-10-06', trackingPageUrl: 'https://remi.example.com/t' }))
    const status = await (await getStatus()).json()
    const mine = status.stores.find((s: any) => s.id === res.body.storeId)
    expect(mine).toMatchObject({
      shop: shopOf('new'), connected: true, authMode: 'CLIENT_CREDENTIALS', orderPrefix: 'SCTNEW', payoutStartDate: '2026-10-06',
      trackingPageUrl: 'https://remi.example.com/t', scopes: ['read_orders', 'read_products'], readAllOrders: false, lastSyncAt: null,
    })
    expectNoSecrets(JSON.stringify(status))
  })

  it('shop_not_permitted falls back to NEEDS_OAUTH with the OAuth url of the store', async () => {
    mintReply = () => json(400, { error: 'shop_not_permitted', error_description: `app for ${CLIENT_ID} is not installed, secret ${SECRET}` })
    const res = await connect(ccBody('oa', { projectName: 'SCT OAuth' }))
    expect(res.status).toBe(200)
    const store = (await storeOf('oa'))!
    expect(res.body).toEqual({ status: 'NEEDS_OAUTH', storeId: store.id, oauthUrl: `/api/auth/shopify?shop=${shopOf('oa')}` })
    expect(store.credential).toMatchObject({ authMode: 'OAUTH', clientId: CLIENT_ID, clientSecret: SECRET, accessToken: null })
    expect(store.project?.name).toBe('SCT OAuth')
    expect(graphCalls()).toHaveLength(0)
    expectNoSecrets(res.text)

    const start = await startOAuth(request(res.body.oauthUrl, 'super'))
    expect(start.status).toBeGreaterThanOrEqual(300)
    expect(start.status).toBeLessThan(400)
    const location = new URL(start.headers.get('location')!)
    expect(location.host).toBe(shopOf('oa'))
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID)
  })

  it('shop_not_permitted on an OAuth store that already works is a 409 and writes nothing', async () => {
    const store = await prisma.shopifyStore.create({ data: { shop: shopOf('oa'), orderPrefix: 'SCTOA' } })
    await saveStoreCredential(store.id, { authMode: 'OAUTH', clientId: 'old-id', clientSecret: 'old-secret', accessToken: OLD_TOKEN })
    const credentialBefore = await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })
    const storeBefore = await prisma.shopifyStore.findUnique({ where: { id: store.id } })
    mintReply = () => json(400, { error: 'shop_not_permitted' })
    const res = await connect(ccBody('oa', { projectName: 'SCT Not Made', payoutStartDate: '2026-10-06' }))
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('chưa được cài')
    expect(res.body.error).toContain('"Ngắt kết nối" trên thẻ store này')
    expect(await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })).toEqual(credentialBefore)
    expect(await prisma.shopifyStore.findUnique({ where: { id: store.id } })).toEqual(storeBefore)
    expect(await scopesOf(store.id)).toBeNull()
    expect(await projectsMade()).toBe(0)
    expect(graphCalls()).toHaveLength(0)
    expect((await getStoreConnection(store.id)).token).toBe(OLD_TOKEN)
  })

  it('shop_not_permitted on a client-credentials store that already works is a 409: its row and token stay as they were', async () => {
    const store = await prisma.shopifyStore.create({ data: { shop: shopOf('oa'), orderPrefix: 'SCTOA' } })
    await saveStoreCredential(store.id, { authMode: 'CLIENT_CREDENTIALS', clientId: 'test-other-client-555', clientSecret: OTHER_SECRET, accessToken: OLD_TOKEN, tokenExpiresAt: new Date(Date.now() + 20 * 3600_000) })
    const credentialBefore = await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })
    mintReply = () => json(400, { error: 'shop_not_permitted' })
    const res = await connect(ccBody('oa', { projectName: 'SCT Not Made' }))
    expect(res.status).toBe(409)
    expect(await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })).toEqual(credentialBefore)
    expect((await getStoreConnection(store.id)).token).toBe(OLD_TOKEN)
    expect(mintCalls()).toHaveLength(1)
    expect(await projectsMade()).toBe(0)
  })

  it('any credential the store can already connect with is kept: a pasted token, or a complete pair without a token yet', async () => {
    const shapes: Array<Parameters<typeof saveStoreCredential>[1]> = [
      { authMode: 'TOKEN', accessToken: OLD_TOKEN },
      { authMode: 'CLIENT_CREDENTIALS', clientId: 'test-other-client-555', clientSecret: OTHER_SECRET },
    ]
    for (let index = 0; index < shapes.length; index++) {
      const credential = shapes[index]
      const store = await prisma.shopifyStore.create({ data: { shop: shopOf(`oa${index}`) } })
      await saveStoreCredential(store.id, credential)
      const before = await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })
      mintReply = () => json(400, { error: 'shop_not_permitted' })
      expect((await connect(ccBody(`oa${index}`))).status).toBe(409)
      expect(await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })).toEqual(before)
    }
  })

  it('shop_not_permitted on a store with no usable credential still goes through OAuth', async () => {
    const store = await prisma.shopifyStore.create({ data: { shop: shopOf('oa') } })
    await saveStoreCredential(store.id, { authMode: 'OAUTH', clientId: 'old-id', clientSecret: 'old-secret' })
    mintReply = () => json(400, { error: 'shop_not_permitted' })
    const res = await connect(ccBody('oa'))
    expect(res.body).toEqual({ status: 'NEEDS_OAUTH', storeId: store.id, oauthUrl: `/api/auth/shopify?shop=${shopOf('oa')}` })
    expect((await storeOf('oa'))!.credential).toMatchObject({ authMode: 'OAUTH', clientId: CLIENT_ID, clientSecret: SECRET, accessToken: null })
  })

  it('Shopify rejecting the Client ID or Secret is a 400 and saves nothing', async () => {
    mintReply = () => json(400, { error: 'invalid_client', error_description: `bad secret ${SECRET} for ${CLIENT_ID}` })
    const res = await connect(ccBody('bad', { projectName: 'SCT Bad' }))
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Client ID')
    expect(await storeOf('bad')).toBeNull()
    expect(await projectsMade()).toBe(0)
    expectNoSecrets(res.text)
  })

  it('Shopify unreachable is a 502 and saves nothing', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError(`fetch failed for ${SECRET}`) }) as unknown as typeof fetch
    const res = await connect(ccBody('down', { projectName: 'SCT Down' }))
    expect(res.status).toBe(502)
    expect(await storeOf('down')).toBeNull()
    expectNoSecrets(res.text)
  })

  it('a token without read_orders is refused', async () => {
    graphReply = () => json(200, {
      data: { shop: { name: 'X', ianaTimezone: 'UTC' }, currentAppInstallation: { accessScopes: [] }, orders: null },
      errors: [{ message: `Access denied for orders field, token ${MINTED}`, path: ['orders'], extensions: { code: 'ACCESS_DENIED' } }],
    })
    const res = await connect(ccBody('noscope', { projectName: 'SCT NoScope' }))
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('read_orders')
    expect(await storeOf('noscope')).toBeNull()
    expectNoSecrets(res.text)
  })
})

describe('POST /api/stores/connect: pasted access token', () => {
  it('verifies by calling the shop before saving', async () => {
    const res = await connect({ shop: shopOf('tok'), accessToken: PASTED, projectName: 'SCT Token' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'CONNECTED', orderPrefix: 'SCTNEW', timezone: 'America/New_York' })
    expect(mintCalls()).toHaveLength(0)
    expect(graphCalls()).toHaveLength(1)
    expect((graphCalls()[0].init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(PASTED)
    expect((await storeOf('tok'))!.credential).toMatchObject({ authMode: 'TOKEN', accessToken: PASTED, clientId: null, clientSecret: null, tokenExpiresAt: null })
    expectNoSecrets(res.text)
  })

  it('a wrong token is a 400 and saves nothing', async () => {
    graphReply = () => json(401, { errors: `[API] Invalid API key or access token ${PASTED}` })
    const res = await connect({ shop: shopOf('tok'), accessToken: PASTED, projectName: 'SCT Wrong' })
    expect(res.status).toBe(400)
    expect(await storeOf('tok')).toBeNull()
    expect(await projectsMade()).toBe(0)
    expectNoSecrets(res.text)
  })
})

describe('POST /api/stores/connect: order prefix', () => {
  it('refuses an order prefix already used by another store', async () => {
    const owner = await prisma.shopifyStore.create({ data: { shop: shopOf('owner'), orderPrefix: 'LIT' } })
    graphReply = () => snapshot({ orders: ['#LIT9'] })
    const res = await connect(ccBody('dup', { projectName: 'SCT Dup' }))
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('LIT')
    expect(res.body.error).toContain(shopOf('owner'))
    expect(await storeOf('dup')).toBeNull()
    expect(await projectsMade()).toBe(0)
    expect((await prisma.shopifyStore.findUnique({ where: { id: owner.id } }))!.orderPrefix).toBe('LIT')
  })

  it('compares prefixes without regard to case', async () => {
    await prisma.shopifyStore.create({ data: { shop: shopOf('owner'), orderPrefix: 'sctlow' } })
    graphReply = () => snapshot({ orders: ['#SCTLOW5'] })
    expect((await connect(ccBody('dup'))).status).toBe(409)
  })

  it('a disabled store still reserves its prefix', async () => {
    await prisma.shopifyStore.create({ data: { shop: shopOf('owner'), orderPrefix: 'SCTOFF', enabled: false } })
    graphReply = () => snapshot({ orders: ['#SCTOFF9'] })
    const res = await connect(ccBody('dup', { projectName: 'SCT Dup' }))
    expect(res.status).toBe(409)
    expect(res.body.error).toContain(shopOf('owner'))
    expect(await storeOf('dup')).toBeNull()
  })

  it('reads the prefix as the letters right before the number, in either case', async () => {
    graphReply = () => snapshot({ orders: ['#sctlow9'] })
    const res = await connect(ccBody('pfx'))
    expect(res.body).toMatchObject({ status: 'CONNECTED', orderPrefix: 'SCTLOW' })
  })

  it('refuses a newest order named like #REMI-1010: the tool routes orders by <PREFIX><number>', async () => {
    graphReply = () => snapshot({ orders: ['#REMI-1010'] })
    const res = await connect(ccBody('pfx', { projectName: 'SCT Pfx' }))
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('#REMI-1010')
    expect(res.body.error).toContain('REMI1010')
    expect(res.body.error).toContain('Order ID')
    expect(await storeOf('pfx')).toBeNull()
    expect(await projectsMade()).toBe(0)
  })

  it('refuses a store with no prefix (#1001) and says where to set it in Shopify', async () => {
    graphReply = () => snapshot({ orders: ['#1001'] })
    const res = await connect(ccBody('pfx', { projectName: 'SCT Pfx' }))
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('#1001')
    expect(res.body.error).toContain('Settings')
    expect(res.body.error).toContain('prefix')
    expect(await storeOf('pfx')).toBeNull()
    expect(await projectsMade()).toBe(0)
  })

  it('a store with no orders yet stays connected with prefix null, and order sync refuses it until a prefix is set', async () => {
    graphReply = () => snapshot({ orders: [] })
    const res = await connect(ccBody('nopfx', { projectName: 'SCT NoPfx' }))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'CONNECTED', orderPrefix: null })
    const store = (await storeOf('nopfx'))!
    expect(store.orderPrefix).toBeNull()

    calls = []
    const refused = await syncOrders(request('/api/shopify/orders/sync', 'super', { method: 'POST', body: { storeId: store.id } }))
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toContain('tiền tố')
    expect(calls).toHaveLength(0)
    expect((await storeOf('nopfx'))!.lastError).toMatch(/^\[order-sync\] .*tiền tố/)

    graphReply = () => snapshot({ orders: ['#SCTNOP1001'] })
    const again = await connect({ shop: shopOf('nopfx') })
    expect(again.body).toMatchObject({ status: 'CONNECTED', storeId: store.id, orderPrefix: 'SCTNOP' })
    const after = (await storeOf('nopfx'))!
    expect(after.orderPrefix).toBe('SCTNOP')
    expect(after.lastError).toMatch(/^\[order-sync\] /)

    graphReply = () => json(200, { data: { shop: { ianaTimezone: 'America/New_York' }, orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } })
    const synced = await syncOrders(request('/api/shopify/orders/sync', 'super', { method: 'POST', body: { storeId: store.id } }))
    expect(synced.status).toBe(200)
    expect(await synced.json()).toMatchObject({ totalSynced: 0, projectName: 'SCT NoPfx' })
    expect((await storeOf('nopfx'))!.lastError).toBeNull()
  })

  it('a store with the prefix LIT syncs as before', async () => {
    const project = await prisma.project.create({ data: { name: 'SCT Lit', startDate: new Date('2026-05-01') } })
    const store = await prisma.shopifyStore.create({ data: { shop: shopOf('lit'), orderPrefix: 'LIT', projectId: project.id } })
    await saveStoreCredential(store.id, { authMode: 'TOKEN', accessToken: OTHER_TOKEN })
    graphReply = () => json(200, { data: { shop: { ianaTimezone: 'America/Denver' }, orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } })
    const res = await syncOrders(request('/api/shopify/orders/sync', 'super', { method: 'POST', body: { storeId: store.id } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ totalSynced: 0, errors: [] })
  })
})

describe('POST /api/stores/connect: projects', () => {
  it('links an existing project that has no store', async () => {
    const project = await prisma.project.create({ data: { name: 'SCT Free', startDate: new Date('2026-05-01') } })
    const res = await connect(ccBody('proj', { projectId: project.id }))
    expect(res.status).toBe(200)
    expect((await storeOf('proj'))!.projectId).toBe(project.id)
    expect(await projectsMade()).toBe(1)
  })

  it('refuses a project that already belongs to another store', async () => {
    const project = await prisma.project.create({ data: { name: 'SCT Taken', startDate: new Date('2026-05-01') } })
    await prisma.shopifyStore.create({ data: { shop: shopOf('owner'), projectId: project.id } })
    const res = await connect(ccBody('proj', { projectId: project.id }))
    expect(res.status).toBe(409)
    expect(await storeOf('proj')).toBeNull()
  })

  it('refuses an archived or unknown project', async () => {
    const archived = await prisma.project.create({ data: { name: 'SCT Archived', startDate: new Date('2026-05-01'), archivedAt: new Date() } })
    expect((await connect(ccBody('proj', { projectId: archived.id }))).status).toBe(400)
    expect((await connect(ccBody('proj', { projectId: 'sct-no-such-project' }))).status).toBe(400)
    expect(await storeOf('proj')).toBeNull()
  })

  it('without a project name or id the store is connected but not linked', async () => {
    const res = await connect(ccBody('proj'))
    expect(res.status).toBe(200)
    expect((await storeOf('proj'))!.projectId).toBeNull()
    expect(await projectsMade()).toBe(0)
  })

  it('a new project starts on the project date, else the payout date', async () => {
    await connect(ccBody('proj', { projectName: 'SCT Dated', startDate: '2026-09-01', payoutStartDate: '2026-10-06' }))
    expect((await storeOf('proj'))!.project!.startDate.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    graphReply = () => snapshot({ orders: ['#SCTPAY1'] })
    await connect(ccBody('pay', { projectName: 'SCT Payout date', payoutStartDate: '2026-10-06' }))
    expect((await storeOf('pay'))!.project!.startDate.toISOString()).toBe('2026-10-06T00:00:00.000Z')
  })
})

describe('POST /api/stores/connect: other stores and re-connecting', () => {
  it("adding a store does not change another store's credential", async () => {
    const other = await prisma.shopifyStore.create({ data: { shop: shopOf('other'), orderPrefix: 'SCTOTH', enabled: false } })
    await saveStoreCredential(other.id, { authMode: 'CLIENT_CREDENTIALS', clientId: 'test-other-client-555', clientSecret: OTHER_SECRET, accessToken: OTHER_TOKEN, tokenExpiresAt: new Date(Date.now() + 86_400_000) })
    const before = await prisma.shopifyStoreCredential.findUnique({ where: { storeId: other.id } })
    const storeBefore = await prisma.shopifyStore.findUnique({ where: { id: other.id } })

    expect((await connect(ccBody('new', { projectName: 'SCT Added' }))).status).toBe(200)
    graphReply = () => snapshot({ orders: ['#SCTTOK1'] })
    expect((await connect({ shop: shopOf('tok'), accessToken: PASTED })).status).toBe(200)
    mintReply = () => json(400, { error: 'shop_not_permitted' })
    expect((await connect(ccBody('oa'))).status).toBe(200)

    expect(await prisma.shopifyStoreCredential.findUnique({ where: { storeId: other.id } })).toEqual(before)
    expect(await prisma.shopifyStore.findUnique({ where: { id: other.id } })).toEqual(storeBefore)
    expect(await prisma.shopifyStoreCredential.count({ where: { store: { shop: { startsWith: 'sct-' } } } })).toBe(4)
  })

  it('re-connects a store that already exists: same row, project, prefix and settings, new credential', async () => {
    const project = await prisma.project.create({ data: { name: 'SCT Kept', startDate: new Date('2026-05-01') } })
    const store = await prisma.shopifyStore.create({ data: {
      shop: shopOf('re'), orderPrefix: 'SCTKEEP', projectId: project.id, enabled: false, trackingPageUrl: 'https://kept.example.com/t', payoutStartDate: '2026-01-01',
      lastError: '[order-sync] token revoked', lastErrorAt: new Date(), connectedAt: new Date('2026-09-01'),
    } })
    await saveStoreCredential(store.id, { authMode: 'TOKEN', accessToken: 'test-old-token' })
    graphReply = () => snapshot({ orders: ['#SCTNEW1010'], tz: 'Asia/Tokyo' })

    const res = await connect({
      shop: shopOf('re'), accessToken: PASTED, projectName: 'SCT Another', payoutStartDate: '2026-10-06', trackingPageUrl: 'https://other.example.com/t', startDate: '2026-02-02',
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'CONNECTED', storeId: store.id, orderPrefix: 'SCTKEEP', timezone: 'Asia/Tokyo' })
    expect(await prisma.shopifyStore.count({ where: { shop: shopOf('re') } })).toBe(1)
    expect(await projectsMade()).toBe(1)
    const after = (await storeOf('re'))!
    expect(after).toMatchObject({
      id: store.id, projectId: project.id, orderPrefix: 'SCTKEEP', enabled: false, trackingPageUrl: 'https://kept.example.com/t', payoutStartDate: '2026-01-01',
      ianaTimezone: 'Asia/Tokyo', lastError: '[order-sync] token revoked',
    })
    expect(after.lastErrorAt).not.toBeNull()
    expect(after.connectedAt.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(after.credential).toMatchObject({ authMode: 'TOKEN', accessToken: PASTED })
  })

  it('a store registered earlier without a project or settings gets them filled in', async () => {
    const store = await prisma.shopifyStore.create({ data: { shop: shopOf('legacy') } })
    await saveStoreCredential(store.id, { authMode: 'OAUTH', clientId: 'test-other-client-555', clientSecret: OTHER_SECRET, accessToken: 'test-old-token' })
    const res = await connect(ccBody('legacy', { projectName: 'SCT Legacy', payoutStartDate: '2026-10-06', trackingPageUrl: 'https://legacy.example.com/t' }))
    expect(res.body).toMatchObject({ status: 'CONNECTED', storeId: store.id, orderPrefix: 'SCTNEW' })
    const after = (await storeOf('legacy'))!
    expect(after).toMatchObject({ id: store.id, orderPrefix: 'SCTNEW', payoutStartDate: '2026-10-06', trackingPageUrl: 'https://legacy.example.com/t' })
    expect(after.project?.name).toBe('SCT Legacy')
    expect(after.credential).toMatchObject({ authMode: 'CLIENT_CREDENTIALS', clientId: CLIENT_ID, clientSecret: SECRET, accessToken: MINTED })
    expect(await prisma.shopifyStore.count({ where: { shop: shopOf('legacy') } })).toBe(1)
  })

  it('a re-connect whose newest order shows another prefix keeps the stored one and warns with both', async () => {
    const store = await prisma.shopifyStore.create({ data: { shop: shopOf('re'), orderPrefix: 'SCTKEEP' } })
    await saveStoreCredential(store.id, { authMode: 'TOKEN', accessToken: OLD_TOKEN })
    graphReply = () => snapshot({ orders: ['#SCTOTHER5'] })
    const res = await connect({ shop: shopOf('re'), accessToken: PASTED })
    expect(res.body).toMatchObject({ status: 'CONNECTED', storeId: store.id, orderPrefix: 'SCTKEEP' })
    expect(res.body.warning).toContain('SCTOTHER')
    expect(res.body.warning).toContain('SCTKEEP')
    expect((await storeOf('re'))!.orderPrefix).toBe('SCTKEEP')
  })

  it('no warning when the newest order shows the stored prefix in any case, or no prefix at all', async () => {
    await prisma.shopifyStore.create({ data: { shop: shopOf('re'), orderPrefix: 'SCTKEEP' } })
    for (const name of ['#sctkeep5', '#SCTKEEP5', '#1001']) {
      graphReply = () => snapshot({ orders: [name] })
      const res = await connect({ shop: shopOf('re'), accessToken: PASTED })
      expect([name, res.status, res.body.warning]).toEqual([name, 200, undefined])
    }
  })

  it('a re-connect is not blocked by the prefix check when the store already has a prefix', async () => {
    await prisma.shopifyStore.create({ data: { shop: shopOf('re'), orderPrefix: 'SCTKEEP' } })
    graphReply = () => snapshot({ orders: ['#1001'] })
    const res = await connect({ shop: shopOf('re'), accessToken: PASTED })
    expect(res.status).toBe(200)
    expect(res.body.orderPrefix).toBe('SCTKEEP')
  })
})

describe('POST /api/stores/connect: re-check with the stored credential', () => {
  const ccStore = async (tokenLife: number | null, extra: Record<string, unknown> = {}) => {
    const store = await prisma.shopifyStore.create({ data: { shop: shopOf('chk'), orderPrefix: 'SCTCHK', ...extra } })
    await saveStoreCredential(store.id, {
      authMode: 'CLIENT_CREDENTIALS', clientId: CLIENT_ID, clientSecret: SECRET,
      ...(tokenLife === null ? {} : { accessToken: OLD_TOKEN, tokenExpiresAt: new Date(Date.now() + tokenLife) }),
    })
    return store
  }

  it('a still-fresh stored client-credentials token is reused: nothing is minted and the credential is not written', async () => {
    const store = await ccStore(5 * 3600_000)
    const before = await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })
    const res = await connect({ shop: shopOf('chk') })
    expect(res.body).toMatchObject({ status: 'CONNECTED', storeId: store.id, orderPrefix: 'SCTCHK' })
    expect(mintCalls()).toHaveLength(0)
    expect((graphCalls()[0].init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(OLD_TOKEN)
    expect(await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })).toEqual(before)
  })

  it('a stored token that is about to expire is minted once through the shared path, and the pair stays', async () => {
    const store = await ccStore(30 * 60_000)
    const res = await connect({ shop: shopOf('chk') })
    expect(res.body).toMatchObject({ status: 'CONNECTED', storeId: store.id })
    expect(mintCalls()).toHaveLength(1)
    expect(new URLSearchParams(String(mintCalls()[0].init.body)).get('client_id')).toBe(CLIENT_ID)
    expect((await storeOf('chk'))!.credential).toMatchObject({ authMode: 'CLIENT_CREDENTIALS', clientId: CLIENT_ID, clientSecret: SECRET, accessToken: MINTED })
  })

  it('a credential replaced while the new token is being minted is not overwritten with the stale pair', async () => {
    const store = await ccStore(30 * 60_000)
    let first = true
    mintReply = async () => {
      if (!first) return mintOk(MINTED)
      first = false
      await prisma.shopifyStoreCredential.update({ where: { storeId: store.id }, data: { clientId: REPLACED_ID, clientSecret: REPLACED_SECRET } })
      return mintOk(STALE)
    }
    const res = await connect({ shop: shopOf('chk') })
    expect(res.body).toMatchObject({ status: 'CONNECTED', storeId: store.id })
    expect(mintCalls()).toHaveLength(2)
    expect(new URLSearchParams(String(mintCalls()[1].init.body)).get('client_id')).toBe(REPLACED_ID)
    expect((await storeOf('chk'))!.credential).toMatchObject({ clientId: REPLACED_ID, clientSecret: REPLACED_SECRET, accessToken: MINTED })
    expect((graphCalls()[0].init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(MINTED)
  })

  it('a fresh stored token that Shopify refuses is forgotten and replaced by one new mint', async () => {
    const store = await ccStore(5 * 3600_000)
    let refused = false
    graphReply = () => {
      if (refused) return snapshot()
      refused = true
      return json(401, { errors: 'Invalid access token' })
    }
    const res = await connect({ shop: shopOf('chk') })
    expect(res.body).toMatchObject({ status: 'CONNECTED', storeId: store.id })
    expect(mintCalls()).toHaveLength(1)
    expect(graphCalls()).toHaveLength(2)
    expect((graphCalls()[1].init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(MINTED)
    expect((await storeOf('chk'))!.credential).toMatchObject({ clientId: CLIENT_ID, clientSecret: SECRET, accessToken: MINTED })
  })

  it('a new token that Shopify also refuses is a 400', async () => {
    await ccStore(5 * 3600_000)
    graphReply = () => json(401, { errors: 'Invalid access token' })
    const res = await connect({ shop: shopOf('chk') })
    expect(res.status).toBe(400)
    expect(mintCalls()).toHaveLength(1)
  })

  it('stored client credentials that Shopify answers shop_not_permitted to go through OAuth, writing nothing', async () => {
    const store = await ccStore(30 * 60_000)
    const before = await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })
    mintReply = () => json(400, { error: 'shop_not_permitted' })
    const res = await connect({ shop: shopOf('chk') })
    expect(res.body).toEqual({ status: 'NEEDS_OAUTH', storeId: store.id, oauthUrl: `/api/auth/shopify?shop=${shopOf('chk')}` })
    expect(mintCalls()).toHaveLength(1)
    expect(await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })).toEqual(before)
  })

  it('stored client credentials that Shopify rejects are a 400 and write nothing', async () => {
    const store = await ccStore(30 * 60_000)
    const before = await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })
    mintReply = () => json(400, { error: 'invalid_client' })
    const res = await connect({ shop: shopOf('chk') })
    expect(res.status).toBe(400)
    expect(await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })).toEqual(before)
  })

  it('a disabled store can be re-checked and stays disabled', async () => {
    const store = await ccStore(5 * 3600_000, { enabled: false })
    const res = await connect({ shop: shopOf('chk') })
    expect(res.body).toMatchObject({ status: 'CONNECTED', storeId: store.id })
    expect((await storeOf('chk'))!.enabled).toBe(false)
  })

  it('a stored credential with no token yet (OAuth not finished) is a 400 and writes nothing', async () => {
    const store = await prisma.shopifyStore.create({ data: { shop: shopOf('chk') } })
    await saveStoreCredential(store.id, { authMode: 'OAUTH', clientId: CLIENT_ID, clientSecret: SECRET })
    const before = await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })
    const res = await connect({ shop: shopOf('chk') })
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
    expect(await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })).toEqual(before)
  })

  it('an unexpected failure on the stored path logs without the stored values or the minted token', async () => {
    await ccStore(30 * 60_000)
    const failing = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error(`write failed: ${CLIENT_ID} ${SECRET} ${OLD_TOKEN} ${MINTED}`))
    const res = await connect({ shop: shopOf('chk') })
    failing.mockRestore()
    expect(res.status).toBe(500)
    expect(errorSpy).toHaveBeenCalled()
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('stores/connect')
  })

  it('a stored OAuth token is verified as it is, and the credential is left alone', async () => {
    const store = await prisma.shopifyStore.create({ data: { shop: shopOf('chk') } })
    await saveStoreCredential(store.id, { authMode: 'OAUTH', clientId: CLIENT_ID, clientSecret: SECRET, accessToken: PASTED })
    const before = await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })
    const res = await connect({ shop: shopOf('chk') })
    expect(res.body).toMatchObject({ status: 'CONNECTED', orderPrefix: 'SCTNEW' })
    expect(mintCalls()).toHaveLength(0)
    expect((graphCalls()[0].init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(PASTED)
    expect(await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })).toEqual(before)
  })

  it('a stored OAuth token that Shopify rejects sends the store through OAuth again, writing nothing', async () => {
    const store = await prisma.shopifyStore.create({ data: { shop: shopOf('chk') } })
    await saveStoreCredential(store.id, { authMode: 'OAUTH', clientId: CLIENT_ID, clientSecret: SECRET, accessToken: PASTED })
    const before = await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })
    graphReply = () => json(401, { errors: 'Invalid access token' })
    const res = await connect({ shop: shopOf('chk') })
    expect(res.body).toEqual({ status: 'NEEDS_OAUTH', storeId: store.id, oauthUrl: `/api/auth/shopify?shop=${shopOf('chk')}` })
    expect(await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })).toEqual(before)
  })

  it('a stored pasted token that Shopify rejects is a 400', async () => {
    const store = await prisma.shopifyStore.create({ data: { shop: shopOf('chk') } })
    await saveStoreCredential(store.id, { authMode: 'TOKEN', accessToken: PASTED })
    graphReply = () => json(401, { errors: 'Invalid access token' })
    const res = await connect({ shop: shopOf('chk') })
    expect(res.status).toBe(400)
    expectNoSecrets(res.text)
  })

  it('no secrets and nothing stored is a 400', async () => {
    expect((await connect({ shop: shopOf('chk') })).status).toBe(400)
    await prisma.shopifyStore.create({ data: { shop: shopOf('chk') } })
    expect((await connect({ shop: shopOf('chk') })).status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('granted scopes', () => {
  it('the OAuth callback records the scopes Shopify granted, and disconnecting the store removes them and keeps the store', async () => {
    const store = await prisma.shopifyStore.create({ data: { shop: shopOf('oa'), orderPrefix: 'SCTOA', payoutStartDate: '2026-10-06', trackingPageUrl: 'https://oa.example.com/t' } })
    await saveStoreCredential(store.id, { authMode: 'OAUTH', clientId: CLIENT_ID, clientSecret: SECRET })
    saveOAuthState('sct-state', shopOf('oa'))
    mintReply = () => json(200, { access_token: 'shpat_test_oauth_token', scope: 'read_orders, read_products,read_all_orders' })
    const callback = await oauthCallback(callbackRequest(shopOf('oa'), 'sct-state', SECRET))
    expect(callback.status).toBe(200)

    const entry = async () => (await (await getStatus()).json()).stores.find((s: any) => s.id === store.id)
    expect(await entry()).toMatchObject({ connected: true, scopes: ['read_orders', 'read_products', 'read_all_orders'], readAllOrders: true })

    const other = await prisma.shopifyStore.create({ data: { shop: shopOf('other') } })
    await saveStoreCredential(other.id, { authMode: 'TOKEN', accessToken: OTHER_TOKEN })
    await disconnect(store.id)
    expect(await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })).toBeNull()
    expect((await prisma.shopifyStoreCredential.findUnique({ where: { storeId: other.id } }))?.accessToken).toBe(OTHER_TOKEN)
    expect(await storeOf('oa')).toMatchObject({ id: store.id, orderPrefix: 'SCTOA', payoutStartDate: '2026-10-06', trackingPageUrl: 'https://oa.example.com/t' })
    expect(await scopesOf(store.id)).toBeNull()
    expect(await entry()).toMatchObject({ connected: false, scopes: null, readAllOrders: null })
  })

  it('a connect records them and a later callback replaces them', async () => {
    const res = await connect(ccBody('oa', { projectName: 'SCT Scopes' }))
    expect(JSON.parse((await scopesOf(res.body.storeId))!).scopes).toEqual(['read_orders', 'read_products'])
    saveOAuthState('sct-state-2', shopOf('oa'))
    mintReply = () => json(200, { access_token: 'shpat_test_oauth_token', scope: 'read_orders' })
    expect((await oauthCallback(callbackRequest(shopOf('oa'), 'sct-state-2', SECRET))).status).toBe(200)
    expect(JSON.parse((await scopesOf(res.body.storeId))!).scopes).toEqual(['read_orders'])
  })
})

describe('POST /api/stores/connect: validation and access', () => {
  it('rejects an invalid shop domain with 400 and calls nobody', async () => {
    for (const shop of ['', 'example.com', 'x.myshopify.com.evil.com', 'localhost', 'a b.myshopify.com', 'https://evil.com/x.myshopify.com', 'ok.myshopify.com:8080', 'a.myshopify.com@evil.com', 'a.myshopify.com.', undefined, 12, ['a.myshopify.com']]) {
      const res = await connect({ shop, clientId: CLIENT_ID, clientSecret: SECRET })
      expect([shop, res.status]).toEqual([shop, 400])
      expect(res.body.error).toContain('myshopify.com')
    }
    expect(calls).toHaveLength(0)
    expect(await prisma.shopifyStore.count({ where: { shop: { startsWith: 'sct-' } } })).toBe(0)
  })

  it('rejects half a client credential pair, wrong types, a bad date and a bad tracking url', async () => {
    const bad: Array<Record<string, unknown>> = [
      { shop: shopOf('v'), clientId: CLIENT_ID },
      { shop: shopOf('v'), clientSecret: SECRET },
      { shop: shopOf('v'), clientId: 5, clientSecret: SECRET },
      { shop: shopOf('v'), accessToken: { token: PASTED } },
      ccBody('v', { payoutStartDate: '10/06/2026' }),
      ccBody('v', { payoutStartDate: '2026-13-40' }),
      ccBody('v', { startDate: 'yesterday', projectName: 'SCT V' }),
      ccBody('v', { trackingPageUrl: 'http://remi.example.com/t' }),
      ccBody('v', { trackingPageUrl: 'https://localhost/t' }),
      ccBody('v', { projectName: 42 }),
    ]
    for (const body of bad) expect([body, (await connect(body)).status]).toEqual([body, 400])
    expect((await connectRoute(request('/api/stores/connect', 'super', { method: 'POST', body: [1] }))).status).toBe(400)
    expect(calls).toHaveLength(0)
    expect(await storeOf('v')).toBeNull()
  })

  it('an unexpected failure answers 500 with a fixed text and logs without the secrets', async () => {
    const failing = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error(`Invalid upsert() data: { clientId: '${CLIENT_ID}', clientSecret: '${SECRET}', accessToken: "${PASTED}" }`))
    const res = await connect({ ...ccBody('boom'), accessToken: PASTED })
    failing.mockRestore()
    expect(res.status).toBe(500)
    expectNoSecrets(res.text)
    expect(errorSpy).toHaveBeenCalled()
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('stores/connect')
    expect(await storeOf('boom')).toBeNull()
  })

  it('only a Super Admin may connect a store', async () => {
    for (const who of ['admin', 'support', 'seller']) {
      const res = await connect(ccBody('new', { projectName: 'SCT Forbidden' }), who)
      expect([who, res.status]).toEqual([who, 403])
    }
    expect((await connect(ccBody('new'), null)).status).toBe(401)
    expect(calls).toHaveLength(0)
    expect(await storeOf('new')).toBeNull()
    expect(await projectsMade()).toBe(0)
  })
})

describe('PATCH /api/stores/[id]', () => {
  const make = (extra: Record<string, unknown> = {}) => prisma.shopifyStore.create({ data: { shop: shopOf('set'), orderPrefix: 'SCTSET', ...extra } })

  it('switches a store off and on and answers with the public store shape', async () => {
    const store = await make()
    const off = await patch(store.id, { enabled: false })
    expect(off.status).toBe(200)
    expect(off.body).toEqual({ store: { id: store.id, shop: shopOf('set'), name: shopOf('set'), orderPrefix: 'SCTSET', enabled: false } })
    expect((await storeOf('set'))!.enabled).toBe(false)

    const listed = await (await listStores(request('/api/stores?includeDisabled=1', 'super'))).json()
    expect(listed.stores.find((s: any) => s.id === store.id)).toEqual(off.body.store)

    const on = await patch(store.id, { enabled: true })
    expect(on.body.store.enabled).toBe(true)
  })

  it('sets and clears the tracking page url and the payout start date', async () => {
    const store = await make()
    expect((await patch(store.id, { trackingPageUrl: 'https://remi.example.com/apps/track?nums=', payoutStartDate: '2026-10-06' })).status).toBe(200)
    expect(await storeOf('set')).toMatchObject({ trackingPageUrl: 'https://remi.example.com/apps/track?nums=', payoutStartDate: '2026-10-06', orderPrefix: 'SCTSET', enabled: true })
    expect((await patch(store.id, { trackingPageUrl: null, payoutStartDate: null })).status).toBe(200)
    expect(await storeOf('set')).toMatchObject({ trackingPageUrl: null, payoutStartDate: null })
    expect((await patch(store.id, { trackingPageUrl: '  ' })).status).toBe(200)
    expect((await storeOf('set'))!.trackingPageUrl).toBeNull()
  })

  it('refuses any other key and changes nothing', async () => {
    const store = await make({ trackingPageUrl: 'https://kept.example.com/t' })
    for (const body of [{ orderPrefix: 'HACK' }, { enabled: false, shop: 'x.myshopify.com' }, { projectId: 'p' }, { accessToken: PASTED }, { clientSecret: SECRET }, {}, { enabled: 'yes' }, { payoutStartDate: '06/10/2026' }, { trackingPageUrl: 'http://remi.example.com/t' }, { trackingPageUrl: 'https://127.0.0.1/t' }, { trackingPageUrl: 5 }]) {
      const res = await patch(store.id, body)
      expect([body, res.status]).toEqual([body, 400])
      expectNoSecrets(res.text)
    }
    expect(await storeOf('set')).toMatchObject({ orderPrefix: 'SCTSET', enabled: true, trackingPageUrl: 'https://kept.example.com/t', shop: shopOf('set') })
  })

  it('answers 404 for an unknown id and 400 for a body that is not an object', async () => {
    expect((await patch('sct-no-such-store', { enabled: false })).status).toBe(404)
    const store = await make()
    expect((await patchStore(request(`/api/stores/${store.id}`, 'super', { method: 'PATCH', body: [1] }), { params: { id: store.id } })).status).toBe(400)
  })

  it('only a Super Admin may change a store', async () => {
    const store = await make()
    for (const who of ['admin', 'support', 'seller']) expect([who, (await patch(store.id, { enabled: false }, who)).status]).toEqual([who, 403])
    expect((await patch(store.id, { enabled: false }, null)).status).toBe(401)
    expect((await storeOf('set'))!.enabled).toBe(true)
  })
})
