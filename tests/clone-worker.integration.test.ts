import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'crypto'
import { getEventListeners } from 'events'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { saveStoreCredential } from '@/lib/store-connections'
import { generateWorkerToken, revokeWorkerToken } from '@/lib/artwork-worker'
import { notifyCloneQueue } from '@/lib/clone/jobs'
import { CLONE_SETTINGS_KEY, saveCloneSettings } from '@/lib/clone/settings'
import {
  CLONE_LEASE_MS, CLONE_MAX_ATTEMPTS, CLONE_MAX_WAIT_S, CLONE_WORKER_SEEN_KEY, CLONE_WORKER_TOKEN_KEY,
  claimCloneJob, claimWithWait, cloneWorkerInfo, completeCloneJob, failCloneJob, generateCloneWorkerToken, heartbeatCloneJob,
  makeShopifyProductState, revokeCloneWorkerToken, verifyCloneWorkerRequest, type ProductState,
} from '@/lib/clone/worker'

const P = 'cw4'
const STORE = `${P}-store-a`
const STORE_OFF = `${P}-store-off`
const STORE_NO_PREFIX = `${P}-store-noprefix`
const TOKEN = `${P}-shpat-secret-token-value`
const GID = 'gid://shopify/Product/9054123557021'
const ONLINE_URL = 'https://litzzy.com/products/zw-mug'
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const MISSING = 'Sản phẩm không có trên store.'
const NOT_ACTIVE = 'Sản phẩm chưa ACTIVE.'
const NOT_ONLINE = 'Sản phẩm chưa lên Online Store.'
const FOREIGN_SKU = 'Còn variant mang SKU khác mã đã cấp.'

async function makeStore(id: string, opts: { enabled?: boolean; orderPrefix?: string | null } = {}) {
  await prisma.shopifyStore.create({
    data: { id, shop: `${id}.myshopify.com`, orderPrefix: opts.orderPrefix === undefined ? 'CWA' : opts.orderPrefix, enabled: opts.enabled ?? true },
  })
  await saveStoreCredential(id, { authMode: 'TOKEN', accessToken: TOKEN })
}

let n = 0
async function seedJob(over: Partial<{
  storeId: string; status: string; attempts: number; lockedAt: Date | null; startedAt: Date | null; createdAt: Date; force: boolean
}> = {}) {
  n++
  return prisma.cloneJob.create({
    data: {
      storeId: STORE, sourceUrl: `https://shop.example.com/products/abc-${n}`, sourceKey: `shop.example.com/products/abc-${n}`,
      skuCode: `ZW26110${String(n).padStart(5, '0')}`, requestedById: `${P}-user`, requestedByName: 'Seller A', ...over,
    },
  })
}

const rowOf = (id: string) => prisma.cloneJob.findUniqueOrThrow({ where: { id } })

async function running() {
  const job = await seedJob()
  const { job: claim } = await claimCloneJob()
  expect(claim?.id).toBe(job.id)
  return { id: job.id, attempts: claim!.attempts, skuCode: job.skuCode }
}

const req = (authorization?: string) =>
  new NextRequest('http://localhost/api/clone-worker/claim', { method: 'POST', headers: authorization === undefined ? {} : { authorization } })

// The claim reads the whole queue, so every test starts from an empty CloneJob table.
async function wipe() {
  await prisma.cloneJob.deleteMany({})
  await prisma.appSetting.deleteMany({ where: { key: { in: [CLONE_SETTINGS_KEY, CLONE_WORKER_TOKEN_KEY, CLONE_WORKER_SEEN_KEY] } } })
}

beforeAll(async () => {
  await wipe()
  await prisma.shopifyStore.deleteMany({ where: { id: { startsWith: `${P}-` } } })
  await makeStore(STORE)
  await makeStore(STORE_OFF, { enabled: false })
  await makeStore(STORE_NO_PREFIX, { orderPrefix: null })
})

beforeEach(wipe)

const waiterCount = () => globalThis.__cloneQueueWaiters?.size ?? 0

// Every way out of claimWithWait takes its wait out of the waiter set, so none may be left after a test.
afterEach(() => {
  vi.restoreAllMocks()
  expect(waiterCount()).toBe(0)
})

afterAll(async () => {
  await wipe()
  await prisma.shopifyStore.deleteMany({ where: { id: { startsWith: `${P}-` } } })
})

