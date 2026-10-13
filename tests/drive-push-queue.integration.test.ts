import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { NextRequest } from 'next/server'

const schedule = vi.fn()
vi.mock('node-cron', () => ({ default: { schedule: (...args: unknown[]) => schedule(...args) } }))

import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { canCallApi } from '@/lib/api-access'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/roles'
import { GOOGLE_KEYS } from '@/lib/google-oauth'
import { primeAccessToken, resetDriveCache } from '@/lib/google-drive'
import { saveArtwork, storageRoot } from '@/lib/design-storage'
import { artworkUrl } from '@/lib/design-studio'
import { pushArtworkToDrive } from '@/lib/design-drive-push'
import {
  DRIVE_PUSH_RESULT_KEY, MAX_CONSECUTIVE_FAILURES, drainDrivePushes, enqueueDrivePush, getDrivePushStatus, pushPendingArtworksToDrive,
  resetDrivePushQueue, runDrivePushJob, startBulkDrivePush,
} from '@/lib/drive-push-queue'
import { DRIVE_PUSH_CRON, initDrivePushScheduler, runScheduledDrivePush } from '@/lib/drive-push-scheduler'
import { driveBannerItems, type DriveHealthView } from '@/app/design-studio/components/drive-health-model'
import { GET as pushStatusRoute, POST as pushStartRoute } from '@/app/api/setup/google-drive/push-local/route'
import { GET as healthRoute } from '@/app/api/design-studio/drive-health/route'

type Call = { url: string; method: string; headers: Headers; body: any }

const KEYS = [...Object.values(GOOGLE_KEYS), DRIVE_PUSH_RESULT_KEY]
const ORDER_ID = 'gid://test/Order/dpq-1'
const OTHER_ORDER_ID = 'gid://test/Order/dpq-2'
const SHOP = 'dpq-store.myshopify.com'
const PROJECT = 'proj_dpq'
const SUP = 'sup_dpq'
const SESSION = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=dpq-'
const GB = 1024 ** 3
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpq-storage-'))
const driveLink = (n: string | number) => `https://drive.google.com/file/d/dpq-file-${n}/view?usp=drivesdk`
const savedFlag = process.env.DISABLE_SCHEDULERS
const initKeys = () => (globalThis as typeof globalThis & { __initOnce?: Set<string> }).__initOnce
let lineId = ''
let calls: Call[] = []
let tokens: Record<'super' | 'admin' | 'support', string> = { super: '', admin: '', support: '' }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type Overrides = { gate?: Promise<void>; put?: (name: string) => Response | null; token?: () => Response; about?: () => Response }

function driveMock(o: Overrides = {}) {
  calls = []
  let sessions = 0
  let folders = 0
  const names = new Map<string, string>()
  vi.stubGlobal('fetch', vi.fn(async (input: any, init: RequestInit = {}) => {
    const c: Call = { url: String(input), method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body }
    calls.push(c)
    if (c.url === 'https://oauth2.googleapis.com/token') return o.token ? o.token() : json({ access_token: 'at-new', expires_in: 3600 })
    if (c.url.startsWith('https://www.googleapis.com/drive/v3/about')) {
      return o.about ? o.about() : json({ user: { emailAddress: 'owner@gmail.com' }, storageQuota: { limit: String(15 * GB), usage: String(14 * GB) } })
    }
    if (c.url.startsWith('https://www.googleapis.com/upload/drive/v3/files') && c.method === 'POST') {
      const id = String(++sessions)
      names.set(id, JSON.parse(String(c.body)).name)
      return new Response(null, { status: 200, headers: { Location: `${SESSION}${id}` } })
    }
    if (c.url.startsWith(SESSION) && c.method === 'PUT') {
      const n = c.url.slice(SESSION.length)
      if (o.gate) await o.gate
      const custom = o.put?.(names.get(n) ?? '')
      if (custom) return custom
      return json({ id: `dpq-file-${n}`, webViewLink: driveLink(n) })
    }
    if (c.url.includes('/permissions')) return json({ id: 'anyoneWithLink' })
    if (c.method === 'DELETE') return new Response(null, { status: 204 })
    if (c.url.startsWith('https://www.googleapis.com/drive/v3/files?q=')) return json({ files: [] })
    if (c.url.startsWith('https://www.googleapis.com/drive/v3/files?fields=id') && c.method === 'POST') return json({ id: `folder-${++folders}` })
    return json({ error: { message: `unexpected ${c.method} ${c.url}` } }, 500)
  }))
}

