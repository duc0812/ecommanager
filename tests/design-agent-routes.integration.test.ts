import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { saveAgentSettings } from '@/lib/design-settings'
import { AGENT_USER_EMAIL } from '@/lib/design-agent/agent-user'
import { agentRunnerInfo, generateAgentRunnerToken } from '@/lib/design-agent/runner'
import { drainDrivePushes, resetDrivePushQueue } from '@/lib/drive-push-queue'
import { POST as claim } from '@/app/api/design-agent/runner/claim/route'
import { POST as heartbeat } from '@/app/api/design-agent/runner/jobs/[id]/heartbeat/route'
import { POST as result } from '@/app/api/design-agent/runner/jobs/[id]/result/route'
import { POST as fail } from '@/app/api/design-agent/runner/jobs/[id]/fail/route'
import { POST as notes } from '@/app/api/design-agent/runner/notes/route'
import { POST as hold } from '@/app/api/design-agent/runner/hold/route'
import { PUT as artwork } from '@/app/api/design-agent/runner/tasks/[key]/artwork/route'
import { POST as submit } from '@/app/api/design-agent/runner/tasks/[key]/submit/route'
import { POST as reopen } from '@/app/api/design-agent/runner/tasks/[key]/reopen/route'
import { GET as files } from '@/app/api/design-agent/runner/files/[artworkId]/route'
import { agentFixture } from './helpers/design-agent-fixture'

const fx = agentFixture('dar')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dar-storage-'))
const TPL_SKU = 'DAR-FB'
let token = ''
let queued = ''
let running = ''
let running2 = ''
let running3 = ''
const ids: Record<string, string> = {}

const taskId = async (key: string) => (await prisma.designTask.findUniqueOrThrow({ where: { taskKey: key } })).id

async function run(key: string, kind = 'FIX', extra: Record<string, unknown> = {}) {
  return (await prisma.designAgentJob.create({
    data: { kind, source: 'REJECT', taskId: await taskId(key), taskKey: key, requestText: 'x', status: 'RUNNING', attempts: 1, lockedAt: new Date(), startedAt: new Date(), ...extra },
  })).id
}

function png(width: number, height: number): Buffer {
  const head = Buffer.alloc(64, 7)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'latin1')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return head
}

function auth(tok: string): Record<string, string> {
  return tok ? { authorization: `Bearer ${tok}` } : {}
}