describe('worker token', () => {
  it('giữ đúng các hằng số của hàng chờ', () => {
    expect(CLONE_WORKER_TOKEN_KEY).toBe('clone.worker.tokenHash')
    expect(CLONE_WORKER_SEEN_KEY).toBe('clone.worker.lastSeenAt')
    expect([CLONE_LEASE_MS, CLONE_MAX_ATTEMPTS, CLONE_MAX_WAIT_S]).toEqual([600_000, 2, 25])
  })

  it('token: chỉ lưu hash, sai token và thiếu token đều false', async () => {
    expect(await verifyCloneWorkerRequest(req('Bearer cqw_nothing-configured'))).toBe(false)
    const token = await generateCloneWorkerToken()
    expect(token).toMatch(/^cqw_[A-Za-z0-9_-]{43}$/)
    const row = await prisma.appSetting.findUniqueOrThrow({ where: { key: CLONE_WORKER_TOKEN_KEY } })
    expect(row.value).toBe(crypto.createHash('sha256').update(token, 'utf8').digest('hex'))
    expect(row.value).not.toContain(token.slice(4))

    expect(await verifyCloneWorkerRequest(req(`Bearer ${token}`))).toBe(true)
    expect(await verifyCloneWorkerRequest(req(`bearer ${token}`))).toBe(true)
    expect(await verifyCloneWorkerRequest(req(`Bearer ${token}x`))).toBe(false)
    expect(await verifyCloneWorkerRequest(req(token))).toBe(false)
    expect(await verifyCloneWorkerRequest(req('Bearer '))).toBe(false)
    expect(await verifyCloneWorkerRequest(req(''))).toBe(false)
    expect(await verifyCloneWorkerRequest(req())).toBe(false)

    const design = await generateWorkerToken()
    try {
      expect(await verifyCloneWorkerRequest(req(`Bearer ${design}`))).toBe(false)
    } finally {
      await revokeWorkerToken()
    }

    const replaced = await generateCloneWorkerToken()
    expect(await verifyCloneWorkerRequest(req(`Bearer ${token}`))).toBe(false)
    expect(await verifyCloneWorkerRequest(req(`Bearer ${replaced}`))).toBe(true)
    await revokeCloneWorkerToken()
    expect(await verifyCloneWorkerRequest(req(`Bearer ${replaced}`))).toBe(false)
  })

  it('cloneWorkerInfo: có token chưa, thấy máy lúc nào, online khi thấy trong 90 giây', async () => {
    expect(await cloneWorkerInfo()).toEqual({ configured: false, tokenUpdatedAt: null, lastSeenAt: null, online: false })
    const token = await generateCloneWorkerToken()
    const old = new Date(Date.now() - 91_000)
    await claimCloneJob(old)
    const offline = await cloneWorkerInfo()
    expect(offline).toMatchObject({ configured: true, lastSeenAt: old.toISOString(), online: false })
    expect(offline.tokenUpdatedAt).toMatch(ISO_RE)
    const now = new Date()
    await claimCloneJob(now)
    const online = await cloneWorkerInfo()
    expect(online).toMatchObject({ configured: true, lastSeenAt: now.toISOString(), online: true })
    expect(JSON.stringify(online)).not.toContain(token)
    await revokeCloneWorkerToken()
    expect(await cloneWorkerInfo()).toMatchObject({ configured: false, tokenUpdatedAt: null })
  })

  it('heartbeat, fail và complete cũng ghi lastSeenAt: máy đang chạy job vẫn online', async () => {
    const setSeen = (ms: number) =>
      prisma.appSetting.update({ where: { key: CLONE_WORKER_SEEN_KEY }, data: { value: new Date(ms).toISOString() } })
    const job = await seedJob()
    const claim = (await claimCloneJob(new Date(Date.now() - 120_000))).job!
    expect((await cloneWorkerInfo()).online).toBe(false)
    expect(await heartbeatCloneJob(job.id, claim.attempts, { stage: 'clone' })).toEqual({ ok: true, cancelled: false })
    expect((await cloneWorkerInfo()).online).toBe(true)

    await setSeen(Date.now() - 120_000)
    expect(await heartbeatCloneJob(job.id, claim.attempts + 5, {})).toEqual({ ok: false, cancelled: false })
    expect((await cloneWorkerInfo()).online).toBe(true)

    await setSeen(Date.now() - 120_000)
    expect(await failCloneJob(job.id, claim.attempts, { failKind: 'TOOL', error: 'x' })).toEqual({ status: 'FAILED' })
    expect((await cloneWorkerInfo()).online).toBe(true)

    const next = await running()
    await setSeen(Date.now() - 120_000)
    expect(await completeCloneJob(next.id, next.attempts, { productGid: GID, qaVerdict: 'FAIL' })).toMatchObject({ status: 'FAILED' })
    expect((await cloneWorkerInfo()).online).toBe(true)
  })
})

