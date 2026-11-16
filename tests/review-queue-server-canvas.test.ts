import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { createClient } from '@libsql/client'
import { openQueue } from '../scripts/review-queue/store.mjs'
import { createReviewServer } from '../scripts/review-queue/server.mjs'

// The template canvas of the review page: the detail carries the line's print template (stored at intake, else read from the
// newest prod snapshot) and /guide/<itemId> serves the template's artguide from the main checkout, else from prod into a cache.

let tmp: string
let root: string
let main: string
let q: any
let server: http.Server | null = null
let base = ''
let port = 0
let clock: number
const deps = { marker: 'deps' }
const fixDeps = { marker: 'fixDeps' }
const ops = { runFixJob: () => new Promise(() => {}) }

const TPL = {
  id: 'tplA', name: 'Hoodie 12 mảnh', supplierId: 'sup1', supplierSku: 'WZIP-L', widthPx: 2000, heightPx: 1000, dpi: 200, bleedIn: 0.125, safeIn: 0.2, mirror: false,
  areas: [{ name: 'FRONT', x: 0, y: 0, w: 1000, h: 1000, shaped: true }, { name: 'BACK', x: 1000, y: 0, w: 1000, h: 1000, shaped: true }],
  guideImagePath: 'templates/tplA/guide.png',
}

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

async function addItem(id: string, taskKey: string, template: any) {
  const files = versionFiles(id, 1, [{ part: 'PRINT_FRONT', kind: 'PRINT' }])
  await q.addOrUpdate({
    id, taskKey, groupKey: taskKey, taskKeys: [taskKey], kind: 'line',
    apiLines: [{ taskKey, action: 'push', files: files.map(f => ({ kind: f.kind, printArea: f.printArea, path: f.path, fileName: f.fileName })) }],
    files, meta: { taskKey, productTitle: 'Hoodie', ...(template === undefined ? {} : { template }) }, qa: { verdict: 'pass', items: [] },
  })
}

async function start(guides: any) {
  if (server) await new Promise(r => server!.close(() => r(undefined)))
  server = createReviewServer({ queue: q, deps, fixDeps, ops, now: () => new Date(clock), log: () => {}, guides })
  await new Promise<void>(r => server!.listen(port, '127.0.0.1', () => { port = (server!.address() as any).port; r() }))
  base = `http://127.0.0.1:${port}`
}

function raw(p: string): Promise<{ status: number; body: string; type: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers: { host: `127.0.0.1:${port}` } }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), type: res.headers['content-type'] }))
    })
    req.on('error', reject)
    req.end()
  })
}

const detail = async (id: string) => (await fetch(`${base}/api/items/${id}`)).json()

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-canvas-'))
  root = path.join(tmp, 'queue')
  main = path.join(tmp, 'main')
  fs.mkdirSync(main, { recursive: true })
  clock = Date.parse('2026-11-17T01:00:00Z')
  q = await openQueue({ root, now: () => new Date(clock) })
  port = 0
  await start({ mainCheckout: main })
})

afterEach(async () => {
  if (server) await new Promise(r => server!.close(() => r(undefined)))
  server = null
  await q.close()
})

