import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createDeliveryClient, DeliveryGaveUp, DeliveryStopped } from '../scripts/lib/delivery-client.mjs'
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

  it('posts a note to the task note route with the same token and retries', async () => {
    const h = harness([json({ error: 'busy' }, 503), json({ ok: true })])
    const r = await make(h).note('LIT 1/a', 'Đang chờ chủ shop duyệt ở máy local (tối đa 1 giờ)')
    expect(r).toEqual({ ok: true, status: 200, body: { ok: true } })
    expect(h.calls.map(x => `${x.init.method} ${x.url}`)).toEqual([
      'POST https://x.test/api/design-studio/worker/delivery/tasks/LIT%201%2Fa/note',
      'POST https://x.test/api/design-studio/worker/delivery/tasks/LIT%201%2Fa/note',
    ])
    expect(h.calls[1].init.headers.Authorization).toBe('Bearer sekret')
    expect(JSON.parse(h.calls[1].init.body)).toEqual({ message: 'Đang chờ chủ shop duyệt ở máy local (tối đa 1 giờ)' })
    expect(h.waits).toEqual([5000])
  })

  it('with timeoutMs aborts a hanging request and retries within the budget', async () => {
    const h = harness([])
    const signals: any[] = []
    const fetchImpl = (url: any, init: any) => {
      h.calls.push({ url, init })
      signals.push(init.signal)
      return new Promise<Response>((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    }
    const c = make(h, { fetchImpl, timeoutMs: 20, budgetMs: 30_000 })
    await expect(c.note('K', 'm')).rejects.toBeInstanceOf(DeliveryGaveUp)
    expect(h.calls).toHaveLength(3)
    expect(h.waits).toEqual([5000, 10000])
    expect(signals.every(s => s && s.aborted)).toBe(true)
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

  it('retries a 502 and a 504 like a 503', async () => {
    const h = harness([json({}, 502), json({}, 504, { 'Retry-After': '3' }), json({ ok: 1 })])
    const r = await make(h).commit('K', {})
    expect(r).toEqual({ ok: true, status: 200, body: { ok: 1 } })
    expect(h.waits).toEqual([5000, 3000])
  })

  it('returns a 500 as { ok: false } without retrying', async () => {
    const h = harness([json({ error: 'boom' }, 500)])
    expect(await make(h).commit('K', {})).toEqual({ ok: false, status: 500, body: { error: 'boom' } })
    expect(h.waits).toEqual([])
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

describe('delivery client stops', () => {
  it('stops at once on a 401', async () => {
    const h = harness([json({ error: 'no' }, 401)])
    let err: any
    try { await make(h).taskState('K') } catch (e) { err = e }
    expect(err).toBeInstanceOf(DeliveryStopped)
    expect(err.status).toBe(401)
    expect(h.waits).toEqual([])
    expect(h.calls).toHaveLength(1)
  })

  it.each(['disabled', 'drive_not_connected'])('stops at once on a 503 with code %s', async code => {
    const h = harness([json({ error: 'x', code }, 503)])
    let err: any
    try { await make(h).driveToken() } catch (e) { err = e }
    expect(err).toBeInstanceOf(DeliveryStopped)
    expect(err.code).toBe(code)
    expect(h.waits).toEqual([])
  })

  it('still retries a plain 503 (code busy)', async () => {
    const h = harness([json({ error: 'x', code: 'busy' }, 503, { 'Retry-After': '2' }), json({ ok: 1 })])
    expect((await make(h).taskState('K')).ok).toBe(true)
    expect(h.waits).toEqual([2000])
  })
})

describe('uploader recovery', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deliv-up2-'))
  const file = path.join(tmp, 'a.png')
  fs.writeFileSync(file, Buffer.alloc(100, 1))
  const session = () => new Response('', { status: 200, headers: { location: 'https://www.googleapis.com/upload/s1' } })

  it('takes the id from a 200 answer to the status query after a dropped connection', async () => {
    let puts = 0
    const fetchImpl: any = async (url: any, init: any = {}) => {
      if (String(url).includes('uploadType=resumable')) return session()
      puts++
      if (puts === 1) throw new Error('socket hang up')
      expect(init.headers['Content-Range']).toBe('bytes */100')
      return json({ id: 'DONE' })
    }
    const up = createUploader({ accessToken: async () => 't', fetchImpl, sleep: async () => {} })
    expect(await up.upload({ path: file, name: 'a.png', mimeType: 'image/png', parentId: 'P' })).toEqual({ id: 'DONE', size: 100 })
  })

  it('retries a 5xx when starting the session', async () => {
    let starts = 0
    const waits: number[] = []
    const fetchImpl: any = async (url: any) => {
      if (String(url).includes('uploadType=resumable')) return ++starts < 3 ? json({ error: { message: 'down' } }, 503) : session()
      return json({ id: 'OK' })
    }
    const up = createUploader({ accessToken: async () => 't', fetchImpl, sleep: async (ms: number) => { waits.push(ms) } })
    expect((await up.upload({ path: file, name: 'a.png', mimeType: 'image/png', parentId: 'P' })).id).toBe('OK')
    expect(waits).toEqual([2000, 4000])
  })
})

describe('delivery client approve token', () => {
  it('sends X-Delivery-Approve only on commits whose body has approve: true, never on other calls', async () => {
    const h = harness([json({}), json({}), json({}), json({}), json({}), json({})])
    const c = make(h, { approveToken: 'APPROVE-SECRET' })
    await c.commit('K', { action: 'push', approve: true })
    await c.commit('K', { action: 'push', approve: true, dryRun: true })
    await c.commit('K', { action: 'push' })
    await c.commit('K', { action: 'push', approve: 'yes' })
    await c.taskState('K')
    await c.note('K', 'hi')
    const header = (i: number) => h.calls[i].init.headers['X-Delivery-Approve']
    expect([0, 1, 2, 3, 4, 5].map(header)).toEqual(['APPROVE-SECRET', 'APPROVE-SECRET', undefined, undefined, undefined, undefined])
    expect(h.calls.every(x => x.init.headers.Authorization === 'Bearer sekret')).toBe(true)
  })

  it('without an approve token an approve commit goes without the header (the server answers 403)', async () => {
    const h = harness([json({ code: 'approve_token' }, 403)])
    const r = await make(h).commit('K', { action: 'push', approve: true })
    expect(r).toMatchObject({ ok: false, status: 403 })
    expect(h.calls[0].init.headers['X-Delivery-Approve']).toBeUndefined()
  })
})
