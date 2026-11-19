import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import sharp from 'sharp'
import { createClient } from '@libsql/client'
import { openQueue } from '../scripts/review-queue/store.mjs'
import { enqueuePlan, queueApiLines, resolveShared, makePreview, runQueueIntake, makeNoteClient, noteQueueState, QUEUE_NOTE, HOLDING_NOTE } from '../scripts/review-queue/intake.mjs'
import { DeliveryGaveUp } from '../scripts/lib/delivery-client.mjs'

const NOTE = 'Đang chờ chủ shop duyệt ở máy local (tối đa 1 giờ)'
let tmp: string
let storageRoot: string
let queueRoot: string
let outDir: string
let ledgerPath: string
let q: any
let snapshot: any
let notes: [string, string][]
let logs: string[]
let downloads: string[]

const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const put = (rel: string, body: string) => {
  const p = path.join(storageRoot, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  return rel
}
const client = { note: async (key: string, message: string) => { notes.push([key, message]); return { ok: true, status: 200, body: { ok: true } } } }
const previewer = async (input: any, dst: string) => {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.writeFileSync(dst, `jpeg:${Buffer.isBuffer(input) ? input.toString() : path.basename(input)}`)
}
const download = async (url: string) => { downloads.push(url); return Buffer.from(`img:${url}`) }
const log = (m: string) => { logs.push(m) }

const printFile = (over: any = {}) => ({
  localId: 'a1', printArea: 'front', kind: 'PRINT', fileName: 'front.png', mimeType: 'image/png', size: 5, widthPx: 10, heightPx: 10,
  storagePath: 'r/LIT1_1/front.png', transfer: 'upload', ...over,
})
const planLine = (over: any = {}) => ({ taskKey: 'LIT1_1', action: 'push', prodStatus: 'NEW', productTitle: 'Plan title', files: [printFile()], ...over })

async function makeSnapshot(dir: string) {
  const db = createClient({ url: `file:${path.join(dir, 'snap.db').replace(/\\/g, '/')}` })
  await db.execute('CREATE TABLE DesignTask (taskKey TEXT, orderId TEXT, shopifyLineId TEXT)')
  await db.execute('CREATE TABLE OrderLine (orderId TEXT, shopifyLineId TEXT, productTitle TEXT, variantTitle TEXT, sku TEXT, resolvedSupplierSku TEXT, customAttributesJson TEXT, customallFieldsJson TEXT, previewCdnUrl TEXT, imageUrl TEXT, resolvedSupplierId TEXT, shopifyProductId TEXT)')
  await db.execute('CREATE TABLE "Order" (id TEXT, shopifyOrderNumber TEXT, placedAt TEXT, storeId TEXT)')
  await db.execute('CREATE TABLE PrintTemplate (id TEXT, name TEXT, supplierId TEXT, supplierSku TEXT, widthPx INTEGER, heightPx INTEGER, dpi INTEGER, bleedIn REAL, safeIn REAL, mirror INTEGER, areas TEXT, guideImagePath TEXT)')
  await db.execute('CREATE TABLE DesignArtwork (orderId TEXT, shopifyLineId TEXT, kind TEXT, removedAt TEXT)')
  await db.execute({ sql: 'INSERT INTO PrintTemplate VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', args: ['tplA', 'Hoodie 1', 'sup1', 'MWHD-1', 1000, 500, 200, 0.125, 0.2, 0, '[{"name":"FRONT","x":0,"y":0,"w":500,"h":500},{"name":"BACK","x":500,"y":0,"w":500,"h":500}]', 'templates/tplA/guide.png'] })
  const line = async (taskKey: string, n: number, over: any = {}) => {
    await db.execute({ sql: 'INSERT INTO DesignTask VALUES (?, ?, ?)', args: [taskKey, `o${n}`, `sl${n}`] })
    await db.execute({ sql: 'INSERT INTO "Order" VALUES (?, ?, ?, ?)', args: [`o${n}`, `LIT${n}`, '2026-11-14T08:00:00.000Z', 'store1'] })
    await db.execute({
      sql: 'INSERT INTO OrderLine VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [`o${n}`, `sl${n}`, over.productTitle ?? `Custom Hoodie ${n}`, 'Black / L', `TN${n}-BL-L`, `MWHD-${n}`,
        JSON.stringify(over.attrs ?? [{ key: 'Name', value: 'Anna' }, { key: '_customall_preview', value: 'https://cdn.x/attr.png' }]),
        JSON.stringify(over.cmFields ?? [{ key: 'Font', value: 'Script' }]),
        over.previewCdnUrl === undefined ? `https://cdn.x/preview-${n}.png` : over.previewCdnUrl,
        over.imageUrl === undefined ? `https://cdn.x/store-${n}.jpg` : over.imageUrl, 'sup1', `gid://shopify/Product/${n}`],
    })
  }
  await line('LIT1_1', 1)
  await line('LIT2_1', 2)
  await line('LIT3_1', 3, { previewCdnUrl: null })
  // LIT4_1: a HaPo tumbler through the _pers builder, no preview anywhere; LIT5_1: no custom at all, no preview; LIT6_1: prod already holds a mockup
  await line('LIT4_1', 4, { previewCdnUrl: null, attrs: [{ key: 'Custom Name', value: 'Kate' }, { key: '_pers', value: 'mw4midg6kthh' }] })
  await line('LIT5_1', 5, { previewCdnUrl: null, attrs: [{ key: 'Custom Name Yes or No', value: 'No' }], cmFields: [] })
  await line('LIT6_1', 6, { previewCdnUrl: null, attrs: [{ key: 'Custom Name', value: 'Mia' }, { key: '_pers', value: 'abc' }] })
  await db.execute({ sql: 'INSERT INTO DesignArtwork VALUES (?, ?, ?, ?)', args: ['o6', 'sl6', 'MOCKUP', null] })
  return db
}