const puts = () => calls.filter(c => c.method === 'PUT')
const uploadInits = () => calls.filter(c => c.url.startsWith('https://www.googleapis.com/upload/drive/v3/files') && c.method === 'POST')

async function connect() {
  await prisma.appSetting.createMany({
    data: [
      { key: GOOGLE_KEYS.clientId, value: 'cid' },
      { key: GOOGLE_KEYS.clientSecret, value: 'secret' },
      { key: GOOGLE_KEYS.refreshToken, value: '1//refresh' },
      { key: GOOGLE_KEYS.rootFolderId, value: 'root-1' },
    ],
  })
  primeAccessToken('at-primed', 3600, '1//refresh')
}

let clock = Date.parse('2026-10-01T00:00:00Z')

async function local(name: string, printArea = 'Front') {
  const saved = await saveArtwork({ lineId, printArea, fileName: name, mimeType: 'image/png', bytes: Buffer.from(`bytes of ${name}`), uploadedById: null })
  clock += 60_000
  await prisma.designArtwork.update({ where: { id: saved.id }, data: { createdAt: new Date(clock) } })
  return saved
}

const row = (id: string) => prisma.designArtwork.findUniqueOrThrow({ where: { id } })
const setting = async (key: string) => (await prisma.appSetting.findUnique({ where: { key } }))?.value ?? null

function req(pathname: string, who: keyof typeof tokens | null, method = 'GET') {
  const r = new NextRequest(`http://localhost${pathname}`, { method })
  if (who) r.cookies.set(AUTH_COOKIE, tokens[who])
  return r
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'DPQ Store', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'DPQSUP' }, create: { id: SUP, name: 'DPQ Supplier', code: 'DPQSUP' }, update: {} })
  const base = { projectId: PROJECT, storeId, financialStatus: 'PAID', currency: 'USD', grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-05T12:00:00Z') }
  const order = await prisma.order.create({
    data: { ...base, id: ORDER_ID, shopifyOrderNumber: '#DPQ1', lines: { create: [{ shopifyLineId: 'p1', sku: 'S', productTitle: 'Shirt', qty: 1, linePosition: 1, unitPrice: 1 }] } },
    include: { lines: true },
  })
  lineId = order.lines[0].id
  await prisma.order.create({
    data: { ...base, id: OTHER_ORDER_ID, shopifyOrderNumber: '#DPQ2', lines: { create: [{ shopifyLineId: 'q1', sku: 'S', productTitle: 'Shirt', qty: 1, linePosition: 1, unitPrice: 1 }] } },
  })
  await prisma.designTask.create({ data: { orderId: ORDER_ID, shopifyLineId: 'p1', taskKey: 'DPQ1_1' } })
  const users = [['super', 'SUPERADMIN'], ['admin', 'ADMIN'], ['support', 'SUPPORT']] as const
  for (const [name, role] of users) {
    const email = `${name}@dpq.test`
    const permissions = role === 'SUPPORT' ? ['design_tasks'] : []
    const id = (await prisma.appUser.upsert({ where: { email }, create: { name, email, role, permissions: JSON.stringify(permissions) }, update: {} })).id
    tokens[name] = await signToken({ userId: id, email, name, role, permissions: permissions as any, tv: 0 })
  }
})

