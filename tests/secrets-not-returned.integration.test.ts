import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { canCallApi } from '@/lib/api-access'
import { DEFAULT_ROLE_PERMISSIONS, type FeaturePermission, type UserRole } from '@/lib/roles'
import { maskApiKey, setParcelPanelApiKey } from '@/lib/tracking/parcelpanel-config'
import { saveCsSecrets } from '@/lib/cs/settings'
import { savePgprintsSettings } from '@/lib/pgprints-settings'
import { saveCreativeSecrets } from '@/lib/creative/settings'
import { saveTelegramConfig } from '@/lib/telegram'
import { ordersScopeFixture, SELLER_FEATURES } from './helpers/orders-scope-fixture'

vi.mock('@/lib/telegram', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/telegram')>()),
  sendTelegramMessage: vi.fn(async () => ({ skipped: true })),
}))

import { GET as listSuppliers, POST as createSupplierRoute } from '@/app/api/suppliers/route'
import { GET as getSupplier, PATCH as patchSupplier, DELETE as deleteSupplier } from '@/app/api/suppliers/[id]/route'
import { GET as supplierProducts } from '@/app/api/suppliers/products/route'
import { GET as listOrders } from '@/app/api/fulfillment/orders/route'
import { GET as dsOrder } from '@/app/api/design-studio/orders/[id]/route'
import { GET as listResources, POST as postResource, PATCH as patchResource, DELETE as deleteResource } from '@/app/api/tools/resources/route'
import { POST as revealProxy } from '@/app/api/tools/resources/reveal/route'
import { GET as parcelpanelConfig } from '@/app/api/fulfillment/tracking/parcelpanel-config/route'
import { GET as csSettings } from '@/app/api/cs/settings/route'
import { GET as pgprintsSettings } from '@/app/api/fulfillment/pgprints/settings/route'
import { GET as creativeSettings } from '@/app/api/tools/creative/settings/route'
import { GET as telegramStatus } from '@/app/api/tools/telegram/route'
import { GET as trelloConfig } from '@/app/api/trello/config/route'

const fx = ordersScopeFixture('sec')
const X = 'secx'
const KEY_MARK = 'sk-secx-supplier-marker-93f1'
const PW_MARK = 'pw-secx-proxy-marker-71c2'
const PROXY_ID = `${X}-proxy-1`
const BARE_PROXY_ID = `${X}-proxy-2`
const ACCOUNT_ID = `${X}-account-1`
const PROXY_HOST = 'sec-proxy-1.test'
const EXTRA_EMAILS = ['support-res', 'admin-setup'].map(k => `${X}-${k}@test.local`)
const GONE_EMAILS = ['gone', 'bumped'].map(k => `${X}-${k}@test.local`)
const SETTING_KEYS = [
  'parcelpanel_api_key', 'cs.freshdeskApiKey', 'cs.anthropicApiKey', 'cs.kieApiKey', 'pgprints.storeId', 'pgprints.secretKey',
  'creative.kieApiKey', 'creative.replicateApiToken', 'telegram.botToken', 'telegram.chatId', 'trello.apiKey', 'trello.token',
]
const tokens: Record<string, string> = {}

async function makeUser(key: string, email: string, role: UserRole, permissions: FeaturePermission[]) {
  await prisma.appUser.deleteMany({ where: { email } })
  const row = await prisma.appUser.create({ data: { name: key, email, role, permissions: JSON.stringify(permissions) } })
  tokens[key] = await signToken({ userId: row.id, email, name: key, role, permissions, tv: row.tokenVersion })
  return row
}

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

const params = <T extends Record<string, string>>(p: T) => ({ params: p })
const json = async (res: Response) => ({ status: res.status, text: await res.clone().text(), body: await res.json().catch(() => null) as any })
const storedApiKey = async (id: string) => (await prisma.$queryRaw<{ apiKey: string | null }[]>`SELECT apiKey FROM Supplier WHERE id = ${id}`)[0]?.apiKey ?? null
const orderWithSupplier = fx.orderId('a', 2)