const source = () => ({ cli: 'push-local-renders', out: outDir, ledgerPath })
const enqueue = async (plan: any, over: any = {}) => {
  const { lines } = queueApiLines(plan, { storageRoot, ledgerPath })
  return enqueuePlan({ plan, apiLines: lines, queue: q, snapshot, client, previewer, download, source: source(), log, ...over })
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-intake-'))
  storageRoot = path.join(tmp, 'storage')
  queueRoot = path.join(tmp, 'queue')
  outDir = path.join(tmp, 'out')
  ledgerPath = path.join(outDir, 'api-ledger.json')
  notes = []
  logs = []
  downloads = []
  q = await openQueue({ root: queueRoot })
  snapshot = await makeSnapshot(tmp)
})
afterEach(async () => {
  await q.close()
  snapshot.close()
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
})

describe('enqueuePlan', () => {
  it('enqueues a single line: files copied into v1, a preview per file, meta from the snapshot, one prod note', async () => {
    put('r/LIT1_1/front.png', 'FRONT-ART')
    put('r/LIT1_1/back.png', 'BACK-ART')
    const plan = { lines: [planLine({ files: [printFile(), printFile({ localId: 'a2', printArea: 'back', fileName: 'back.png', storagePath: 'r/LIT1_1/back.png' })] })] }
    const r = await enqueue(plan)
    expect(r).toMatchObject({ enqueued: ['LIT1_1'], unchanged: [], bypassed: [], refused: [] })
    const item = await q.activeByTaskKey('LIT1_1')
    expect(item).toMatchObject({ kind: 'line', groupKey: 'LIT1_1', status: 'waiting', version: 1, qa: { verdict: 'unchecked', items: [] } })
    const v1 = path.join(queueRoot, 'items', item.id, 'v1')
    expect(fs.readFileSync(path.join(v1, 'PRINT_front.png'), 'utf8')).toBe('FRONT-ART')
    expect(fs.readFileSync(path.join(v1, 'PRINT_back.png'), 'utf8')).toBe('BACK-ART')
    expect(fs.readFileSync(path.join(v1, 'preview', 'PRINT_front.jpg'), 'utf8')).toBe('jpeg:PRINT_front.png')
    expect(fs.existsSync(path.join(v1, 'preview', 'PRINT_back.jpg'))).toBe(true)
    const [ver] = await q.versions(item.id)
    expect(ver.files).toHaveLength(2)
    expect(ver.files.find((f: any) => f.part === 'PRINT_front')).toMatchObject({
      kind: 'PRINT', printArea: 'front', taskKey: 'LIT1_1', path: path.join(v1, 'PRINT_front.png'), sha256: sha(path.join(v1, 'PRINT_front.png')),
      preview: path.join(v1, 'preview', 'PRINT_front.jpg'), source: path.join(storageRoot, 'r/LIT1_1/front.png'),
    })
    expect(item.apiLines).toHaveLength(1)
    expect(item.apiLines[0]).toMatchObject({ taskKey: 'LIT1_1', action: 'push', expectedStatus: 'NEW', retire: [] })
    expect(item.apiLines[0].files.map((f: any) => f.path).sort()).toEqual([path.join(v1, 'PRINT_back.png'), path.join(v1, 'PRINT_front.png')])
    expect(item.meta).toMatchObject({
      productTitle: 'Custom Hoodie 1', variantTitle: 'Black / L', sku: 'TN1-BL-L', supplierSku: 'MWHD-1', orderNumber: 'LIT1', placedAt: '2026-11-14T08:00:00.000Z',
      custom: [{ name: 'Name', value: 'Anna' }, { name: 'Font', value: 'Script' }],
      customerPreview: path.join(v1, 'customer.jpg'), customerPreviewUrl: 'https://cdn.x/preview-1.png',
      storeImage: path.join(v1, 'store.jpg'), storeImageUrl: 'https://cdn.x/store-1.jpg',
      sourceCli: 'push-local-renders', ledgerPath, out: outDir,
    })
    expect(item.meta.template).toMatchObject({ id: 'tplA', name: 'Hoodie 1', widthPx: 1000, heightPx: 500, guideImagePath: 'templates/tplA/guide.png' })
    expect(item.meta.template.areas.map((a: any) => a.name)).toEqual(['FRONT', 'BACK'])
    expect(fs.readFileSync(path.join(v1, 'customer.jpg'), 'utf8')).toBe('jpeg:img:https://cdn.x/preview-1.png')
    expect(notes).toEqual([['LIT1_1', NOTE]])
    expect(QUEUE_NOTE).toBe(NOTE)
  })

  it('a byte-identical re-run is unchanged: no new version, clock kept, no second note, nothing downloaded again', async () => {
    put('r/LIT1_1/front.png', 'FRONT-ART')
    const plan = { lines: [planLine()] }
    await enqueue(plan)
    const before = await q.activeByTaskKey('LIT1_1')
    downloads = []
    const r = await enqueue(plan)
    expect(r).toMatchObject({ enqueued: [], unchanged: ['LIT1_1'], bypassed: [], refused: [] })
    const after = await q.get(before.id)
    expect(after.version).toBe(1)
    expect(after.enteredAt).toBe(before.enteredAt)
    expect(notes).toHaveLength(1)
    expect(downloads).toEqual([])
    expect(fs.existsSync(path.join(queueRoot, 'items', before.id, 'v2'))).toBe(false)
  })

  it('different output on a rejected item makes v2, back to waiting, clock restarts, no second note; identical output stays rejected', async () => {
    put('r/LIT1_1/front.png', 'FRONT-ART')
    const plan = { lines: [planLine()] }
    await enqueue(plan)
    const item = await q.activeByTaskKey('LIT1_1')
    await q.setStatus(item.id, 'rejected', { reason: 'tên lệch' })
    expect((await enqueue(plan)).unchanged).toEqual(['LIT1_1'])
    expect((await q.get(item.id)).status).toBe('rejected')
    await new Promise(r => setTimeout(r, 5))
    put('r/LIT1_1/front.png', 'FRONT-ART-FIXED')
    const r = await enqueue(plan)
    expect(r.enqueued).toEqual(['LIT1_1'])
    const v2 = await q.get(item.id)
    expect(v2).toMatchObject({ version: 2, status: 'waiting' })
    expect(v2.enteredAt > item.enteredAt).toBe(true)
    const v2dir = path.join(queueRoot, 'items', item.id, 'v2')
    expect(fs.readFileSync(path.join(v2dir, 'PRINT_front.png'), 'utf8')).toBe('FRONT-ART-FIXED')
    expect(fs.readFileSync(path.join(queueRoot, 'items', item.id, 'v1', 'PRINT_front.png'), 'utf8')).toBe('FRONT-ART')
    expect(v2.apiLines[0].files[0].path).toBe(path.join(v2dir, 'PRINT_front.png'))
    expect(v2.meta.customerPreview).toBe(path.join(v2dir, 'customer.jpg'))
    expect(fs.existsSync(path.join(v2dir, 'customer.jpg'))).toBe(true)
    expect(notes).toHaveLength(1)
  })

  it('a needs_look item from the same bytes is re-recorded as a new version and counts down again', async () => {
    put('r/LIT1_1/front.png', 'FRONT-ART')
    const plan = { lines: [planLine()] }
    await enqueue(plan)
    const item = await q.activeByTaskKey('LIT1_1')
    await q.setStatus(item.id, 'needs_look', { reason: 'prod đã thay đổi' })
    await new Promise(r => setTimeout(r, 5))
    const r = await enqueue(plan)
    expect(r).toMatchObject({ enqueued: ['LIT1_1'], unchanged: [] })
    const v2 = await q.get(item.id)
    expect(v2).toMatchObject({ version: 2, status: 'waiting', statusReason: null })
    expect(v2.enteredAt > item.enteredAt).toBe(true)
    expect(fs.readFileSync(path.join(queueRoot, 'items', item.id, 'v2', 'PRINT_front.png'), 'utf8')).toBe('FRONT-ART')
    expect((await enqueue(plan)).unchanged).toEqual(['LIT1_1'])
    await q.setStatus(item.id, 'needs_look', { reason: 'lại đổi' })
    const failed = await enqueue(plan, { qaByKey: { LIT1_1: { verdict: 'fail', items: ['tên vượt khung'] } } })
    expect(failed.enqueued).toEqual(['LIT1_1'])
    expect(await q.get(item.id)).toMatchObject({ version: 3, status: 'qa_failed' })
  })

  it('api lines that now mean something else on prod make a new version even with identical bytes', async () => {
    put('r/LIT1_1/front.png', 'FRONT-ART')
    await enqueue({ lines: [planLine()] })
    const item = await q.activeByTaskKey('LIT1_1')
    await q.setStatus(item.id, 'rejected', { reason: 'tên lệch' })
    const changes = [
      planLine({ prodStatus: 'REVIEW' }),
      planLine({ prodStatus: 'REVIEW', action: 'replace', replaces: [{ id: 'art1' }] }),
      planLine({ prodStatus: 'REVIEW', action: 'replace', replaces: [{ id: 'art1' }, { id: 'art2' }] }),
    ]
    for (let i = 0; i < changes.length; i++) {
      const line = changes[i]
      const r = await enqueue({ lines: [line] })
      expect(r.enqueued).toEqual(['LIT1_1'])
      const cur = await q.get(item.id)
      expect(cur).toMatchObject({ version: i + 2, status: 'waiting' })
      expect(cur.apiLines[0]).toMatchObject({ action: line.action, expectedStatus: 'REVIEW' })
    }
    expect((await q.get(item.id)).apiLines[0]).toMatchObject({ planIds: ['art1', 'art2'], retire: ['art1', 'art2'] })
    expect((await enqueue({ lines: [changes[2]] })).unchanged).toEqual(['LIT1_1'])
    expect(notes).toHaveLength(1)
  })

  it('prod hears once when an item stops counting down and once when it counts again', async () => {
    put('r/LIT1_1/front.png', 'FRONT-ART')
    await enqueue({ lines: [planLine()] })
    const item = await q.activeByTaskKey('LIT1_1')
    notes = []
    expect(await noteQueueState(q, item.id, client, log)).toBeNull()
    await q.setStatus(item.id, 'rejected', { reason: 'x' })
    expect(await noteQueueState(q, item.id, client, log)).toBe(HOLDING_NOTE)
    await q.setStatus(item.id, 'fixing', { reason: 'agent' })
    expect(await noteQueueState(q, item.id, client, log)).toBeNull()
    expect(notes).toEqual([['LIT1_1', HOLDING_NOTE]])
    await q.setStatus(item.id, 'rejected', { reason: 'agent không sửa được' })
    put('r/LIT1_1/front.png', 'FRONT-ART-FIXED')
    expect((await enqueue({ lines: [planLine()] })).enqueued).toEqual(['LIT1_1'])
    expect(notes).toEqual([['LIT1_1', HOLDING_NOTE], ['LIT1_1', QUEUE_NOTE]])
    await q.setStatus(item.id, 'needs_look', { reason: 'prod đổi' })
    const bad = { note: async () => ({ ok: false, status: 503, body: { error: 'down' } }) }
    expect(await noteQueueState(q, item.id, bad, log)).toBeNull()
    expect(logs.some(l => l.includes('không ghi được ghi chú lên prod') && l.includes('503'))).toBe(true)
    expect((await q.events(item.id)).some((e: any) => e.type === 'note_failed')).toBe(true)
    expect(await noteQueueState(q, item.id, client, log)).toBe(HOLDING_NOTE)
    expect(await noteQueueState(q, item.id, null, log)).toBeNull()
  })

  it('a group that only reuses a file already on Drive is bypassed (delivered by the caller as today)', async () => {
    const shared = (taskKey: string) => planLine({ taskKey, files: [printFile({ storagePath: null, transfer: 'reuse', shared: true, driveFileId: 'DRV_OLD', size: 99 })] })
    const plan = { lines: [shared('LIT2_1'), shared('LIT3_1'), { taskKey: 'LIT9_9', action: 'revert', files: [], replaces: [{ id: 'art9' }], readiness: 'LOW', reason: 'tay' }] }
    const r = await enqueue(plan)
    expect(r).toMatchObject({ enqueued: [], unchanged: [], bypassed: ['LIT2_1', 'LIT3_1', 'LIT9_9'], refused: [] })
    expect(await q.list()).toEqual([])
    expect(notes).toEqual([])
  })

  it('a group with a new upload is one group item holding all its api lines; later lines resolve to the first line\'s Drive file', async () => {
    put('spec/dl/x.png', 'SHARED-ART')
    const lead = planLine({ taskKey: 'LIT2_1', files: [printFile({ storagePath: 'spec/dl/x.png', fileName: 'front.png' })] })
    const later = planLine({ taskKey: 'LIT3_1', files: [printFile({ storagePath: 'spec/dl/x.png', transfer: 'reuse', shared: true, sharedFrom: 'LIT2_1', driveFileId: null })] })
    const r = await enqueue({ lines: [lead, later] })
    expect(r).toMatchObject({ enqueued: ['LIT2_1', 'LIT3_1'], unchanged: [], bypassed: [], refused: [] })
    const items = await q.list()
    expect(items).toHaveLength(1)
    const item = items[0]
    expect(item).toMatchObject({ kind: 'group', groupKey: 'LIT2_1', taskKey: 'LIT2_1' })
    expect(item.apiLines.map((l: any) => l.taskKey)).toEqual(['LIT2_1', 'LIT3_1'])
    const follower = item.apiLines[1].files[0]
    expect(follower.shortcutOf).toBeUndefined()
    expect(follower).toMatchObject({ sharedFrom: 'LIT2_1', sharedKey: 'PRINT/front', size: 5 })
    const [ver] = await q.versions(item.id)
    expect(ver.files).toHaveLength(1)
    expect(item.meta.lines.map((m: any) => m.taskKey)).toEqual(['LIT2_1', 'LIT3_1'])
    expect(item.meta.productTitle).toBe('Custom Hoodie 2')
    expect(notes.map(n => n[0])).toEqual(['LIT2_1', 'LIT3_1'])
    expect((await q.activeByTaskKey('LIT3_1'))?.id).toBe(item.id)

    const waiting = resolveShared(item.apiLines, () => null)
    expect(waiting.waiting).toEqual(['LIT3_1'])
    const done = resolveShared(item.apiLines, (from: string, key: string) => (from === 'LIT2_1' && key === 'PRINT/front' ? 'DRV_NEW' : null))
    expect(done.waiting).toEqual([])
    expect(done.lines[1].files[0]).toMatchObject({ shortcutOf: 'DRV_NEW', size: 5 })
    expect(done.lines[1].files[0].sharedFrom).toBeUndefined()
    expect(item.apiLines[1].files[0].shortcutOf).toBeUndefined()
  })

  it('a later line whose first line already delivered (Drive id in the ledger) is a plain shortcut and bypassed', async () => {
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(ledgerPath, JSON.stringify({ lines: { 'LIT2_1#x': { taskKey: 'LIT2_1', applied: '2026-11-15T00:00:00Z', files: { 'PRINT/front': { driveFileId: 'DRV_DONE' } } } } }))
    const later = planLine({ taskKey: 'LIT3_1', files: [printFile({ storagePath: 'spec/dl/x.png', transfer: 'reuse', shared: true, sharedFrom: 'LIT2_1', driveFileId: null })] })
    const r = await enqueue({ lines: [later] })
    expect(r.bypassed).toEqual(['LIT3_1'])
  })

  it('a missing local file for a part that is not a shortcut refuses the line with a clear reason; nothing queued', async () => {
    const r = await enqueue({ lines: [planLine({ files: [printFile({ storagePath: 'r/LIT1_1/missing.png', fileName: 'front.png' })] })] })
    expect(r.enqueued).toEqual([])
    expect(r.refused).toHaveLength(1)
    expect(r.refused[0].taskKey).toBe('LIT1_1')
    expect(r.refused[0].reason).toMatch(/không thấy file front\.png/)
    expect(r.refused[0].reason).toContain(path.join(storageRoot, 'r/LIT1_1/missing.png'))
    expect(await q.list()).toEqual([])
    expect(notes).toEqual([])
  })

  it('a refused first line refuses its whole group', async () => {
    const lead = planLine({ taskKey: 'LIT2_1', files: [printFile({ storagePath: 'spec/dl/gone.png' })] })
    const later = planLine({ taskKey: 'LIT3_1', files: [printFile({ storagePath: 'spec/dl/gone.png', transfer: 'reuse', shared: true, sharedFrom: 'LIT2_1', driveFileId: null })] })
    const r = await enqueue({ lines: [lead, later] })
    expect(r.refused.map((x: any) => x.taskKey)).toEqual(['LIT2_1', 'LIT3_1'])
  })

  it('qa results go with the item (fail → qa_failed), a failed note is logged and not fatal, a failed download keeps only the URL', async () => {
    put('r/LIT1_1/front.png', 'FRONT-ART')
    const badClient = { note: async () => { throw new Error('mạng hỏng') } }
    const r = await enqueue({ lines: [planLine()] }, {
      client: badClient,
      qaByKey: { LIT1_1: { verdict: 'fail', items: ['tên tràn khung'] } },
      download: async () => { throw new Error('timeout') },
    })
    expect(r.enqueued).toEqual(['LIT1_1'])
    expect(r.unnoted).toEqual(['LIT1_1'])
    expect(logs.filter(l => l.includes('CẢNH BÁO'))).toHaveLength(1)
    const item = await q.activeByTaskKey('LIT1_1')
    expect(item).toMatchObject({ status: 'qa_failed', qa: { verdict: 'fail', items: ['tên tràn khung'] } })
    expect(item.meta.customerPreview).toBeNull()
    expect(item.meta.customerPreviewUrl).toBe('https://cdn.x/preview-1.png')
    expect(item.meta.storeImage).toBeNull()
    expect(logs.some(l => l.includes('LIT1_1') && l.includes('mạng hỏng'))).toBe(true)
  })

  it('keeps the auto render QA inputs with the version (one line: as given; a group: byKey) so --qa-item can re-run the check', async () => {
    put('r/LIT1_1/front.png', 'FRONT-ART')
    const inputs = { source: 'local-render', taskKey: 'LIT1_1', noName: false, tolerance: 3, pieces: [{ printArea: 'front', part: 'PRINT_front' }] }
    await enqueue({ lines: [planLine()] }, { qaByKey: { LIT1_1: { verdict: 'fail', items: ['tên vượt khung 15 px'], inputs } } })
    const item = await q.activeByTaskKey('LIT1_1')
    expect(item.qa).toEqual({ verdict: 'fail', items: ['tên vượt khung 15 px'], inputs })
    expect((await q.versions(item.id))[0].qa.inputs).toEqual(inputs)

    put('spec/dl/x.png', 'SHARED-ART')
    const lead = planLine({ taskKey: 'LIT2_1', files: [printFile({ storagePath: 'spec/dl/x.png' })] })
    const later = planLine({ taskKey: 'LIT3_1', files: [printFile({ storagePath: 'spec/dl/x.png', transfer: 'reuse', shared: true, sharedFrom: 'LIT2_1', driveFileId: null })] })
    await enqueue({ lines: [lead, later] }, { qaByKey: { LIT2_1: { verdict: 'pass', items: [], inputs: { source: 'flat-text', taskKey: 'LIT2_1' } }, LIT3_1: { verdict: 'pass', items: [] } } })
    expect((await q.activeByTaskKey('LIT2_1')).qa).toEqual({ verdict: 'pass', items: [], inputs: { byKey: { LIT2_1: { source: 'flat-text', taskKey: 'LIT2_1' } } } })
  })

  it('a line without QA inputs stores no inputs key', async () => {
    put('r/LIT1_1/front.png', 'FRONT-ART')
    await enqueue({ lines: [planLine()] }, { qaByKey: { LIT1_1: { verdict: 'pass', items: [], inputs: 'not an object' } } })
    expect((await q.activeByTaskKey('LIT1_1')).qa).toEqual({ verdict: 'pass', items: [] })
  })

  it('falls back to the _customall_preview attribute when the line has no previewCdnUrl', async () => {
    put('r/LIT3_1/front.png', 'ART3')
    await enqueue({ lines: [planLine({ taskKey: 'LIT3_1', files: [printFile({ storagePath: 'r/LIT3_1/front.png' })] })] })
    const item = await q.activeByTaskKey('LIT3_1')
    expect(item.meta.customerPreviewUrl).toBe('https://cdn.x/attr.png')
  })
})

