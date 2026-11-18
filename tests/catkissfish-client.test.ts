import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CatkissfishError, cancelOrder, createAutoDesignOrder, designListFor, findOrder, formatAccepted, getOrder, getProductDetail, getTrackingNumbers, hasLeftFactory,
  isCatkissfishSupplier, issueToken, phoneParts, pickVariant, shippingOf, singleTracking, styleCodeOf,
  type CatkissfishSession, type CkfProduct,
} from '@/lib/catkissfish'

const BASE = 'https://www.catkissfish.com/website'
type Reply = { status?: number; json?: unknown; text?: string } | 'network-error'
type Seen = { url: URL; init: RequestInit }
let seen: Seen[] = []
let replies: Reply[] = []

const ok = (data: unknown): Reply => ({ json: { code: 0, message: '', data } })

function session(token = 'tok-1'): CatkissfishSession & { renewed: number } {
  const s = { renewed: 0, token: async () => token, renew: async () => { s.renewed++; return 'tok-2' } }
  return s
}

const headerOf = (c: Seen, name: string) => (c.init.headers as Record<string, string>)[name]

beforeEach(() => {
  seen = []
  replies = []
  vi.stubGlobal('fetch', vi.fn(async (input: any, init: RequestInit = {}) => {
    seen.push({ url: new URL(String(input)), init })
    const r = replies.shift() ?? ok({})
    if (r === 'network-error') throw new TypeError('fetch failed')
    return new Response(r.text ?? JSON.stringify(r.json), { status: r.status ?? 200 })
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('naming helpers', () => {
  it('knows the supplier by code or api type', () => {
    expect(isCatkissfishSupplier({ code: 'catkissfish' })).toBe(true)
    expect(isCatkissfishSupplier({ code: 'x', apiType: 'CatKissFish' })).toBe(true)
    expect(isCatkissfishSupplier({ code: 'bondre' })).toBe(false)
    expect(isCatkissfishSupplier(null)).toBe(false)
  })

  it('reads a carrier by id or name, and refuses one CatKissFish does not list', () => {
    expect(shippingOf('usps')).toEqual({ id: '90JFKFC', name: 'USPS' })
    expect(shippingOf('60VQCAA')?.name).toBe('YUNTU')
    expect(shippingOf('Overnight')).toBeNull()
    expect(shippingOf('')).toBeNull()
  })

  it('treats an API SKU that repeats the tool SKU as not set, which is how the scarf SKU is stored', () => {
    expect(styleCodeOf({ sku: 'CKF-KNIT-SCARF-35X193', apiSku: 'CKF-KNIT-SCARF-35X193' })).toBe('Scarf & Silk Scarf1-14')
    expect(styleCodeOf({ sku: 'CKF-KNIT-SCARF-35X193', apiSku: null })).toBe('Scarf & Silk Scarf1-14')
    expect(styleCodeOf({ sku: 'CKF-KNIT-SCARF-35X193', apiSku: 'Other Style' })).toBe('Other Style')
    expect(styleCodeOf({ sku: 'NEW', apiSku: 'NEW' })).toBeNull()
  })
})

describe('issueToken', () => {
  it('posts the key as multipart and reads the token from data', async () => {
    replies = [ok({ access_token: 'abc', expires_in: 7200 })]
    const before = Date.now()
    const t = await issueToken('id-1', 'secret-1')
    expect(seen[0].url.href).toBe(`${BASE}/oauth2/client_token`)
    const form = seen[0].init.body as FormData
    expect([form.get('grant_type'), form.get('client_id'), form.get('client_secret')]).toEqual(['client_credentials', 'id-1', 'secret-1'])
    expect(t.token).toBe('abc')
    expect(new Date(t.expiresAt).getTime()).toBeGreaterThanOrEqual(before + 7200_000)
  })

  it('reads the answer the live API gives: code 200 and client_token', async () => {
    replies = [{ json: { code: 200, msg: 'ok', data: { client_token: 'live-token', expires_in: 7200, client_id: 'id' } } }]
    expect((await issueToken('id', 'secret')).token).toBe('live-token')
  })

  it('also reads a token at the top level and assumes the documented 2 hours', async () => {
    replies = [{ json: { access_token: 'top' } }]
    const t = await issueToken('id', 'secret')
    expect(t.token).toBe('top')
    expect(new Date(t.expiresAt).getTime() - Date.now()).toBeGreaterThan(7100_000)
  })

  it('says plainly when the account has no developer permission', async () => {
    replies = [{ json: { code: 10000, message: 'nope' } }]
    await expect(issueToken('id', 'secret')).rejects.toThrow(/chưa có quyền dùng Open API/)
  })

  it('refuses an answer without a token', async () => {
    replies = [ok({})]
    await expect(issueToken('id', 'secret')).rejects.toThrow(/không trả về access token/)
  })

  it('never repeats the key in the error', async () => {
    replies = [{ status: 400, json: { code: 400, message: 'bad client my-client-id / my-secret-value' } }]
    const e = await issueToken('my-client-id', 'my-secret-value').catch(x => x)
    expect(e.message).toBe('bad client *** / ***')
  })
})

describe('answers', () => {
  it('sends the token in the access-token header', async () => {
    replies = [ok({ id: '9', state: 1 })]
    await getOrder(session(), '9')
    expect(headerOf(seen[0], 'access-token')).toBe('tok-1')
    expect(seen[0].url.pathname).toBe('/website/open/api/order/detail')
    expect(seen[0].url.searchParams.get('id')).toBe('9')
  })

  it('counts a non-zero code as a refusal, with a known outcome', async () => {
    replies = [{ json: { code: 500100, message: 'Bad address' } }]
    const e = await createAutoDesignOrder(session(), '{}').catch(x => x)
    expect(e).toBeInstanceOf(CatkissfishError)
    expect(e).toMatchObject({ message: 'Bad address', code: 500100, unknownOutcome: false })
  })

  it.each<[string, Reply]>([
    ['no connection', 'network-error'],
    ['a server error', { status: 502, text: '<html>bad gateway</html>' }],
    ['a 200 that is not JSON', { text: '<html>ok</html>' }],
    ['a 200 without the code envelope', { json: { hello: 1 } }],
  ])('leaves the outcome unknown on %s, and does not send again', async (_name, reply) => {
    replies = [reply]
    const s = session()
    await expect(createAutoDesignOrder(s, '{}')).rejects.toMatchObject({ unknownOutcome: true })
    expect(seen).toHaveLength(1)
    expect(s.renewed).toBe(0)
  })

  it.each<[string, Reply]>([
    ['a 401', { status: 401, json: { code: 401, message: 'unauthorized' } }],
    ['the no-permission code', { json: { code: 10000, message: 'denied' } }],
    ['the live bad-token answer', { json: { code: 6007, message: 'You do not have permission to access.' } }],
    ['a message about the token', { json: { code: 4001, message: 'access-token expired' } }],
  ])('gets a new token once after %s', async (_name, reply) => {
    replies = [reply, ok({})]
    const s = session()
    await createAutoDesignOrder(s, '{"a":1}')
    expect(s.renewed).toBe(1)
    expect(seen.map(c => headerOf(c, 'access-token'))).toEqual(['tok-1', 'tok-2'])
    expect(seen[1].init.body).toBe('{"a":1}')
  })

  it('names the code of a refusal that carries no message', async () => {
    replies = [{ json: { code: 1000 } }]
    await expect(getProductDetail(session(), 'NO-STYLE')).rejects.toThrow('CatKissFish báo lỗi mã 1000')
  })

  it('still treats code 200 as a refusal outside the token call', async () => {
    replies = [{ json: { code: 200, msg: 'ok', data: {} } }]
    await expect(createAutoDesignOrder(session(), '{}')).rejects.toMatchObject({ code: 200, unknownOutcome: false })
  })

  it('does not ask for a new token after an ordinary refusal', async () => {
    replies = [{ json: { code: 7, message: 'Bad style' } }]
    const s = session()
    await expect(createAutoDesignOrder(s, '{}')).rejects.toThrow('Bad style')
    expect(s.renewed).toBe(0)
  })
})

describe('findOrder', () => {
  const rows = (...records: unknown[]) => [ok({ total: records.length, records })]

  it('filters by our number and checks the number on the row', async () => {
    replies = rows({ id: '1', shopOrderId: 'OTHER', state: 2 }, { id: '2', shopOrderId: 'REMI1', state: 1 })
    expect(await findOrder(session(), 'REMI1')).toEqual({ id: '2', platformOrderId: 'REMI1', state: 1, stateLabel: 'Chưa thanh toán' })
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ pageNum: 1, pageSize: 20, platformOrderId: 'REMI1' })
  })

  it('never takes another order for ours', async () => {
    replies = rows({ id: '1', shopOrderId: 'OTHER', state: 2 })
    expect(await findOrder(session(), 'REMI1')).toBeNull()
  })

  it('prefers a live order to a cancelled one under the same number', async () => {
    replies = rows({ id: '1', shopOrderId: 'REMI1', state: 6 }, { id: '2', shopOrderId: 'REMI1', state: 3 })
    expect((await findOrder(session(), 'REMI1'))?.id).toBe('2')
  })

  it('trusts the filter for a lone row that carries no number', async () => {
    replies = rows({ id: '5', state: 2 })
    expect((await findOrder(session(), 'REMI1'))?.id).toBe('5')
  })

  it('finds nothing in an empty page', async () => {
    replies = rows()
    expect(await findOrder(session(), 'REMI1')).toBeNull()
  })
})

describe('product, cancel and tracking', () => {
  it('reads the product by style code', async () => {
    replies = [ok({
      name: 'Knit Scarf', styleCode: 'Scarf & Silk Scarf1-14',
      colorSizeInfoList: [{ color: 'White', size: 'One Size', saleState: true }],
      colorInfoList: [{ colorEnName: 'White' }], sizeNameList: ['One Size'],
      dimensions: [{ fieldName: 'Design_1', name: 'Body', supportUploadFormat: '0,1' }, { name: 'no field' }],
    })]
    const p = await getProductDetail(session(), 'Scarf & Silk Scarf1-14')
    expect(seen[0].url.searchParams.get('styleCode')).toBe('Scarf & Silk Scarf1-14')
    expect(p).toMatchObject({ name: 'Knit Scarf', colors: ['White'], sizes: ['One Size'] })
    expect(p?.dimensions).toEqual([{ fieldName: 'Design_1', name: 'Body', supportUploadFormat: '0,1' }])
  })

  it('cancels by order id', async () => {
    await cancelOrder(session(), '77')
    expect(seen[0].url.pathname).toBe('/website/open/api/order/cancel')
    expect(seen[0].url.searchParams.get('id')).toBe('77')
  })

  it('skips tracking rows without a number', async () => {
    replies = [ok([{ logisticName: 'USPS', logisticKey: 'usps', logisticNumber: '9400' }, { logisticName: 'USPS', logisticNumber: '' }])]
    expect(await getTrackingNumbers(session(), '1')).toEqual([{ name: 'USPS', key: 'usps', number: '9400' }])
  })

  it('names a tracking number only when the order has exactly one', () => {
    const t = (number: string) => ({ name: null, key: null, number })
    expect(singleTracking([t('A')])?.number).toBe('A')
    expect(singleTracking([t('A'), t('A')])?.number).toBe('A')
    expect(singleTracking([t('A'), t('B')])).toBeNull()
    expect(singleTracking([])).toBeNull()
  })

  it('reads tracking only once the parcel left, or when the state is missing', () => {
    expect([1, 2, 3, 7].map(hasLeftFactory)).toEqual([false, false, false, false])
    expect([4, 5, null].map(hasLeftFactory)).toEqual([true, true, true])
  })
})

describe('pickVariant', () => {
  const product = (over: Partial<CkfProduct>): CkfProduct => ({ name: null, styleCode: null, dimensions: [], variants: [], colors: [], sizes: [], ...over })

  it('uses CatKissFish spelling for the color and size of the blank', () => {
    const p = product({ colors: ['White', 'Black'], sizes: ['S', 'M'] })
    expect(pickVariant(p, { color: 'white', size: 's' })).toEqual({ color: 'White', size: 'S', problem: null })
  })

  it('needs no match when the product has one color and one size', () => {
    const p = product({ colors: ['Natural'], sizes: ['ONE'] })
    expect(pickVariant(p, { color: 'white', size: 'Unisize' })).toEqual({ color: 'Natural', size: 'ONE', problem: null })
  })

  it('keeps the SKU values when CatKissFish lists none, as a print-on-demand style may', () => {
    expect(pickVariant(product({}), { color: 'white', size: 'Unisize' })).toEqual({ color: 'white', size: 'Unisize', problem: null })
  })

  it('names the options when the blank is not one of them', () => {
    expect(pickVariant(product({ colors: ['Red', 'Blue'], sizes: ['S'] }), { color: 'white', size: 'S' }).problem).toMatch(/Red, Blue/)
  })

  it('refuses a variant CatKissFish stopped selling', () => {
    const p = product({ colors: ['White'], sizes: ['S'], variants: [{ color: 'White', size: 'S', saleState: false }] })
    expect(pickVariant(p, { color: 'white', size: 's' }).problem).toMatch(/ngừng bán/)
  })
})

describe('designListFor', () => {
  const dim = (fieldName: string, name: string | null = null) => ({ fieldName, name, supportUploadFormat: null })
  const print = (area: string) => ({ area, publicUrl: `https://x/${area}` })

  it('sends one unnamed file to a style with no design areas', () => {
    expect(designListFor([print('Print')], []).list).toEqual([{ imageUrl: 'https://x/Print' }])
  })

  it('does not drop a second file silently when the style has no areas', () => {
    expect(designListFor([print('Print'), print('Back')], []).unmatched).toEqual(['Back'])
  })

  it('puts the one file on the one area whatever its name', () => {
    expect(designListFor([print('Print')], [dim('Design_1')]).list).toEqual([{ printableDesignArea: 'Design_1', imageUrl: 'https://x/Print' }])
  })

  it('matches several parts to areas by name and reports the rest', () => {
    const r = designListFor([print('Front'), print('Hood')], [dim('Design_1', 'front'), dim('Back')])
    expect(r.list).toEqual([{ printableDesignArea: 'Design_1', imageUrl: 'https://x/Front' }])
    expect(r.unmatched).toEqual(['Hood'])
    expect(r.unfilled).toEqual(['Back'])
  })
})

describe('small formats', () => {
  it('checks a file against the formats an area names', () => {
    const d = (supportUploadFormat: string | null) => ({ fieldName: 'A', name: null, supportUploadFormat })
    expect(formatAccepted(d('0'), 'image/jpeg')).toBe(false)
    expect(formatAccepted(d('0,1'), 'image/jpeg')).toBe(true)
    expect(formatAccepted(d('1'), 'image/png')).toBe(false)
    expect(formatAccepted(d(null), 'image/png')).toBe(true)
    expect(formatAccepted(undefined, 'image/png')).toBe(true)
  })

  it('splits the dialling code from the phone', () => {
    expect(phoneParts('+1 (303) 555-0100', 'US')).toEqual({ countryCode: '+1', phone: '3035550100' })
    expect(phoneParts('303-555-0100', 'US')).toEqual({ countryCode: '+1', phone: '3035550100' })
    expect(phoneParts('+44 20 7946 0000', 'GB')).toEqual({ countryCode: '+44', phone: '2079460000' })
    expect(phoneParts('', 'ZZ')).toEqual({})
  })
})
