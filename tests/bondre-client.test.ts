import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  BondreError, cancelOrder, createOrder, findOrder, getAccount, issueToken, isBondreSupplier, listAllSkus, packageForLine, quoteOrder, shippingTypeOf, suggestSku,
  type BondreSession,
} from '@/lib/bondre'

const BASE = 'https://bondre.vip/api/open/v1'

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const mock = vi.fn(async (input: any, init?: RequestInit) => impl(String(input), init ?? {}))
  vi.stubGlobal('fetch', mock)
  return mock
}

function session(token = 'tok-1'): BondreSession & { renewed: number } {
  const s = {
    renewed: 0,
    token: async () => (s.renewed > 0 ? `tok-renewed-${s.renewed}` : token),
    renew: async () => { s.renewed++; return `tok-renewed-${s.renewed}` },
  }
  return s
}

const ok = (data: unknown) => jsonResponse(200, { code: 200, msg: 'Success', requestId: 'r', data })

afterEach(() => { vi.unstubAllGlobals() })

describe('isBondreSupplier', () => {
  it('matches the supplier code or api type', () => {
    expect(isBondreSupplier({ code: 'bondre' })).toBe(true)
    expect(isBondreSupplier({ code: 'x', apiType: 'Bondre' })).toBe(true)
    expect(isBondreSupplier({ code: 'merchize' })).toBe(false)
    expect(isBondreSupplier(null)).toBe(false)
  })
})