beforeEach(async () => {
  await drainDrivePushes()
  resetDrivePushQueue()
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  await prisma.designArtwork.deleteMany({ where: { orderId: { in: [ORDER_ID, OTHER_ORDER_ID] } } })
  await prisma.designArtworkUpload.deleteMany({ where: { orderId: ORDER_ID } })
  await prisma.orderLine.updateMany({ where: { orderId: { in: [ORDER_ID, OTHER_ORDER_ID] } }, data: { designDriveLink: null } })
  await prisma.skuSupplierDesign.deleteMany({ where: { supplierId: SUP } })
  fs.rmSync(path.join(tmp, 'design'), { recursive: true, force: true })
  resetDriveCache()
  schedule.mockClear()
  initKeys()?.delete('drive-push-scheduler')
})

afterEach(async () => {
  await drainDrivePushes()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  await prisma.skuSupplierDesign.deleteMany({ where: { supplierId: SUP } })
  await prisma.order.deleteMany({ where: { id: { in: [ORDER_ID, OTHER_ORDER_ID] } } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.appUser.deleteMany({ where: { email: { endsWith: '@dpq.test' } } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
  if (savedFlag === undefined) delete process.env.DISABLE_SCHEDULERS
  else process.env.DISABLE_SCHEDULERS = savedFlag
})

describe('pushPendingArtworksToDrive', () => {
  it('pushes the oldest files first, up to the limit, and reports counts', async () => {
    const a = await local('a.png')
    const b = await local('b.png')
    const c = await local('c.png')
    await prisma.designArtwork.update({ where: { id: (await local('gone.png')).id }, data: { removedAt: new Date() } })
    await connect()
    driveMock()

    const first = await pushPendingArtworksToDrive({ limit: 2 })
    expect(first).toEqual({ pending: 1, attempted: 2, pushed: 2, failed: 0, skipped: 0, missing: 0, lastError: null, stopped: null })
    expect(uploadInits().map(i => JSON.parse(i.body).name)).toEqual(['v1-a.png', 'v2-b.png'])
    expect((await row(a.id)).storage).toBe('DRIVE')
    expect((await row(b.id)).storage).toBe('DRIVE')
    expect((await row(c.id)).storage).toBe('LOCAL')

    const second = await pushPendingArtworksToDrive({ limit: 2 })
    expect(second).toMatchObject({ pending: 0, attempted: 1, pushed: 1 })
    expect(puts()).toHaveLength(3)
    expect((await pushPendingArtworksToDrive({ limit: 2 })).attempted).toBe(0)
  })

  it('never pushes a file twice, whatever runs at the same time', async () => {
    const files = [await local('a.png'), await local('b.png'), await local('c.png'), await local('d.png')]
    await connect()
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    driveMock({ gate })

    enqueueDrivePush(files[0].id)
    const direct = pushArtworkToDrive(files[1].id)
    const queueA = pushPendingArtworksToDrive({ limit: 10 })
    const queueB = pushPendingArtworksToDrive({ limit: 10, force: true })
    enqueueDrivePush(files[2].id)
    await new Promise(resolve => setTimeout(resolve, 50))
    release()
    await Promise.all([direct, queueA, queueB])
    await drainDrivePushes()
    await pushPendingArtworksToDrive({ limit: 10, force: true })

    expect(uploadInits()).toHaveLength(4)
    expect(puts()).toHaveLength(4)
    const stored = await Promise.all(files.map(f => row(f.id)))
    expect(stored.every(r => r.storage === 'DRIVE')).toBe(true)
    expect(new Set(stored.map(r => r.driveFileId)).size).toBe(4)
    expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(0)
    expect(await prisma.designArtworkUpload.count({ where: { orderId: ORDER_ID, completedAt: { not: null } } })).toBe(4)
  })

  it('a file missing on disk is counted as missing and does not hold up the rest', async () => {
    const lost = await local('lost.png')
    const ok = await local('ok.png')
    fs.rmSync(path.join(storageRoot(), (await row(lost.id)).storagePath!))
    await connect()
    driveMock()
    const r = await pushPendingArtworksToDrive({ limit: 5 })
    expect(r).toMatchObject({ pending: 1, attempted: 1, pushed: 1, failed: 0, missing: 1, stopped: null })
    expect((await row(ok.id)).storage).toBe('DRIVE')
    expect(puts()).toHaveLength(1)
  })

  it('a failed file waits out a back-off on scheduled runs; a forced run retries it', async () => {
    const bad = await local('bad.png')
    const good = await local('good.png')
    await connect()
    driveMock({ put: name => (name.includes('bad') ? json({ error: { message: 'Rate Limit Exceeded' } }, 403) : null) })

    const first = await pushPendingArtworksToDrive({ limit: 5 })
    expect(first).toMatchObject({ pending: 1, attempted: 2, pushed: 1, failed: 1, stopped: null })
    expect(first.lastError).toMatch(/^Chưa đẩy được lên Drive: .*Rate Limit Exceeded/)
    expect((await row(bad.id)).storage).toBe('LOCAL')
    expect((await row(good.id)).storage).toBe('DRIVE')

    const before = puts().length
    expect(await pushPendingArtworksToDrive({ limit: 5 })).toMatchObject({ pending: 1, attempted: 0, failed: 0 })
    expect(puts()).toHaveLength(before)

    driveMock()
    expect(await pushPendingArtworksToDrive({ limit: 5, force: true })).toMatchObject({ pending: 0, attempted: 1, pushed: 1 })
    expect((await row(bad.id)).storage).toBe('DRIVE')
  })

  it('gives up for this run after several failures in a row', async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 2; i++) await local(`f${i}.png`)
    await connect()
    driveMock({ put: () => json({ error: { message: 'The user has exceeded their Drive storage quota' } }, 403) })
    const r = await pushPendingArtworksToDrive({ limit: 50 })
    expect(r).toMatchObject({ attempted: MAX_CONSECUTIVE_FAILURES, failed: MAX_CONSECUTIVE_FAILURES, pushed: 0, stopped: 'too_many_failures', pending: MAX_CONSECUTIVE_FAILURES + 2 })
    expect(r.lastError).toMatch(/storage quota/)
  })

  it('a revoked token marks the connection, stops the queue, and nothing calls Google until it is reconnected', async () => {
    const a = await local('a.png')
    await local('b.png')
    await local('c.png')
    await connect()
    resetDriveCache()
    driveMock({ token: () => json({ error: 'invalid_grant' }, 400) })

    const r = await pushPendingArtworksToDrive({ limit: 10 })
    expect(r).toMatchObject({ attempted: 1, failed: 1, pushed: 0, stopped: 'needs_reconnect', lastError: 'Google Drive cần kết nối lại', pending: 3 })
    expect(calls.map(c => c.url)).toEqual(['https://oauth2.googleapis.com/token'])
    expect(await setting(GOOGLE_KEYS.needsReconnect)).toBe('1')

    driveMock()
    expect(await pushPendingArtworksToDrive({ limit: 10, force: true })).toMatchObject({ attempted: 0, stopped: 'needs_reconnect' })
    enqueueDrivePush(a.id)
    await drainDrivePushes()
    await runScheduledDrivePush()
    expect(calls).toHaveLength(0)
    expect(await setting(DRIVE_PUSH_RESULT_KEY)).toBeNull()

    await prisma.appSetting.deleteMany({ where: { key: GOOGLE_KEYS.needsReconnect } })
    primeAccessToken('at-again', 3600, '1//refresh')
    expect(await pushPendingArtworksToDrive({ limit: 10 })).toMatchObject({ pushed: 3, pending: 0, stopped: null })
  })

  it('does nothing while Drive is not connected', async () => {
    await local('a.png')
    driveMock()
    expect(await pushPendingArtworksToDrive({ limit: 10 })).toMatchObject({ pending: 1, attempted: 0, stopped: 'not_connected' })
    expect(calls).toHaveLength(0)
  })
})

describe('links after a push', () => {
  it('rewrites the approved line, the design library row and the lines that took the public URL from the library', async () => {
    const art = await local('lib.png', 'Artwork')
    const token = 'ab'.repeat(32)
    await prisma.designArtwork.update({ where: { id: art.id }, data: { publicToken: token } })
    const publicUrl = `https://pod.example.com/api/public/artwork/${token}/lib.png`
    const other = 'https://drive.google.com/file/d/other-area/view'
    await prisma.orderLine.update({ where: { id: lineId }, data: { designDriveLink: artworkUrl(art.id) } })
    await prisma.orderLine.updateMany({ where: { orderId: OTHER_ORDER_ID }, data: { designDriveLink: publicUrl } })
    const joined = await prisma.skuSupplierDesign.create({ data: { sku: 'DPQ-A', supplierId: SUP, designLink: `${publicUrl} | ${other}`, ready: true, source: 'STUDIO' } })
    const untouched = await prisma.skuSupplierDesign.create({
      data: { sku: 'DPQ-B', supplierId: SUP, designLink: `https://pod.example.com/api/public/artwork/${'cd'.repeat(32)}/lib.png`, ready: true, source: 'STUDIO' },
    })
    await connect()
    driveMock()

    expect(await pushPendingArtworksToDrive({ limit: 5 })).toMatchObject({ pushed: 1 })
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } })).designDriveLink).toBe(driveLink(1))
    expect((await prisma.orderLine.findFirstOrThrow({ where: { orderId: OTHER_ORDER_ID } })).designDriveLink).toBe(driveLink(1))
    expect(await prisma.skuSupplierDesign.findUniqueOrThrow({ where: { id: joined.id } })).toMatchObject({ designLink: `${driveLink(1)} | ${other}`, ready: true, source: 'STUDIO' })
    expect((await prisma.skuSupplierDesign.findUniqueOrThrow({ where: { id: untouched.id } })).designLink).toContain('/api/public/artwork/')
  })
})

