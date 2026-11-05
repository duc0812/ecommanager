import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { getStoreConnection, getStoreConnectionByShop, saveStoreCredential, tryStoreConnection } from '@/lib/store-connections'
import { saveOAuthState } from '@/lib/token-store'

vi.mock('@/lib/api-auth', () => ({ requireSuperadmin: vi.fn(async () => ({ user: { id: 'admin' } })) }))

import { GET as startOAuth } from '@/app/api/auth/shopify/route'
import { GET as oauthCallback } from '@/app/api/auth/shopify/callback/route'
import { POST as saveConfig } from '@/app/api/auth/shopify-config/route'
import { GET as getStatus, DELETE as deleteStatus } from '@/app/api/auth/status/route'

const LITZZY = 'caramiaus-store.myshopify.com'
const A = 'oa-a.myshopify.com'
const B = 'oa-b.myshopify.com'
const NEW = 'oa-new.myshopify.com'
const MINE = [LITZZY, A, B, NEW]
const SECRET_A = 'secret-of-store-a'
const SECRET_B = 'secret-of-store-b'

let ids: Record<string, string> = {}
let fetchMock: ReturnType<typeof vi.fn>
const realFetch = global.fetch

async function cleanup() {
  await prisma.shopifyStore.deleteMany({ where: { shop: { in: MINE } } })
}

async function makeStore(shop: string, credential?: Parameters<typeof saveStoreCredential>[1]) {
  const store = await prisma.shopifyStore.create({ data: { shop } })
  ids[shop] = store.id
  if (credential) await saveStoreCredential(store.id, credential)
}

async function twoStores() {
  await makeStore(A, { authMode: 'OAUTH', clientId: 'client-a', clientSecret: SECRET_A, accessToken: 'tok-a' })
  await makeStore(B, { authMode: 'OAUTH', clientId: 'client-b', clientSecret: SECRET_B, accessToken: 'tok-b-old' })
}

function callbackRequest(shop: string, state: string, secret: string, code = 'code-1') {
  const params: Record<string, string> = { code, shop, state, timestamp: '1700000000' }
  const message = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&')
  const hmac = crypto.createHmac('sha256', secret).update(message).digest('hex')
  return new NextRequest(`http://localhost/api/auth/shopify/callback?${new URLSearchParams({ ...params, hmac })}`)
}

async function credentialOf(shop: string) {
  return prisma.shopifyStoreCredential.findUnique({ where: { storeId: ids[shop] } })
}

