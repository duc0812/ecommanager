import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPrintpossOrder, findPrintpossOrder, listPrintpossVariants, PrintpossError, printpossTrackingFor, type PrintpossOrder } from '@/lib/printposs'
import { printpossId } from '@/lib/printposs-shared'
import { canCallApi } from '@/lib/api-access'

const item = { product_variant_id: 501, quantity: 2, design_image_url: 'https://example.com/print.png', mockup_image_url: 'https://example.com/mockup.png' }
const remote = (): PrintpossOrder => ({ order_number: 'PP100', external_order_id: 'TEST100', order_status: 'shipped', payment_status: 'paid', total_cost: 10,
  items: [{ ...item, id: 1 }], packages: [{ id: 2, tracking_number: 'TRACK', carrier: 'USPS', status: 'in_transit', items: [{ order_item_id: 1, quantity: 2 }] }] })
afterEach(() => vi.unstubAllGlobals())

describe('Printposs HTTP', () => {
  it('uses the documented host, bearer header and pagination; never follows returned next URLs', async () => {
    const fetcher = vi.fn(async (input: any, init: RequestInit) => {
      const url = new URL(input)
      expect(url.origin).toBe('https://api.printposs.com')
      expect(init.headers).toMatchObject({ Authorization: 'Bearer secret' })
      expect(init.redirect).toBe('error')
      const page = Number(url.searchParams.get('page'))
      return Response.json({ data: [{ name: 'Case', variants: [{ id: page, sku: `CASE-${page}`, variant_name: 'Case', base_cost: '5.50', is_active: true }] }], meta: { last_page: 2 }, links: { next: 'https://evil.test/steal-token' } })
    })
    vi.stubGlobal('fetch', fetcher)
    expect(await listPrintpossVariants('secret')).toMatchObject([{ id: 1, baseCost: 5.5, active: true }, { id: 2 }])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([500, 408, 409, 422])('keeps uncertain create outcomes locked (%s)', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'external_order_id already exists' }, { status })))
    await expect(createPrintpossOrder('secret', '{}')).rejects.toMatchObject({ unknownOutcome: true })
  })

  it('distinguishes a validation refusal from network and malformed replies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Invalid quantity', errors: { 'items.0.quantity': ['Must be positive'] } }, { status: 422 })))
    await expect(createPrintpossOrder('secret', '{}')).rejects.toMatchObject({ status: 422, unknownOutcome: false })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    await expect(createPrintpossOrder('secret', '{}')).rejects.toMatchObject({ unknownOutcome: true })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>')))
    await expect(createPrintpossOrder('secret', '{}')).rejects.toBeInstanceOf(PrintpossError)
    await expect(createPrintpossOrder('secret', '{}')).rejects.toMatchObject({ unknownOutcome: true })
  })

  it('scans all pages for exact external references', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = new URL(input)
      if (url.pathname.endsWith('/PP100')) return Response.json({ success: true, data: remote() })
      return Response.json({ data: url.searchParams.get('page') === '1' ? [{ external_order_id: 'TEST10', order_number: 'OTHER' }] : [remote()], meta: { last_page: 2 } })
    }))
    expect((await findPrintpossOrder('secret', 'TEST100'))?.order_number).toBe('PP100')
  })

  it('does not accept missing variant arrays as an empty catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 1, name: 'No variants' }] })))
    await expect(listPrintpossVariants('secret')).rejects.toThrow('variants')
  })
})

describe('Printposs tracking identity', () => {
  it('matches items by variant, files and quantity even when remote items are reordered', () => {
    const second = { ...item, product_variant_id: 502, design_image_url: 'https://example.com/other.png' }
    const r = remote()
    r.items.unshift({ ...second, id: 3 })
    r.packages.push({ id: 4, tracking_number: 'OTHER', carrier: 'UPS', status: 'shipped', items: [{ order_item_id: 3, quantity: 2 }] })
    expect(Array.from(printpossTrackingFor([item, second], ['a', 'b'], r))).toEqual([
      ['a', { number: 'TRACK', company: 'USPS' }], ['b', { number: 'OTHER', company: 'UPS' }],
    ])
  })

  it('holds partial quantities, split parcels, missing identities and unpaid orders', () => {
    const r = remote()
    r.packages[0].items![0].quantity = 1
    expect(printpossTrackingFor([item], ['a'], r).size).toBe(0)
    r.packages.push({ id: 3, tracking_number: 'OTHER', carrier: 'UPS', status: 'shipped', items: [{ order_item_id: 1, quantity: 1 }] })
    expect(printpossTrackingFor([item], ['a'], r).size).toBe(0)
    expect(printpossTrackingFor([item, item], ['a', 'b'], remote()).size).toBe(0)
    const unpaid = remote(); unpaid.payment_status = 'unpaid'
    expect(printpossTrackingFor([item], ['a'], unpaid).size).toBe(0)
    const noItems = remote(); delete noItems.packages[0].items
    expect(printpossTrackingFor([item], ['a'], noItems).size).toBe(0)
  })
})

describe('Printposs permissions and IDs', () => {
  it('only permits superadmin token writes and scoped export sends', () => {
    expect(canCallApi('ADMIN', [], '/api/fulfillment/printposs/settings', 'PUT')).toBe('forbidden')
    expect(canCallApi('SUPERADMIN', [], '/api/fulfillment/printposs/settings', 'PUT')).toBe('ok')
    expect(canCallApi('SUPPORT', ['fulfillment_export'], '/api/fulfillment/printposs/orders/o1/push', 'POST')).toBe('ok')
    expect(canCallApi('SELLER', ['fulfillment_export'], '/api/fulfillment/printposs/orders/o1/push', 'POST')).toBe('forbidden')
    expect(canCallApi('SELLER', ['fulfillment_orders'], '/api/fulfillment/printposs/orders/o1/push', 'POST')).toBe('forbidden')
    expect(canCallApi(null, [], '/api/fulfillment/printposs/orders/o1/preview', 'GET')).toBe('unauthenticated')
    for (const bad of [null, '', '1.5', '-1', 0, '9e8', '9007199254740993']) expect(printpossId(bad)).toBeNull()
    expect(printpossId('501')).toBe(501)
  })
})
