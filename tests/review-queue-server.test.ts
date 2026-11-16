import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { openQueue } from '../scripts/review-queue/store.mjs'
import { createReviewServer } from '../scripts/review-queue/server.mjs'

const H = 3_600_000
let tmp: string
let root: string
let q: any
let server: http.Server
let base: string
let port: number
let calls: { name: string; args: any[] }[]
let ops: any
const deps = { marker: 'deps' }
const fixDeps = { marker: 'fixDeps' }
let clock: number

function versionFiles(itemId: string, n: number, parts: { part: string; kind: string }[]) {
  const vdir = path.join(root, 'items', itemId, `v${n}`)
  fs.mkdirSync(path.join(vdir, 'preview'), { recursive: true })
  return parts.map(({ part, kind }) => {
    const p = path.join(vdir, `${part}.png`)
    fs.writeFileSync(p, `ORIGINAL:${part}:v${n}`)
    const preview = path.join(vdir, 'preview', `${part}.jpg`)
    fs.writeFileSync(preview, `PREVIEW:${part}:v${n}`)
    return { part, kind, printArea: part.split('_')[1], taskKey: itemId, fileName: `${part}.png`, path: p, sha256: `sha-${part}-${n}`, preview }
  })
}

async function addItem(id: string, taskKey: string, over: any = {}) {
  const files = versionFiles(id, 1, over.parts ?? [{ part: 'PRINT_Front', kind: 'PRINT' }, { part: 'MOCKUP_Front', kind: 'MOCKUP' }])
  const vdir = path.join(root, 'items', id, 'v1')
  if (over.customer) fs.writeFileSync(path.join(vdir, 'customer.jpg'), 'CUSTOMER')
  await q.addOrUpdate({
    id, taskKey, groupKey: taskKey, taskKeys: [taskKey], kind: 'line',
    apiLines: [{ taskKey, action: 'push', files: files.map(f => ({ kind: f.kind, printArea: f.printArea, path: f.path, fileName: f.fileName })) }],
    files,
    meta: {
      taskKey, productTitle: `Tote ${taskKey}`, variantTitle: 'L', orderNumber: '#LIT1', placedAt: '2026-11-14T03:00:00.000Z',
      custom: [{ name: 'Tên', value: 'Terry' }],
      customerPreview: over.customer ? path.join(vdir, 'customer.jpg') : null,
      customerPreviewUrl: 'https://cdn.example/customer.png',
      storeImage: null, storeImageUrl: 'https://cdn.example/store.png',
      sourceCli: 'push-local-renders', ledgerPath: path.join(tmp, 'out', 'api-ledger.json'), out: path.join(tmp, 'out'),
    },
    qa: over.qa ?? { verdict: 'pass', items: [] },
  })
  return id
}

function raw(method: string, p: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function restart(over: any) {
  await new Promise(r => server.close(() => r(undefined)))
  server = createReviewServer({ queue: q, deps, fixDeps, ops: { ...ops, ...over }, now: () => new Date(clock), log: () => {} })
  await new Promise<void>(r => server.listen(port, '127.0.0.1', () => r()))
}

const post = (p: string, body: any = {}, headers: Record<string, string> = { 'X-Review-Queue': '1' }) =>
  fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-server-'))
  root = path.join(tmp, 'queue')
  clock = Date.parse('2026-11-16T01:00:00Z')
  q = await openQueue({ root, now: () => new Date(clock) })
  calls = []
  const rec = (name: string, result: any) => async (...args: any[]) => { calls.push({ name, args }); return typeof result === 'function' ? result(...args) : result }
  ops = {
    approveItem: rec('approveItem', (_q: any, id: string) => ({ ok: true, itemId: id, status: 'approved', message: 'Duyệt ở máy local' })),
    rejectItem: rec('rejectItem', (_q: any, id: string) => ({ ok: true, itemId: id, status: 'rejected' })),
    sendToCloud: rec('sendToCloud', (_q: any, id: string) => ({ ok: true, itemId: id, status: 'cloud' })),
    removeItem: rec('removeItem', (_q: any, id: string) => ({ ok: true, itemId: id, status: 'removed' })),
    startFix: rec('startFix', (_q: any, id: string) => ({ ok: true, itemId: id, jobId: `${id}-1`, status: 'fixing' })),
    runFixJob: rec('runFixJob', () => new Promise(() => {})),
  }
  server = createReviewServer({ queue: q, deps, fixDeps, ops, now: () => new Date(clock), log: () => {} })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as any).port
  base = `http://127.0.0.1:${port}`
})

