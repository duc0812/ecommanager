import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createDeliveryClient, DeliveryGaveUp } from '../scripts/lib/delivery-client.mjs'
import { createUploader, cachedDriveToken } from '../scripts/lib/delivery-drive-upload.mjs'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

function harness(responses: (Response | Error)[]) {
  const calls: { url: string; init: any }[] = []
  const waits: number[] = []
  let t = 1_000
  const fetchImpl = async (url: any, init: any = {}) => {
    calls.push({ url, init })
    const r = responses.shift() ?? json({ ok: true })
    if (r instanceof Error) throw r
    return r
  }
  const sleep = async (ms: number) => { waits.push(ms); t += ms }
  const now = () => t
  return { calls, waits, fetchImpl, sleep, now }
}

const make = (h: ReturnType<typeof harness>, extra: any = {}) =>
  createDeliveryClient({ baseUrl: 'https://x.test', token: 'sekret', fetchImpl: h.fetchImpl, sleep: h.sleep, now: h.now, ...extra })

describe('delivery client', () => {
  it('retries a 503 honouring Retry-After and then succeeds', async () => {
    const h = harness([json({ error: 'busy' }, 503, { 'Retry-After': '1' }), json({ taskKey: 'K' })])
    const r = await make(h).taskState('K')
    expect(r).toEqual({ ok: true, status: 200, body: { taskKey: 'K' } })
    expect(h.waits).toEqual([1000])
    expect(h.calls).toHaveLength(2)
  })

  it('sends the bearer token, encodes the key and uses the right routes', async () => {
    const h = harness([json({}), json({}), json({}), json({})])
    const c = make(h)
    await c.driveToken()
    await c.taskState('LIT 1/a')
    await c.commit('LIT 1/a', { action: 'push' })
    await c.putPreview('art1', Buffer.from([0xff, 0xd8, 0xff]))
    expect(h.calls.map(x => `${x.init.method} ${x.url}`)).toEqual([
      'POST https://x.test/api/design-studio/worker/delivery/drive-token',
      'GET https://x.test/api/design-studio/worker/delivery/tasks/LIT%201%2Fa',
      'POST https://x.test/api/design-studio/worker/delivery/tasks/LIT%201%2Fa/commit',
      'PUT https://x.test/api/design-studio/worker/delivery/artworks/art1/preview',
    ])
    for (const x of h.calls) expect(x.init.headers.Authorization).toBe('Bearer sekret')
    expect(JSON.parse(h.calls[2].init.body)).toEqual({ action: 'push' })
    expect(h.calls[3].init.headers['Content-Type']).toBe('image/jpeg')
  })

  it('backs off 5s, 10s, 20s... capped at 60s without Retry-After, also on 429 and network errors', async () => {
    const h = harness([json({}, 429), new Error('ECONNRESET'), json({}, 503), json({}, 503), json({}, 503), json({}, 503), json({ ok: 1 })])
    const r = await make(h).taskState('K')
    expect(r.ok).toBe(true)
    expect(h.waits).toEqual([5000, 10000, 20000, 40000, 60000, 60000])
  })

  it('gives up with DeliveryGaveUp when the next wait would pass the budget', async () => {
    const h = harness(Array.from({ length: 200 }, () => json({ error: 'x' }, 503)))
    let err: any
    try { await make(h).taskState('K') } catch (e) { err = e }
    expect(err).toBeInstanceOf(DeliveryGaveUp)
    expect(err.status).toBe(503)
    expect(h.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30 * 60 * 1000)
    expect(h.calls.length).toBeLessThan(200)
  })

  it('returns non-2xx other than 429/503 as { ok: false } without throwing', async () => {
    const h = harness([json({ error: 'stale', code: 'stale_state' }, 409)])
    expect(await make(h).commit('K', {})).toEqual({ ok: false, status: 409, body: { error: 'stale', code: 'stale_state' } })
    expect(h.waits).toEqual([])
  })

  it('never puts the token in an error', async () => {
    const h = harness(Array.from({ length: 200 }, () => new Error('boom')))
    let err: any
    try { await make(h).taskState('K') } catch (e) { err = e }
    expect(err).toBeInstanceOf(DeliveryGaveUp)
    expect(String(err.message) + String(err.lastError?.message)).not.toContain('sekret')
  })
})