describe('claimCloneJob', () => {
  it('claim: job cũ nhất trước, hai lần gọi liền nhau chỉ một lần nhận được', async () => {
    await saveCloneSettings({ targets: ['customily:CWA', 'teeinblue:REMI'] })
    const newer = await seedJob({ createdAt: new Date(Date.now() - 1000) })
    const older = await seedJob({ createdAt: new Date(Date.now() - 5000) })

    const first = await claimCloneJob()
    expect(first).toEqual({
      paused: false,
      job: {
        id: older.id, sourceUrl: older.sourceUrl, skuCode: older.skuCode, attempts: 1, requestedByName: 'Seller A',
        store: { id: STORE, orderPrefix: 'CWA', shop: `${STORE}.myshopify.com` }, targets: ['customily:CWA', 'teeinblue:REMI'], force: false,
      },
    })
    expect(JSON.stringify(first)).not.toContain(TOKEN)
    expect(await claimCloneJob()).toEqual({ job: null, paused: false })

    const row = await rowOf(older.id)
    expect(row).toMatchObject({ status: 'RUNNING', attempts: 1 })
    expect(row.startedAt).not.toBeNull()
    expect(row.lockedAt).not.toBeNull()
    expect((await rowOf(newer.id)).status).toBe('QUEUED')
  })

  it('claim: job bị ép clone lại mang force: true xuống runner', async () => {
    const forced = await seedJob({ force: true, createdAt: new Date(Date.now() - 2000) })
    expect((await claimCloneJob()).job).toMatchObject({ id: forced.id, force: true })
    await failCloneJob(forced.id, 1, { failKind: 'TOOL', error: 'x' })
    const plain = await seedJob()
    expect((await claimCloneJob()).job).toMatchObject({ id: plain.id, force: false })
  })

  it('claim: nhiều lần gọi cùng lúc chỉ một lần nhận được, chỉ một job RUNNING', async () => {
    await seedJob({ createdAt: new Date(Date.now() - 3000) })
    await seedJob({ createdAt: new Date(Date.now() - 2000) })
    await seedJob({ createdAt: new Date(Date.now() - 1000) })
    const results = await Promise.all([claimCloneJob(), claimCloneJob(), claimCloneJob(), claimCloneJob()])
    expect(results.filter(r => r.job !== null)).toHaveLength(1)
    expect(await prisma.cloneJob.count({ where: { status: 'RUNNING' } })).toBe(1)
  })

  it('claim: đang có job RUNNING còn hạn thì trả null', async () => {
    await seedJob({ status: 'RUNNING', attempts: 1, lockedAt: new Date(Date.now() - 60_000), startedAt: new Date(Date.now() - 60_000), createdAt: new Date(Date.now() - 2000) })
    const queued = await seedJob({ createdAt: new Date(Date.now() - 5000) })
    expect(await claimCloneJob()).toEqual({ job: null, paused: false })
    expect((await rowOf(queued.id)).status).toBe('QUEUED')
  })

  it('claim: paused thì trả { job: null, paused: true } và vẫn ghi lastSeenAt', async () => {
    await saveCloneSettings({ paused: true })
    const job = await seedJob()
    const now = new Date()
    expect(await claimCloneJob(now)).toEqual({ job: null, paused: true })
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: CLONE_WORKER_SEEN_KEY } })).value).toBe(now.toISOString())
    expect((await rowOf(job.id)).status).toBe('QUEUED')
  })

  it('lease hết lần 1: job được nhận lại với attempts 2; hết lần 2: FAILED/WORKER_LOST', async () => {
    const t0 = Date.now() - 3 * CLONE_LEASE_MS
    const job = await seedJob({ createdAt: new Date(t0 - 1000) })

    expect((await claimCloneJob(new Date(t0))).job).toMatchObject({ id: job.id, attempts: 1 })
    const startedAt = (await rowOf(job.id)).startedAt
    expect(startedAt?.getTime()).toBe(t0)
    expect(await claimCloneJob(new Date(t0 + CLONE_LEASE_MS - 1000))).toEqual({ job: null, paused: false })

    expect((await claimCloneJob(new Date(t0 + CLONE_LEASE_MS + 1000))).job).toMatchObject({ id: job.id, attempts: 2 })
    const again = await rowOf(job.id)
    expect(again).toMatchObject({ status: 'RUNNING', attempts: 2 })
    expect(again.startedAt?.getTime()).toBe(t0)
    expect(again.lockedAt?.getTime()).toBe(t0 + CLONE_LEASE_MS + 1000)

    const next = await seedJob({ createdAt: new Date(t0) })
    const third = await claimCloneJob(new Date(t0 + 2 * CLONE_LEASE_MS + 2000))
    expect(third.job).toMatchObject({ id: next.id, attempts: 1 })
    const lost = await rowOf(job.id)
    expect(lost).toMatchObject({ status: 'FAILED', failKind: 'WORKER_LOST', error: 'Máy xử lý không trả kết quả.', lockedAt: null, attempts: 2 })
    expect(lost.finishedAt?.getTime()).toBe(t0 + 2 * CLONE_LEASE_MS + 2000)
  })

  it('claim: job hết lease lần 1 nằm sau job đang chờ quay về QUEUED, không có hai job RUNNING', async () => {
    const lockedAt = new Date(Date.now() - CLONE_LEASE_MS - 1000)
    const older = await seedJob({ createdAt: new Date(Date.now() - 9000) })
    const expired = await seedJob({ status: 'RUNNING', attempts: 1, lockedAt, startedAt: lockedAt, createdAt: new Date(Date.now() - 5000) })
    await prisma.cloneJob.update({ where: { id: expired.id }, data: { stage: 'qa' } })

    expect((await claimCloneJob()).job).toMatchObject({ id: older.id, attempts: 1 })
    const back = await rowOf(expired.id)
    expect(back).toMatchObject({ status: 'QUEUED', attempts: 1, lockedAt: null, stage: null, finishedAt: null, failKind: null })
    expect(back.startedAt?.getTime()).toBe(lockedAt.getTime())
    expect(await prisma.cloneJob.count({ where: { status: 'RUNNING' } })).toBe(1)
    expect(await heartbeatCloneJob(expired.id, 1, {})).toEqual({ ok: false, cancelled: false })

    expect(await claimCloneJob()).toEqual({ job: null, paused: false })
    expect(await failCloneJob(older.id, 1, { failKind: 'TOOL', error: 'x' })).toEqual({ status: 'FAILED' })
    expect((await claimCloneJob()).job).toMatchObject({ id: expired.id, attempts: 2 })
  })

  it('claim: job hết lease lần 2 nằm sau job đang chờ vẫn thành FAILED/WORKER_LOST ngay', async () => {
    const lockedAt = new Date(Date.now() - CLONE_LEASE_MS - 1000)
    const older = await seedJob({ createdAt: new Date(Date.now() - 9000) })
    const lostJob = await seedJob({ status: 'RUNNING', attempts: 2, lockedAt, startedAt: lockedAt, createdAt: new Date(Date.now() - 5000) })
    expect((await claimCloneJob()).job).toMatchObject({ id: older.id, attempts: 1 })
    expect(await rowOf(lostJob.id)).toMatchObject({ status: 'FAILED', failKind: 'WORKER_LOST', error: 'Máy xử lý không trả kết quả.' })
  })

  it('claim: store mất kết nối, đang tắt hoặc thiếu orderPrefix → FAILED/TOOL rồi nhận job kế tiếp', async () => {
    const t = Date.now()
    const gone = await seedJob({ storeId: `${P}-store-missing`, createdAt: new Date(t - 4000) })
    const off = await seedJob({ storeId: STORE_OFF, createdAt: new Date(t - 3000) })
    const bare = await seedJob({ storeId: STORE_NO_PREFIX, createdAt: new Date(t - 2000) })
    const ok = await seedJob({ createdAt: new Date(t - 1000) })

    expect((await claimCloneJob()).job?.id).toBe(ok.id)
    for (const j of [gone, off, bare]) {
      const row = await rowOf(j.id)
      expect(row).toMatchObject({ status: 'FAILED', failKind: 'TOOL', error: 'Store không còn kết nối.', lockedAt: null })
      expect(row.finishedAt).not.toBeNull()
    }
  })

  it('claim: nhận lại job hết lease giữ startedAt, xoá stage của lần trước', async () => {
    const startedAt = new Date(Date.now() - 3 * CLONE_LEASE_MS)
    const job = await seedJob({ status: 'RUNNING', attempts: 1, startedAt, lockedAt: startedAt })
    await prisma.cloneJob.update({ where: { id: job.id }, data: { stage: 'qa' } })
    expect((await claimCloneJob()).job).toMatchObject({ id: job.id, attempts: 2 })
    const row = await rowOf(job.id)
    expect(row.startedAt?.getTime()).toBe(startedAt.getTime())
    expect(row.stage).toBeNull()
  })
})