afterEach(async () => {
  await new Promise(r => server.close(() => r(undefined)))
  await q.close()
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
})

describe('GET /api/items', () => {
  it('lists items with countdown, thumbnail, title and counts', async () => {
    await addItem('rq_a1', 'LIT1_1')
    clock += H
    await addItem('rq_b2', 'LIT2_1', { qa: { verdict: 'fail', items: ['tên vượt khung 5 px'] } })
    const r = await fetch(`${base}/api/items`)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.items.map((i: any) => [i.id, i.status])).toEqual([['rq_a1', 'waiting'], ['rq_b2', 'qa_failed']])
    const a = body.items[0]
    expect(a).toMatchObject({ taskKey: 'LIT1_1', version: 1, title: 'Tote LIT1_1', qa: { verdict: 'pass', count: 0 } })
    expect(a.deadline).toBe(new Date(Date.parse('2026-11-16T01:00:00Z') + 3 * H).toISOString())
    expect(a.thumb).toBe('/files/rq_a1/v/1/preview/PRINT_Front.jpg')
    expect(body.items[1].qa).toEqual({ verdict: 'fail', count: 1, items: ['tên vượt khung 5 px'] })
    expect(body.counts).toMatchObject({ waiting: 1, qa_failed: 1, rejected: 0 })
    expect(typeof body.now).toBe('string')
  })

  it('filters by status and has no countdown for rejected', async () => {
    await addItem('rq_a1', 'LIT1_1')
    await addItem('rq_b2', 'LIT2_1')
    await q.setStatus('rq_b2', 'rejected', { reason: 'màu tên' })
    const body = await (await fetch(`${base}/api/items?status=rejected,needs_look`)).json()
    expect(body.items.map((i: any) => i.id)).toEqual(['rq_b2'])
    expect(body.items[0]).toMatchObject({ status: 'rejected', statusReason: 'màu tên', deadline: null })
    expect(body.counts).toMatchObject({ waiting: 1, rejected: 1 })
  })
})

describe('GET /api/items/:id', () => {
  it('returns the item, its version files with urls, images, custom fields and history', async () => {
    await addItem('rq_a1', 'LIT1_1', { customer: true })
    const r = await fetch(`${base}/api/items/rq_a1`)
    expect(r.status).toBe(200)
    const d = await r.json()
    expect(d.item).toMatchObject({ id: 'rq_a1', taskKey: 'LIT1_1', status: 'waiting', version: 1 })
    expect(d.item.meta.custom).toEqual([{ name: 'Tên', value: 'Terry' }])
    expect(d.versions).toHaveLength(1)
    const f = d.versions[0].files[0]
    expect(f).toMatchObject({ part: 'PRINT_Front', kind: 'PRINT', url: '/files/rq_a1/v/1/PRINT_Front.png', previewUrl: '/files/rq_a1/v/1/preview/PRINT_Front.jpg' })
    expect(f.bytes).toBeGreaterThan(0)
    expect(d.images.customer).toEqual({ url: '/files/rq_a1/v/1/customer.jpg', original: 'https://cdn.example/customer.png' })
    expect(d.images.store).toEqual({ url: 'https://cdn.example/store.png', original: 'https://cdn.example/store.png' })
    expect(d.events.map((e: any) => e.message)).toContain('Vào hàng chờ (v1, waiting)')
    expect(d.memberKeys).toEqual(['LIT1_1'])
  })

  it('needs_look items carry the re-run command', async () => {
    await addItem('rq_a1', 'LIT1_1')
    await q.setStatus('rq_a1', 'needs_look', { reason: 'Prod đã thay đổi' })
    const d = await (await fetch(`${base}/api/items/rq_a1`)).json()
    expect(d.rerun).toContain('push-local-renders.mjs --via api --to-queue --line LIT1_1')
  })

  it('unknown or malformed id → 404', async () => {
    expect((await fetch(`${base}/api/items/rq_nope`)).status).toBe(404)
    expect((await fetch(`${base}/api/items/..%2Fqueue.db`)).status).toBe(404)
  })
})