describe('scheduler', () => {
  it('registers one job every 10 minutes, and none while DISABLE_SCHEDULERS=1', async () => {
    initDrivePushScheduler()
    initDrivePushScheduler()
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(schedule.mock.calls[0][0]).toBe(DRIVE_PUSH_CRON)
    expect(DRIVE_PUSH_CRON).toMatch(/^\d+-59\/10 \* \* \* \*$/)

    schedule.mockClear()
    initKeys()?.delete('drive-push-scheduler')
    process.env.DISABLE_SCHEDULERS = '1'
    const { register } = await import('@/instrumentation')
    await register()
    expect(schedule).not.toHaveBeenCalled()
    expect(initKeys()?.has('drive-push-scheduler') ?? false).toBe(false)
  })

  it('runs one job at a time and stores the last result and a fresh quota snapshot', async () => {
    await local('a.png')
    await local('b.png')
    await connect()
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    driveMock({ gate })

    const first = runDrivePushJob('schedule', { limit: 5 })
    const second = await runDrivePushJob('manual', { limit: 5 })
    expect(second).toEqual({ skipped: true })
    expect((await getDrivePushStatus()).running).toBe(true)
    release()
    const done = await first
    expect(done.skipped).toBe(false)
    expect(puts()).toHaveLength(2)

    const last = JSON.parse((await setting(DRIVE_PUSH_RESULT_KEY))!)
    expect(last).toMatchObject({ trigger: 'schedule', pushed: 2, failed: 0, pending: 0, lastError: null, quotaError: null })
    expect(typeof last.ranAt).toBe('string')
    expect(JSON.parse((await setting(GOOGLE_KEYS.quota))!)).toMatchObject({ limit: 15 * GB, usage: 14 * GB })
    expect(await getDrivePushStatus()).toMatchObject({ pending: 0, running: false, pushed: 2, failed: 0, lastError: null, trigger: 'schedule' })
  })

  it('a scheduled run is silent while Drive is not connected', async () => {
    await local('a.png')
    driveMock()
    await runScheduledDrivePush()
    expect(calls).toHaveLength(0)
    expect(await setting(DRIVE_PUSH_RESULT_KEY)).toBeNull()
  })
})

