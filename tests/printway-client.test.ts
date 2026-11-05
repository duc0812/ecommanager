import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  PrintwayError, cancelOrder, createOrder, e164Phone, findOrder, isPrintwaySupplier, listAllSkus, payOrder, printwayAreaFor, quoteOrder, trackingForLine, type PrintwayTracking,
} from '@/lib/printway'

const BASE = 'https://apis.printway.io/v3'
const TOKEN = 'tok-1'

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const mock = vi.fn(async (input: any, init?: RequestInit) => impl(String(input), init ?? {}))
  vi.stubGlobal('fetch', mock)
  return mock
}

const lastCall = (mock: ReturnType<typeof stubFetch>) => {
  const [url, init] = mock.mock.calls[mock.mock.calls.length - 1] as [any, RequestInit]
  return { url: String(url), init, headers: init.headers as Record<string, string> }
}

afterEach(() => { vi.unstubAllGlobals(); delete process.env.PRINTWAY_API_URL })

describe('isPrintwaySupplier', () => {
  it('matches the supplier code or api type', () => {
    expect(isPrintwaySupplier({ code: 'printway' })).toBe(true)
    expect(isPrintwaySupplier({ code: 'x', apiType: 'Printway' })).toBe(true)
    expect(isPrintwaySupplier({ code: 'bondre' })).toBe(false)
    expect(isPrintwaySupplier(null)).toBe(false)
  })
})

describe('calls', () => {
  it('sends the bearer token to the production API', async () => {
    const mock = stubFetch(() => jsonResponse(200, { data: [] }))
    await listAllSkus(TOKEN)
    const c = lastCall(mock)
    expect(c.url.startsWith(`${BASE}/products/list-sku-catalogs`)).toBe(true)
    expect(c.headers.Authorization).toBe('Bearer tok-1')
  })

  it('goes to the test environment when told to, and nowhere else', async () => {
    process.env.PRINTWAY_API_URL = 'https://uat.printway.work/api/v3'
    const mock = stubFetch(() => jsonResponse(200, { data: [] }))
    await listAllSkus(TOKEN)
    expect(lastCall(mock).url.startsWith('https://uat.printway.work/api/v3/')).toBe(true)

    process.env.PRINTWAY_API_URL = 'https://evil.example.com/v3'
    await expect(listAllSkus(TOKEN)).rejects.toThrow()
  })

  it('treats a refusal in the body as a failure, whatever the HTTP status', async () => {
    stubFetch(() => jsonResponse(200, { status: false, message: 'Invalid sku' }))
    await expect(quoteOrder(TOKEN, {})).rejects.toMatchObject({ message: 'Invalid sku' })
  })

  it('reads the message of an HTTP error', async () => {
    stubFetch(() => jsonResponse(422, { message: 'shipping_zip is required' }))
    await expect(quoteOrder(TOKEN, {})).rejects.toMatchObject({ status: 422, message: 'shipping_zip is required', noResponse: false })
  })

  it('marks a timeout or network failure as unanswered', async () => {
    stubFetch(() => { throw new TypeError('fetch failed') })
    await expect(quoteOrder(TOKEN, {})).rejects.toMatchObject({ noResponse: true })
    await expect(quoteOrder(TOKEN, {})).rejects.toBeInstanceOf(PrintwayError)
  })
})

