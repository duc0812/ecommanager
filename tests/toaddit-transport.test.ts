import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from 'node:http2'
import { postToadditHttp2 } from '@/lib/toaddit-transport'

const fake = vi.hoisted(() => ({ rows: new Map<string, string>() }))
vi.mock('@/lib/db', () => {
  const tx = { appSetting: {
    findUnique: async ({ where }: any) => fake.rows.has(where.key) ? { value: fake.rows.get(where.key) } : null,
    upsert: async ({ where, create, update }: any) => { fake.rows.set(where.key, fake.rows.has(where.key) ? update.value : create.value) },
  } }
  return { prisma: { ...tx, $transaction: async (fn: any) => fn(tx) } }
})
vi.mock('node:http2', () => ({ connect: vi.fn() }))
const sessions: any[] = []
beforeEach(() => {
  fake.rows.clear(); sessions.length = 0; vi.mocked(connect).mockReset()
  vi.mocked(connect).mockImplementation((() => {
    const client: any = new EventEmitter()
    client.alpnProtocol = 'h2'
    client.destroy = vi.fn()
    client.request = vi.fn((headers: any) => {
      const stream: any = new EventEmitter()
      stream.close = vi.fn()
      stream.end = vi.fn((body: string) => {
        client.sent = { headers, body }
        Promise.resolve().then(() => { stream.emit('response', { ':status': 200 }); stream.emit('data', Buffer.from('{"code":0}')); stream.emit('end') })
      })
      return stream
    })
    sessions.push(client)
    Promise.resolve().then(() => client.emit('connect'))
    return client
  }) as any)
})
afterEach(() => vi.useRealTimers())
const headers = { 'X-App-Key': 'transport-fixture-key', 'X-Timestamp': '123', 'X-Nonce': 'unique', 'X-Access-Token': 'fixture-token' }

describe('Toaddit HTTP/2 transport', () => {
  it('uses TLS and POST, preserves JSON and closes the connection', async () => {
    expect(await postToadditHttp2('https://openapi.toaddit.com', '/openapi/toaddit/v1/order/list', headers, '{}')).toEqual({ status: 200, text: '{"code":0}' })
    expect(connect).toHaveBeenCalledWith('https://openapi.toaddit.com', { minVersion: 'TLSv1.2', ALPNProtocols: ['h2'] })
    expect(sessions[0].sent).toMatchObject({ headers: { ':method': 'POST', ':path': '/openapi/toaddit/v1/order/list', ...headers }, body: '{}' })
    expect(sessions[0].destroy).toHaveBeenCalled()
  })
  it('enforces the shared 1 QPS budget across calls', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-24T00:00:00Z'))
    await postToadditHttp2('https://openapi.toaddit.com', '/one', headers, '{}')
    const second = postToadditHttp2('https://openapi.toaddit.com', '/two', headers, '{}')
    await vi.advanceTimersByTimeAsync(1099)
    expect(connect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await second
    expect(connect).toHaveBeenCalledTimes(2)
  })
  it('rejects foreign hosts and paths before credentials can be sent', async () => {
    await expect(postToadditHttp2('https://attacker.example.com', '/one', headers, '{}')).rejects.toThrow()
    await expect(postToadditHttp2('https://openapi.toaddit.com', '//attacker.example.com', headers, '{}')).rejects.toThrow()
    expect(connect).not.toHaveBeenCalled()
  })
  it('rejects an HTTP/1.1 negotiation and hides transport details', async () => {
    vi.mocked(connect).mockImplementation((() => {
      const c: any = new EventEmitter(); c.alpnProtocol = 'http/1.1'; c.destroy = vi.fn()
      Promise.resolve().then(() => c.emit('connect')); return c
    }) as any)
    await expect(postToadditHttp2('https://openapi.toaddit.com', '/one', headers, '{}')).rejects.toThrow('HTTP/2')
  })
})