async function seedProxies() {
  await prisma.toolAccount.deleteMany({ where: { id: ACCOUNT_ID } })
  await prisma.resourceProxy.deleteMany({ where: { OR: [{ id: { startsWith: X } }, { host: { startsWith: 'sec-proxy' } }] } })
  await prisma.resourceProxy.create({ data: { id: PROXY_ID, name: 'Proxy one', host: PROXY_HOST, port: '3128', username: 'proxy-user-1', password: PW_MARK, status: 'MAINTAIN' } })
  await prisma.resourceProxy.create({ data: { id: BARE_PROXY_ID, name: 'Proxy two', host: 'sec-proxy-2.test', port: '3129', username: 'proxy-user-2', status: 'MAINTAIN' } })
  await prisma.toolAccount.create({ data: { id: ACCOUNT_ID, email: 'sec-account@example.test', accountCode: 'SEC-1', accountType: 'Via', status: 'ACTIVE', proxyId: PROXY_ID } })
}

async function storedPassword(id = PROXY_ID) {
  return (await prisma.resourceProxy.findUnique({ where: { id } }))?.password ?? null
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await prisma.appUser.deleteMany({ where: { email: { in: [...EXTRA_EMAILS, ...GONE_EMAILS] } } })
  await prisma.supplier.deleteMany({ where: { code: { startsWith: 'SECX' } } })
  await prisma.appSetting.deleteMany({ where: { key: { in: SETTING_KEYS } } })
  await fx.seed()
  Object.assign(tokens, fx.tokens)
  await makeUser('supportRes', EXTRA_EMAILS[0], 'SUPPORT', [...DEFAULT_ROLE_PERMISSIONS.SUPPORT, 'tools_resources'])
  await makeUser('adminSetup', EXTRA_EMAILS[1], 'ADMIN', [...DEFAULT_ROLE_PERMISSIONS.ADMIN, 'setup_store'])
  await prisma.supplier.update({ where: { id: fx.supplierId }, data: { apiKey: KEY_MARK } })
  await prisma.supplierProduct.create({ data: { supplierId: fx.supplierId, sku: 'SECX-SKU', baseCost: 3 } })
  await prisma.order.update({ where: { id: orderWithSupplier }, data: { defaultSupplierId: fx.supplierId } })
})

beforeEach(async () => {
  await prisma.$executeRaw`UPDATE Supplier SET apiKey = ${KEY_MARK}, isActive = 1 WHERE id = ${fx.supplierId}`
  await seedProxies()
})

afterAll(async () => {
  await prisma.toolAccount.deleteMany({ where: { OR: [{ id: ACCOUNT_ID }, { email: { startsWith: 'sec-' } }] } })
  await prisma.resourceProxy.deleteMany({ where: { OR: [{ id: { startsWith: X } }, { host: { startsWith: 'sec-proxy' } }] } })
  await prisma.appUser.deleteMany({ where: { email: { in: [...EXTRA_EMAILS, ...GONE_EMAILS] } } })
  await prisma.supplier.deleteMany({ where: { code: { startsWith: 'SECX' } } })
  await prisma.appSetting.deleteMany({ where: { key: { in: SETTING_KEYS } } })
  await fx.cleanup()
})