describe('Shopify OAuth and status per store', () => {
  beforeEach(async () => {
    ids = {}
    await cleanup()
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: 'tok-new', scope: 'read_orders' }), { status: 200 }))
    global.fetch = fetchMock as unknown as typeof fetch
  })
  afterEach(async () => {
    global.fetch = realFetch
    await cleanup()
  })

  it('callback saves the token only on the store in the state', async () => {
    await twoStores()
    saveOAuthState('state-b', B)
    const res = await oauthCallback(callbackRequest(B, 'state-b', SECRET_B))
    expect(res.status).toBe(200)

    expect((await credentialOf(B))?.accessToken).toBe('tok-new')
    expect(await credentialOf(A)).toMatchObject({ accessToken: 'tok-a', clientId: 'client-a', clientSecret: SECRET_A })
    expect(await credentialOf(B)).toMatchObject({ authMode: 'OAUTH', clientId: 'client-b', clientSecret: SECRET_B })

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(`https://${B}/admin/oauth/access_token`)
    expect(JSON.parse(init.body)).toEqual({ client_id: 'client-b', client_secret: SECRET_B, code: 'code-1' })
  })

  it('callback with a shop that differs from the state returns 400 and changes nothing', async () => {
    await twoStores()
    saveOAuthState('state-a', A)
    const res = await oauthCallback(callbackRequest(B, 'state-a', SECRET_B))
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await credentialOf(A))?.accessToken).toBe('tok-a')
    expect((await credentialOf(B))?.accessToken).toBe('tok-b-old')
  })

  it("callback verifies HMAC with that store's secret", async () => {
    await twoStores()
    saveOAuthState('state-b', B)
    const res = await oauthCallback(callbackRequest(B, 'state-b', SECRET_A))
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await credentialOf(A))?.accessToken).toBe('tok-a')
    expect((await credentialOf(B))?.accessToken).toBe('tok-b-old')
  })

  it('callback for a shop with no stored app credentials returns 400', async () => {
    await makeStore(NEW)
    saveOAuthState('state-new', NEW)
    const res = await oauthCallback(callbackRequest(NEW, 'state-new', 'whatever'))
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await credentialOf(NEW)).toBeNull()
  })

  it("reinstall replaces only that store's token", async () => {
    await twoStores()
    const old = new Date('2026-01-01T00:00:00Z')
    await prisma.shopifyStoreCredential.update({ where: { storeId: ids[B] }, data: { connectedAt: old } })
    await prisma.shopifyStore.update({ where: { id: ids[B] }, data: { lastError: 'invalid token', lastErrorAt: new Date() } })

    saveOAuthState('state-1', B)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'tok-b-reinstalled' }), { status: 200 }))
    expect((await oauthCallback(callbackRequest(B, 'state-1', SECRET_B))).status).toBe(200)

    const b = await credentialOf(B)
    expect(b?.accessToken).toBe('tok-b-reinstalled')
    expect(b!.connectedAt.getTime()).toBeGreaterThan(old.getTime())
    expect((await credentialOf(A))?.accessToken).toBe('tok-a')
    const store = await prisma.shopifyStore.findUnique({ where: { id: ids[B] } })
    expect(store).toMatchObject({ lastError: null, lastErrorAt: null })
  })

  it('a failed token exchange leaves the stored token alone', async () => {
    await twoStores()
    saveOAuthState('state-b', B)
    fetchMock.mockResolvedValueOnce(new Response('denied', { status: 400 }))
    const res = await oauthCallback(callbackRequest(B, 'state-b', SECRET_B))
    expect(res.status).toBe(502)
    expect((await credentialOf(B))?.accessToken).toBe('tok-b-old')
  })

  it('the state is single use', async () => {
    await twoStores()
    saveOAuthState('state-b', B)
    expect((await oauthCallback(callbackRequest(B, 'state-b', SECRET_B))).status).toBe(200)
    expect((await oauthCallback(callbackRequest(B, 'state-b', SECRET_B))).status).toBe(400)
  })

  it('status never returns secrets', async () => {
    await twoStores()
    await makeStore(NEW)
    await makeStore(LITZZY, { authMode: 'CLIENT_CREDENTIALS', clientId: 'client-l', clientSecret: 'secret-l', accessToken: 'tok-l', tokenExpiresAt: new Date(Date.now() + 86_400_000) })

    const body = await (await getStatus()).json()
    const text = JSON.stringify(body)
    for (const secret of [SECRET_A, SECRET_B, 'secret-l', 'tok-a', 'tok-b-old', 'tok-l', 'client-a', 'client-l']) {
      expect(text).not.toContain(secret)
    }

    const mine = body.stores.filter((s: any) => MINE.includes(s.shop))
    expect(mine.map((s: any) => s.shop).sort()).toEqual([A, B, LITZZY, NEW].sort())
    expect(Object.keys(mine[0]).sort()).toEqual(['authMode', 'connected', 'connectedAt', 'enabled', 'id', 'lastError', 'lastErrorAt', 'projectName', 'shop'])
    const byShop = Object.fromEntries(mine.map((s: any) => [s.shop, s]))
    expect(byShop[A]).toMatchObject({ id: ids[A], connected: true, authMode: 'OAUTH', enabled: true, projectName: null })
    expect(byShop[NEW]).toMatchObject({ connected: false, authMode: null, connectedAt: null })
  })

  it('status keeps the legacy shopify shape for the Litzzy store', async () => {
    expect((await (await getStatus()).json()).shopify).toEqual({ connected: false })

    await makeStore(LITZZY, { authMode: 'OAUTH', clientId: 'client-l', clientSecret: 'secret-l', accessToken: 'tok-l' })
    const body = await (await getStatus()).json()
    expect(body.shopify).toEqual({ connected: true, shop: LITZZY, connectedAt: expect.any(String) })
    expect(Object.keys(body.shopify)).toEqual(['connected', 'shop', 'connectedAt'])

    await prisma.shopifyStoreCredential.update({ where: { storeId: ids[LITZZY] }, data: { accessToken: null } })
    expect((await (await getStatus()).json()).shopify).toEqual({ connected: false })
  })

  it('a store saved before OAuth finishes is listed as not connected', async () => {
    await makeStore(NEW, { authMode: 'OAUTH', clientId: 'client-n', clientSecret: 'secret-n' })
    const body = await (await getStatus()).json()
    expect(body.stores.find((s: any) => s.shop === NEW)).toMatchObject({ connected: false, authMode: 'OAUTH' })
  })

  it('DELETE status needs a storeId and removes only that store credential', async () => {
    await twoStores()
    const noId = await deleteStatus(new NextRequest('http://localhost/api/auth/status', { method: 'DELETE' }))
    expect(noId.status).toBe(400)
    expect(await credentialOf(B)).not.toBeNull()

    const unknown = await deleteStatus(new NextRequest('http://localhost/api/auth/status?storeId=oa-missing', { method: 'DELETE' }))
    expect(unknown.status).toBe(404)

    const res = await deleteStatus(new NextRequest(`http://localhost/api/auth/status?storeId=${ids[B]}`, { method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect(await credentialOf(B)).toBeNull()
    expect(await prisma.shopifyStore.findUnique({ where: { id: ids[B] } })).not.toBeNull()
    expect((await credentialOf(A))?.accessToken).toBe('tok-a')
  })

  it('shopify-config saves into the credential of that shop and creates the store when missing', async () => {
    await twoStores()
    const res = await saveConfig(new NextRequest('http://localhost/api/auth/shopify-config', {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'client-n', apiSecret: 'secret-n', shop: ` ${NEW.toUpperCase()} ` }),
    }))
    expect(res.status).toBe(200)
    const store = await prisma.shopifyStore.findUnique({ where: { shop: NEW }, include: { credential: true } })
    expect(store?.credential).toMatchObject({ authMode: 'OAUTH', clientId: 'client-n', clientSecret: 'secret-n', accessToken: null })
    expect((await res.json())).toEqual({ ok: true, storeId: store!.id })
    expect(await credentialOf(A)).toMatchObject({ clientId: 'client-a', clientSecret: SECRET_A, accessToken: 'tok-a' })
    expect(await credentialOf(B)).toMatchObject({ clientId: 'client-b', clientSecret: SECRET_B, accessToken: 'tok-b-old' })
  })

  it('shopify-config on a connected store keeps its working token until OAuth replaces it', async () => {
    await twoStores()
    await saveConfig(new NextRequest('http://localhost/api/auth/shopify-config', {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'client-a2', apiSecret: 'secret-a2', shop: A }),
    }))
    expect(await credentialOf(A)).toMatchObject({ authMode: 'OAUTH', clientId: 'client-a2', clientSecret: 'secret-a2', accessToken: 'tok-a' })
  })

  const configRequest = (body: object) => saveConfig(new NextRequest('http://localhost/api/auth/shopify-config', { method: 'POST', body: JSON.stringify(body) }))
  const mintReply = (token: string) => new Response(JSON.stringify({ access_token: token, expires_in: 86399 }), { status: 200 })

  async function ccStore(shop: string) {
    const expiresAt = new Date(Date.now() + 20 * 60 * 60 * 1000)
    await makeStore(shop, { authMode: 'CLIENT_CREDENTIALS', clientId: 'cc-id', clientSecret: 'cc-secret', accessToken: 'tok-cc', tokenExpiresAt: expiresAt })
    return expiresAt
  }

  it('shopify-config with the same id and secret keeps a client-credentials store connected', async () => {
    const expiresAt = await ccStore(A)
    expect((await configRequest({ apiKey: 'cc-id', apiSecret: 'cc-secret', shop: A })).status).toBe(200)
    expect(await credentialOf(A)).toMatchObject({ authMode: 'CLIENT_CREDENTIALS', accessToken: 'tok-cc', tokenExpiresAt: expiresAt })
    expect(await getStoreConnection(ids[A])).toEqual({ storeId: ids[A], shop: A, token: 'tok-cc' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shopify-config with a new secret keeps client-credentials mode and mints with the new secret', async () => {
    await ccStore(A)
    expect((await configRequest({ apiKey: 'cc-id', apiSecret: 'cc-secret-2', shop: A })).status).toBe(200)
    expect(await credentialOf(A)).toMatchObject({ authMode: 'CLIENT_CREDENTIALS', clientSecret: 'cc-secret-2', accessToken: null, tokenExpiresAt: null })

    fetchMock.mockResolvedValueOnce(mintReply('tok-minted'))
    expect((await getStoreConnection(ids[A])).token).toBe('tok-minted')
    expect(new URLSearchParams(String(fetchMock.mock.calls[0][1].body)).get('client_secret')).toBe('cc-secret-2')
  })

  it('shopify-config with a new client id also drops the old token', async () => {
    await ccStore(A)
    await configRequest({ apiKey: 'cc-id-2', apiSecret: 'cc-secret', shop: A })
    expect(await credentialOf(A)).toMatchObject({ authMode: 'CLIENT_CREDENTIALS', clientId: 'cc-id-2', accessToken: null, tokenExpiresAt: null })
  })

  it('the callback flips a client-credentials store to OAuth', async () => {
    await ccStore(A)
    await configRequest({ apiKey: 'cc-id', apiSecret: 'cc-secret-2', shop: A })
    saveOAuthState('state-cc', A)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'tok-oauth' }), { status: 200 }))
    expect((await oauthCallback(callbackRequest(A, 'state-cc', 'cc-secret-2'))).status).toBe(200)
    expect(await credentialOf(A)).toMatchObject({ authMode: 'OAUTH', clientId: 'cc-id', clientSecret: 'cc-secret-2', accessToken: 'tok-oauth', tokenExpiresAt: null })
    expect((await getStoreConnection(ids[A])).token).toBe('tok-oauth')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('the token exchange refuses redirects and has a timeout', async () => {
    await twoStores()
    saveOAuthState('state-b', B)
    expect((await oauthCallback(callbackRequest(B, 'state-b', SECRET_B))).status).toBe(200)
    const init = fetchMock.mock.calls[0][1]
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('a token exchange that cannot reach Shopify returns 502 and keeps the stored token', async () => {
    await twoStores()
    saveOAuthState('state-b', B)
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed: unexpected redirect'))
    const res = await oauthCallback(callbackRequest(B, 'state-b', SECRET_B))
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain(SECRET_B)
    expect((await credentialOf(B))?.accessToken).toBe('tok-b-old')
  })

  it('shopify-config rejects a missing field or an invalid shop', async () => {
    const post = (body: object) => saveConfig(new NextRequest('http://localhost/api/auth/shopify-config', { method: 'POST', body: JSON.stringify(body) }))
    expect((await post({ apiKey: 'k', shop: NEW })).status).toBe(400)
    expect((await post({ apiKey: 'k', apiSecret: 's', shop: 'not-a-shop.example.com' })).status).toBe(400)
    expect(await prisma.shopifyStore.findUnique({ where: { shop: NEW } })).toBeNull()
  })

  it('the OAuth start uses the Client ID of the shop asked for, whatever other shops are configured', async () => {
    await twoStores()
    const res = await startOAuth(new NextRequest(`http://localhost/api/auth/shopify?shop=${B}`))
    expect(res.status).toBe(307)
    const location = new URL(res.headers.get('location')!)
    expect(location.origin).toBe(`https://${B}`)
    expect(location.searchParams.get('client_id')).toBe('client-b')
    expect(new URL(location.searchParams.get('redirect_uri')!).pathname).toBe('/api/auth/shopify/callback')
    const state = location.searchParams.get('state')!
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'tok-via-start' }), { status: 200 }))
    expect((await oauthCallback(callbackRequest(B, state, SECRET_B))).status).toBe(200)
    expect((await credentialOf(B))?.accessToken).toBe('tok-via-start')
  })

  it('the OAuth start refuses a shop with no Client ID', async () => {
    await makeStore(NEW)
    const res = await startOAuth(new NextRequest(`http://localhost/api/auth/shopify?shop=${NEW}`))
    expect(res.status).toBe(400)
    const unknown = await startOAuth(new NextRequest('http://localhost/api/auth/shopify?shop=oa-nobody.myshopify.com'))
    expect(unknown.status).toBe(400)
  })

  it('tryStoreConnection turns a refused store into a value and rethrows anything else', async () => {
    const byShop = () => tryStoreConnection(() => getStoreConnectionByShop(LITZZY))
    expect(await byShop()).toMatchObject({ conn: null, error: { code: 'NOT_CONNECTED', shop: LITZZY } })
    await makeStore(LITZZY, { authMode: 'TOKEN', accessToken: 'tok-l' })
    expect(await byShop()).toMatchObject({ conn: { shop: LITZZY, token: 'tok-l' } })
    await prisma.shopifyStore.update({ where: { id: ids[LITZZY] }, data: { enabled: false } })
    expect(await byShop()).toMatchObject({ conn: null, error: { code: 'DISABLED', shop: LITZZY } })
    await expect(tryStoreConnection(async () => { throw new Error('db down') })).rejects.toThrow('db down')
  })
})