function post(url: string, body: unknown, tok = token) {
  return new NextRequest(`http://localhost/api/design-agent/runner${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth(tok) }, body: JSON.stringify(body),
  })
}

function get(url: string, tok = token) {
  return new NextRequest(`http://localhost/api/design-agent/runner${url}`, { headers: auth(tok) })
}

function put(key: string, printArea: string, bytes: Buffer, tok = token, kind = 'PRINT') {
  const qs = new URLSearchParams({ printArea, fileName: `${printArea}.png`, kind })
  return new NextRequest(`http://localhost/api/design-agent/runner/tasks/${key}/artwork?${qs}`, {
    method: 'PUT', headers: { 'content-type': 'image/png', ...auth(tok) }, body: bytes, duplex: 'half',
  } as any)
}

const id = (v: string) => ({ params: { id: v } })
const key = (v: string) => ({ params: { key: v } })
const art = (v: string) => ({ params: { artworkId: v } })
const body = async (p: Promise<Response>): Promise<[number, unknown]> => { const r = await p; return [r.status, await r.json()] }

async function lastEvent(taskKey: string) {
  const e = await prisma.designTaskEvent.findFirstOrThrow({ where: { taskId: await taskId(taskKey) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const actor = e.actorId ? await prisma.appUser.findUnique({ where: { id: e.actorId } }) : null
  return { type: e.type, message: e.message, actorName: actor?.name ?? null }
}

async function storedArtwork(orderId: string, shopifyLineId: string, name: string, bytes: Buffer, printArea = 'Front') {
  const rel = `design/dar/${name}`
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
  fs.writeFileSync(path.join(tmp, rel), bytes)
  return (await prisma.designArtwork.create({
    data: { orderId, shopifyLineId, printArea, version: 1, fileName: name, storagePath: rel, size: bytes.length, mimeType: 'image/png', widthPx: 100, heightPx: 100 },
  })).id
}

const ROUTES: [string, (tok: string) => Promise<Response>][] = [
  ['claim', t => claim(post('/claim', {}, t))],
  ['heartbeat', t => heartbeat(post('/jobs/x/heartbeat', {}, t), id('x'))],
  ['result', t => result(post('/jobs/x/result', {}, t), id('x'))],
  ['fail', t => fail(post('/jobs/x/fail', {}, t), id('x'))],
  ['notes', t => notes(post('/notes', {}, t))],
  ['hold', t => hold(post('/hold', {}, t))],
  ['artwork', t => artwork(put('X_1', 'Front', png(10, 10), t), key('X_1'))],
  ['submit', t => submit(post('/tasks/X_1/submit', {}, t), key('X_1'))],
  ['reopen', t => reopen(post('/tasks/X_1/reopen', {}, t), key('X_1'))],
  ['files', t => files(get('/files/x', t), art('x'))],
]

beforeAll(async () => {
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAR' } } })
  await prisma.appSetting.deleteMany({ where: { key: { in: ['design.settings', 'design.agent.tokenHash', 'design.agent.lastSeenAt'] } } })
  await fx.cleanup()
  await fx.seed()
  await prisma.printTemplate.deleteMany({ where: { supplierId: fx.supplierId } })
  await prisma.printTemplate.create({ data: {
    supplierId: fx.supplierId, supplierSku: TPL_SKU, name: 'DAR Front Back', widthPx: 2000, heightPx: 1000,
    areas: JSON.stringify([{ name: 'Front', x: 0, y: 0, w: 1000, h: 1000 }, { name: 'Back', x: 1000, y: 0, w: 1000, h: 1000 }]),
  } })
  const o1 = await fx.order(1, { skus: ['DR1-Hoodie'], taskStatus: 'REJECTED' })
  await storedArtwork(o1.orderId, 'l1', 'Front.png', png(100, 100))
  const o2 = await fx.order(2, { skus: ['DR2-Hoodie'], taskStatus: 'REJECTED', supplierSku: TPL_SKU })
  await storedArtwork(o2.orderId, 'l1', 'Front.png', png(100, 100))
  await fx.order(3, { skus: ['DR3-Hoodie'], taskStatus: 'DONE', withPrint: true, exported: true })
  await fx.order(4, { skus: ['DR4-Hoodie'] })
  const o5 = await fx.order(5, { skus: ['DR5-Hoodie'], taskStatus: 'REJECTED' })
  ids.artRunning = await storedArtwork(o5.orderId, 'l1', 'Run.png', png(100, 100))
  const o6 = await fx.order(6, { skus: ['DR6-Hoodie'], taskStatus: 'REJECTED' })
  ids.artOther = await storedArtwork(o6.orderId, 'l1', 'Other.png', png(100, 100))
  await fx.order(7, { skus: ['DR7-Hoodie'], taskStatus: 'REJECTED' })
  await fx.order(8, { skus: ['DR8-Hoodie'], taskStatus: 'REJECTED' })
  await saveAgentSettings({ maxConcurrent: 10 })
  token = await generateAgentRunnerToken()
  queued = (await prisma.designAgentJob.create({ data: { kind: 'FIX', source: 'REJECT', taskId: await taskId('DAR7_1'), taskKey: 'DAR7_1', requestText: 'x' } })).id
  running = await run('DAR1_1')
  running2 = await run('DAR8_1')
  running3 = await run('DAR2_1')
  await run('DAR3_1', 'LIBRARY_APPLY', { source: 'LIBRARY', affectedJson: JSON.stringify({ rows: [], fulfilledCount: 0 }) })
  await run('DAR5_1')
})

afterEach(async () => {
  await drainDrivePushes()
  resetDrivePushQueue()
})

afterAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAR' } } })
  await prisma.appSetting.deleteMany({ where: { key: { in: ['design.settings', 'design.agent.tokenHash', 'design.agent.lastSeenAt'] } } })
  await prisma.printTemplate.deleteMany({ where: { supplierId: fx.supplierId } })
  await prisma.appUser.deleteMany({ where: { email: AGENT_USER_EMAIL } })
  await fx.cleanup()
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
})

describe('runner API', () => {
  it.each(ROUTES)('%s refuses a call without the runner token', async (_name, call) => {
    const res = await call('')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect((await call('dag_wrong')).status).toBe(401)
  })

  it('claim answers { jobs: [] } and records the runner as seen', async () => {
    await prisma.designAgentJob.updateMany({ where: { taskKey: { startsWith: 'DAR' } }, data: { status: 'DONE' } })
    const res = await claim(post('/claim', { free: 3, waitSeconds: 0 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ jobs: [] })
    expect((await agentRunnerInfo()).online).toBe(true)
    await prisma.designAgentJob.updateMany({ where: { id: { in: [running, running2, running3] } }, data: { status: 'RUNNING' } })
    await prisma.designAgentJob.updateMany({ where: { taskKey: { in: ['DAR3_1', 'DAR5_1'] } }, data: { status: 'RUNNING' } })
    await prisma.designAgentJob.update({ where: { id: queued }, data: { status: 'QUEUED' } })
  })

  it('claim hands out a queued job in the contract shape', async () => {
    await prisma.designAgentJob.update({ where: { id: queued }, data: { status: 'QUEUED' } })
    const res = await claim(post('/claim', { free: 1, waitSeconds: 0 }))
    const json = await res.json()
    expect(json.jobs).toHaveLength(1)
    expect(json.jobs[0]).toMatchObject({ id: queued, kind: 'FIX', task: { key: 'DAR7_1' }, parent: null })
    expect((await claim(post('/claim', { free: 'many' }))).status).toBe(200)
  })

  it('heartbeat / result / fail follow the contract', async () => {
    const queuedNow = await prisma.designAgentJob.create({ data: { kind: 'FIX', source: 'REJECT', taskId: await taskId('DAR4_1'), taskKey: 'DAR4_1', requestText: 'x' } })
    expect(await body(heartbeat(post(`/jobs/${queuedNow.id}/heartbeat`, { stage: 's', rounds: 0 }), id(queuedNow.id)))).toEqual([409, { error: 'not running' }])
    expect(await body(heartbeat(post(`/jobs/${running}/heartbeat`, { stage: 'round 1: codex', rounds: 1 }), id(running)))).toEqual([200, { ok: true }])
    expect(await body(fail(post(`/jobs/${running2}/fail`, { error: 'x', permanent: false }), id(running2)))).toEqual([200, { ok: true, status: 'QUEUED', attempts: 1 }])
    expect(await body(fail(post(`/jobs/${running2}/fail`, { error: 'x' }), id(running2)))).toEqual([409, { error: 'not running' }])
    expect((await result(post(`/jobs/${running}/result`, { outcome: 'MAYBE', summary: 's' }), id(running))).status).toBe(400)
    expect(await body(result(post(`/jobs/${running}/result`, { outcome: 'NEEDS_OWNER', summary: 'thiếu nguồn', rounds: 3, result: {} }), id(running)))).toEqual([200, { ok: true, status: 'NEEDS_OWNER' }])
    expect(await body(result(post(`/jobs/${running}/result`, { outcome: 'NEEDS_OWNER', summary: 'lại' }), id(running)))).toEqual([409, { error: 'not running' }])
    await run('DAR1_1')
  })

  it('artwork: 409 without a running job, then a new version of the part', async () => {
    expect((await artwork(put('DAR4_1', 'Front', png(100, 100)), key('DAR4_1'))).status).toBe(409)
    const res = await artwork(put('DAR1_1', 'Front', png(100, 100)), key('DAR1_1'))
    expect(await res.json()).toMatchObject({ ok: true, version: 2, printArea: 'Front', artworkId: expect.any(String) })
    expect(await lastEvent('DAR1_1')).toMatchObject({ type: 'ARTWORK', actorName: 'Design Agent' })
    expect((await artwork(put('DAR1_1', 'Front', png(100, 100), token, 'BAD'), key('DAR1_1'))).status).toBe(400)
  })

  it('submit', async () => {
    expect(await body(submit(post('/tasks/DAR2_1/submit', {}), key('DAR2_1')))).toEqual([400, { error: expect.any(String), missing: ['Back'] }])
    expect(await body(submit(post('/tasks/DAR1_1/submit', {}), key('DAR1_1')))).toEqual([200, { ok: true, status: 'REVIEW' }])
    expect((await submit(post('/tasks/DAR4_1/submit', {}), key('DAR4_1'))).status).toBe(409)
  })

  it('reopen, notes, hold', async () => {
    expect(await body(reopen(post('/tasks/DAR3_1/reopen', { reason: 'Nội bộ phát hiện lỗi', note: 'cập nhật thư viện' }), key('DAR3_1')))).toEqual([200, { ok: true, status: 'REJECTED', sent: true }])
    expect((await reopen(post('/tasks/DAR4_1/reopen', {}), key('DAR4_1'))).status).toBe(409)
    expect((await notes(post('/notes', { taskKey: 'NOPE_1', message: 'x' }))).status).toBe(404)
    expect(await body(notes(post('/notes', { taskKey: 'DAR1_1', message: 'vòng 1' })))).toEqual([200, { ok: true }])
    await saveAgentSettings({ autoFixOnReject: false })
    expect(await body(hold(post('/hold', { taskKey: 'DAR4_1', reason: 'tên vượt khung' })))).toEqual([200, { ok: true, jobId: null }])
    expect((await hold(post('/hold', { taskKey: 'NOPE_1', reason: 'x' }))).status).toBe(404)
  })

  it('files: only for a task with a covering job, as an attachment', async () => {
    const ok = await files(get(`/files/${ids.artRunning}`), art(ids.artRunning))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(Buffer.from(await ok.arrayBuffer()).equals(png(100, 100))).toBe(true)
    expect((await files(get(`/files/${ids.artOther}`), art(ids.artOther))).status).toBe(404)
    expect((await files(get('/files/nope'), art('nope'))).status).toBe(404)
  })

  it('a task covered only by a running LIBRARY_APPLY job takes upload and submit, and is refused once that job stops', async () => {
    const target = await fx.order(9, { skus: ['DR9-Hoodie'], taskStatus: 'REJECTED' })
    await storedArtwork(target.orderId, 'l1', 'Cover.png', png(100, 100))
    await fx.order(10, { skus: ['DR10-Hoodie'], taskStatus: 'REJECTED' })
    const apply = await run('DAR10_1', 'LIBRARY_APPLY', { source: 'LIBRARY', affectedJson: JSON.stringify({ rows: [{ taskKey: 'DAR9_1' }], fulfilledCount: 0 }) })
    expect((await artwork(put('DAR9_1', 'Front', png(100, 100)), key('DAR9_1'))).status).toBe(200)
    expect(await lastEvent('DAR9_1')).toMatchObject({ type: 'ARTWORK', actorName: 'Design Agent' })

    await prisma.designAgentJob.update({ where: { id: apply }, data: { status: 'DONE' } })
    expect(await body(artwork(put('DAR9_1', 'Front', png(100, 100)), key('DAR9_1')))).toEqual([409, { error: 'Task không có job Agent đang chạy' }])
    expect(await body(submit(post('/tasks/DAR9_1/submit', {}), key('DAR9_1')))).toEqual([409, { error: 'Task không có job Agent đang chạy' }])
    expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'DAR9_1' } })).status).toBe('REJECTED')

    await prisma.designAgentJob.update({ where: { id: apply }, data: { status: 'RUNNING' } })
    expect(await body(submit(post('/tasks/DAR9_1/submit', {}), key('DAR9_1')))).toEqual([200, { ok: true, status: 'REVIEW' }])
    expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'DAR9_1' } })).status).toBe('REVIEW')
  })
})