describe('mockup per line (owner 11/04: every line; 11/17: builder lines get their preview rebuilt)', () => {
  const madeFile = (name: string) => async ({ info, outDir }: any) => {
    fs.mkdirSync(outDir, { recursive: true })
    const p = path.join(outDir, `MOCKUP_${info.taskKey}.jpg`)
    fs.writeFileSync(p, `MOCK-${name}`)
    return { state: 'hapo', note: 'dựng lại preview builder', file: { kind: 'MOCKUP', printArea: `Preview ${name}`, fileName: `${info.taskKey}_Preview_${name}.jpg`, mimeType: 'image/jpeg', path: p, widthPx: 10, heightPx: 10 } }
  }
  const noFile = async ({ info }: any) => ({ state: 'missing', note: `builder ${info.builder}`, reason: `dòng qua builder (${info.builder}) nhưng TN4 chưa có công thức` })

  it('a built mockup is copied into the version, listed with the files and sent with the api line; meta says how it was made', async () => {
    put('r/LIT4_1/front.png', 'ART4')
    const seen: any[] = []
    const r = await enqueue({ lines: [planLine({ taskKey: 'LIT4_1', files: [printFile({ storagePath: 'r/LIT4_1/front.png' })] })] }, { mockup: async (a: any) => { seen.push(a); return madeFile('Kate')(a) }, artworkBuilder: 'X:/ab' })
    expect(r.enqueued).toEqual(['LIT4_1'])
    expect(seen[0]).toMatchObject({ hasMockupFile: false, root: 'X:/ab', info: { taskKey: 'LIT4_1', builder: 'pers', prodMockup: false, customerPreviewUrl: null, custom: [{ name: 'Custom Name', value: 'Kate' }, { name: 'Font', value: 'Script' }] } })
    const item = await q.activeByTaskKey('LIT4_1')
    expect(item.status).toBe('waiting')
    expect(item.meta.mockup).toEqual({ state: 'hapo', note: 'dựng lại preview builder' })
    const v1 = path.join(queueRoot, 'items', item.id, 'v1')
    const [ver] = await q.versions(item.id)
    const mock = ver.files.find((f: any) => f.kind === 'MOCKUP')
    expect(mock).toMatchObject({ part: 'MOCKUP_Preview_Kate', printArea: 'Preview Kate', taskKey: 'LIT4_1', path: path.join(v1, 'MOCKUP_Preview_Kate.jpg'), preview: path.join(v1, 'preview', 'MOCKUP_Preview_Kate.jpg') })
    expect(fs.readFileSync(mock.path, 'utf8')).toBe('MOCK-Kate')
    expect(item.apiLines[0].files.map((f: any) => [f.kind, f.printArea, f.path])).toEqual([['PRINT', 'front', path.join(v1, 'PRINT_front.png')], ['MOCKUP', 'Preview Kate', path.join(v1, 'MOCKUP_Preview_Kate.jpg')]])
    expect(fs.existsSync(path.join(queueRoot, 'tmp')) ? fs.readdirSync(path.join(queueRoot, 'tmp')) : []).toEqual([])
  })

  it('no mockup possible → the item fails QA with "Thiếu mockup" and the reason; a later run that builds one makes a new waiting version', async () => {
    put('r/LIT4_1/front.png', 'ART4')
    const plan = { lines: [planLine({ taskKey: 'LIT4_1', files: [printFile({ storagePath: 'r/LIT4_1/front.png' })] })] }
    await enqueue(plan, { mockup: noFile })
    const item = await q.activeByTaskKey('LIT4_1')
    expect(item).toMatchObject({ status: 'qa_failed', version: 1, qa: { verdict: 'fail', items: ['Thiếu mockup: dòng qua builder (pers) nhưng TN4 chưa có công thức'] } })
    expect(item.meta.mockup).toMatchObject({ state: 'missing', reason: expect.stringContaining('TN4') })
    const r = await enqueue(plan, { mockup: madeFile('Kate') })
    expect(r.enqueued).toEqual(['LIT4_1'])
    const again = await q.activeByTaskKey('LIT4_1')
    expect(again).toMatchObject({ id: item.id, status: 'waiting', version: 2, qa: { verdict: 'unchecked', items: [] } })
    expect(again.meta.mockup.state).toBe('hapo')
  })

  it('an item queued before the mockup check (no state) gets a new version when the check now says missing, with the same bytes', async () => {
    put('r/LIT4_1/front.png', 'ART4')
    const plan = { lines: [planLine({ taskKey: 'LIT4_1', files: [printFile({ storagePath: 'r/LIT4_1/front.png' })] })] }
    await enqueue(plan, { mockup: async () => ({ state: 'present', note: 'x' }) })
    const v1 = await q.activeByTaskKey('LIT4_1')
    expect(v1).toMatchObject({ version: 1, status: 'waiting' })
    await enqueue(plan, { mockup: noFile })
    const v2 = await q.activeByTaskKey('LIT4_1')
    expect(v2).toMatchObject({ id: v1.id, version: 2, status: 'qa_failed', meta: { mockup: { state: 'missing' } } })
    expect(v2.qa.items[0]).toMatch(/^Thiếu mockup:/)
    const r = await enqueue(plan, { mockup: noFile })
    expect(r.unchanged).toEqual(['LIT4_1'])
  })

  it('a group: each line gets its own mockup; one missing line fails the group with its key in the item', async () => {
    put('spec/dl/x.png', 'SHARED')
    const first = planLine({ taskKey: 'LIT4_1', files: [printFile({ storagePath: 'spec/dl/x.png', transfer: 'upload', shared: true })] })
    const later = planLine({ taskKey: 'LIT5_1', files: [printFile({ storagePath: 'spec/dl/x.png', transfer: 'reuse', shared: true, sharedFrom: 'LIT4_1', driveFileId: null })] })
    const byKey: any = { LIT4_1: madeFile('Kate'), LIT5_1: noFile }
    await enqueue({ lines: [first, later] }, { mockup: async (a: any) => byKey[a.info.taskKey](a) })
    const item = await q.activeByTaskKey('LIT4_1')
    expect(item).toMatchObject({ kind: 'group', status: 'qa_failed', qa: { verdict: 'fail', items: ['LIT5_1: Thiếu mockup: dòng qua builder (null) nhưng TN4 chưa có công thức'] } })
    expect(item.meta.lines.map((m: any) => [m.taskKey, m.mockup.state])).toEqual([['LIT4_1', 'hapo'], ['LIT5_1', 'missing']])
    expect(item.apiLines.find((l: any) => l.taskKey === 'LIT4_1').files.some((f: any) => f.kind === 'MOCKUP')).toBe(true)
    expect(item.apiLines.find((l: any) => l.taskKey === 'LIT5_1').files.some((f: any) => f.kind === 'MOCKUP')).toBe(false)
  })

  it('a group that only reuses a Drive print still enters the queue when its mockup is a new file (no-custom line: store photo)', async () => {
    const reuse = planLine({ taskKey: 'LIT5_1', files: [printFile({ storagePath: 'spec/dl/x.png', transfer: 'reuse', driveFileId: 'drv1' })] })
    const r = await enqueue({ lines: [reuse] }, { artworkBuilder: path.join(tmp, 'no-such-builder') })
    expect(r).toMatchObject({ enqueued: ['LIT5_1'], bypassed: [] })
    const item = await q.activeByTaskKey('LIT5_1')
    expect(item.meta.mockup.state).toBe('store')
    expect(item.apiLines[0].files.map((f: any) => [f.kind, f.knownDriveFileId ?? null, !!f.path])).toEqual([['PRINT', 'drv1', false], ['MOCKUP', null, true]])
    const [ver] = await q.versions(item.id)
    expect(ver.files.map((f: any) => f.kind)).toEqual(['MOCKUP'])
    const r2 = await enqueue({ lines: [planLine({ taskKey: 'LIT1_1', files: [printFile({ storagePath: 'spec/dl/y.png', transfer: 'reuse', driveFileId: 'drv2' })] })] })
    expect(r2).toMatchObject({ enqueued: [], bypassed: ['LIT1_1'] })
  })

  it('with the real resolver: a shopper preview or a prod mockup needs no file; no custom at all takes the store photo', async () => {
    for (const k of ['LIT1_1', 'LIT5_1', 'LIT6_1']) put(`r/${k}/front.png`, `ART-${k}`)
    const lines = ['LIT1_1', 'LIT5_1', 'LIT6_1'].map(k => planLine({ taskKey: k, files: [printFile({ storagePath: `r/${k}/front.png` })] }))
    const r = await enqueue({ lines }, { artworkBuilder: path.join(tmp, 'no-such-builder') })
    expect(r.enqueued).toEqual(['LIT1_1', 'LIT5_1', 'LIT6_1'])
    expect((await q.activeByTaskKey('LIT1_1')).meta.mockup.state).toBe('preview')
    expect((await q.activeByTaskKey('LIT6_1')).meta.mockup).toMatchObject({ state: 'prod' })
    const store = await q.activeByTaskKey('LIT5_1')
    expect(store.status).toBe('waiting')
    expect(store.meta.mockup).toMatchObject({ state: 'store' })
    const [ver] = await q.versions(store.id)
    const mock = ver.files.find((f: any) => f.kind === 'MOCKUP')
    expect(mock).toMatchObject({ part: 'MOCKUP_Preview_no-name', printArea: 'Preview no-name' })
    expect(fs.readFileSync(mock.path, 'utf8')).toBe('jpeg:img:https://cdn.x/store-5.jpg')
    expect(downloads.filter(u => u === 'https://cdn.x/store-5.jpg').length).toBeGreaterThanOrEqual(1)
  })
})