describe('/api/setup/google-drive/push-local', () => {
  it('is open to admins, closed to everyone else', async () => {
    expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/setup/google-drive/push-local', 'POST')).toBe('ok')
    expect(canCallApi('SUPPORT', DEFAULT_ROLE_PERMISSIONS.SUPPORT, '/api/setup/google-drive/push-local', 'GET')).toBe('forbidden')
    expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/setup/google-drive', 'GET')).toBe('forbidden')
    await connect()
    driveMock()
    expect((await pushStartRoute(req('/api/setup/google-drive/push-local', 'support', 'POST'))).status).toBe(403)
    expect((await pushStatusRoute(req('/api/setup/google-drive/push-local', 'support'))).status).toBe(403)
    expect((await pushStartRoute(req('/api/setup/google-drive/push-local', null, 'POST'))).status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('starts a run in the background and reports progress, then the final counts', async () => {
    await local('a.png')
    await local('b.png')
    await local('bad.png')
    await connect()
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    driveMock({ gate, put: name => (name.includes('bad') ? json({ error: { message: 'Backend Error' } }, 500) : null) })

    const idle = await (await pushStatusRoute(req('/api/setup/google-drive/push-local', 'admin'))).json()
    expect(idle).toMatchObject({ pending: 3, running: false, pushed: 0, failed: 0, lastError: null })

    const res = await pushStartRoute(req('/api/setup/google-drive/push-local', 'admin', 'POST'))
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ started: true, running: true, pending: 3 })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await (await pushStatusRoute(req('/api/setup/google-drive/push-local', 'admin'))).json()).toMatchObject({ running: true, pending: 3, trigger: 'manual' })

    release()
    await drainDrivePushes()
    const final = await (await pushStatusRoute(req('/api/setup/google-drive/push-local', 'super'))).json()
    expect(final).toMatchObject({ pending: 1, running: false, queued: false, pushed: 2, failed: 1, trigger: 'manual' })
    expect(final.lastError).toMatch(/Backend Error/)
    expect(JSON.parse((await setting(DRIVE_PUSH_RESULT_KEY))!)).toMatchObject({ trigger: 'manual', pushed: 2, failed: 1 })
  })

  it('a click during a scheduled run queues a full run that starts when it ends', async () => {
    await local('a.png')
    await connect()
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    driveMock({ gate })

    const scheduled = runScheduledDrivePush()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(startBulkDrivePush()).toEqual({ started: false })
    expect(await getDrivePushStatus()).toMatchObject({ running: true, queued: true, trigger: 'schedule' })
    await local('late.png')
    release()
    await scheduled
    await drainDrivePushes()
    expect(await getDrivePushStatus()).toMatchObject({ running: false, queued: false, trigger: 'manual', pending: 0 })
    expect(puts()).toHaveLength(2)
  })

  it('refuses to start while Drive is not connected or needs reconnecting', async () => {
    driveMock()
    expect((await pushStartRoute(req('/api/setup/google-drive/push-local', 'admin', 'POST'))).status).toBe(400)
    await connect()
    await prisma.appSetting.create({ data: { key: GOOGLE_KEYS.needsReconnect, value: '1' } })
    const res = await pushStartRoute(req('/api/setup/google-drive/push-local', 'admin', 'POST'))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/kết nối lại/)
    expect(calls).toHaveLength(0)
  })
})