describe('heartbeatCloneJob', () => {
  it('heartbeat của lần chạy cũ (attempts lệch) bị từ chối; job đã CANCELLED trả cancelled: true', async () => {
    const job = await seedJob()
    const claim = (await claimCloneJob(new Date(Date.now() - 5 * 60_000))).job!
    const before = (await rowOf(job.id)).lockedAt!

    expect(await heartbeatCloneJob(job.id, claim.attempts + 1, { stage: 'clone' })).toEqual({ ok: false, cancelled: false })
    expect(await heartbeatCloneJob(job.id, claim.attempts - 1, { stage: 'clone' })).toEqual({ ok: false, cancelled: false })
    const refused = await rowOf(job.id)
    expect(refused.stage).toBeNull()
    expect(refused.lockedAt?.getTime()).toBe(before.getTime())

    expect(await heartbeatCloneJob(job.id, claim.attempts, { stage: 'clone', platform: 'customily' })).toEqual({ ok: true, cancelled: false })
    const beat = await rowOf(job.id)
    expect(beat).toMatchObject({ stage: 'clone', platform: 'customily', status: 'RUNNING' })
    expect(beat.lockedAt!.getTime()).toBeGreaterThan(before.getTime())

    await prisma.cloneJob.update({ where: { id: job.id }, data: { status: 'CANCELLED' } })
    expect(await heartbeatCloneJob(job.id, claim.attempts, {})).toEqual({ ok: false, cancelled: true })
    expect(await heartbeatCloneJob(`${P}-missing`, 1, {})).toEqual({ ok: false, cancelled: false })
  })

  it('heartbeat: stage và platform ngoài danh sách bị bỏ qua, lease vẫn được gia hạn', async () => {
    const { id, attempts } = await running()
    expect(await heartbeatCloneJob(id, attempts, { stage: 'nhận diện', platform: 'unsupported:globo-apps' })).toEqual({ ok: true, cancelled: false })
    expect(await rowOf(id)).toMatchObject({ stage: 'nhận diện', platform: 'unsupported:globo-apps' })

    const bad: { stage: unknown; platform: unknown }[] = [
      { stage: 'C:\\Users\\owner\\.ssh', platform: 'unsupported:Globo Apps' },
      { stage: 'QA', platform: 'shopify' },
      { stage: 42, platform: { name: 'customily' } },
      { stage: 'clone '.repeat(20), platform: `unsupported:${'a'.repeat(21)}` },
      { stage: '', platform: 'unsupported:' },
    ]
    for (const patch of bad) {
      const lockedBefore = (await rowOf(id)).lockedAt!.getTime()
      await new Promise(r => setTimeout(r, 5))
      expect(await heartbeatCloneJob(id, attempts, patch)).toEqual({ ok: true, cancelled: false })
      const row = await rowOf(id)
      expect(row).toMatchObject({ stage: 'nhận diện', platform: 'unsupported:globo-apps' })
      expect(row.lockedAt!.getTime()).toBeGreaterThan(lockedBefore)
    }

    for (const stage of ['clone', 'qa', 'public']) {
      await heartbeatCloneJob(id, attempts, { stage })
      expect((await rowOf(id)).stage).toBe(stage)
    }
    for (const platform of ['customall', 'teeinblue', 'customix', 'unknown', 'customily']) {
      await heartbeatCloneJob(id, attempts, { platform })
      expect((await rowOf(id)).platform).toBe(platform)
    }
  })
})

describe('failCloneJob', () => {
  it('fail retryable ở lần 1 → QUEUED; ở lần 2 → FAILED', async () => {
    const { id, attempts } = await running()
    expect(attempts).toBe(1)
    expect(await failCloneJob(id, 1, { failKind: 'TIMEOUT', error: 'phiên quá 120 phút', retryable: true })).toEqual({ status: 'QUEUED' })
    const queued = await rowOf(id)
    expect(queued).toMatchObject({ status: 'QUEUED', lockedAt: null, failKind: null, finishedAt: null })

    expect((await claimCloneJob()).job).toMatchObject({ id, attempts: 2 })
    expect(await failCloneJob(id, 2, { failKind: 'TIMEOUT', error: 'phiên quá 120 phút', retryable: true })).toEqual({ status: 'FAILED' })
    const failed = await rowOf(id)
    expect(failed).toMatchObject({ status: 'FAILED', failKind: 'TIMEOUT', error: 'phiên quá 120 phút', lockedAt: null })
    expect(failed.finishedAt).not.toBeNull()
  })

  it('fail: failKind lạ hoặc của server thành TOOL, error cắt 2000 ký tự, productGid chỉ nhận gid sản phẩm', async () => {
    for (const failKind of ['VERIFY', 'WORKER_LOST', 'tool', 'NOPE', 42, undefined]) {
      const { id, attempts } = await running()
      expect(await failCloneJob(id, attempts, { failKind, error: 'x' })).toEqual({ status: 'FAILED' })
      expect((await rowOf(id)).failKind).toBe('TOOL')
    }
    for (const failKind of ['UNSUPPORTED', 'NOT_ENABLED', 'SOURCE', 'TOOL', 'TOOL_GAP', 'QA', 'TIMEOUT']) {
      const { id, attempts } = await running()
      await failCloneJob(id, attempts, { failKind, error: 'x' })
      expect((await rowOf(id)).failKind).toBe(failKind)
    }

    const long = await running()
    await failCloneJob(long.id, long.attempts, { failKind: 'SOURCE', error: 'é'.repeat(2500), productGid: GID })
    const row = await rowOf(long.id)
    expect(row.error).toBe('é'.repeat(2000))
    expect(row.productGid).toBe(GID)

    const odd = await running()
    await failCloneJob(odd.id, odd.attempts, { failKind: 'SOURCE', error: { text: 'not a string' }, productGid: 'gid://shopify/Product/1; rm -rf /' })
    expect(await rowOf(odd.id)).toMatchObject({ error: null, productGid: null })
  })

  it('fail: retryable khác true không quay lại hàng chờ; attempts lệch hoặc job không RUNNING → null', async () => {
    const { id, attempts } = await running()
    expect(await failCloneJob(id, attempts + 1, { failKind: 'TOOL', error: 'x' })).toBeNull()
    expect(await failCloneJob(id, attempts, { failKind: 'TOOL', error: 'x', retryable: 'true' })).toEqual({ status: 'FAILED' })
    expect(await failCloneJob(id, attempts, { failKind: 'TOOL', error: 'again' })).toBeNull()
    expect((await rowOf(id)).error).toBe('x')
    expect(await failCloneJob(`${P}-missing`, 1, { failKind: 'TOOL', error: 'x' })).toBeNull()
  })
})