describe('makePreview', () => {
  it('JPEG at most 1600 px; white ink on transparency gets a dark background so it stays visible', async () => {
    const src = path.join(tmp, 'white.png')
    const w = 2000, h = 100
    const raw = Buffer.alloc(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (x < w / 2) { raw[i] = 255; raw[i + 1] = 255; raw[i + 2] = 255; raw[i + 3] = 255 }
    }
    await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toFile(src)
    const dst = path.join(tmp, 'out', 'p.jpg')
    await makePreview(src, dst)
    const meta = await sharp(dst).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(1600)
    const { data, info } = await sharp(dst).raw().toBuffer({ resolveWithObject: true })
    const at = (x: number) => data[(Math.floor(info.height / 2) * info.width + x) * info.channels]
    expect(at(1500)).toBeLessThan(80)
    expect(at(100)).toBeGreaterThan(230)
  })
})

describe('runQueueIntake', () => {
  it('pins the output lines auto_render.py queue_said/queue_outcome parse (header, "  <key>  <phrase>", summary)', async () => {
    put('r/LIT1_1/front.png', 'FRONT-ART')
    const shared = planLine({ taskKey: 'LIT2_1', files: [printFile({ storagePath: null, transfer: 'reuse', shared: true, driveFileId: 'DRV_OLD', size: 99 })] })
    const fakeClient = {
      note: client.note,
      taskState: async () => ({ ok: true, status: 200, body: { status: 'NEW', artworks: [], incomingFolder: { id: 'IN' } } }),
      commit: async () => ({ ok: true, status: 200, body: { status: 'REVIEW', artworks: [] } }),
      putPreview: async () => ({ ok: true, status: 200, body: {} }),
    }
    const run = async () => {
      const out: string[] = []
      await runQueueIntake({
        plan: { lines: [planLine(), shared] }, storageRoot, outDir, snapshot, queueRoot, sourceCli: 'push-local-renders',
        makeDeps: () => ({ client: fakeClient, uploader: { upload: async () => { throw new Error('no upload expected') } } }),
        makeNoteClient: () => client, previewer, download, log: (m: string) => out.push(m),
      })
      return out.join('\n').split('\n')
    }
    const header = /^== Hàng chờ duyệt local \(.*\): \d+ dòng ==$/
    const summary = /^\d+ dòng · vào hàng chờ \d+/
    const first = await run()
    expect(first.filter(l => header.test(l.trim()))).toEqual([`== Hàng chờ duyệt local (${queueRoot}): 2 dòng ==`])
    expect(first).toContain('  LIT1_1  vào hàng chờ')
    expect(first.find(l => l.startsWith('  LIT2_1  '))).toMatch(/^ {2}LIT2_1 {2}giao thẳng/)
    const sumAt = first.findIndex(l => summary.test(l))
    expect(sumAt).toBeGreaterThan(first.indexOf('  LIT1_1  vào hàng chờ'))
    const second = await run()
    expect(second.find(l => l.startsWith('  LIT1_1  '))).toMatch(/^ {2}LIT1_1 {2}không đổi/)
    expect(second.some(l => summary.test(l))).toBe(true)
  })

  it('prints one line per key and sends only the bypassed lines through the normal API delivery', async () => {
    put('r/LIT1_1/front.png', 'FRONT-ART')
    const shared = planLine({ taskKey: 'LIT2_1', files: [printFile({ storagePath: null, transfer: 'reuse', shared: true, driveFileId: 'DRV_OLD', size: 99 })] })
    const commits: string[] = []
    const fakeClient = {
      note: client.note,
      taskState: async () => ({ ok: true, status: 200, body: { status: 'NEW', artworks: [], incomingFolder: { id: 'IN' } } }),
      commit: async (key: string) => { commits.push(key); return { ok: true, status: 200, body: { status: 'REVIEW', artworks: [] } } },
      putPreview: async () => ({ ok: true, status: 200, body: {} }),
    }
    const out: string[] = []
    const qaFile = path.join(tmp, 'qa.json')
    fs.writeFileSync(qaFile, JSON.stringify({ LIT1_1: { verdict: 'pass', items: [] } }))
    const code = await runQueueIntake({
      plan: { lines: [planLine(), shared, { taskKey: 'LIT5_5', action: 'skip', skipReason: 'Task trên prod đang DONE', files: [] }] },
      storageRoot, outDir, snapshot, queueRoot, sourceCli: 'push-local-renders', qaJson: qaFile,
      makeDeps: () => ({ client: fakeClient, uploader: { upload: async () => { throw new Error('no upload expected') } } }),
      makeNoteClient: () => client,
      previewer, download, log: (m: string) => out.push(m),
    })
    expect(code).toBe(0)
    expect(commits).toEqual(['LIT2_1'])
    expect(notes).toEqual([['LIT1_1', NOTE]])
    const text = out.join('\n')
    expect(text).toMatch(/LIT1_1\s+vào hàng chờ/)
    expect(text).toMatch(/LIT2_1\s+giao thẳng/)
    expect(text).toMatch(/LIT5_5\s+không gửi: Task trên prod đang DONE/)
    const q2 = await openQueue({ root: queueRoot })
    expect((await q2.activeByTaskKey('LIT1_1'))?.qa).toEqual({ verdict: 'pass', items: [] })
    await q2.close()
  })

  it('with nothing to send prints 0 dòng and never builds a client or opens the queue', async () => {
    const out: string[] = []
    const emptyRoot = path.join(tmp, 'never')
    const code = await runQueueIntake({
      plan: { lines: [] }, storageRoot, outDir, snapshot, queueRoot: emptyRoot, sourceCli: 'push-local-renders',
      makeDeps: () => { throw new Error('no client expected') }, makeNoteClient: () => { throw new Error('no note client expected') }, previewer, download, log: (m: string) => out.push(m),
    })
    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/0 dòng/)
    expect(fs.existsSync(emptyRoot)).toBe(false)
  })
})