describe('issueToken', () => {
  it('logs in with the customer account and returns the token with its expiry', async () => {
    const fetchMock = stubFetch(() => ok({ token: 'abc', tokenType: 'Bearer', expireTime: '2026-11-07T08:00:00Z' }))
    await expect(issueToken('a@b.c', 'pw')).resolves.toEqual({ token: 'abc', expireTime: '2026-11-07T08:00:00Z' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe(`${BASE}/auth/token`)
    expect(JSON.parse(String(init.body))).toEqual({ email: 'a@b.c', password: 'pw' })
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('reports a refused login', async () => {
    stubFetch(() => jsonResponse(401, { code: 401, msg: 'Wrong password' }))
    await expect(issueToken('a@b.c', 'bad')).rejects.toMatchObject({ status: 401, message: 'Wrong password' })
  })
})

describe('calls with a session', () => {
  it('sends the bearer token and returns the data', async () => {
    const fetchMock = stubFetch(() => ok({ businessName: 'TM', availableAmount: 12 }))
    await expect(getAccount(session())).resolves.toMatchObject({ businessName: 'TM', availableAmount: 12 })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe(`${BASE}/account`)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
  })

  it('takes a fresh token once on 401, then gives up', async () => {
    const s = session()
    let n = 0
    const fetchMock = stubFetch((_u, init) => {
      n++
      return (init.headers as Record<string, string>).Authorization === 'Bearer tok-1'
        ? jsonResponse(401, { code: 401, msg: 'Token has expired' })
        : ok({ businessName: 'TM' })
    })
    await expect(getAccount(s)).resolves.toMatchObject({ businessName: 'TM' })
    expect(n).toBe(2)
    expect(s.renewed).toBe(1)

    fetchMock.mockImplementation(async () => jsonResponse(401, { code: 401, msg: 'Token is invalid' }))
    await expect(getAccount(s)).rejects.toMatchObject({ status: 401 })
  })

  it('treats a JSON code other than 200 as a failure, whatever the HTTP status', async () => {
    stubFetch(() => jsonResponse(200, { code: 588, msg: 'Address is not valid' }))
    await expect(getAccount(session())).rejects.toBeInstanceOf(BondreError)
  })

  it('marks a timeout or network failure as unanswered', async () => {
    stubFetch(() => { throw new TypeError('fetch failed') })
    await expect(getAccount(session())).rejects.toMatchObject({ noResponse: true })
  })
})

describe('quoteOrder', () => {
  it('reads the warnings and errors of a quote', async () => {
    stubFetch(() => ok({ preview: true, warnings: ['Remote postcode'], errors: [] }))
    await expect(quoteOrder(session(), '{}')).resolves.toMatchObject({ warnings: ['Remote postcode'], errors: [] })
  })
})

describe('createOrder', () => {
  const body = JSON.stringify({ merchantOrderCode: 'LIT1' })

  it('returns the formal codes of a synced order', async () => {
    const fetchMock = stubFetch(() => ok({ previewId: 81, merchantOrderCode: 'LIT1', autoSync: true, syncStatus: 'SYNCED', orderCode: 'PO-B', orderCodes: ['PO-B', 'PO-C'], previewOrderCodes: ['PO-A'], syncError: null }))
    await expect(createOrder(session(), body)).resolves.toMatchObject({ previewId: 81, syncStatus: 'SYNCED', orderCode: 'PO-B', orderCodes: ['PO-B', 'PO-C'] })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe(`${BASE}/orders`)
    expect(init.body).toBe(body)
  })

  it('returns a failed sync with its preview instead of throwing, so the preview can be cleaned up', async () => {
    stubFetch(() => jsonResponse(422, { code: 588, msg: 'Sync failed', data: { previewId: 90, syncStatus: 'FAILED', orderCode: 'PO-R', orderCodes: [], syncError: 'Out of stock' } }))
    await expect(createOrder(session(), body)).resolves.toMatchObject({ previewId: 90, syncStatus: 'FAILED', syncError: 'Out of stock', orderCodes: [] })
  })

  it('returns an unknown result from a 500 that says so', async () => {
    stubFetch(() => jsonResponse(500, { code: 500, msg: 'Error', data: { previewId: 91, syncStatus: 'UNKNOWN' } }))
    await expect(createOrder(session(), body)).resolves.toMatchObject({ previewId: 91, syncStatus: 'UNKNOWN' })
  })

  it('throws a refusal that made no preview', async () => {
    stubFetch(() => jsonResponse(404, { code: 404, msg: 'SKU Name was not found: X' }))
    await expect(createOrder(session(), body)).rejects.toMatchObject({ status: 404, message: 'SKU Name was not found: X' })
  })

  it('never sends a create twice after a network failure', async () => {
    const fetchMock = stubFetch(() => { throw new TypeError('fetch failed') })
    await expect(createOrder(session(), body)).rejects.toMatchObject({ noResponse: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('findOrder', () => {
  it('finds the formal order by the customer order number and reads its packages', async () => {
    const fetchMock = stubFetch(url => {
      if (url.includes('/orders?')) return ok({ total: 1, rows: [{ orderId: 98221, orderCode: 'PO-B', merchantOrderCode: 'LIT1', status: 'In Production' }] })
      return ok({
        orderId: 98221, orderCode: 'PO-B', merchantOrderCode: 'LIT1', status: 'Shipped', memberOrderIds: [98221, 98222],
        packages: [
          { packageId: 1, orderId: 98221, trackingNo: 'YT1', localTrackingNo: '', packageStatus: 'Shipped', orderItems: [{ skuName: 'Mug / 11oz', quantity: 1 }] },
          { packageId: 2, orderId: 98222, trackingNo: '', localTrackingNo: 'USPS9', packageStatus: 'Shipped', orderItems: [{ skuName: 'Rug / 36in', quantity: 1 }] },
        ],
      })
    })
    const order = await findOrder(session(), 'LIT1')
    expect(order).toMatchObject({ orderId: 98221, orderCode: 'PO-B', status: 'Shipped', memberOrderIds: [98221, 98222] })
    expect(order!.packages.map(p => p.tracking)).toEqual(['YT1', 'USPS9'])
    expect(order!.packages[0].skuNames).toEqual(['Mug / 11oz'])
    expect(String(fetchMock.mock.calls[0][0])).toContain('merchantOrderCode=LIT1')
  })

  it('returns null when Bondre holds no formal order under that number', async () => {
    stubFetch(() => ok({ total: 0, rows: [] }))
    await expect(findOrder(session(), 'LIT1')).resolves.toBeNull()
  })

  it('ignores a row of another customer order number', async () => {
    stubFetch(() => ok({ total: 1, rows: [{ orderId: 5, merchantOrderCode: 'LIT1-R2' }] }))
    await expect(findOrder(session(), 'LIT1')).resolves.toBeNull()
  })
})

describe('cancelOrder', () => {
  it('sends the idempotency key the API requires', async () => {
    const fetchMock = stubFetch(() => ok({}))
    await cancelOrder(session(), 98221, 'key-1')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe(`${BASE}/orders/98221/cancel`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('key-1')
  })
})

describe('listAllSkus', () => {
  it('reads every page', async () => {
    const fetchMock = stubFetch(url => {
      const page = new URL(url).searchParams.get('pageNum')
      return page === '1'
        ? ok({ total: 101, rows: Array.from({ length: 100 }, (_, i) => ({ skuName: `S${i}`, skuCode: `C${i}`, productName: 'P' })) })
        : ok({ total: 101, rows: [{ skuName: 'S100', skuCode: 'C100', productName: 'P' }] })
    })
    const skus = await listAllSkus(session())
    expect(skus).toHaveLength(101)
    expect(skus[100]).toEqual({ skuName: 'S100', skuCode: 'C100', productName: 'P' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('packageForLine', () => {
  const pack = (tracking: string | null, skuNames: string[]) => ({ tracking, skuNames, status: null })

  it('gives every line the only package', () => {
    expect(packageForLine('Mug', [pack('T1', [])])?.tracking).toBe('T1')
  })

  it('picks the package holding the SKU when an order was split', () => {
    const packages = [pack('T1', ['Mug']), pack('T2', ['Rug'])]
    expect(packageForLine('Rug', packages)?.tracking).toBe('T2')
  })

  it('does not guess when a split order does not name the SKU', () => {
    expect(packageForLine('Lamp', [pack('T1', ['Mug']), pack('T2', ['Rug'])])).toBeNull()
  })
})

describe('shippingTypeOf', () => {
  it('reads a name or a number, and falls back to Standard', () => {
    expect(shippingTypeOf('Fast')).toMatchObject({ type: 2, name: 'Fast' })
    expect(shippingTypeOf('usps')).toMatchObject({ type: 4, name: 'USPS' })
    expect(shippingTypeOf('3')).toMatchObject({ type: 3, name: 'Express' })
    expect(shippingTypeOf(null)).toMatchObject({ type: 1, name: 'Standard' })
    expect(shippingTypeOf('')).toMatchObject({ type: 1, name: 'Standard' })
  })

  it('refuses a value Bondre has no method for', () => {
    expect(shippingTypeOf('Overnight')).toBeNull()
  })
})

describe('suggestSku', () => {
  const skus = [
    { skuName: 'Cauldron Mug / 11.5oz', skuCode: 'CM-115', productName: 'Cauldron Mug' },
    { skuName: 'Thick Rug 36IN', skuCode: 'CFXHDD-36IN', productName: 'Rug' },
    { skuName: 'Thick Rug 48IN', skuCode: 'CFXHDD-48IN', productName: 'Rug' },
    { skuName: 'Tree Topper 6 in', skuCode: 'TT-6', productName: 'Tree Topper' },
    { skuName: 'Tree Topper 10 in', skuCode: 'TT-10', productName: 'Tree Topper' },
  ]

  it('takes the exact SKU code first', () => {
    expect(suggestSku({ sku: 'CFXHDD-36IN', productName: 'Foldable Rectangular Thick Flannel Rug', variant1Value: '36IN' }, skus)).toBe('Thick Rug 36IN')
  })

  it('matches the product name with the size', () => {
    expect(suggestSku({ sku: '115OZ', productName: 'Cauldron Mug', variant1Value: '11.5oz' }, skus)).toBe('Cauldron Mug / 11.5oz')
    expect(suggestSku({ sku: '10-IN', productName: 'Tree Topper', variant1Value: '10 in' }, skus)).toBe('Tree Topper 10 in')
  })

  it('suggests nothing without a matching size', () => {
    expect(suggestSku({ sku: '14-IN', productName: 'Tree Topper', variant1Value: '14 in' }, skus)).toBeNull()
  })

  it('suggests nothing for a product it cannot find', () => {
    expect(suggestSku({ sku: 'X', productName: 'Acrylic Light Box', variant1Value: '8IN' }, skus)).toBeNull()
  })
})