describe('GET /api/items/:id → template', () => {
  it('carries the template stored at intake, with a guide url only when the template has a guide image', async () => {
    await addItem('rq_t1', 'LIT5_1', TPL)
    await addItem('rq_t2', 'LIT6_1', { ...TPL, id: 'tplB', guideImagePath: null })
    await addItem('rq_t0', 'LIT4_1', null)
    const d = await detail('rq_t1')
    expect(d.template).toMatchObject({ id: 'tplA', name: 'Hoodie 12 mảnh', widthPx: 2000, heightPx: 1000, dpi: 200, guideUrl: '/guide/rq_t1' })
    expect(d.template.areas.map((a: any) => a.name)).toEqual(['FRONT', 'BACK'])
    expect((await detail('rq_t2')).template).toMatchObject({ id: 'tplB', guideUrl: null })
    expect((await detail('rq_t0')).template).toBeNull()
  })

  it('an item queued before templates were stored reads its template from the newest prod snapshot of the main checkout', async () => {
    fs.mkdirSync(path.join(main, 'db-backups'), { recursive: true })
    for (const [name, tplName] of [['prod-snap-20261116-0100.db', 'Old tpl'], ['prod-snap-20261117-0100.db', 'Snap tpl']]) {
      const snap = createClient({ url: `file:${path.join(main, 'db-backups', name).replace(/\\/g, '/')}` })
      await snap.execute('CREATE TABLE DesignTask (taskKey TEXT, orderId TEXT, shopifyLineId TEXT)')
      await snap.execute('CREATE TABLE OrderLine (orderId TEXT, shopifyLineId TEXT, resolvedSupplierId TEXT, resolvedSupplierSku TEXT, shopifyProductId TEXT)')
      await snap.execute('CREATE TABLE "Order" (id TEXT, storeId TEXT)')
      await snap.execute('CREATE TABLE PrintTemplate (id TEXT, name TEXT, supplierId TEXT, supplierSku TEXT, widthPx INTEGER, heightPx INTEGER, dpi INTEGER, bleedIn REAL, safeIn REAL, mirror INTEGER, areas TEXT, guideImagePath TEXT)')
      await snap.execute({ sql: 'INSERT INTO DesignTask VALUES (?,?,?)', args: ['LIT1_1', 'o1', 'l1'] })
      await snap.execute({ sql: 'INSERT INTO OrderLine VALUES (?,?,?,?,?)', args: ['o1', 'l1', 'sup1', 'WZIP-L', null] })
      await snap.execute({ sql: 'INSERT INTO PrintTemplate VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', args: ['tplS', tplName, 'sup1', 'WZIP-L', 1000, 500, 200, 0.125, 0.2, 0, '[{"name":"FRONT","x":0,"y":0,"w":1000,"h":500}]', null] })
      snap.close()
    }
    await addItem('rq_a1', 'LIT1_1', undefined)
    await addItem('rq_a2', 'LIT9_1', undefined)
    expect((await detail('rq_a1')).template).toMatchObject({ id: 'tplS', name: 'Snap tpl', guideUrl: null })
    expect((await detail('rq_a1')).template.areas).toEqual([{ name: 'FRONT', x: 0, y: 0, w: 1000, h: 500, shaped: false }])
    expect((await detail('rq_a2')).template).toBeNull()
  })

  it('no snapshot at all → template null, detail still answers', async () => {
    await addItem('rq_a1', 'LIT1_1', undefined)
    const d = await detail('rq_a1')
    expect(d.item.id).toBe('rq_a1')
    expect(d.template).toBeNull()
  })
})

describe('GET /guide/:itemId', () => {
  it('serves the guide from the main checkout storage, else fetches it once from prod into the queue cache, else 404', async () => {
    fs.mkdirSync(path.join(main, 'storage', 'templates', 'tplA'), { recursive: true })
    fs.writeFileSync(path.join(main, 'storage', 'templates', 'tplA', 'guide.png'), 'LOCAL-GUIDE')
    const fetched: string[] = []
    await start({ mainCheckout: main, fetchGuide: async (id: string) => { fetched.push(id); return id === 'tplC' ? Buffer.from('PROD-GUIDE') : null } })
    await addItem('rq_t1', 'LIT5_1', TPL)
    await addItem('rq_t3', 'LIT7_1', { ...TPL, id: 'tplC', guideImagePath: 'templates/tplC/guide.jpg' })
    await addItem('rq_t4', 'LIT8_1', { ...TPL, id: 'tplD', guideImagePath: 'templates/tplD/guide.png' })
    await addItem('rq_t5', 'LIT9_1', { ...TPL, id: 'tplE', guideImagePath: '../../queue.db' })
    await addItem('rq_t6', 'LIT10_1', { ...TPL, id: 'tplF', guideImagePath: 'templates/tplF/guide.psd' })
    await addItem('rq_t0', 'LIT4_1', null)
    const local = await raw('/guide/rq_t1')
    expect([local.status, local.body, local.type]).toEqual([200, 'LOCAL-GUIDE', 'image/png'])
    const prod = await raw('/guide/rq_t3')
    expect([prod.status, prod.body, prod.type]).toEqual([200, 'PROD-GUIDE', 'image/jpeg'])
    expect(fs.readFileSync(path.join(root, 'guides', 'tplC.jpg'), 'utf8')).toBe('PROD-GUIDE')
    expect((await raw('/guide/rq_t3')).body).toBe('PROD-GUIDE')
    expect(fetched).toEqual(['tplC'])
    expect((await raw('/guide/rq_t4')).status).toBe(404)
    expect(fetched).toEqual(['tplC', 'tplD'])
    expect((await raw('/guide/rq_t5')).status).toBe(404)
    expect((await raw('/guide/rq_t6')).status).toBe(404)
    expect((await raw('/guide/rq_t0')).status).toBe(404)
    expect((await raw('/guide/rq_nope')).status).toBe(404)
    expect((await raw('/guide/rq_t1/x')).status).toBe(404)
  })

  it('a prod fetch error is a 404 for the page, not a crash', async () => {
    await start({ mainCheckout: main, fetchGuide: async () => { throw new Error('HTTP 503') } })
    await addItem('rq_t1', 'LIT5_1', TPL)
    expect((await raw('/guide/rq_t1')).status).toBe(404)
    expect((await detail('rq_t1')).template.guideUrl).toBe('/guide/rq_t1')
  })
})