describe('Supplier.apiKey', () => {
  it('no response carries a supplier apiKey', async () => {
    const id = fx.supplierId
    const answers = {
      list: await json(await listSuppliers(request('/api/suppliers', 'admin'))),
      listInactive: await json(await listSuppliers(request('/api/suppliers?includeInactive=1', 'admin'))),
      one: await json(await getSupplier(request(`/api/suppliers/${id}`, 'admin'), params({ id }))),
      patched: await json(await patchSupplier(request(`/api/suppliers/${id}`, 'admin', { method: 'PATCH', body: {} }), params({ id }))),
      created: await json(await createSupplierRoute(request('/api/suppliers', 'admin', { method: 'POST', body: { name: 'New one', code: 'SECXNEW', apiKey: KEY_MARK } }))),
      products: await json(await supplierProducts(request(`/api/suppliers/products?supplierId=${id}`, 'admin'))),
      orders: await json(await listOrders(request('/api/fulfillment/orders?pageSize=200', 'admin'))),
      designStudio: await json(await dsOrder(request(`/api/design-studio/orders/${orderWithSupplier}`, 'admin'), params({ id: orderWithSupplier }))),
    }
    for (const [label, answer] of Object.entries(answers)) expect([label, answer.status < 300]).toEqual([label, true])
    for (const [label, answer] of Object.entries(answers)) expect([label, answer.text.includes(KEY_MARK)]).toEqual([label, false])
    for (const label of ['list', 'listInactive', 'one', 'patched', 'products', 'orders', 'designStudio'] as const) {
      expect([label, answers[label].text.includes('SECSUP')]).toEqual([label, true])
    }
    expect(Object.keys(answers.one.body)).not.toContain('apiKey')
    expect(answers.list.body.suppliers.find((s: any) => s.id === id)).not.toHaveProperty('apiKey')
  })

  it('the Prisma client omits it everywhere, nested or not, and gives it back only when a query asks', async () => {
    const id = fx.supplierId
    const nested = [
      await prisma.supplier.findUnique({ where: { id } }),
      await prisma.supplier.findMany({ where: { id }, include: { _count: { select: { products: true } } } }),
      await prisma.supplierProduct.findMany({ where: { supplierId: id }, include: { supplier: true } }),
      await prisma.order.findUnique({ where: { id: orderWithSupplier }, include: { defaultSupplier: true } }),
      await prisma.supplier.update({ where: { id }, data: { note: 'touched' } }),
    ]
    expect(JSON.stringify(nested)).not.toContain(KEY_MARK)
    expect(nested[2]).toHaveLength(1)
    expect(await storedApiKey(id)).toBe(KEY_MARK)
    const asked = await prisma.supplier.findUnique({ where: { id }, omit: { apiKey: false } })
    expect(asked?.apiKey).toBe(KEY_MARK)
  })

  it('supplier writes ignore apiKey', async () => {
    const id = fx.supplierId
    const patched = await json(await patchSupplier(request(`/api/suppliers/${id}`, 'admin', { method: 'PATCH', body: { apiKey: 'x', note: 'new note' } }), params({ id })))
    expect(patched.status).toBe(200)
    expect(patched.body.note).toBe('new note')
    expect(await storedApiKey(id)).toBe(KEY_MARK)

    const created = await json(await createSupplierRoute(request('/api/suppliers', 'admin', { method: 'POST', body: { name: 'Fresh', code: 'SECXFRESH', apiKey: 'smuggled' } })))
    expect(created.status).toBe(201)
    expect(await storedApiKey(created.body.id)).toBeNull()
  })

  it('a seller gets only the id, name and code of each supplier; every other role gets the rows as before', async () => {
    const FULL_ROW = ['_count', 'additionalItemShipFee', 'apiType', 'code', 'createdAt', 'currency', 'firstItemShipFee', 'id', 'isActive', 'name', 'note', 'preferenceRank']
    await prisma.supplier.update({ where: { id: fx.supplierId }, data: { note: 'secx contact: factory@example.test', apiType: 'secx-api', firstItemShipFee: 4.5 } })
    try {
      const rows = async (who: string, url = '/api/suppliers') => {
        const answer = await json(await listSuppliers(request(url, who)))
        expect([who, answer.status]).toEqual([who, 200])
        return answer
      }
      const admin = await rows('admin')
      for (const who of ['sellerA', 'sellerB']) {
        for (const url of ['/api/suppliers', '/api/suppliers?includeInactive=1']) {
          const seller = await rows(who, url)
          expect(seller.body.suppliers.length).toBeGreaterThan(0)
          for (const s of seller.body.suppliers) expect(Object.keys(s).sort()).toEqual(['code', 'id', 'name'])
          expect(seller.text).not.toContain('factory@example.test')
          expect(seller.text).not.toContain('secx-api')
        }
      }
      const seller = await rows('sellerA')
      expect(seller.body.suppliers.find((s: any) => s.id === fx.supplierId)).toEqual({ id: fx.supplierId, name: 'SEC Supplier', code: 'SECSUP' })
      expect(seller.body.suppliers.map((s: any) => s.id)).toEqual(admin.body.suppliers.map((s: any) => s.id))

      for (const who of ['admin', 'supportRes', 'super']) {
        const answer = await rows(who)
        const mine = answer.body.suppliers.find((s: any) => s.id === fx.supplierId)
        expect([who, Object.keys(mine).sort()]).toEqual([who, FULL_ROW])
        expect(mine).toMatchObject({ note: 'secx contact: factory@example.test', apiType: 'secx-api', firstItemShipFee: 4.5, _count: { products: 1, templates: 0 } })
        expect(answer.body).toEqual(admin.body)
      }
    } finally {
      await prisma.supplier.update({ where: { id: fx.supplierId }, data: { note: null, apiType: null, firstItemShipFee: 0 } })
    }
  })

  it('seller can GET /api/suppliers and nothing else under it', async () => {
    const id = fx.supplierId
    const list = await json(await listSuppliers(request('/api/suppliers', 'sellerA')))
    expect(list.status).toBe(200)
    expect(list.text).toContain('SECSUP')
    expect(list.text).not.toContain(KEY_MARK)

    const created = await createSupplierRoute(request('/api/suppliers', 'sellerA', { method: 'POST', body: { name: 'Seller made', code: 'SECXSELLER' } }))
    expect(created.status).toBe(403)
    expect(await prisma.supplier.count({ where: { code: 'SECXSELLER' } })).toBe(0)
    expect((await getSupplier(request(`/api/suppliers/${id}`, 'sellerA'), params({ id }))).status).toBe(403)
    expect((await patchSupplier(request(`/api/suppliers/${id}`, 'sellerA', { method: 'PATCH', body: { name: 'Renamed' } }), params({ id }))).status).toBe(403)
    expect((await deleteSupplier(request(`/api/suppliers/${id}`, 'sellerA', { method: 'DELETE' }), params({ id }))).status).toBe(403)
    expect(await prisma.supplier.findUnique({ where: { id }, select: { name: true, isActive: true } })).toEqual({ name: 'SEC Supplier', isActive: true })

    const everything = DEFAULT_ROLE_PERMISSIONS.ADMIN
    expect(canCallApi('SELLER', SELLER_FEATURES, '/api/suppliers', 'GET')).toBe('ok')
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect([method, canCallApi('SELLER', everything, '/api/suppliers', method)]).toEqual([method, 'forbidden'])
    for (const [method, path] of [
      ['GET', `/api/suppliers/${id}`], ['PATCH', `/api/suppliers/${id}`], ['DELETE', `/api/suppliers/${id}`],
      ['GET', '/api/suppliers/templates'], ['POST', '/api/suppliers/templates'], ['GET', `/api/suppliers/templates/${id}`],
      ['GET', '/api/suppliers/products'], ['PUT', '/api/suppliers/products'], ['DELETE', `/api/suppliers/products/${id}`],
    ] as const) {
      expect([method, path, canCallApi('SELLER', everything, path, method)]).toEqual([method, path, 'forbidden'])
    }
  })
})