describe('cachedDriveToken', () => {
  it('reuses the token until 60 s before expiry, and refetches when forced', async () => {
    let t = Date.parse('2026-11-15T10:00:00Z')
    let n = 0
    const client = { driveToken: async () => ({ ok: true, status: 200, body: { accessToken: `tok${++n}`, expiresAt: new Date(t + 10 * 60_000).toISOString() } }) }
    const get = cachedDriveToken(client, { now: () => t })
    expect(await get()).toBe('tok1')
    t += 8 * 60_000
    expect(await get()).toBe('tok1')
    t += 90_000
    expect(await get()).toBe('tok2')
    expect(await get(true)).toBe('tok3')
  })

  it('throws when the server has no token', async () => {
    const get = cachedDriveToken({ driveToken: async () => ({ ok: false, status: 503, body: { code: 'drive_not_connected' } }) })
    await expect(get()).rejects.toThrow(/drive_not_connected|503/)
  })
})

describe('uploader', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deliv-up-'))
  const file = path.join(tmp, 'a.png')
  fs.writeFileSync(file, Buffer.alloc(100, 1))

  it('refuses a session URL outside www.googleapis.com', async () => {
    const calls: string[] = []
    const fetchImpl = async (url: any, init: any = {}) => { calls.push(`${init.method} ${url}`); return new Response('', { status: 200, headers: { location: 'https://evil.test/up' } }) }
    const up = createUploader({ accessToken: async () => 't', fetchImpl })
    await expect(up.upload({ path: file, name: 'a.png', mimeType: 'image/png', parentId: 'P' })).rejects.toThrow(/googleapis/)
    expect(calls.some(c => c.includes('evil.test'))).toBe(false)
  })

  it('uploads in chunks with 308 handling and returns id and size', async () => {
    const big = path.join(tmp, 'big.bin')
    const total = 9 * 1024 * 1024
    const first = 8 * 1024 * 1024
    fs.writeFileSync(big, Buffer.alloc(total, 2))
    const puts: string[] = []
    const fetchImpl = async (url: any, init: any = {}) => {
      if (url.includes('uploadType=resumable')) return new Response('', { status: 200, headers: { location: 'https://www.googleapis.com/upload/s1' } })
      puts.push(init.headers['Content-Range'])
      if (puts.length === 1) return new Response('', { status: 308, headers: { range: `bytes=0-${first - 1}` } })
      return json({ id: 'F1' }, 200)
    }
    const up = createUploader({ accessToken: async () => 't', fetchImpl })
    const r = await up.upload({ path: big, name: 'big.bin', mimeType: 'application/octet-stream', parentId: 'P' })
    expect(r).toEqual({ id: 'F1', size: total })
    expect(puts).toEqual([`bytes 0-${first - 1}/${total}`, `bytes ${first}-${total - 1}/${total}`])
  })

  it('refetches the token once on a 401', async () => {
    const tokens: boolean[] = []
    let starts = 0
    const fetchImpl = async (url: any) => {
      if (url.includes('uploadType=resumable')) {
        starts++
        return starts === 1 ? json({ error: { message: 'expired' } }, 401) : new Response('', { status: 200, headers: { location: 'https://www.googleapis.com/upload/s1' } })
      }
      return json({ id: 'F2' })
    }
    const up = createUploader({ accessToken: async (force?: boolean) => { tokens.push(!!force); return 't' }, fetchImpl })
    expect((await up.upload({ path: file, name: 'a.png', mimeType: 'image/png', parentId: 'P' })).id).toBe('F2')
    expect(tokens).toEqual([false, true])
  })
})
