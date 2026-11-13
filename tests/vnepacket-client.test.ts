import { describe, it, expect, vi, afterEach } from 'vitest'
import { VnepacketError, getTracking, login, parseTracking, referenceCandidates, shipmentStatusOf, tokenExpiry, type VnepacketSession } from '@/lib/vnepacket'

const BASE = 'https://api.vnepacket.com.vn'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function stubFetch(impl: (url: string, init: RequestInit) => Response) {
  const mock = vi.fn(async (input: any, init?: RequestInit) => impl(String(input), init ?? {}))
  vi.stubGlobal('fetch', mock)
  return mock
}

function session(): VnepacketSession & { renewed: number } {
  const s = { renewed: 0, token: async () => (s.renewed ? `tok-${s.renewed}` : 'tok-0'), renew: async () => `tok-${++s.renewed}` }
  return s
}

// The documented answer, cut to three events.
const DOC_TRACKING = {
  status: 'success',
  message: 'get tracking success',
  tracking: {
    tracking_number: '9200190181596801055262',
    carrier: null,
    label_path: 'https://vnepacket.com.vn/Uploads/Labels/HPW24086AKM.pdf',
    events: {
      statusDetails: [
        { description: 'DELIVERED FRONT DOOR/PORCH', date: '2024-08-30 11:40:00', location: 'AIEA HI 96701' },
        { description: 'OUT FOR DELIVERY', date: '2024-08-30 06:10:00', location: 'AIEA HI 96701' },
        { description: 'SHIPMENT LABEL CREATED', date: '2024-08-23 09:49:57', location: 'Ho Chi Minh VN' },
      ],
    },
    is_checkin: true,
    status: '_delivered',
  },
}

afterEach(() => { vi.unstubAllGlobals() })

describe('login', () => {
  it('posts the account to /me and keeps the access token', async () => {
    const mock = stubFetch(() => json({ status: 'success', access_token: 'abc.def.ghi', fullName: 'Shop', message: 'ok' }))
    expect(await login('me@shop.test', 'pw')).toEqual({ token: 'abc.def.ghi', fullName: 'Shop', expiresAt: null })
    const [url, init] = mock.mock.calls[0]
    expect(String(url)).toBe(`${BASE}/me`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ username: 'me@shop.test', password: 'pw' })
  })

  it('turns the HTTP 200 "fail" envelope into an error', async () => {
    stubFetch(() => json({ status: 'fail', message: 'user not found' }))
    await expect(login('x', 'y')).rejects.toThrow('user not found')
  })
})

describe('tokenExpiry', () => {
  it('reads exp from a JWT and gives null for anything else', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_900_000_000 })).toString('base64url')
    expect(tokenExpiry(`h.${payload}.s`)).toBe(new Date(1_900_000_000_000).toISOString())
    expect(tokenExpiry('opaque-token')).toBeNull()
  })
})

describe('getTracking', () => {
  it('reads the documented answer: number, label, check-in, events', async () => {
    const mock = stubFetch(() => json(DOC_TRACKING))
    const { tracking } = await getTracking(session(), 'LIT5166_1')
    expect(String(mock.mock.calls[0][0])).toBe(`${BASE}/tracking/get/LIT5166_1`)
    expect((mock.mock.calls[0][1]?.headers as any).Authorization).toBe('Bearer tok-0')
    expect(tracking).toMatchObject({ reference: 'LIT5166_1', trackingNumber: '9200190181596801055262', carrier: null, status: '_delivered', checkedIn: true })
    expect(tracking?.events).toHaveLength(3)
    expect(tracking?.events[0]).toEqual({ time: '2024-08-30 11:40:00', desc: 'DELIVERED FRONT DOOR/PORCH', location: 'AIEA HI 96701' })
  })

  it('encodes the # of a reference', async () => {
    const mock = stubFetch(() => json(DOC_TRACKING))
    await getTracking(session(), '#LIT5202')
    expect(String(mock.mock.calls[0][0])).toBe(`${BASE}/tracking/get/%23LIT5202`)
  })

  it('logs in again once when the token is refused', async () => {
    const s = session()
    let calls = 0
    stubFetch(() => (++calls === 1 ? json({ status: 'error', message: 'authorization header invalid' }) : json(DOC_TRACKING)))
    const { tracking } = await getTracking(s, 'LIT1_1')
    expect(s.renewed).toBe(1)
    expect(tracking?.trackingNumber).toBe('9200190181596801055262')
  })

  it('gives no tracking, with the message, when VNEpacket has no shipment under the code', async () => {
    stubFetch(() => json({ status: 'error', message: 'shipment not found' }))
    expect(await getTracking(session(), 'LIT9_1')).toEqual({ tracking: null, message: 'shipment not found' })
  })

  it('throws on a server fault instead of calling the parcel missing', async () => {
    stubFetch(() => json({ message: 'boom' }, 500))
    await expect(getTracking(session(), 'LIT9_1')).rejects.toBeInstanceOf(VnepacketError)
  })
})

describe('shipmentStatusOf', () => {
  const t = (status: string | null, descs: string[], trackingNumber: string | null = '92001') => ({
    status, trackingNumber, checkedIn: false, events: descs.map((desc, i) => ({ time: `2026-11-0${9 - i} 10:00:00`, desc, location: null })),
  })
  it('maps the API status and the newest event to the tracking buckets', () => {
    expect(shipmentStatusOf(parseTracking('x', DOC_TRACKING))).toBe('DELIVERED')
    expect(shipmentStatusOf(t(null, ['OUT FOR DELIVERY', 'ARRIVED POST OFFICE']))).toBe('OUT_FOR_DELIVERY')
    expect(shipmentStatusOf(t(null, ['DEPARTED FACILITY', 'SHIPMENT LABEL CREATED']))).toBe('IN_TRANSIT')
    expect(shipmentStatusOf(t(null, ['SHIPMENT LABEL CREATED']))).toBe('INFO_RECEIVED')
    expect(shipmentStatusOf(t(null, [], null))).toBe('PENDING')
    expect(shipmentStatusOf(t(null, ['DELIVERY ATTEMPTED - NO ACCESS']))).toBe('EXCEPTION')
    expect(shipmentStatusOf(t('_in_transit', []))).toBe('IN_TRANSIT')
    expect(shipmentStatusOf({ ...t(null, []), checkedIn: true })).toBe('IN_TRANSIT')
  })
})

describe('referenceCandidates', () => {
  it('tries the line key first and the bare order only for a lone line at the supplier', () => {
    expect(referenceCandidates('LIT5166_1', '#LIT5166', true)).toEqual(['#LIT5166_1', 'LIT5166_1', '#LIT5166', 'LIT5166'])
    expect(referenceCandidates('LIT5166_2', '#LIT5166', false)).toEqual(['#LIT5166_2', 'LIT5166_2'])
  })
})