describe('completeCloneJob', () => {
  const state = (over: Partial<NonNullable<ProductState>> = {}, code = ''): ProductState => ({
    status: 'ACTIVE', onlineStoreUrl: ONLINE_URL, handle: 'zw-mug-shopify', productType: 'Mug', skus: [code, `${code}-BLACK-XL`], ...over,
  })
  const asked: [string, string][] = []
  const fake = (answer: ProductState | Error | ((code: string) => ProductState), code: string) => ({
    productState: async (storeId: string, gid: string) => {
      asked.push([storeId, gid])
      if (answer instanceof Error) throw answer
      return typeof answer === 'function' ? answer(code) : answer
    },
  })
  const pass = { productGid: GID, handle: 'runner-handle', qaVerdict: 'PASS', qaNote: 'so compare.png, đủ 4 layer' }

  beforeEach(() => {
    asked.length = 0
  })

  async function expectVerifyFail(id: string, result: unknown, error: string) {
    expect(result).toEqual({ status: 'FAILED', error })
    const row = await rowOf(id)
    expect(row).toMatchObject({ status: 'FAILED', failKind: 'VERIFY', error, productUrl: null, lockedAt: null, productGid: GID })
    expect(row.finishedAt).not.toBeNull()
  }

  it('complete: DRAFT → FAILED/VERIFY "Sản phẩm chưa ACTIVE."', async () => {
    const { id, attempts, skuCode } = await running()
    const result = await completeCloneJob(id, attempts, pass, fake(code => state({ status: 'DRAFT' }, code), skuCode))
    await expectVerifyFail(id, result, NOT_ACTIVE)
    expect(asked).toEqual([[STORE, GID]])
  })

  it('complete: onlineStoreUrl null → FAILED/VERIFY', async () => {
    const { id, attempts, skuCode } = await running()
    const result = await completeCloneJob(id, attempts, pass, fake(code => state({ onlineStoreUrl: null }, code), skuCode))
    await expectVerifyFail(id, result, NOT_ONLINE)
  })

  it('complete: một variant mang SKU đối thủ → FAILED/VERIFY', async () => {
    const cases: ((code: string) => string | null)[] = [() => 'FS-HALLOWEEN-MUG-11OZ', () => null, code => `${code}X`, code => `X${code}`, () => '']
    for (const other of cases) {
      const { id, attempts, skuCode } = await running()
      const result = await completeCloneJob(id, attempts, pass, fake(code => state({ skus: [`${code}-WHITE`, other(code)] }, code), skuCode))
      await expectVerifyFail(id, result, FOREIGN_SKU)
    }
    const empty = await running()
    await expectVerifyFail(empty.id, await completeCloneJob(empty.id, empty.attempts, pass, fake(state({ skus: [] }), empty.skuCode)), FOREIGN_SKU)
  })

  it('complete: productState trả null → FAILED/VERIFY "Sản phẩm không có trên store."', async () => {
    const { id, attempts, skuCode } = await running()
    const result = await completeCloneJob(id, attempts, pass, fake(null, skuCode))
    await expectVerifyFail(id, result, MISSING)
  })

  it('complete: productState ném lỗi → { retry: true }, job vẫn RUNNING', async () => {
    const { id, attempts, skuCode } = await running()
    const result = await completeCloneJob(id, attempts, pass, fake(new Error(`HTTP 503 ${TOKEN}`), skuCode))
    expect(result).toMatchObject({ retry: true })
    expect(typeof (result as { error: unknown }).error).toBe('string')
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    const row = await rowOf(id)
    expect(row).toMatchObject({ status: 'RUNNING', attempts, failKind: null, error: null, finishedAt: null, productUrl: null })

    expect(await completeCloneJob(id, attempts, pass, fake(code => state({}, code), skuCode))).toEqual({ status: 'DONE' })
  })

  it('complete: đủ điều kiện → DONE, productUrl = onlineStoreUrl, lưu handle và productType', async () => {
    const { id, attempts, skuCode } = await running()
    const result = await completeCloneJob(
      id, attempts,
      { ...pass, productUrl: 'https://evil.example.com/x', productType: 'Runner Type', costUsd: 1.25, durationMs: 1234.6 } as never,
      fake(code => state({}, code), skuCode),
    )
    expect(result).toEqual({ status: 'DONE' })
    const row = await rowOf(id)
    expect(row).toMatchObject({
      status: 'DONE', failKind: null, error: null, productGid: GID, productUrl: ONLINE_URL, handle: 'zw-mug-shopify', productType: 'Mug',
      reused: false, qaVerdict: 'PASS', qaNote: pass.qaNote, costUsd: 1.25, durationMs: 1235, lockedAt: null, skuCode,
    })
    expect(row.finishedAt).not.toBeNull()
    expect(asked).toEqual([[STORE, GID]])

    expect(await completeCloneJob(id, attempts, pass, fake(code => state({}, code), skuCode))).toBeNull()
    expect(await heartbeatCloneJob(id, attempts, {})).toEqual({ ok: false, cancelled: false })
    expect(await failCloneJob(id, attempts, { failKind: 'TOOL', error: 'late' })).toBeNull()
    expect((await rowOf(id)).status).toBe('DONE')
  })

  it('complete reused: bỏ qua điều kiện SKU', async () => {
    const { id, attempts, skuCode } = await running()
    const result = await completeCloneJob(id, attempts, { ...pass, reused: true }, fake(state({ skus: ['FS-OLD-SKU-1', null] }), skuCode))
    expect(result).toEqual({ status: 'DONE' })
    expect(await rowOf(id)).toMatchObject({ status: 'DONE', reused: true, productUrl: ONLINE_URL })

    const draft = await running()
    const refused = await completeCloneJob(draft.id, draft.attempts, { ...pass, reused: true }, fake(state({ status: 'DRAFT', skus: ['FS-OLD'] }), draft.skuCode))
    await expectVerifyFail(draft.id, refused, NOT_ACTIVE)

    const offline = await running()
    const hidden = await completeCloneJob(offline.id, offline.attempts, { ...pass, reused: true }, fake(state({ onlineStoreUrl: null, skus: ['FS-OLD'] }), offline.skuCode))
    await expectVerifyFail(offline.id, hidden, NOT_ONLINE)

    const loose = await running()
    const strict = await completeCloneJob(loose.id, loose.attempts, { ...pass, reused: 'true' }, fake(state({ skus: ['FS-OLD'] }), loose.skuCode))
    await expectVerifyFail(loose.id, strict, FOREIGN_SKU)
  })

  it('complete: qaVerdict khác PASS → FAILED/QA, không hỏi Shopify', async () => {
    for (const qaVerdict of ['FAIL', 'pass', 'PASS ', true, undefined]) {
      const { id, attempts, skuCode } = await running()
      const result = await completeCloneJob(id, attempts, { ...pass, qaVerdict }, fake(code => state({}, code), skuCode))
      expect(result).toMatchObject({ status: 'FAILED' })
      const row = await rowOf(id)
      expect(row).toMatchObject({ status: 'FAILED', failKind: 'QA', qaVerdict: null, productUrl: null, lockedAt: null })
      expect(row.finishedAt).not.toBeNull()
    }
    expect(asked).toEqual([])
  })

  it('complete: productGid sai dạng → FAILED/TOOL, không hỏi Shopify', async () => {
    for (const productGid of ['gid://shopify/ProductVariant/1', '9054123557021', `${GID}\n`, `${GID}/x`, null]) {
      const { id, attempts, skuCode } = await running()
      const result = await completeCloneJob(id, attempts, { ...pass, productGid }, fake(code => state({}, code), skuCode))
      expect(result).toMatchObject({ status: 'FAILED' })
      expect(await rowOf(id)).toMatchObject({ status: 'FAILED', failKind: 'TOOL', productGid: null, productUrl: null })
    }
    expect(asked).toEqual([])
  })

  it('complete: attempts lệch hoặc job không RUNNING → null, không hỏi Shopify', async () => {
    const { id, attempts, skuCode } = await running()
    expect(await completeCloneJob(id, attempts + 1, pass, fake(code => state({}, code), skuCode))).toBeNull()
    expect(await completeCloneJob(`${P}-missing`, 1, pass, fake(code => state({}, code), skuCode))).toBeNull()
    const queued = await seedJob()
    expect(await completeCloneJob(queued.id, 0, pass, fake(code => state({}, code), queued.skuCode))).toBeNull()
    expect(asked).toEqual([])
    expect((await rowOf(id)).status).toBe('RUNNING')
  })

  it('complete: lease bị nhận lại trong lúc hỏi Shopify → null, không ghi đè lần chạy mới', async () => {
    const { id, attempts, skuCode } = await running()
    const result = await completeCloneJob(id, attempts, pass, {
      productState: async () => {
        await prisma.cloneJob.update({ where: { id }, data: { attempts: attempts + 1, lockedAt: new Date() } })
        return state({}, skuCode)
      },
    })
    expect(result).toBeNull()
    expect(await rowOf(id)).toMatchObject({ status: 'RUNNING', attempts: attempts + 1, productUrl: null })
  })

  it('complete: qaNote cắt 500 ký tự; costUsd, durationMs chỉ nhận số hữu hạn không âm', async () => {
    const bad: { costUsd: unknown; durationMs: unknown }[] = [
      { costUsd: -1, durationMs: -5 },
      { costUsd: Number.NaN, durationMs: Number.POSITIVE_INFINITY },
      { costUsd: '3', durationMs: '1000' },
      { costUsd: null, durationMs: 1e20 },
    ]
    for (const extra of bad) {
      const { id, attempts, skuCode } = await running()
      expect(await completeCloneJob(id, attempts, { ...pass, qaNote: 'n'.repeat(600), ...extra }, fake(code => state({}, code), skuCode))).toEqual({ status: 'DONE' })
      expect(await rowOf(id)).toMatchObject({ costUsd: null, durationMs: null, qaNote: 'n'.repeat(500) })
    }
    const zero = await running()
    await completeCloneJob(zero.id, zero.attempts, { ...pass, qaNote: 42, costUsd: 0, durationMs: 0 }, fake(code => state({}, code), zero.skuCode))
    expect(await rowOf(zero.id)).toMatchObject({ costUsd: 0, durationMs: 0, qaNote: null })
  })
})