describe('GET /api/design-studio/drive-health', () => {
  const health = async (who: keyof typeof tokens = 'support') => (await healthRoute(req('/api/design-studio/drive-health', who))).json()

  it('reports the state from the database alone', async () => {
    await local('a.png')
    driveMock()
    expect(await health()).toEqual({ state: 'not_connected', pending: 1, quota: null, quotaWarning: false, canConnect: false, canPush: false })

    await connect()
    await prisma.appSetting.create({ data: { key: GOOGLE_KEYS.quota, value: JSON.stringify({ limit: 15 * GB, usage: 14 * GB, checkedAt: '2026-10-13T00:00:00.000Z' }) } })
    expect(await health('admin')).toEqual({
      state: 'connected', pending: 1, quotaWarning: true, canConnect: false, canPush: true,
      quota: { limit: 15 * GB, usage: 14 * GB, percent: 93.3, checkedAt: '2026-10-13T00:00:00.000Z' },
    })

    await prisma.appSetting.update({ where: { key: GOOGLE_KEYS.quota }, data: { value: JSON.stringify({ limit: 15 * GB, usage: 13.5 * GB, checkedAt: '2026-10-13T00:00:00.000Z' }) } })
    expect(await health('super')).toMatchObject({ state: 'connected', quotaWarning: false, quota: { percent: 90 }, canConnect: true, canPush: true })

    await prisma.appSetting.update({ where: { key: GOOGLE_KEYS.quota }, data: { value: JSON.stringify({ limit: null, usage: 900 * GB, checkedAt: '2026-10-13T00:00:00.000Z' }) } })
    expect(await health()).toMatchObject({ quotaWarning: false, quota: { limit: null, percent: null } })

    await prisma.appSetting.create({ data: { key: GOOGLE_KEYS.needsReconnect, value: '1' } })
    expect(await health()).toMatchObject({ state: 'needs_reconnect', pending: 1 })
    expect(calls).toHaveLength(0)
    expect((await healthRoute(req('/api/design-studio/drive-health', null))).status).toBe(401)
  })

  it('never leaks the connection secrets', async () => {
    await connect()
    const text = await (await healthRoute(req('/api/design-studio/drive-health', 'support'))).text()
    expect(text).not.toContain('1//refresh')
    expect(text).not.toContain('secret')
  })
})

