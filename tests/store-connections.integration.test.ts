import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { prisma } from '@/lib/db'
import {
  StoreConnectionError,
  getStoreConnection,
  getStoreConnectionByShop,
  listConnectedStores,
  maskCredential,
  mintClientCredentialsToken,
  saveStoreCredential,
} from '@/lib/store-connections'

const A = 'sc-a.myshopify.com'
const B = 'sc-b.myshopify.com'
const OFF = 'sc-off.myshopify.com'
const BARE = 'sc-bare.myshopify.com'
const CC = 'sc-cc.myshopify.com'
const PROJECT = 'sc-project'
const MINE = [A, B, OFF, BARE, CC]
const HOUR = 60 * 60 * 1000

let ids: Record<string, string> = {}
let fetchMock: ReturnType<typeof vi.fn>
const realFetch = global.fetch

function mintReply(token = 'shpat_minted', expiresIn = 86399) {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function cleanup() {
  await prisma.shopifyStore.deleteMany({ where: { shop: { in: MINE } } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
}

async function makeStore(shop: string, data: Record<string, unknown> = {}) {
  const store = await prisma.shopifyStore.create({ data: { shop, ...data } })
  ids[shop] = store.id
  return store
}

async function makeCcStore(expiresAt: Date | null, token: string | null = 'shpat_old') {
  await makeStore(CC)
  await saveStoreCredential(ids[CC], { authMode: 'CLIENT_CREDENTIALS', clientId: 'cid', clientSecret: 'secret', accessToken: token, tokenExpiresAt: expiresAt })
}

describe('store connections', () => {
  beforeEach(async () => {
    ids = {}
    await cleanup()
    fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
  })
  afterEach(async () => {
    global.fetch = realFetch
    await cleanup()
  })

  it("returns the stored token for that store, never another store's", async () => {
    await makeStore(A)
    await makeStore(B)
    await saveStoreCredential(ids[A], { authMode: 'TOKEN', accessToken: 'tok-a' })
    await saveStoreCredential(ids[B], { authMode: 'OAUTH', accessToken: 'tok-b' })
    expect(await getStoreConnection(ids[A])).toEqual({ storeId: ids[A], shop: A, token: 'tok-a' })
    expect(await getStoreConnection(ids[B])).toEqual({ storeId: ids[B], shop: B, token: 'tok-b' })
    expect(await getStoreConnectionByShop(B)).toEqual({ storeId: ids[B], shop: B, token: 'tok-b' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('mints when a client-credentials token is missing or within 1 hour of expiry', async () => {
    await makeCcStore(new Date(Date.now() + 30 * 60 * 1000))
    fetchMock.mockResolvedValue(mintReply('shpat_new', 86399))
    const before = Date.now()
    const conn = await getStoreConnection(ids[CC])
    const after = Date.now()
    expect(conn).toEqual({ storeId: ids[CC], shop: CC, token: 'shpat_new' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(`https://${CC}/admin/oauth/access_token`)
    expect(init.method).toBe('POST')
    const body = new URLSearchParams(String(init.body))
    expect(body.get('grant_type')).toBe('client_credentials')
    expect(body.get('client_id')).toBe('cid')
    expect(body.get('client_secret')).toBe('secret')

    const stored = await prisma.shopifyStoreCredential.findUnique({ where: { storeId: ids[CC] } })
    expect(stored!.accessToken).toBe('shpat_new')
    expect(stored!.tokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(before + 86399 * 1000)
    expect(stored!.tokenExpiresAt!.getTime()).toBeLessThanOrEqual(after + 86399 * 1000)
  })

  it('mints when the client-credentials token is missing altogether', async () => {
    await makeCcStore(null, null)
    fetchMock.mockResolvedValue(mintReply('shpat_first'))
    expect((await getStoreConnection(ids[CC])).token).toBe('shpat_first')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not mint when more than 1 hour remains', async () => {
    await makeCcStore(new Date(Date.now() + 2 * HOUR))
    const conn = await getStoreConnection(ids[CC])
    expect(conn.token).toBe('shpat_old')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never mints for a token or oauth store, however old', async () => {
    await makeStore(A)
    await saveStoreCredential(ids[A], { authMode: 'OAUTH', accessToken: 'tok-a', tokenExpiresAt: new Date(Date.now() - HOUR) })
    expect((await getStoreConnection(ids[A])).token).toBe('tok-a')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('two concurrent calls mint once', async () => {
    await makeCcStore(new Date(Date.now() - HOUR))
    fetchMock.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 30))
      return mintReply('shpat_once')
    })
    const [one, two] = await Promise.all([getStoreConnection(ids[CC]), getStoreConnectionByShop(CC)])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(one.token).toBe('shpat_once')
    expect(two.token).toBe('shpat_once')
  })

  it('a minted token is reused by the next call', async () => {
    await makeCcStore(new Date(Date.now() - HOUR))
    fetchMock.mockResolvedValue(mintReply('shpat_once'))
    await getStoreConnection(ids[CC])
    expect((await getStoreConnection(ids[CC])).token).toBe('shpat_once')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a failed mint throws MINT_FAILED and keeps the old token', async () => {
    const stale = new Date(Date.now() + 10 * 60 * 1000)
    await makeCcStore(stale)
    await makeStore(A)
    await saveStoreCredential(ids[A], { authMode: 'TOKEN', accessToken: 'tok-a' })
    fetchMock.mockResolvedValue(new Response('{"error":"invalid_client"}', { status: 400 }))

    const error = await getStoreConnection(ids[CC]).then(() => null, e => e)
    expect(error).toBeInstanceOf(StoreConnectionError)
    expect(error).toMatchObject({ code: 'MINT_FAILED', shop: CC, storeId: ids[CC] })
    expect(String(error.message)).not.toContain('secret')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain(CC)

    const stored = await prisma.shopifyStoreCredential.findUnique({ where: { storeId: ids[CC] } })
    expect(stored!.accessToken).toBe('shpat_old')
    expect(stored!.tokenExpiresAt!.getTime()).toBe(stale.getTime())

    fetchMock.mockClear()
    expect((await getStoreConnection(ids[A])).token).toBe('tok-a')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a mint reply without a token is a failed mint', async () => {
    await makeCcStore(null, null)
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await expect(getStoreConnection(ids[CC])).rejects.toMatchObject({ code: 'MINT_FAILED', shop: CC })
  })

  it('a network error while minting is MINT_FAILED too', async () => {
    await makeCcStore(null, null)
    fetchMock.mockRejectedValue(new Error('socket hang up'))
    await expect(getStoreConnection(ids[CC])).rejects.toMatchObject({ code: 'MINT_FAILED', shop: CC })
  })

  it('after a failed mint the next call tries again', async () => {
    await makeCcStore(null, null)
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }))
    await expect(getStoreConnection(ids[CC])).rejects.toMatchObject({ code: 'MINT_FAILED' })
    fetchMock.mockResolvedValueOnce(mintReply('shpat_retry'))
    expect((await getStoreConnection(ids[CC])).token).toBe('shpat_retry')
  })

  it('disabled store throws DISABLED', async () => {
    await makeStore(OFF, { enabled: false })
    await saveStoreCredential(ids[OFF], { authMode: 'TOKEN', accessToken: 'tok-off' })
    await expect(getStoreConnection(ids[OFF])).rejects.toMatchObject({ code: 'DISABLED', shop: OFF, storeId: ids[OFF] })
    await expect(getStoreConnectionByShop(OFF)).rejects.toMatchObject({ code: 'DISABLED' })
  })

  it('store without credential throws NOT_CONNECTED', async () => {
    await makeStore(BARE)
    await expect(getStoreConnection(ids[BARE])).rejects.toMatchObject({ code: 'NOT_CONNECTED', shop: BARE })
  })

  it('a credential without a token throws NOT_CONNECTED', async () => {
    await makeStore(A)
    await saveStoreCredential(ids[A], { authMode: 'TOKEN', accessToken: null })
    await expect(getStoreConnection(ids[A])).rejects.toMatchObject({ code: 'NOT_CONNECTED', shop: A })
  })

  it('an unknown store or shop throws NOT_CONNECTED', async () => {
    await expect(getStoreConnection('sc-missing')).rejects.toBeInstanceOf(StoreConnectionError)
    await expect(getStoreConnectionByShop('sc-missing.myshopify.com')).rejects.toMatchObject({ code: 'NOT_CONNECTED', shop: 'sc-missing.myshopify.com' })
  })

  it('listConnectedStores skips disabled stores and stores with no credential', async () => {
    await prisma.project.create({ data: { id: PROJECT, name: 'SC Project', startDate: new Date('2026-01-01') } })
    await makeStore(A, { orderPrefix: 'SCA', ianaTimezone: 'America/New_York', projectId: PROJECT, payoutStartDate: '2026-02-01', trackingPageUrl: 'https://a.example/track?nums=' })
    await makeStore(OFF, { enabled: false })
    await makeStore(BARE)
    await saveStoreCredential(ids[A], { authMode: 'TOKEN', accessToken: 'tok-a' })
    await saveStoreCredential(ids[OFF], { authMode: 'TOKEN', accessToken: 'tok-off' })

    const mine = (await listConnectedStores()).filter(s => MINE.includes(s.shop))
    expect(mine).toEqual([{
      id: ids[A],
      shop: A,
      orderPrefix: 'SCA',
      ianaTimezone: 'America/New_York',
      projectId: PROJECT,
      projectName: 'SC Project',
      payoutStartDate: '2026-02-01',
      trackingPageUrl: 'https://a.example/track?nums=',
    }])
  })

  it('listConnectedStores never exposes credentials and does not mint', async () => {
    await makeCcStore(null, null)
    const listed = (await listConnectedStores()).find(s => s.shop === CC)
    expect(listed).toBeTruthy()
    expect(JSON.stringify(listed)).not.toContain('secret')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('saveStoreCredential replaces the credential and keeps one row per store', async () => {
    await makeStore(A)
    await saveStoreCredential(ids[A], { authMode: 'TOKEN', accessToken: 'tok-1' })
    await saveStoreCredential(ids[A], { authMode: 'CLIENT_CREDENTIALS', clientId: 'cid', clientSecret: 'sec', accessToken: 'tok-2', tokenExpiresAt: new Date(Date.now() + 5 * HOUR) })
    expect(await prisma.shopifyStoreCredential.count({ where: { storeId: ids[A] } })).toBe(1)
    const stored = await prisma.shopifyStoreCredential.findUnique({ where: { storeId: ids[A] } })
    expect(stored).toMatchObject({ authMode: 'CLIENT_CREDENTIALS', clientId: 'cid', clientSecret: 'sec', accessToken: 'tok-2' })
  })

  it('mintClientCredentialsToken returns the token and an expiry from expires_in', async () => {
    fetchMock.mockResolvedValue(mintReply('shpat_x', 3600))
    const before = Date.now()
    const out = await mintClientCredentialsToken(A, 'cid', 'sec')
    expect(out.token).toBe('shpat_x')
    expect(out.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000)
    expect(out.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 3600 * 1000)
  })

  it('mintClientCredentialsToken refuses a shop that is not a public https host', async () => {
    await expect(mintClientCredentialsToken('localhost', 'cid', 'sec')).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('maskCredential', () => {
  it('never returns the full value', () => {
    for (const value of ['shpat_0123456789abcdef', 'abcdefghi', 'short', 'x']) {
      const masked = maskCredential(value)
      expect(masked).not.toBe(value)
      expect(masked).not.toContain(value)
    }
    expect(maskCredential('shpat_0123456789abcdef')).toBe('shpa…cdef')
  })
  it('returns null for an empty value', () => {
    expect(maskCredential(null)).toBeNull()
    expect(maskCredential('')).toBeNull()
  })
})