describe('claimWithWait', () => {
  it('claimWithWait trả ngay khi notifyCloneQueue được gọi trong lúc chờ', async () => {
    const started = Date.now()
    setTimeout(() => {
      void seedJob().then(() => notifyCloneQueue())
    }, 50)
    const result = await claimWithWait(5)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(result.paused).toBe(false)
    expect(result.job?.id).toBe((await prisma.cloneJob.findFirstOrThrow()).id)
  })

  it('không mất lần đánh thức: job tạo ngay sau lần đọc đầu (chưa ai chờ) vẫn được trả trong cùng lần gọi', async () => {
    const original = prisma.cloneJob.findMany.bind(prisma.cloneJob) as (args: unknown) => Promise<unknown>
    let created = ''
    vi.spyOn(prisma.cloneJob, 'findMany').mockImplementationOnce((async (args: unknown) => {
      const found = await original(args)
      created = (await seedJob()).id
      notifyCloneQueue()
      return found
    }) as any)
    const started = Date.now()
    const result = await claimWithWait(5)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(result.job?.id).toBe(created)
  })

  it('có job sẵn thì trả ngay; không có job và waitSeconds 0, âm hoặc NaN thì trả null ngay', async () => {
    for (const w of [0, -3, Number.NaN]) {
      const started = Date.now()
      expect(await claimWithWait(w)).toEqual({ job: null, paused: false })
      expect(Date.now() - started).toBeLessThan(1000)
    }
    const job = await seedJob()
    const started = Date.now()
    expect((await claimWithWait(5)).job?.id).toBe(job.id)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('hết thời gian chờ mà không có job → null; waitSeconds kẹp ở 25', async () => {
    const started = Date.now()
    expect(await claimWithWait(0.4)).toEqual({ job: null, paused: false })
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)

    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const long = () => timeout.mock.calls.map(c => c[1]).filter((d): d is number => typeof d === 'number' && d > 20_000)
    const pending = claimWithWait(1000)
    for (let i = 0; i < 200 && long().length === 0; i++) await new Promise(r => setTimeout(r, 10))
    expect(long().length).toBeGreaterThan(0)
    expect(Math.max(...long())).toBeLessThanOrEqual(25_000)
    expect(Math.max(...long())).toBeGreaterThan(24_000)
    timeout.mockRestore()
    const job = await seedJob()
    notifyCloneQueue()
    expect((await pending).job?.id).toBe(job.id)
  })

  it('paused: chờ hết thời gian rồi trả { job: null, paused: true }, dù có job mới', async () => {
    await saveCloneSettings({ paused: true })
    const started = Date.now()
    setTimeout(() => {
      void seedJob().then(() => notifyCloneQueue())
    }, 50)
    expect(await claimWithWait(1)).toEqual({ job: null, paused: true })
    expect(Date.now() - started).toBeGreaterThanOrEqual(950)
  })

  it('runner ngắt kết nối trong lúc chờ: không nhận job vừa tạo, job vẫn QUEUED, không còn waiter hay listener', async () => {
    const client = new AbortController()
    const started = Date.now()
    let created = ''
    setTimeout(() => {
      void seedJob().then(job => {
        created = job.id
        client.abort()
        notifyCloneQueue()
      })
    }, 200)
    expect(await claimWithWait(5, client.signal)).toEqual({ job: null, paused: false })
    expect(Date.now() - started).toBeLessThan(1500)
    expect(created).not.toBe('')
    expect(await rowOf(created)).toMatchObject({ status: 'QUEUED', attempts: 0, lockedAt: null })
    expect(getEventListeners(client.signal, 'abort')).toHaveLength(0)
  })

  it('ngắt kết nối mà không có job mới: dừng chờ ngay, không đợi hết thời gian', async () => {
    const client = new AbortController()
    const started = Date.now()
    setTimeout(() => client.abort(), 50)
    expect(await claimWithWait(5, client.signal)).toEqual({ job: null, paused: false })
    expect(Date.now() - started).toBeLessThan(1500)
    expect(getEventListeners(client.signal, 'abort')).toHaveLength(0)
  })

  it('signal đã bị huỷ từ trước: không nhận job dù có sẵn', async () => {
    const job = await seedJob()
    const client = new AbortController()
    client.abort()
    expect(await claimWithWait(5, client.signal)).toEqual({ job: null, paused: false })
    expect((await rowOf(job.id)).status).toBe('QUEUED')
  })

  it('signal còn sống: mọi đường ra đều gỡ listener (có job ngay, có job lúc chờ, hết giờ)', async () => {
    const client = new AbortController()
    const job = await seedJob()
    expect((await claimWithWait(5, client.signal)).job?.id).toBe(job.id)
    await failCloneJob(job.id, 1, { failKind: 'TOOL', error: 'x' })

    setTimeout(() => {
      void seedJob().then(() => notifyCloneQueue())
    }, 50)
    expect((await claimWithWait(5, client.signal)).job).not.toBeNull()
    expect(getEventListeners(client.signal, 'abort')).toHaveLength(0)
    expect(waiterCount()).toBe(0)
    await prisma.cloneJob.updateMany({ where: { status: 'RUNNING' }, data: { status: 'FAILED' } })

    expect(await claimWithWait(0.3, client.signal)).toEqual({ job: null, paused: false })
    expect(getEventListeners(client.signal, 'abort')).toHaveLength(0)
  })
})

describe('makeShopifyProductState', () => {
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const product = {
    status: 'ACTIVE', onlineStoreUrl: ONLINE_URL, handle: 'zw-mug', productType: 'Mug',
    variants: { nodes: [{ sku: 'ZW2611050001' }, { sku: 'ZW2611050001-BLACK' }, { sku: null }], pageInfo: { hasNextPage: false, endCursor: 'c1' } },
  }

  // Serves `pages` one per call, following the `after` cursor the caller sends; records every variables object it was sent.
  const paged = (pages: (string | null)[][], sent: Record<string, unknown>[] = []) => async (_url: string, init?: RequestInit) => {
    const variables = JSON.parse(String(init?.body)).variables as Record<string, unknown>
    sent.push(variables)
    const i = typeof variables.after === 'string' ? Number(variables.after.replace('cursor-', '')) : 0
    const more = i < pages.length - 1
    return answer({
      data: { product: { ...product, variants: { nodes: pages[i].map(sku => ({ sku })), pageInfo: { hasNextPage: more, endCursor: more ? `cursor-${i + 1}` : null } } } },
    })
  }

  it('đọc hết mọi trang variant theo con trỏ after', async () => {
    const sent: Record<string, unknown>[] = []
    const state = await makeShopifyProductState({ fetchImpl: paged([['A-1', 'A-2'], ['A-3'], [null, 'A-4']], sent) })(STORE, GID)
    expect(state?.skus).toEqual(['A-1', 'A-2', 'A-3', null, 'A-4'])
    expect(sent).toEqual([{ id: GID, after: null }, { id: GID, after: 'cursor-1' }, { id: GID, after: 'cursor-2' }])
  })

  it('cần trang thứ 13 → ném lỗi (không bao giờ coi là đạt); hasNextPage mà thiếu con trỏ → ném lỗi', async () => {
    const sent: Record<string, unknown>[] = []
    const logs: string[] = []
    const pages = Array.from({ length: 13 }, (_, i) => [`P-${i}`])
    await expect(makeShopifyProductState({ fetchImpl: paged(pages, sent), log: m => logs.push(m) })(STORE, GID)).rejects.toBeInstanceOf(Error)
    expect(sent).toHaveLength(12)
    expect(logs).toHaveLength(1)

    const noCursor = async () => answer({ data: { product: { ...product, variants: { ...product.variants, pageInfo: { hasNextPage: true, endCursor: null } } } } })
    await expect(makeShopifyProductState({ fetchImpl: noCursor, log: () => {} })(STORE, GID)).rejects.toBeInstanceOf(Error)
  })

  it('complete qua 3 trang: SKU đối thủ ở trang cuối → FAILED/VERIFY; cả 3 trang đúng mã → DONE', async () => {
    const bad = await running()
    const b = bad.skuCode
    const refused = await completeCloneJob(bad.id, bad.attempts, { productGid: GID, qaVerdict: 'PASS' }, {
      productState: makeShopifyProductState({ fetchImpl: paged([[b, `${b}-S`], [`${b}-M`], [`${b}-L`, 'FS-COMPETITOR-XL']]) }),
    })
    expect(refused).toEqual({ status: 'FAILED', error: FOREIGN_SKU })
    expect(await rowOf(bad.id)).toMatchObject({ status: 'FAILED', failKind: 'VERIFY', error: FOREIGN_SKU, productUrl: null })

    const good = await running()
    const g = good.skuCode
    const done = await completeCloneJob(good.id, good.attempts, { productGid: GID, qaVerdict: 'PASS' }, {
      productState: makeShopifyProductState({ fetchImpl: paged([[g, `${g}-S`], [`${g}-M`], [`${g}-L`]]) }),
    })
    expect(done).toEqual({ status: 'DONE' })
    expect(await rowOf(good.id)).toMatchObject({ status: 'DONE', productUrl: ONLINE_URL, handle: 'zw-mug', productType: 'Mug' })
  })

  it('complete: sản phẩm cần trang thứ 13 → { retry: true }, job vẫn RUNNING', async () => {
    const job = await running()
    const pages = Array.from({ length: 13 }, (_, i) => [`${job.skuCode}-V${i}`])
    const result = await completeCloneJob(job.id, job.attempts, { productGid: GID, qaVerdict: 'PASS' }, {
      productState: makeShopifyProductState({ fetchImpl: paged(pages), log: () => {} }),
    })
    expect(result).toMatchObject({ retry: true })
    expect(await rowOf(job.id)).toMatchObject({ status: 'RUNNING', attempts: job.attempts, finishedAt: null, productUrl: null })
  })

  it('hỏi product(id:) của store đích, token chỉ nằm trong header', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const ask = makeShopifyProductState({ fetchImpl: async (url, init) => { seen.push({ url: String(url), init: init ?? {} }); return answer({ data: { product } }) } })
    expect(await ask(STORE, GID)).toEqual({
      status: 'ACTIVE', onlineStoreUrl: ONLINE_URL, handle: 'zw-mug', productType: 'Mug', skus: ['ZW2611050001', 'ZW2611050001-BLACK', null],
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe(`https://${STORE}.myshopify.com/admin/api/2024-10/graphql.json`)
    expect((seen[0].init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(TOKEN)
    expect(seen[0].init.redirect).toBe('error')
    const body = JSON.parse(String(seen[0].init.body))
    expect(body.variables).toEqual({ id: GID, after: null })
    expect(body.query.replace(/\s+/g, ' ')).toContain(
      'product(id: $id) { status onlineStoreUrl handle productType variants(first: 250, after: $after) { nodes { sku } pageInfo { hasNextPage endCursor } } }',
    )
    expect(seen[0].url).not.toContain(TOKEN)
    expect(String(seen[0].init.body)).not.toContain(TOKEN)
  })

  it('product null → null; productType rỗng → null', async () => {
    expect(await makeShopifyProductState({ fetchImpl: async () => answer({ data: { product: null } }) })(STORE, GID)).toBeNull()
    const typeless = await makeShopifyProductState({ fetchImpl: async () => answer({ data: { product: { ...product, productType: '', onlineStoreUrl: null } } }) })(STORE, GID)
    expect(typeless).toMatchObject({ productType: null, onlineStoreUrl: null })
  })

  it('lỗi mạng, HTTP lỗi, dữ liệu lạ, store không kết nối: ném lỗi, token không vào log hay lỗi', async () => {
    const cases: { storeId: string; fetchImpl: (url: string, init?: RequestInit) => Promise<Response> }[] = [
      { storeId: STORE, fetchImpl: async () => { throw new Error(`ECONNRESET ${TOKEN}`) } },
      { storeId: STORE, fetchImpl: async () => answer({ errors: `Invalid token ${TOKEN}` }, 401) },
      { storeId: STORE, fetchImpl: async () => answer({ errors: [{ message: `Throttled ${TOKEN}` }] }) },
      { storeId: STORE, fetchImpl: async () => new Response(`<html>${TOKEN}</html>`, { status: 200 }) },
      { storeId: STORE, fetchImpl: async () => answer({ data: { product: { ...product, variants: null } } }) },
      { storeId: STORE, fetchImpl: async () => answer({ data: {} }) },
      { storeId: `${P}-store-missing`, fetchImpl: async () => answer({ data: { product } }) },
    ]
    for (const c of cases) {
      const logs: string[] = []
      const ask = makeShopifyProductState({ fetchImpl: c.fetchImpl, log: m => logs.push(m) })
      let thrown: unknown = null
      try {
        await ask(c.storeId, GID)
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(Error)
      expect(String((thrown as Error).message)).not.toContain(TOKEN)
      expect(String((thrown as Error).stack)).not.toContain(TOKEN)
      expect(logs.length).toBeGreaterThan(0)
      for (const line of logs) expect(line).not.toContain(TOKEN)
    }
  })

  it('shop không phải host https công khai: không gửi token', async () => {
    const internal = await prisma.shopifyStore.create({ data: { id: `${P}-internal`, shop: `${P}-internal.local` } })
    try {
      await saveStoreCredential(internal.id, { authMode: 'TOKEN', accessToken: TOKEN })
      let fetched = 0
      const ask = makeShopifyProductState({ fetchImpl: async () => { fetched++; return answer({ data: { product } }) }, log: () => {} })
      await expect(ask(internal.id, GID)).rejects.toBeInstanceOf(Error)
      expect(fetched).toBe(0)
    } finally {
      await prisma.shopifyStore.delete({ where: { id: internal.id } })
    }
  })
})