describe('fix round 1', () => {
  const lead = () => planLine({ taskKey: 'LIT2_1', files: [printFile({ storagePath: 'spec/dl/x.png' })] })
  const later = () => planLine({ taskKey: 'LIT3_1', files: [printFile({ storagePath: 'spec/dl/x.png', transfer: 'reuse', shared: true, sharedFrom: 'LIT2_1', driveFileId: null })] })

  it('a key already in another active item is refused, never queued twice or bypassed (A with B queued, then --line B)', async () => {
    put('spec/dl/x.png', 'SHARED-ART')
    await enqueue({ lines: [lead(), later()] })
    const item = await q.activeByTaskKey('LIT2_1')
    put('r/LIT3_1/front.png', 'OWN-ART')
    const own = await enqueue({ lines: [planLine({ taskKey: 'LIT3_1', files: [printFile({ storagePath: 'r/LIT3_1/front.png' })] })] })
    expect(own.enqueued).toEqual([])
    expect(own.refused).toEqual([{ taskKey: 'LIT3_1', reason: `đã có trong hàng chờ ${item.id}` }])
    const shortcut = await enqueue({ lines: [planLine({ taskKey: 'LIT3_1', files: [printFile({ storagePath: null, transfer: 'reuse', shared: true, driveFileId: 'DRV_OLD', size: 9 })] })] })
    expect(shortcut.bypassed).toEqual([])
    expect(shortcut.refused).toEqual([{ taskKey: 'LIT3_1', reason: `đã có trong hàng chờ ${item.id}` }])
    expect(await q.list()).toHaveLength(1)
  })

  it('a key_held refusal from the store (an intake racing past the key check) reads "đã có trong hàng chờ" and leaves no files', async () => {
    put('spec/dl/x.png', 'SHARED-ART')
    await enqueue({ lines: [lead(), later()] })
    const item = await q.activeByTaskKey('LIT2_1')
    put('r/LIT3_1/front.png', 'OWN-ART')
    const racing = { ...q, activeByTaskKey: async () => null }
    const r = await enqueue({ lines: [planLine({ taskKey: 'LIT3_1', files: [printFile({ storagePath: 'r/LIT3_1/front.png' })] })] }, { queue: racing })
    expect(r.refused).toEqual([{ taskKey: 'LIT3_1', reason: `đã có trong hàng chờ ${item.id}` }])
    expect(await q.list()).toHaveLength(1)
    expect(fs.readdirSync(path.join(queueRoot, 'items'))).toEqual([item.id])
  })

  it('a group that gains a member with byte-identical files is a new version holding the new member', async () => {
    put('spec/dl/x.png', 'SHARED-ART')
    await enqueue({ lines: [lead()] })
    const first = await q.activeByTaskKey('LIT2_1')
    expect(first.kind).toBe('line')
    const r = await enqueue({ lines: [lead(), later()] })
    expect(r.enqueued).toEqual(['LIT2_1', 'LIT3_1'])
    const item = await q.get(first.id)
    expect(item).toMatchObject({ version: 2, kind: 'group' })
    expect(item.apiLines.map((l: any) => l.taskKey)).toEqual(['LIT2_1', 'LIT3_1'])
    expect((await q.activeByTaskKey('LIT3_1'))?.id).toBe(first.id)
    expect(notes.map(n => n[0])).toEqual(['LIT2_1', 'LIT3_1'])
    await enqueue({ lines: [lead(), later()] })
    expect(notes.map(n => n[0])).toEqual(['LIT2_1', 'LIT3_1'])
  })

  it('a copied file loses knownDriveFileId so delivery uploads exactly the reviewed copy', async () => {
    put('r/LIT1_1/front.png', 'FRONT-ART')
    await enqueue({ lines: [planLine({ files: [printFile({ transfer: 'reuse', driveFileId: 'DRV_LOCALPUSH', size: 9 })] })] })
    const item = await q.activeByTaskKey('LIT1_1')
    const f = item.apiLines[0].files[0]
    expect(f.knownDriveFileId).toBeUndefined()
    expect(f.path).toBe(path.join(queueRoot, 'items', item.id, 'v1', 'PRINT_front.png'))
  })

  it('an item the agent is fixing is left alone: unchanged with reason, nothing written', async () => {
    put('r/LIT1_1/front.png', 'FRONT-ART')
    await enqueue({ lines: [planLine()] })
    const item = await q.activeByTaskKey('LIT1_1')
    await q.setStatus(item.id, 'fixing', { reason: 'Codex' })
    put('r/LIT1_1/front.png', 'NEW-ART')
    const r = await enqueue({ lines: [planLine()] })
    expect(r.unchanged).toEqual(['LIT1_1'])
    expect(r.reasons).toEqual({ LIT1_1: 'agent đang sửa' })
    expect(await q.get(item.id)).toMatchObject({ version: 1, status: 'fixing' })
    expect(fs.existsSync(path.join(queueRoot, 'items', item.id, 'v2'))).toBe(false)
  })

  it('notes go out after the enqueue loop, and the first failure stops them with one warning line', async () => {
    put('r/LIT1_1/front.png', 'A')
    put('r/LIT3_1/front.png', 'B')
    const seen: number[] = []
    let calls = 0
    const failing = { note: async () => { calls++; seen.push((await q.list()).length); throw new Error('prod chậm') } }
    const r = await enqueue({ lines: [planLine(), planLine({ taskKey: 'LIT3_1', files: [printFile({ storagePath: 'r/LIT3_1/front.png' })] })] }, { client: failing })
    expect(r.enqueued).toEqual(['LIT1_1', 'LIT3_1'])
    expect(calls).toBe(1)
    expect(seen).toEqual([2])
    expect(r.unnoted).toEqual(['LIT1_1', 'LIT3_1'])
    const warn = logs.filter(l => l.includes('CẢNH BÁO'))
    expect(warn).toHaveLength(1)
    expect(warn[0]).toContain('prod chậm')
    expect(warn[0]).toContain('LIT3_1')
  })

  it('the note client has its own 30 s budget and a per-request abort', async () => {
    const waits: number[] = []
    const inits: any[] = []
    let t = 0
    const c = makeNoteClient({
      baseUrl: 'https://x.test', token: 't',
      fetchImpl: async (_u: any, init: any) => { inits.push(init); throw new Error('down') },
      sleep: async (ms: number) => { waits.push(ms); t += ms }, now: () => t,
    })
    await expect(c.note('K', 'm')).rejects.toBeInstanceOf(DeliveryGaveUp)
    expect(waits).toEqual([5000, 10000])
    expect(inits.every(i => i.signal)).toBe(true)
  })
})
