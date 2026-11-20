import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  LenfulError, createOrder, currentTrackingByItem, designsFor, dollars, getOrder, isLenfulSupplier, methodCodeOf, orderOf, remoteStatusOf, vietnamDay,
} from '@/lib/lenful'
import { itemsOfLines } from '@/lib/repos/lenful-push'

const reply = (status: number, json: unknown) => vi.fn(async () => new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } }))

afterEach(() => { vi.unstubAllGlobals() })

describe('Lenful client helpers', () => {
  it('knows the supplier by code, whatever the case', () => {
    expect(isLenfulSupplier({ code: 'lenful' })).toBe(true)
    expect(isLenfulSupplier({ code: 'Lenful' })).toBe(true)
    expect(isLenfulSupplier({ code: 'other', apiType: 'LENFUL' })).toBe(true)
    expect(isLenfulSupplier({ code: 'catkissfish' })).toBe(false)
  })

  it('reads cents as dollars and names the status in Vietnamese', () => {
    expect(dollars(1450)).toBe(14.5)
    expect(dollars(null)).toBeNull()
    expect(remoteStatusOf({ status: 'processing', paymentStatus: 'paid' })).toBe('Đang sản xuất')
    expect(remoteStatusOf({ status: 'pending', paymentStatus: 'unpaid' })).toBe('Chờ xử lý · Chưa thanh toán')
    expect(remoteStatusOf({ status: 'newstate', paymentStatus: null })).toBe('newstate')
  })

  it('takes only whole numbers as shipping method codes', () => {
    expect(methodCodeOf('0')).toBe(0)
    expect(methodCodeOf(' 12 ')).toBe(12)
    expect(methodCodeOf('Express')).toBeNull()
    expect(methodCodeOf('')).toBeNull()
  })

  it('gives the Vietnam day the order list filters by', () => {
    expect(vietnamDay(new Date('2026-11-19T18:30:00Z'))).toBe('2026-11-20')
    expect(vietnamDay(new Date('2026-11-19T16:30:00Z'))).toBe('2026-11-19')
  })
})

describe('designsFor', () => {
  const positions = [{ code: 'back', label: 'Back', isPrimary: false }, { code: 'front', label: 'Front', isPrimary: true }]
  const file = (area: string) => ({ area, publicUrl: `https://x/${area}.png` })

  it('matches parts by code or label and puts the primary position first', () => {
    expect(designsFor([file('Back'), file('front')], positions)).toEqual({
      designs: [{ position: 'front', design_url: 'https://x/front.png' }, { position: 'back', design_url: 'https://x/Back.png' }], unmatched: [], missingPrimary: null,
    })
  })

  it('names the parts with no position and a missing primary one', () => {
    expect(designsFor([file('Back'), file('Sleeve')], positions)).toEqual({ designs: [{ position: 'back', design_url: 'https://x/Back.png' }], unmatched: ['Sleeve'], missingPrimary: 'Front' })
  })

  it('puts the one file of a one-position product there', () => {
    expect(designsFor([file('Print')], [{ code: 'face', label: null, isPrimary: true }]).designs).toEqual([{ position: 'face', design_url: 'https://x/Print.png' }])
  })
})

describe('tracking', () => {
  it('keeps the current number of each item and drops an item with two current numbers', () => {
    const map = currentTrackingByItem([
      { itemId: 'a', carrier: 'USPS', number: 'OLD', status: null, current: false },
      { itemId: 'a', carrier: 'USPS', number: 'A1', status: null, current: true },
      { itemId: 'b', carrier: 'USPS', number: 'B1', status: null, current: true },
      { itemId: 'b', carrier: 'USPS', number: 'B2', status: null, current: true },
    ])
    expect(Array.from(map.entries()).map(([k, v]) => [k, v.number])).toEqual([['a', 'A1']])
  })

  it('pairs our lines with Lenful items in the order they were sent, and by a unique SKU when the order differs', () => {
    const push = { prevExportJson: JSON.stringify({ lineIds: ['x', 'y'], shopifyLineIds: ['L1', 'L2'] }), requestJson: JSON.stringify({ line_items: [{ sku: 'S1' }, { sku: 'S2' }] }) }
    const order = (skus: string[]) => orderOf({ id: 'o', items: skus.map((sku, i) => ({ id: `i${i}`, sku })) })!
    expect(Array.from(itemsOfLines(push, order(['S1', 'S2'])).entries())).toEqual([['L1', 'i0'], ['L2', 'i1']])
    expect(Array.from(itemsOfLines(push, order(['S2', 'S1'])).entries())).toEqual([['L1', 'i1'], ['L2', 'i0']])
    const same = { ...push, requestJson: JSON.stringify({ line_items: [{ sku: 'S1' }, { sku: 'S1' }] }) }
    expect(itemsOfLines(same, order(['S1', 'S1', 'S1'])).size).toBe(0)
  })
})

describe('answers', () => {
  it('hands back the order a 409 carries on a create', async () => {
    vi.stubGlobal('fetch', reply(409, { success: false, message: 'Order already exists', data: { id: 'o1', code: 'LF-1', external_order_id: 'LIT1', workflow_status: 'pending', items: [] } }))
    expect(await createOrder('k', '{}')).toMatchObject({ duplicate: true, order: { id: 'o1', code: 'LF-1' } })
  })

  it('lists every field error of a 422', async () => {
    vi.stubGlobal('fetch', reply(422, { success: false, message: 'Invalid order', data: { errors: [{ field: 'line_items[0].sku', message: 'unknown SKU' }, { field: 'shipping_address.state_code', message: 'required' }] } }))
    await expect(createOrder('k', '{}')).rejects.toMatchObject({ status: 422, unknownOutcome: false, message: 'Invalid order: line_items[0].sku: unknown SKU; shipping_address.state_code: required' })
  })

  it('reads the 401 the live API sends, which is not the documented envelope', async () => {
    vi.stubGlobal('fetch', reply(401, { error: true, url: 'x', statusCode: 401, statusMessage: 'Server Error', message: 'Invalid API key' }))
    const e = await createOrder('k', '{}').catch(x => x)
    expect(e).toBeInstanceOf(LenfulError)
    expect(e.message).toContain('Invalid API key')
    expect(e.unknownOutcome).toBe(false)
  })

  it('treats a 5xx and an unreadable body as no answer', async () => {
    vi.stubGlobal('fetch', reply(503, { message: 'down' }))
    await expect(createOrder('k', '{}')).rejects.toMatchObject({ unknownOutcome: true })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })))
    await expect(createOrder('k', '{}')).rejects.toMatchObject({ unknownOutcome: true })
  })

  it('says how long to wait on a 429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, message: 'Too many' }), { status: 429, headers: { 'Retry-After': '12' } })))
    await expect(createOrder('k', '{}')).rejects.toMatchObject({ message: expect.stringContaining('12 giây') })
  })

  it('answers null for an order Lenful does not have', async () => {
    vi.stubGlobal('fetch', reply(404, { success: false, message: 'Not found' }))
    expect(await getOrder('k', 'nope')).toBeNull()
  })
})
