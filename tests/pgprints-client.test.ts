import { describe, it, expect, vi, afterEach } from 'vitest'
import { PgprintsError, cancelOrder, createOrder, getBalance, searchOrders, searchProducts, signBody } from '@/lib/pgprints'
import { PublicUrlError, publicArtworkFileName, publicArtworkUrl, requirePublicBaseUrl } from '@/lib/public-artwork'
import { countryCodeOf, countryNameOf, resolveStateCode, splitPersonName, stateCodeFromName } from '@/lib/shipping-address'
import { isPgprintsSupplier } from '@/lib/pgprints-shared'

const CREDS = { storeId: 'store-1', secretKey: 'test-secret' }

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const mock = vi.fn(async (input: any, init?: RequestInit) => impl(String(input), init ?? {}))
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => { vi.unstubAllGlobals() })

describe('signBody', () => {
  it('matches the HMAC-SHA256 base64 reference vector', () => {
    expect(signBody('key', 'The quick brown fox jumps over the lazy dog')).toBe('97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=')
  })

  it('signs the empty body as {}', () => {
    expect(signBody('test-secret', '{}')).toBe('L1kEC2O3IAWYREI52iyaTzq8XENCWbIxJtclFNq4zQk=')
  })
})

describe('pgprints client', () => {
  it('getBalance posts {} signed with the store headers', async () => {
    const mock = stubFetch(() => jsonResponse(200, { success: true, data: { availableAmount: 12.5, pendingAmount: 1, paidAmount: 2, upcomingAmount: 3 } }))
    const balance = await getBalance(CREDS)
    expect(balance).toEqual({ availableAmount: 12.5, pendingAmount: 1, paidAmount: 2, upcomingAmount: 3 })
    const [url, init] = mock.mock.calls[0]
    expect(String(url)).toBe('https://app.pgprints.io/api/v1/users/balance')
    expect(init!.method).toBe('POST')
    expect(init!.body).toBe('{}')
    const headers = init!.headers as Record<string, string>
    expect(headers['X-PGPrints-Store-Id']).toBe('store-1')
    expect(headers['X-PGPrints-Hmac-Sha256']).toBe('L1kEC2O3IAWYREI52iyaTzq8XENCWbIxJtclFNq4zQk=')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('createOrder signs exactly the body it sends and reads the ids and costs', async () => {
    const raw = '{"order_id":"A1","line_items":[]}'
    const mock = stubFetch(() => jsonResponse(200, {
      success: true, data: { id: 'int-1', pgcOrderId: 'PG1-1', orderId: 'A1', totalCost: 9.5, shippingFee: 4, handleFee: 0.5, childDetails: [{ sku: 'UT2-One_size' }] },
    }))
    const { order } = await createOrder(CREDS, raw)
    expect(order).toMatchObject({ id: 'int-1', pgcOrderId: 'PG1-1', orderId: 'A1', totalCost: 9.5, shippingFee: 4, handleFee: 0.5 })
    const [url, init] = mock.mock.calls[0]
    expect(String(url)).toBe('https://app.pgprints.io/app/v1/orders/create')
    expect(init!.body).toBe(raw)
    expect((init!.headers as Record<string, string>)['X-PGPrints-Hmac-Sha256']).toBe(signBody('test-secret', raw))
  })

  it('carries the HTTP status and their message, and never retries a create', async () => {
    const mock = stubFetch(() => jsonResponse(400, { success: false, message: 'Sku not found' }))
    const err = await createOrder(CREDS, '{}').catch(e => e)
    expect(err).toBeInstanceOf(PgprintsError)
    expect(err.status).toBe(400)
    expect(err.message).toBe('Sku not found')
    expect(err.noResponse).toBe(false)
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('treats success:false on a 200 as an error', async () => {
    stubFetch(() => jsonResponse(200, { success: false, message: 'Duplicate order_id' }))
    const err = await createOrder(CREDS, '{}').catch(e => e)
    expect(err).toBeInstanceOf(PgprintsError)
    expect(err.message).toBe('Duplicate order_id')
  })

  it('flags a network failure as "no response" without retrying', async () => {
    const mock = stubFetch(() => { throw new TypeError('fetch failed') })
    const err = await createOrder(CREDS, '{}').catch(e => e)
    expect(err).toBeInstanceOf(PgprintsError)
    expect(err.noResponse).toBe(true)
    expect(err.status).toBe(0)
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('refuses to call without credentials', async () => {
    const mock = stubFetch(() => jsonResponse(200, {}))
    await expect(getBalance({ storeId: '', secretKey: '' })).rejects.toBeInstanceOf(PgprintsError)
    expect(mock).not.toHaveBeenCalled()
  })

  it('cancelOrder is a PUT with the order id', async () => {
    const mock = stubFetch(() => jsonResponse(200, { success: true }))
    await cancelOrder(CREDS, 'PG1-1')
    const [url, init] = mock.mock.calls[0]
    expect(String(url)).toBe('https://app.pgprints.io/api/v1/order/cancel')
    expect(init!.method).toBe('PUT')
    expect(init!.body).toBe('{"orderId":"PG1-1"}')
  })

  it('searchProducts maps file slots, ship classes and variants', async () => {
    const mock = stubFetch(() => jsonResponse(200, {
      success: true,
      data: [{
        sku: 'UT2', name: '20oz Tumbler',
        files: [{ name: 'Main', note: 'PNG, 300 DPI', sizeWidth: 3270, sizeHeight: 1860 }],
        shipClasses: ['US Economy'], variants: [{ sku: 'UT2-One_size' }],
      }],
    }))
    const products = await searchProducts(CREDS, { searchKey: 'UT2' })
    expect(products).toEqual([{
      sku: 'UT2', name: '20oz Tumbler',
      files: [{ name: 'Main', note: 'PNG, 300 DPI', sizeWidth: 3270, sizeHeight: 1860 }],
      shipClasses: ['US Economy'], variants: [{ sku: 'UT2-One_size' }],
    }])
    expect(JSON.parse(mock.mock.calls[0][1]!.body as string)).toEqual({ searchKey: 'UT2', page: 1, size: 20 })
  })

  it('searchOrders maps statuses and per-item tracking', async () => {
    stubFetch(() => jsonResponse(200, {
      success: true,
      data: [{ id: 'i', pgcOrderId: 'PG1-1', orderId: 'A1', itemStatuses: ['cooling-off'], totalCost: 7, childDetails: [{ sku: 'UT2-One_size', status: 'cooling-off', trackingNumber: 'YT1', carrierCode: 'yunexpress' }] }],
    }))
    const orders = await searchOrders(CREDS, { fromTime: 1, toTime: 2, searchKey: 'A1' })
    expect(orders[0]).toMatchObject({ pgcOrderId: 'PG1-1', orderId: 'A1', itemStatuses: ['cooling-off'], totalCost: 7 })
    expect(orders[0].items[0]).toEqual({ sku: 'UT2-One_size', status: 'cooling-off', trackingNumber: 'YT1', carrierCode: 'yunexpress' })
  })
})

describe('requirePublicBaseUrl', () => {
  it('accepts a public https origin and trims the trailing slash', () => {
    expect(requirePublicBaseUrl('https://app.shop-tool.com/')).toBe('https://app.shop-tool.com')
  })

  it.each([
    ['missing', undefined],
    ['empty', '  '],
    ['plain http', 'http://app.shop-tool.com'],
    ['localhost', 'https://localhost:3002'],
    ['http localhost', 'http://localhost:3002'],
    ['loopback ip', 'https://127.0.0.1:3002'],
    ['private lan ip', 'https://192.168.1.20'],
    ['private 10.x ip', 'https://10.0.0.5'],
    ['.local host', 'https://tool.local'],
    ['.test host', 'https://tool.test'],
    ['dotless host', 'https://devbox'],
    ['not a url', 'app.shop-tool.com'],
    ['credentials in url', 'https://user:pw@app.shop-tool.com'],
  ])('refuses %s', (_label, value) => {
    expect(() => requirePublicBaseUrl(value as string | undefined)).toThrow(PublicUrlError)
  })

  it('reads NEXT_PUBLIC_APP_URL when called without an argument', () => {
    const before = process.env.NEXT_PUBLIC_APP_URL
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3002'
    expect(() => requirePublicBaseUrl()).toThrow(PublicUrlError)
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.shop-tool.com'
    expect(requirePublicBaseUrl()).toBe('https://app.shop-tool.com')
    if (before === undefined) delete process.env.NEXT_PUBLIC_APP_URL
    else process.env.NEXT_PUBLIC_APP_URL = before
  })
})

describe('public artwork URL', () => {
  it('keeps a safe file name that already ends in the real extension', () => {
    expect(publicArtworkFileName({ fileName: 'Bản in chính.PNG', mimeType: 'image/png' })).toBe('Ban_in_chinh.PNG')
  })

  it('appends the real extension when the name lies about it', () => {
    expect(publicArtworkFileName({ fileName: 'final.txt', mimeType: 'image/png' })).toBe('final.txt.png')
    expect(publicArtworkFileName({ fileName: 'photo.jpeg', mimeType: 'image/jpeg' })).toBe('photo.jpeg')
  })

  it('builds <base>/api/public/artwork/<token>/<file>', () => {
    const token = 'a'.repeat(64)
    expect(publicArtworkUrl('https://app.shop-tool.com', token, { fileName: 'main.png', mimeType: 'image/png' }))
      .toBe(`https://app.shop-tool.com/api/public/artwork/${token}/main.png`)
  })
})

describe('shipping address helpers', () => {
  it('splits a name so the last word is the last name', () => {
    expect(splitPersonName('Mary Jane Watson')).toEqual({ first: 'Mary Jane', last: 'Watson' })
    expect(splitPersonName('  John   Smith ')).toEqual({ first: 'John', last: 'Smith' })
  })

  it('uses a single word for both first and last name', () => {
    expect(splitPersonName('Cher')).toEqual({ first: 'Cher', last: 'Cher' })
    expect(splitPersonName('')).toEqual({ first: '', last: '' })
    expect(splitPersonName(null)).toEqual({ first: '', last: '' })
  })

  it('maps US state names and CA provinces to 2-letter codes', () => {
    expect(stateCodeFromName('US', 'Colorado')).toBe('CO')
    expect(stateCodeFromName('US', 'new york')).toBe('NY')
    expect(stateCodeFromName('US', 'District of Columbia')).toBe('DC')
    expect(stateCodeFromName('US', 'tx')).toBe('TX')
    expect(stateCodeFromName('CA', 'Québec')).toBe('QC')
    expect(stateCodeFromName('CA', 'British Columbia')).toBe('BC')
    expect(stateCodeFromName('US', 'Atlantis')).toBeNull()
    expect(stateCodeFromName('GB', 'England')).toBeNull()
  })

  it('prefers the stored state code and falls back to the name', () => {
    expect(resolveStateCode({ countryCode: 'US', stateCode: 'ca', state: 'Colorado' })).toBe('CA')
    expect(resolveStateCode({ countryCode: 'US', stateCode: null, state: 'Colorado' })).toBe('CO')
    expect(resolveStateCode({ countryCode: 'GB', stateCode: null, state: 'England' })).toBeNull()
  })

  it('names common countries and falls back to the code', () => {
    expect(countryNameOf('US')).toBe('United States')
    expect(countryNameOf('gb')).toBe('United Kingdom')
    expect(countryNameOf('ZZ')).toBe('ZZ')
    expect(countryCodeOf('us')).toBe('US')
    expect(countryCodeOf('United States')).toBe('US')
    expect(countryCodeOf('Narnia')).toBeNull()
  })
})

describe('isPgprintsSupplier', () => {
  it('matches the supplier code or apiType, case-insensitively', () => {
    expect(isPgprintsSupplier({ code: 'pgprints', apiType: null })).toBe(true)
    expect(isPgprintsSupplier({ code: 'PGPrints', apiType: null })).toBe(true)
    expect(isPgprintsSupplier({ code: 'pg-us', apiType: 'pgprints' })).toBe(true)
    expect(isPgprintsSupplier({ code: 'printway', apiType: null })).toBe(false)
    expect(isPgprintsSupplier(null)).toBe(false)
  })
})