describe('proxy credentials', () => {
  it('proxy passwords are not returned', async () => {
    for (const who of ['super', 'admin', 'supportRes']) {
      const { status, text, body } = await json(await listResources(request('/api/tools/resources', who)))
      expect([who, status]).toEqual([who, 200])
      expect([who, text.includes(PW_MARK)]).toEqual([who, false])
      const proxy = body.proxies.find((p: any) => p.id === PROXY_ID)
      expect(proxy).toMatchObject({ username: 'proxy-user-1', hasPassword: true })
      expect(proxy).not.toHaveProperty('password')
      expect(proxy.accounts[0]).toMatchObject({ id: ACCOUNT_ID })
      expect(body.proxies.find((p: any) => p.id === BARE_PROXY_ID)).toMatchObject({ hasPassword: false })
      const account = body.accounts.find((a: any) => a.id === ACCOUNT_ID)
      expect(account.proxy).toMatchObject({ id: PROXY_ID, username: 'proxy-user-1', hasPassword: true })
      expect(account.proxy).not.toHaveProperty('password')
    }
  })

  it('a created or changed proxy comes back without its password', async () => {
    const created = await json(await postResource(request('/api/tools/resources', 'super', {
      method: 'POST', body: { kind: 'proxy', host: 'sec-proxy-new.test', port: '9000', username: 'new-user', password: 'pw-secx-created-5d0e' },
    })))
    expect(created.status).toBe(200)
    expect(created.text).not.toContain('pw-secx-created-5d0e')
    expect(created.body.proxy).toMatchObject({ host: 'sec-proxy-new.test', username: 'new-user', hasPassword: true })
    expect(created.body.proxy).not.toHaveProperty('password')
    expect(await storedPassword(created.body.proxy.id)).toBe('pw-secx-created-5d0e')

    const changed = await json(await patchResource(request('/api/tools/resources', 'super', {
      method: 'PATCH', body: { kind: 'proxy', id: PROXY_ID, host: PROXY_HOST, port: '3128', username: 'proxy-user-1b', password: 'pw-secx-changed-8a4b', status: 'MAINTAIN' },
    })))
    expect(changed.status).toBe(200)
    expect(changed.text).not.toContain('pw-secx-changed-8a4b')
    expect(changed.text).not.toContain(PW_MARK)
    expect(changed.body.proxy).toMatchObject({ username: 'proxy-user-1b', hasPassword: true })
    expect(changed.body.proxy).not.toHaveProperty('password')
    expect(await storedPassword()).toBe('pw-secx-changed-8a4b')
  })

  it('blank password on PATCH keeps the stored one', async () => {
    const base = { kind: 'proxy', id: PROXY_ID, host: PROXY_HOST, port: '3128', username: 'proxy-user-1', status: 'MAINTAIN' }
    for (const extra of [{ password: '' }, { password: '   ' }, {}, { password: null }]) {
      const res = await json(await patchResource(request('/api/tools/resources', 'super', { method: 'PATCH', body: { ...base, ...extra } })))
      expect([JSON.stringify(extra), res.status, res.body.proxy.hasPassword]).toEqual([JSON.stringify(extra), 200, true])
      expect([JSON.stringify(extra), await storedPassword()]).toEqual([JSON.stringify(extra), PW_MARK])
    }
  })

  it('only a superadmin reveals a proxy password', async () => {
    const reveal = (who: string | null, body: unknown) => revealProxy(request('/api/tools/resources/reveal', who, { method: 'POST', body }))
    const ok = await json(await reveal('super', { proxyId: PROXY_ID }))
    expect(ok.status).toBe(200)
    expect(ok.body.password).toBe(PW_MARK)
    expect((await json(await reveal('super', { proxyId: BARE_PROXY_ID }))).body.password).toBeNull()
    expect((await json(await reveal('super', { proxyId: 'nope' }))).status).toBe(404)
    expect((await json(await reveal('super', {}))).status).toBe(400)

    for (const who of ['admin', 'supportRes', 'sellerA']) {
      const denied = await json(await reveal(who, { proxyId: PROXY_ID }))
      expect([who, denied.status]).toEqual([who, 403])
      expect(denied.text).not.toContain(PW_MARK)
    }
    expect((await reveal(null, { proxyId: PROXY_ID })).status).toBe(401)
    expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/tools/resources/reveal', 'POST')).toBe('forbidden')
    expect(canCallApi('SUPERADMIN', [], '/api/tools/resources/reveal', 'POST')).toBe('ok')
  })

  it('resources writes need a superadmin', async () => {
    const body = (extra: object) => ({ kind: 'proxy', host: PROXY_HOST, port: '3128', ...extra })
    const proxies = await prisma.resourceProxy.count()
    const accounts = await prisma.toolAccount.count()

    for (const who of ['admin', 'supportRes']) {
      const attempts = [
        await postResource(request('/api/tools/resources', who, { method: 'POST', body: body({ host: 'sec-proxy-fresh.test', port: '1', username: 'u', password: 'p' }) })),
        await postResource(request('/api/tools/resources', who, { method: 'POST', body: { kind: 'account', email: 'sec-fresh@example.test', accountCode: 'F', accountType: 'Via' } })),
        await patchResource(request('/api/tools/resources', who, { method: 'PATCH', body: body({ id: PROXY_ID, username: 'hijacked', password: 'hijacked' }) })),
        await patchResource(request('/api/tools/resources', who, { method: 'PATCH', body: { kind: 'account', id: ACCOUNT_ID, email: 'hijacked@example.test', accountCode: 'X', accountType: 'Via' } })),
        await deleteResource(request('/api/tools/resources', who, { method: 'DELETE', body: { kind: 'account', id: ACCOUNT_ID } })),
        await deleteResource(request('/api/tools/resources', who, { method: 'DELETE', body: { kind: 'proxy', id: PROXY_ID } })),
      ]
      expect([who, attempts.map(a => a.status)]).toEqual([who, [403, 403, 403, 403, 403, 403]])
    }

    expect(await prisma.resourceProxy.count()).toBe(proxies)
    expect(await prisma.toolAccount.count()).toBe(accounts)
    expect(await prisma.resourceProxy.findUnique({ where: { id: PROXY_ID } })).toMatchObject({ username: 'proxy-user-1', password: PW_MARK })
    expect(await prisma.toolAccount.findUnique({ where: { id: ACCOUNT_ID } })).toMatchObject({ email: 'sec-account@example.test' })

    const deleted = await deleteResource(request('/api/tools/resources', 'super', { method: 'DELETE', body: { kind: 'account', id: ACCOUNT_ID } }))
    expect(deleted.status).toBe(200)
    expect(await prisma.toolAccount.count()).toBe(accounts - 1)

    for (const method of ['POST', 'PATCH', 'DELETE']) {
      expect([method, canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/tools/resources', method)]).toEqual([method, 'forbidden'])
    }
    expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/tools/resources', 'GET')).toBe('ok')
  })
})

describe('the database decides, not the cookie', () => {
  it('a disabled user with a still-valid cookie is refused', async () => {
    const row = await makeUser('gone', GONE_EMAILS[0], 'ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN)
    const ask = async () => [
      (await listSuppliers(request('/api/suppliers', 'gone'))).status,
      (await listResources(request('/api/tools/resources', 'gone'))).status,
    ]
    expect(await ask()).toEqual([200, 200])
    await prisma.appUser.update({ where: { id: row.id }, data: { status: 'INACTIVE' } })
    expect(await ask()).toEqual([401, 401])
  })

  it('a user whose sessions were revoked is refused', async () => {
    const row = await makeUser('bumped', GONE_EMAILS[1], 'ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN)
    expect((await listSuppliers(request('/api/suppliers', 'bumped'))).status).toBe(200)
    await prisma.appUser.update({ where: { id: row.id }, data: { tokenVersion: { increment: 1 } } })
    expect((await listSuppliers(request('/api/suppliers', 'bumped'))).status).toBe(401)
    expect((await listResources(request('/api/tools/resources', 'bumped'))).status).toBe(401)
    expect((await revealProxy(request('/api/tools/resources/reveal', 'bumped', { method: 'POST', body: { proxyId: PROXY_ID } }))).status).toBe(401)
  })

  it('a superadmin who was disabled cannot reveal or write either', async () => {
    const row = await makeUser('gone', GONE_EMAILS[0], 'SUPERADMIN', DEFAULT_ROLE_PERMISSIONS.SUPERADMIN)
    await prisma.appUser.update({ where: { id: row.id }, data: { status: 'INACTIVE' } })
    expect((await revealProxy(request('/api/tools/resources/reveal', 'gone', { method: 'POST', body: { proxyId: PROXY_ID } }))).status).toBe(401)
    expect((await deleteResource(request('/api/tools/resources', 'gone', { method: 'DELETE', body: { kind: 'proxy', id: PROXY_ID } }))).status).toBe(401)
    expect(await prisma.resourceProxy.findUnique({ where: { id: PROXY_ID } })).not.toBeNull()
  })
})

describe('masked settings', () => {
  const PARCEL = 'pp-secx-secret-marker-key-0001'
  const FRESHDESK = 'fd-secx-marker-key-aaaa1111'
  const ANTHROPIC = 'sk-ant-secx-marker-bbbb2222'
  const KIE = 'kie-secx-marker-key-cccc3333'
  const PG_STORE = 'store-secx-12345678'
  const PG_SECRET = 'pgsecret-secx-marker-4444'
  const CREATIVE_KIE = 'creative-kie-marker-dddd5555'
  const REPLICATE = 'r8_secxmarkertoken6666'
  const BOT = '123456:AAsecxTelegramMarkerToken7777'
  const TRELLO_KEY = 'trello-key-secx-marker-eeee8888'
  const TRELLO_TOKEN = 'trello-token-secx-marker-ffff9999'

  beforeAll(async () => {
    await setParcelPanelApiKey(PARCEL)
    await saveCsSecrets({ freshdeskApiKey: FRESHDESK, anthropicApiKey: ANTHROPIC, kieApiKey: KIE })
    await savePgprintsSettings({ storeId: PG_STORE, secretKey: PG_SECRET })
    await saveCreativeSecrets({ kieApiKey: CREATIVE_KIE, replicateToken: REPLICATE })
    await saveTelegramConfig(BOT, '-1001234')
    for (const [key, value] of [['trello.apiKey', TRELLO_KEY], ['trello.token', TRELLO_TOKEN]]) {
      await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
    }
  })

  type View = {
    name: string
    url: string
    get: (req: NextRequest) => Promise<Response>
    staff: string[]
    flags: (body: any) => boolean[]
    masked: (body: any) => Record<string, string | undefined>
    expected: Record<string, string | null>
    secrets: string[]
  }

  const VIEWS: View[] = [
    {
      name: 'ParcelPanel key', url: '/api/fulfillment/tracking/parcelpanel-config', get: parcelpanelConfig, staff: ['admin', 'support'],
      flags: b => [b.configured], masked: b => ({ maskedKey: b.maskedKey }), expected: { maskedKey: maskApiKey(PARCEL) }, secrets: [PARCEL],
    },
    {
      name: 'CS keys', url: '/api/cs/settings', get: csSettings, staff: ['admin', 'support'],
      flags: b => [b.settings.hasFreshdeskApiKey, b.settings.hasAnthropicApiKey, b.settings.hasKieApiKey],
      masked: b => ({ fd: b.settings.freshdeskApiKeyMasked, an: b.settings.anthropicApiKeyMasked, kie: b.settings.kieApiKeyMasked }),
      expected: { fd: maskApiKey(FRESHDESK), an: maskApiKey(ANTHROPIC), kie: maskApiKey(KIE) }, secrets: [FRESHDESK, ANTHROPIC, KIE],
    },
    {
      name: 'PGprints store id', url: '/api/fulfillment/pgprints/settings', get: pgprintsSettings, staff: ['admin', 'support'],
      flags: b => [b.hasStoreId, b.hasSecretKey], masked: b => ({ store: b.storeIdMasked, secret: b.secretKeyMasked }),
      expected: { store: maskApiKey(PG_STORE), secret: '••••••••••••' }, secrets: [PG_STORE, PG_SECRET],
    },
    {
      name: 'Creative keys', url: '/api/tools/creative/settings', get: creativeSettings, staff: ['admin', 'sellerA'],
      flags: b => [b.hasKie, b.hasReplicate], masked: b => ({ kie: b.kieMasked, rep: b.replicateMasked }),
      expected: { kie: maskApiKey(CREATIVE_KIE), rep: maskApiKey(REPLICATE) }, secrets: [CREATIVE_KIE, REPLICATE],
    },
    {
      name: 'Telegram bot', url: '/api/tools/telegram', get: telegramStatus, staff: ['admin', 'supportRes'],
      flags: b => [b.configured], masked: b => ({ bot: b.botTokenMasked }), expected: { bot: `${BOT.slice(0, 6)}...${BOT.slice(-4)}` }, secrets: [BOT],
    },
    {
      name: 'Trello keys', url: '/api/trello/config', get: trelloConfig, staff: ['adminSetup'],
      flags: b => [b.hasApiKey, b.hasToken], masked: b => ({ key: b.apiKeyMasked, token: b.tokenMasked }),
      expected: { key: maskApiKey(TRELLO_KEY), token: maskApiKey(TRELLO_TOKEN) }, secrets: [TRELLO_KEY, TRELLO_TOKEN],
    },
  ]

  it.each(VIEWS)('masked settings go to superadmin only: $name', async view => {
    const mine = await json(await view.get(request(view.url, 'super')))
    expect(mine.status).toBe(200)
    expect(view.flags(mine.body)).not.toContain(false)
    expect(view.masked(mine.body)).toEqual(view.expected)
    for (const secret of view.secrets) expect(mine.text).not.toContain(secret)

    for (const who of view.staff) {
      const theirs = await json(await view.get(request(view.url, who)))
      expect([who, theirs.status]).toEqual([who, 200])
      expect([who, view.flags(theirs.body)]).toEqual([who, view.flags(mine.body)])
      expect([who, Object.values(view.masked(theirs.body)).filter(v => v !== undefined)]).toEqual([who, []])
      for (const shown of [...view.secrets, ...Object.values(view.expected)]) {
        if (shown) expect([who, theirs.text.includes(shown)]).toEqual([who, false])
      }
    }
  })

  it('a disabled user with a still-valid cookie gets none of the settings views', async () => {
    const row = await makeUser('gone', GONE_EMAILS[0], 'ADMIN', [...DEFAULT_ROLE_PERMISSIONS.ADMIN, 'setup_store'])
    await prisma.appUser.update({ where: { id: row.id }, data: { status: 'INACTIVE' } })
    for (const view of VIEWS) expect([view.name, (await view.get(request(view.url, 'gone'))).status]).toEqual([view.name, 401])
  })
})