describe('createOrder', () => {
  const body = JSON.stringify({ order_id: 'LIT1' })

  it('sends the exact body once and returns the Printway order id', async () => {
    const mock = stubFetch(() => jsonResponse(200, { data: { pw_order_id: 'PWN123', order_id: 'LIT1' } }))
    await expect(createOrder(TOKEN, body)).resolves.toMatchObject({ pwOrderId: 'PWN123' })
    const c = lastCall(mock)
    expect(c.url).toBe(`${BASE}/order/create-new-order`)
    expect(c.init.body).toBe(body)
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('never sends a create twice after a network failure', async () => {
    const mock = stubFetch(() => { throw new TypeError('fetch failed') })
    await expect(createOrder(TOKEN, body)).rejects.toMatchObject({ noResponse: true })
    expect(mock).toHaveBeenCalledTimes(1)
  })
})

describe('payOrder', () => {
  it('pays by the Printway order id', async () => {
    const mock = stubFetch(() => jsonResponse(200, { data: { paid: true } }))
    await payOrder(TOKEN, 'PWN123')
    const c = lastCall(mock)
    expect(c.url).toBe(`${BASE}/order/paid`)
    expect(JSON.parse(String(c.init.body))).toEqual({ order_id: 'PWN123' })
  })

  it('reports a refused payment', async () => {
    stubFetch(() => jsonResponse(400, { message: 'Insufficient balance' }))
    await expect(payOrder(TOKEN, 'PWN123')).rejects.toMatchObject({ message: 'Insufficient balance' })
  })
})

describe('cancelOrder', () => {
  it('cancels by the Printway order id', async () => {
    const mock = stubFetch(() => jsonResponse(200, {}))
    await cancelOrder(TOKEN, 'PWN123')
    const c = lastCall(mock)
    expect(c.url).toBe(`${BASE}/order/cancel-order-api`)
    expect(JSON.parse(String(c.init.body))).toEqual({ pw_order_id: 'PWN123' })
  })
})

describe('findOrder', () => {
  it('asks by our order number and reads its status and tracking', async () => {
    const mock = stubFetch(() => jsonResponse(200, { data: {
      pw_order_id: 'PWN123', order_name: 'LIT1', order_status: 'Shipped',
      order_items: [{ item_sku: 'PW-A', tracking_number: 'YT1', carrier_name: 'Yun' }],
    } }))
    const order = await findOrder(TOKEN, 'LIT1')
    expect(new URL(lastCall(mock).url).searchParams.get('order_name')).toBe('LIT1')
    expect(order).toMatchObject({ pwOrderId: 'PWN123', status: 'Shipped' })
    expect(order!.tracking).toEqual([{ number: 'YT1', company: 'Yun', sku: 'PW-A' }])
  })

  it('reads a tracking number on the order itself', async () => {
    stubFetch(() => jsonResponse(200, { data: { pw_order_id: 'PWN1', tracking_number: 'T9', carrier_name: 'USPS' } }))
    expect((await findOrder(TOKEN, 'LIT1'))!.tracking).toEqual([{ number: 'T9', company: 'USPS', sku: null }])
  })

  it('returns null when Printway holds no such order', async () => {
    stubFetch(() => jsonResponse(404, { message: 'Order not found' }))
    await expect(findOrder(TOKEN, 'LIT1')).resolves.toBeNull()
  })

  it('returns null for an empty answer', async () => {
    stubFetch(() => jsonResponse(200, { data: null }))
    await expect(findOrder(TOKEN, 'LIT1')).resolves.toBeNull()
  })

  it('still fails on a real error', async () => {
    stubFetch(() => jsonResponse(500, { message: 'Server error' }))
    await expect(findOrder(TOKEN, 'LIT1')).rejects.toMatchObject({ status: 500 })
  })
})

describe('listAllSkus', () => {
  it('reads SKU rows wherever the list sits in the answer', async () => {
    stubFetch(() => jsonResponse(200, { data: { items: [{ item_sku: 'PW-A', variant_id: 77, product_name: 'Ornament' }] } }))
    await expect(listAllSkus(TOKEN)).resolves.toEqual([{ skuName: 'PW-A', skuCode: '77', productName: 'Ornament' }])
  })
})

describe('trackingForLine', () => {
  const t = (number: string, sku: string | null): PrintwayTracking => ({ number, company: null, sku })

  it('picks the tracking that names the SKU', () => {
    expect(trackingForLine('PW-B', [t('T1', 'PW-A'), t('T2', 'PW-B')])?.number).toBe('T2')
  })

  it('gives every line the only tracking number of the order', () => {
    expect(trackingForLine('PW-B', [t('T1', null)])?.number).toBe('T1')
    expect(trackingForLine('PW-B', [t('T1', 'PW-A'), t('T1', 'PW-C')])?.number).toBe('T1')
  })

  it('does not guess between different numbers', () => {
    expect(trackingForLine('PW-Z', [t('T1', 'PW-A'), t('T2', 'PW-B')])).toBeNull()
  })

  it('has nothing to give before the order ships', () => {
    expect(trackingForLine('PW-A', [])).toBeNull()
  })
})

describe('e164Phone', () => {
  it('keeps an international number, without the spaces', () => {
    expect(e164Phone('+1 303 555 0100', 'US')).toBe('+13035550100')
    expect(e164Phone('+44 7700 900123', 'GB')).toBe('+447700900123')
    expect(e164Phone('0044 7700 900123', 'GB')).toBe('+447700900123')
  })

  it('adds the country code to a local number and drops its leading zero', () => {
    expect(e164Phone('07700 900123', 'GB')).toBe('+447700900123')
    expect(e164Phone('(303) 555-0100', 'US')).toBe('+13035550100')
    expect(e164Phone('0412 345 678', 'AU')).toBe('+61412345678')
    expect(e164Phone('416-555-0199', 'CA')).toBe('+14165550199')
  })

  it('recognises a number already carrying the country code', () => {
    expect(e164Phone('447700900123', 'GB')).toBe('+447700900123')
    expect(e164Phone('13035550100', 'US')).toBe('+13035550100')
  })

  it('gives up on what it cannot make valid', () => {
    expect(e164Phone('', 'GB')).toBeNull()
    expect(e164Phone('12', 'GB')).toBeNull()
    expect(e164Phone('0612345678', 'FR')).toBeNull()
    expect(e164Phone('call me', 'US')).toBeNull()
  })
})

describe('printwayAreaFor', () => {
  it('reads the side from the part name', () => {
    expect(printwayAreaFor('Front', ['Front', 'Back'])).toBe('artwork_front')
    expect(printwayAreaFor('Back', ['Front', 'Back'])).toBe('artwork_back')
    expect(printwayAreaFor('Hood', ['Front', 'Hood'])).toBe('artwork_hood')
  })

  it('takes the only part of a line as the front, whatever its name', () => {
    expect(printwayAreaFor('Print', ['Print'])).toBe('artwork_front')
    expect(printwayAreaFor('LIT5789_1', ['LIT5789_1'])).toBe('artwork_front')
  })

  it('knows no side for an unnamed part of a many-part line', () => {
    expect(printwayAreaFor('Sheet', ['Sheet', 'Other'])).toBeNull()
  })
})
