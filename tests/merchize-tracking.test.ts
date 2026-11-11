import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrder, getOrderDetail, getOrderTracking, MerchizeError, type MerchizeTracking } from '@/lib/merchize'
import { matchMerchizeTracking, type MerchizeTrackingLine } from '@/lib/merchize-tracking'

vi.mock('@/lib/store-settings', () => ({ getStoreSettings: vi.fn(async () => ({})) }))

const credentials = { baseUrl: 'https://bo-group-1-2.merchize.com/example/bo-api', token: 'test-token' }
const parcel = (number: string, items: MerchizeTracking['items'] = []): MerchizeTracking => ({ number, company: 'USPS', url: null, items })
const line = (id: string, sku: string, catalog: string, qty = 1): MerchizeTrackingLine => ({ shopifyLineId: id, sku, catalogSkus: [catalog], qty })
const item = (catalogSku: string, quantity = 1, sku: string | null = null) => ({ sku, catalogSku, quantity })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Merchize tracking API', () => {
  it('uses the tracking endpoint and decodes its array of parcels and item identifiers', async () => {
    const fetch = vi.fn(async () => Response.json({ success: true, data: [{ has_tracking: true, tracking_number: ' 9214490 ', tracking_company: 'USPS', tracking_url: 'https://tracking.example/9214490', items: [{ sku: '', ffm_mapped_catalog_sku: 'CAT-L', quantity: '2', fulfilled_quantity: 1 }] }] }))
    vi.stubGlobal('fetch', fetch)
    expect(await getOrderTracking(credentials, '#LIT 12-R2', 'store&a')).toEqual([{ number: '9214490', company: 'USPS', url: 'https://tracking.example/9214490', items: [{ sku: null, catalogSku: 'CAT-L', quantity: 1 }] }])
    const [input, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
    const url = new URL(String(input))
    expect(url.pathname).toBe('/example/bo-api/order/external/orders/tracking')
    expect(url.searchParams.get('external_number')).toBe('#LIT 12-R2')
    expect(url.searchParams.get('identifier')).toBe('store&a')
    expect(init).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer test-token' }, redirect: 'error', cache: 'no-store' })
  })

  it('reads order status without assuming order-detail contains tracking', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, data: { _id: 'mz-1', code: 'RX-1', order_status: 'shipping', fulfillment_cost: { total: 12, shipping_cost: 4 } } })))
    expect(await getOrderDetail(credentials, 'LIT1', 'LZ')).toEqual({ id: 'mz-1', code: 'RX-1', status: 'shipping', fulfillmentCost: 12, shippingCost: 4 })
  })

  it('does not turn untracked or empty parcels into tracking', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, data: [{ has_tracking: false, tracking_number: 'pending' }, { has_tracking: true, tracking_number: ' ' }, { has_tracking: true }] })))
    expect(await getOrderTracking(credentials, 'LIT1', 'LZ')).toEqual([])
  })

  it('reports a changed response format rather than treating it as an empty tracking list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, data: { tracking_number: 'x' } })))
    await expect(getOrderTracking(credentials, 'LIT1', 'LZ')).rejects.toBeInstanceOf(MerchizeError)
  })

  it('treats Merchize not-yet-fulfilled response as waiting for tracking', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: false, message: 'Order has not fulfilled. Code: RX-1' })))
    expect(await getOrderTracking(credentials, 'LIT1', 'LZ')).toEqual([])
  })

  it('propagates upstream failures instead of returning an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: false, message: 'upstream unavailable' }, { status: 503 })))
    await expect(getOrderTracking(credentials, 'LIT1', 'LZ')).rejects.toMatchObject({ status: 503 })
  })
})

describe('rate-limited Merchize reads', () => {
  it('waits for Retry-After before retrying', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: false }, { status: 429, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(Response.json({ success: true, data: [] }))
    vi.stubGlobal('fetch', fetch)
    const settled = expect(getOrderTracking(credentials, 'LIT1', 'LZ')).resolves.toEqual([])
    await vi.advanceTimersByTimeAsync(1999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await settled
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('bounds retries when the provider keeps rejecting reads', async () => {
    const fetch = vi.fn(async () => Response.json({ success: false }, { status: 429, headers: { 'Retry-After': '0' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(getOrderTracking(credentials, 'LIT1', 'LZ')).rejects.toMatchObject({ status: 429 })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('never retries a paid create after 429', async () => {
    const fetch = vi.fn(async () => Response.json({ success: false }, { status: 429 }))
    vi.stubGlobal('fetch', fetch)
    await expect(createOrder(credentials, '{}')).rejects.toMatchObject({ status: 429 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('matching Merchize parcels to the lines sent in the API push', () => {
  const lines = [line('a', 'DESIGN-A', 'CAT-L'), line('b', 'DESIGN-B', 'CAT-XL')]

  it('matches separate parcels by mapped catalog SKU even with blank customer SKUs', () => {
    const a = parcel('PK-A', [item('CAT-L')]), b = parcel('PK-B', [item('CAT-XL')])
    const result = matchMerchizeTracking(lines, [b, a])
    expect(Array.from(result.byLine)).toEqual([['a', a], ['b', b]])
    expect(result.ambiguous).toBe(false)
  })

  it('does not fulfill an unshipped line just because another line has a parcel', () => {
    const a = parcel('PK-A', [item('CAT-L')])
    expect(Array.from(matchMerchizeTracking(lines, [a]).byLine.keys())).toEqual(['a'])
  })

  it('uses the customer SKU to distinguish two designs on the same catalog variant', () => {
    const same = [line('a', 'DESIGN-A', 'CAT-L'), line('b', 'DESIGN-B', 'CAT-L')]
    const p = parcel('PK-B', [item('CAT-L', 1, 'DESIGN-B')])
    expect(Array.from(matchMerchizeTracking(same, [p]).byLine.keys())).toEqual(['b'])
  })

  it('holds ambiguous variants, partial quantities and conflicting tracking numbers', () => {
    const same = [line('a', 'DESIGN-A', 'CAT-L'), line('b', 'DESIGN-B', 'CAT-L')]
    for (const result of [
      matchMerchizeTracking(same, [parcel('PK', [item('CAT-L')])]),
      matchMerchizeTracking([line('a', 'DESIGN-A', 'CAT-L', 2)], [parcel('PK', [item('CAT-L')])]),
      matchMerchizeTracking([lines[0]], [parcel('PK1', [item('CAT-L')]), parcel('PK2', [item('CAT-L')])]),
    ]) {
      expect(result.byLine.size).toBe(0)
      expect(result.ambiguous).toBe(true)
    }
  })

  it('keeps the established fallback for parcels with no item identifiers', () => {
    const one = parcel('PK'), repeated = parcel('PK'), other = parcel('OTHER')
    expect(matchMerchizeTracking(lines, [one, repeated]).byLine.size).toBe(2)
    expect(matchMerchizeTracking(lines, [one, other])).toMatchObject({ ambiguous: true })
    expect(matchMerchizeTracking(lines, [one, other]).byLine.size).toBe(0)
    expect(matchMerchizeTracking([lines[0]], [one, other]).byLine.get('a')).toBe(one)
  })
})