describe('driveBannerItems', () => {
  const base: DriveHealthView = { state: 'connected', pending: 0, quota: null, quotaWarning: false, canConnect: false, canPush: false }

  it('says nothing when everything is on Drive', () => {
    expect(driveBannerItems(base)).toEqual([])
  })

  it('not connected: neutral info, Setup link for the superadmin only', () => {
    const [item, ...rest] = driveBannerItems({ ...base, state: 'not_connected', pending: 7 })
    expect(rest).toEqual([])
    expect(item).toMatchObject({ tone: 'idle', text: 'File đang lưu trên server, chưa có bản trên Google Drive', setupLink: false, pushButton: false })
    expect(driveBannerItems({ ...base, state: 'not_connected', canConnect: true })[0].setupLink).toBe(true)
  })

  it('needs reconnect: an error that names the files stuck on the server', () => {
    const [item] = driveBannerItems({ ...base, state: 'needs_reconnect', pending: 3, canPush: true })
    expect(item.tone).toBe('bad')
    expect(item.text).toBe('Google Drive cần kết nối lại — file mới chỉ lưu trên server · 3 file đang nằm trên server')
    expect(item.pushButton).toBe(false)
  })

  it('quota above 90%: a warning with the numbers; waiting files: a small count with a push button for admins', () => {
    const items = driveBannerItems({
      ...base, pending: 4, quotaWarning: true, canPush: true,
      quota: { limit: 15 * GB, usage: 14 * GB, percent: 93.3, checkedAt: '2026-10-13T00:00:00.000Z' },
    })
    expect(items.map(i => [i.id, i.tone, i.text, i.pushButton])).toEqual([
      ['quota', 'warn', 'Google Drive sắp đầy: đã dùng 14.0 GB / 15.0 GB (93.3%)', false],
      ['pending', 'idle', '4 file chờ đẩy lên Drive', true],
    ])
    expect(driveBannerItems({ ...base, pending: 4 })[0].pushButton).toBe(false)
  })
})
