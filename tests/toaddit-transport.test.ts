import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { postToadditRos } from '@/lib/toaddit-transport'
const fake = vi.hoisted(() => ({ rows: new Map<string, string>() }))
vi.mock('@/lib/db', () => {
  const tx = { appSetting: {
    findUnique: async ({ where }: any) => fake.rows.has(where.key) ? { value: fake.rows.get(where.key) } : null,
    upsert: async ({ where, create, update }: any) => { fake.rows.set(where.key, fake.rows.has(where.key) ? update.value : create.value) },
  } }
  return { prisma: { ...tx, $transaction: async (fn: any) => fn(tx) } }
})
const request = vi.fn()
beforeEach(() => { fake.rows.clear(); vi.stubGlobal('fetch', request); request.mockReset(); request.mockImplementation(async () => new Response('{"code":0,"success":1,"data":[]}')) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('ROS transport', () => {
  it('sends Bearer only to the fixed ROS host and forbids redirects', async () => {
    expect(await postToadditRos('fixture-key', '/api/v1/prototype/prototypeList', '{}')).toMatchObject({ status: 200 })
    const [url, init] = request.mock.calls[0]
    expect(String(url)).toBe('https://ros-openapi.toaddit.com/api/v1/prototype/prototypeList')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', body: '{}', headers: { Authorization: 'Bearer fixture-key', 'content-type': 'application/json' } })
    expect(init.headers).not.toHaveProperty('X-App-Key')
  })
  it('paces account requests and hashes key names', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-25T00:00:00Z'))
    await postToadditRos('fixture-key', '/api/v1/order/orderList', '{}')
    const second = postToadditRos('fixture-key', '/api/v1/order/orderList', '{}')
    await vi.advanceTimersByTimeAsync(1099); expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); await second
    expect(request).toHaveBeenCalledTimes(2)
    expect(Array.from(fake.rows.keys()).join()).not.toContain('fixture-key')
  })
  it.each(['//attacker.com', 'https://attacker.com', '/api/v1/order/orderList?x=1', '/openapi/toaddit/v1/order/create', '/api/v1/../order/createOrder'])('rejects credential escape path %s', async path => {
    await expect(postToadditRos('fixture-key', path, '{}')).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
  it('never retries failures and bounds response size', async () => {
    request.mockRejectedValueOnce(new Error('lost connection'))
    await expect(postToadditRos('fixture-key', '/api/v1/order/createOrder', '{}')).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
    fake.rows.clear()
    request.mockResolvedValueOnce(new Response(new Uint8Array(16 * 1024 * 1024 + 1)))
    await expect(postToadditRos('fixture-key', '/api/v1/order/orderList', '{}')).rejects.toThrow('quá lớn')
  })
})