describe('GET /files', () => {
  it('serves the original and the preview of a version', async () => {
    await addItem('rq_a1', 'LIT1_1')
    const orig = await fetch(`${base}/files/rq_a1/v/1/PRINT_Front.png`)
    expect(orig.status).toBe(200)
    expect(orig.headers.get('content-type')).toBe('image/png')
    expect(await orig.text()).toBe('ORIGINAL:PRINT_Front:v1')
    const pv = await fetch(`${base}/files/rq_a1/v/1/preview/PRINT_Front.jpg`)
    expect(pv.headers.get('content-type')).toBe('image/jpeg')
    expect(await pv.text()).toBe('PREVIEW:PRINT_Front:v1')
  })

  it('refuses dot-only and blank segments, and a link out of the folder', async () => {
    await addItem('rq_a1', 'LIT1_1')
    for (const t of ['/files/rq_a1/v/1/...', '/files/rq_a1/v/1/%20..', '/files/rq_a1/v/1/.%20.', '/files/rq_a1/v/1/%20']) {
      expect([400, 403], t).toContain((await raw('GET', t)).status)
    }
    const outside = path.join(tmp, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET')
    fs.symlinkSync(outside, path.join(root, 'items', 'rq_a1', 'v1', 'linked'), 'junction')
    const r = await raw('GET', '/files/rq_a1/v/1/linked/secret.txt')
    expect(r.status).toBe(403)
    expect(r.body).not.toContain('SECRET')
  })

  it('refuses anything outside the item version folder', async () => {
    await addItem('rq_a1', 'LIT1_1')
    fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET')
    const tries = [
      '/files/rq_a1/v/1/../../../secret.txt',
      '/files/rq_a1/v/1/%2e%2e/%2e%2e/%2e%2e/secret.txt',
      '/files/rq_a1/v/1/..%2f..%2f..%2fsecret.txt',
      '/files/rq_a1/v/1/..%5c..%5c..%5csecret.txt',
      '/files/rq_a1/v/1/C:%5cWindows%5cwin.ini',
      '/files/..%2fqueue.db/v/1/x',
      '/files/rq_a1/v/x/PRINT_Front.png',
    ]
    for (const t of tries) {
      const r = await raw('GET', t)
      expect([400, 403, 404], t).toContain(r.status)
      expect(r.body).not.toContain('SECRET')
    }
    expect((await raw('GET', '/files/rq_a1/v/2/PRINT_Front.png')).status).toBe(404)
    expect((await raw('GET', '/files/rq_a1/v/1/nope.png')).status).toBe(404)
  })
})

describe('guards', () => {
  it('POST without X-Review-Queue: 1 → 403 and no action runs', async () => {
    await addItem('rq_a1', 'LIT1_1')
    for (const action of ['approve', 'reject', 'cloud', 'remove', 'fix']) {
      const r = await post(`/api/items/rq_a1/${action}`, { version: 1, reason: 'x', agent: 'claude' }, {})
      expect(r.status).toBe(403)
    }
    expect(calls).toHaveLength(0)
  })

  it('a foreign Host header (DNS rebinding) is refused, GET and POST', async () => {
    await addItem('rq_a1', 'LIT1_1')
    expect((await raw('GET', '/api/items', { Host: 'evil.test' })).status).toBe(403)
    expect((await raw('POST', '/api/items/rq_a1/approve', { Host: `evil.test:${port}`, 'X-Review-Queue': '1', 'Content-Type': 'application/json' }, '{"version":1}')).status).toBe(403)
    expect((await raw('GET', '/api/items', { Host: `localhost:${port}` })).status).toBe(200)
    expect(calls).toHaveLength(0)
  })

  it('a cross-site Origin is refused even with the header', async () => {
    await addItem('rq_a1', 'LIT1_1')
    const r = await post('/api/items/rq_a1/approve', { version: 1 }, { 'X-Review-Queue': '1', Origin: 'https://evil.test' })
    expect(r.status).toBe(403)
    expect(calls).toHaveLength(0)
  })
})

describe('actions', () => {
  it('approve calls approveItem once with the version the page shows', async () => {
    await addItem('rq_a1', 'LIT1_1')
    const r = await post('/api/items/rq_a1/approve', { version: 1 })
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ok: true, status: 'approved' })
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('approveItem')
    expect(calls[0].args[0]).toBe(q)
    expect(calls[0].args[1]).toBe('rq_a1')
    expect(calls[0].args[2]).toBe(deps)
    expect(calls[0].args[3]).toEqual({ force: false, version: 1 })
  })

  it('approve with force passes force: true', async () => {
    await addItem('rq_a1', 'LIT1_1')
    await post('/api/items/rq_a1/approve', { version: 1, force: true })
    expect(calls[0].args[3]).toEqual({ force: true, version: 1 })
  })

  it('the real approveItem refuses an older version with 409 version_changed, nothing sent', async () => {
    const { approveItem } = await import('../scripts/review-queue/actions.mjs')
    await restart({ approveItem })
    await addItem('rq_a1', 'LIT1_1')
    const r = await post('/api/items/rq_a1/approve', { version: 7 })
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ ok: false, code: 'version_changed', version: 1 })
    expect((await q.get('rq_a1')).status).toBe('waiting')
  })

  it('reject, cloud and remove pass their arguments', async () => {
    await addItem('rq_a1', 'LIT1_1')
    await post('/api/items/rq_a1/reject', { version: 1, reason: 'màu tên' })
    await post('/api/items/rq_a1/cloud', { version: 1 })
    await post('/api/items/rq_a1/remove', { version: 1 })
    expect(calls.map(c => [c.name, c.args[1], ...c.args.slice(2).filter(a => a !== deps)])).toEqual([
      ['rejectItem', 'rq_a1', 'màu tên', { version: 1 }],
      ['sendToCloud', 'rq_a1', { force: false, version: 1 }],
      ['removeItem', 'rq_a1', { version: 1 }],
    ])
  })

  it('fix starts the job and runs it in the background without waiting for it', async () => {
    await addItem('rq_a1', 'LIT1_1')
    const r = await post('/api/items/rq_a1/fix', { version: 1, agent: 'codex', reason: 'dời dây quai' })
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ok: true, jobId: 'rq_a1-1', status: 'fixing' })
    expect(calls.map(c => c.name)).toEqual(['startFix', 'runFixJob'])
    expect(calls[0].args.slice(1)).toEqual(['rq_a1', { agent: 'codex', reason: 'dời dây quai', version: 1 }, fixDeps])
    expect(calls[1].args.slice(1)).toEqual(['rq_a1-1', fixDeps])
  })

  it('a refused action keeps its error and gets a non-2xx status', async () => {
    await restart({ removeItem: async () => ({ ok: false, itemId: 'rq_a1', code: 'fixing', error: 'Agent đang sửa dòng này' }) })
    await addItem('rq_a1', 'LIT1_1')
    const r = await post('/api/items/rq_a1/remove', {})
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ ok: false, code: 'fixing', error: 'Agent đang sửa dòng này' })
  })

  it('a body over 64 KB gets a 413 answer', async () => {
    await addItem('rq_a1', 'LIT1_1')
    const r = await raw('POST', '/api/items/rq_a1/reject', { 'X-Review-Queue': '1', 'Content-Type': 'application/json' }, JSON.stringify({ version: 1, reason: 'x'.repeat(70_000) }))
    expect(r.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  it('unknown item → 404 without calling the action; bad JSON → 400', async () => {
    expect((await post('/api/items/rq_zz/approve', { version: 1 })).status).toBe(404)
    await addItem('rq_a1', 'LIT1_1')
    const r = await fetch(`${base}/api/items/rq_a1/approve`, { method: 'POST', headers: { 'X-Review-Queue': '1', 'Content-Type': 'application/json' }, body: '{nope' })
    expect(r.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('static page', () => {
  it('serves the page and its assets', async () => {
    const page = await fetch(`${base}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toBe("default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'")
    expect(page.headers.get('content-type')).toMatch(/text\/html/)
    expect(await page.text()).toContain('Duyệt local')
    expect((await fetch(`${base}/app.js`)).headers.get('content-type')).toMatch(/javascript/)
    expect((await fetch(`${base}/app.css`)).headers.get('content-type')).toMatch(/text\/css/)
    expect((await raw('GET', '/../server.mjs')).status).toBe(404)
  })
})
