import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { prisma } from '@/lib/db'
import type { AuthUser } from '@/lib/api-auth'
import { saveStoreCredential } from '@/lib/store-connections'
import {
  CloneInputError, cancelCloneJob, cloneJobView, createCloneJob, getCloneJob, listCloneJobs, notifyCloneQueue, retryCloneJob,
  sourceKeyOf, waitForCloneQueue,
} from '@/lib/clone/jobs'
import { CLONE_SETTINGS_KEY, getCloneSettings, saveCloneSettings } from '@/lib/clone/settings'
import { SKU_CODE_RE } from '@/lib/clone/sku-code'

const P = 'cj3'
const NOW = new Date('2026-11-06T03:00:00Z')
const STORE_A = `${P}-store-a`
const STORE_B = `${P}-store-b`
const STORE_OFF = `${P}-store-off`
const STORE_BARE = `${P}-store-bare`
const LINK = 'https://Shop.Example.com/products/abc'
const LINK_KEY = 'shop.example.com/products/abc'

const EMAILS = ['super', 'admin', 'support', 'sellera', 'sellera2', 'sellerb', 'noprefix', 'unknown'].map(k => `${P}-${k}@test.local`)

let seq = 0
// Every call starts the codes at a fresh number so two tests never fight over the same unique skuCode.
const sku = () => {
  let n = (seq += 100)
  return { random: () => n++, shopifySkuExists: async () => false, storeIds: async () => [] as string[] }
}
const deps = () => ({ sku: sku(), now: NOW })

const users: Record<string, AuthUser> = {}

async function makeUser(key: string, role: string, skuPrefix: string | null, storeIds: string[] = []) {
  const email = `${P}-${key}@test.local`
  const row = await prisma.appUser.create({
    data: { name: `Name ${key}`, email, role, skuPrefix, storeAccess: { create: storeIds.map(storeId => ({ storeId })) } },
  })
  users[key] = { id: row.id, email, name: row.name, role: role as AuthUser['role'], permissions: ['fulfillment_clone'], tokenVersion: 0 }
}

async function makeStore(id: string, opts: { enabled?: boolean; credential?: boolean } = {}) {
  await prisma.shopifyStore.create({ data: { id, shop: `${id}.myshopify.com`, orderPrefix: id.slice(-1).toUpperCase(), enabled: opts.enabled ?? true } })
  if (opts.credential ?? true) await saveStoreCredential(id, { authMode: 'TOKEN', accessToken: `token-${id}` })
}

let jobN = 0
async function seedJob(over: Partial<{
  storeId: string; sourceUrl: string; sourceKey: string; status: string; failKind: string | null; requestedById: string; requestedByName: string
  productUrl: string | null; attempts: number; stage: string | null; error: string | null; costUsd: number | null; durationMs: number | null
  lockedAt: Date | null; finishedAt: Date | null; createdAt: Date
}> = {}) {
  jobN++
  return prisma.cloneJob.create({
    data: {
      storeId: STORE_A, sourceUrl: LINK, sourceKey: LINK_KEY, skuCode: `ZZ26110${String(jobN).padStart(5, '0')}`,
      requestedById: users.sellera.id, requestedByName: users.sellera.name, ...over,
    },
  })
}

async function codeOf(fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (e) {
    if (e instanceof CloneInputError) return e
    throw e
  }
  throw new Error('expected CloneInputError')
}

async function wipe() {
  await prisma.cloneJob.deleteMany({ where: { storeId: { startsWith: `${P}-` } } })
  await prisma.cloneJob.deleteMany({ where: { skuCode: { startsWith: 'ZZ26110' } } })
  await prisma.appSetting.deleteMany({ where: { key: CLONE_SETTINGS_KEY } })
}

beforeAll(async () => {
  await wipe()
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  await prisma.shopifyStore.deleteMany({ where: { id: { startsWith: `${P}-` } } })
  await makeStore(STORE_A)
  await makeStore(STORE_B)
  await makeStore(STORE_OFF, { enabled: false })
  await makeStore(STORE_BARE, { credential: false })
  await makeUser('super', 'SUPERADMIN', 'ZA')
  await makeUser('admin', 'ADMIN', 'ZB')
  await makeUser('support', 'SUPPORT', 'ZC')
  await makeUser('sellera', 'SELLER', 'ZD', [STORE_A, STORE_OFF, STORE_BARE])
  await makeUser('sellera2', 'SELLER', 'ZE', [STORE_A])
  await makeUser('sellerb', 'SELLER', 'ZF', [STORE_B])
  await makeUser('noprefix', 'SELLER', null, [STORE_A])
  await makeUser('unknown', 'GHOST', 'ZG', [STORE_A])
})

beforeEach(wipe)

afterEach(() => {
  vi.useRealTimers()
})

afterAll(async () => {
  await wipe()
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  await prisma.shopifyStore.deleteMany({ where: { id: { startsWith: `${P}-` } } })
})

describe('sourceKeyOf', () => {
  it('sourceKeyOf gộp các dạng của cùng một link', () => {
    const k = sourceKeyOf('https://Shop.Example.com/products/abc/?variant=1#x')
    expect(k).toBe('shop.example.com/products/abc')
    expect(sourceKeyOf('https://shop.example.com/products/abc')).toBe(k)
  })

  it('giữ path khác nhau là hai khoá, bỏ mọi dấu / cuối, link chỉ có host', () => {
    expect(sourceKeyOf('https://shop.example.com/products/abc')).not.toBe(sourceKeyOf('https://shop.example.com/products/abd'))
    expect(sourceKeyOf('https://shop.example.com/products/abc///')).toBe('shop.example.com/products/abc')
    expect(sourceKeyOf('https://Shop.Example.com/')).toBe('shop.example.com')
    expect(sourceKeyOf('https://shop.example.com')).toBe('shop.example.com')
  })
})

describe('clone settings', () => {
  it('mặc định là không tạm dừng và chưa bật cặp nào', async () => {
    expect(await getCloneSettings()).toEqual({ paused: false, targets: [] })
  })

  it('lưu rồi đọc lại, bỏ trùng, giữ thứ tự', async () => {
    const saved = await saveCloneSettings({ paused: true, targets: ['customily:LIT', 'customall:REMI', 'customily:LIT'] })
    expect(saved).toEqual({ paused: true, targets: ['customily:LIT', 'customall:REMI'] })
    expect(await getCloneSettings()).toEqual(saved)
    expect(await prisma.appSetting.findUnique({ where: { key: 'clone.settings' } })).not.toBeNull()
  })

  it('thiếu trường thì giữ giá trị hiện có', async () => {
    await saveCloneSettings({ paused: true, targets: ['teeinblue:REMI'] })
    expect(await saveCloneSettings({ paused: false })).toEqual({ paused: false, targets: ['teeinblue:REMI'] })
    expect(await saveCloneSettings({ targets: [] })).toEqual({ paused: false, targets: [] })
  })

  it('targets chỉ nhận dạng <nền tảng>:<CHỮ HOA>, sai là 400 và không lưu gì', async () => {
    await saveCloneSettings({ paused: true, targets: ['customily:LIT'] })
    const bad: unknown[] = [
      ['unknown:LIT'], ['customily:lit'], ['customily:'], ['customily:LIT1'], ['customily'], ['customily:LIT; rm'], [1], 'customily:LIT', { 0: 'customily:LIT' },
    ]
    for (const targets of bad) {
      const e = await codeOf(() => saveCloneSettings({ targets }))
      expect(e.status).toBe(400)
    }
    expect((await codeOf(() => saveCloneSettings({ paused: 'yes' }))).status).toBe(400)
    expect((await codeOf(() => saveCloneSettings(null))).status).toBe(400)
    expect((await codeOf(() => saveCloneSettings([]))).status).toBe(400)
    expect(await getCloneSettings()).toEqual({ paused: true, targets: ['customily:LIT'] })
  })

  it('giá trị hỏng trong AppSetting thì đọc ra mặc định', async () => {
    await prisma.appSetting.create({ data: { key: CLONE_SETTINGS_KEY, value: '{not json' } })
    expect(await getCloneSettings()).toEqual({ paused: false, targets: [] })
    await prisma.appSetting.update({ where: { key: CLONE_SETTINGS_KEY }, data: { value: JSON.stringify({ paused: 'x', targets: ['customily:LIT', 'bad', 7] }) } })
    expect(await getCloneSettings()).toEqual({ paused: false, targets: ['customily:LIT'] })
  })
})

describe('createCloneJob', () => {
  it('1. store ngoài phạm vi của seller: 403', async () => {
    const e = await codeOf(() => createCloneJob(users.sellera, { url: LINK, storeId: STORE_B }, deps()))
    expect(e.status).toBe(403)
    expect(e.message).toBe('Bạn không có quyền xem store này.')
    expect(await prisma.cloneJob.count({ where: { storeId: STORE_B } })).toBe(0)
  })

  it('1. store không bật, chưa kết nối hoặc không tồn tại: 403, kể cả với SUPERADMIN và seller được gán', async () => {
    for (const storeId of [STORE_OFF, STORE_BARE, `${P}-no-such-store`, '', null, 5]) {
      for (const who of [users.super, users.sellera]) {
        const e = await codeOf(() => createCloneJob(who, { url: LINK, storeId }, deps()))
        expect(e.status).toBe(403)
        expect(e.message).toBe('Bạn không có quyền xem store này.')
      }
    }
  })

  it('1. kiểm store đến trước kiểm mã SKU và kiểm link', async () => {
    const e = await codeOf(() => createCloneJob(users.noprefix, { url: 'junk', storeId: STORE_B }, deps()))
    expect(e.status).toBe(403)
  })

  it('1. vai trò lạ không có store nào: 403', async () => {
    const e = await codeOf(() => createCloneJob(users.unknown, { url: LINK, storeId: STORE_A }, deps()))
    expect(e.status).toBe(403)
  })

  it('2. người gọi chưa có skuPrefix: 400', async () => {
    const e = await codeOf(() => createCloneJob(users.noprefix, { url: LINK, storeId: STORE_A }, deps()))
    expect(e.status).toBe(400)
    expect(e.message).toBe('Tài khoản chưa có mã SKU 2 chữ cái. Nhờ quản trị điền ở Setup › Users.')
    expect(await prisma.cloneJob.count({ where: { storeId: STORE_A } })).toBe(0)
  })

  it('2. kiểm mã SKU đến trước kiểm link', async () => {
    const e = await codeOf(() => createCloneJob(users.noprefix, { url: 'junk', storeId: STORE_A }, deps()))
    expect(e.message).toContain('mã SKU 2 chữ cái')
  })

  it('2. skuPrefix đọc lại từ AppUser, không từ phiên', async () => {
    await prisma.appUser.update({ where: { id: users.noprefix.id }, data: { skuPrefix: 'ZH' } })
    try {
      const job = await createCloneJob(users.noprefix, { url: LINK, storeId: STORE_A }, deps())
      expect(job.skuCode.startsWith('ZH')).toBe(true)
    } finally {
      await prisma.appUser.update({ where: { id: users.noprefix.id }, data: { skuPrefix: null } })
    }
  })

  it('3. link sai: 400 "Link không hợp lệ."', async () => {
    const bad: unknown[] = ['', '   ', 'not a url', 'http://shop.example.com/p', 'https://localhost/p', 'https://127.0.0.1/p', 'https://user:pw@shop.example.com/p', 'ftp://shop.example.com/p', undefined, null, 12, {}]
    for (const url of bad) {
      const e = await codeOf(() => createCloneJob(users.sellera, { url, storeId: STORE_A }, deps()))
      expect(e.status).toBe(400)
      expect(e.message).toBe('Link không hợp lệ.')
    }
    expect(await prisma.cloneJob.count({ where: { storeId: STORE_A } })).toBe(0)
  })

  it('4. link của chính người gọi đang chờ, đang chạy hoặc xong: 409 kèm jobId', async () => {
    for (const status of ['QUEUED', 'RUNNING', 'DONE']) {
      await wipe()
      const mine = await seedJob({ status })
      const e = await codeOf(() => createCloneJob(users.sellera, { url: `${LINK}/?utm=1#top`, storeId: STORE_A }, deps()))
      expect(e.status).toBe(409)
      expect(e.message).toBe('Bạn đã dán link này rồi.')
      expect(e.extra).toEqual({ jobId: mine.id })
    }
  })

  it('4. link của người khác đã DONE: 409 kèm productUrl, không kèm skuCode, tên người dán, hay jobId', async () => {
    const other = await seedJob({
      status: 'DONE', productUrl: 'https://store-a.example.com/products/made', requestedById: users.sellera2.id, requestedByName: 'Secret Seller Name',
    })
    const e = await codeOf(() => createCloneJob(users.sellera, { url: LINK, storeId: STORE_A }, deps()))
    expect(e.status).toBe(409)
    expect(e.message).toBe('Link này đã có sản phẩm trên store.')
    expect(e.extra).toEqual({ productUrl: 'https://store-a.example.com/products/made' })
    const shown = JSON.stringify({ message: e.message, extra: e.extra })
    for (const secret of [other.skuCode, 'Secret Seller Name', other.id, other.requestedById]) expect(shown).not.toContain(secret)
  })

  it('4. link của người khác chưa xong: 409 "đang được clone", không kèm gì', async () => {
    for (const status of ['QUEUED', 'RUNNING']) {
      await wipe()
      await seedJob({ status, requestedById: users.sellera2.id, requestedByName: 'Someone' })
      const e = await codeOf(() => createCloneJob(users.sellera, { url: LINK, storeId: STORE_A }, deps()))
      expect(e.status).toBe(409)
      expect(e.message).toBe('Link này đang được clone.')
      expect(e.extra).toBeUndefined()
    }
  })

  it('4. job của chính mình được báo trước job của người khác', async () => {
    await seedJob({ status: 'DONE', productUrl: 'https://store-a.example.com/p', requestedById: users.sellera2.id, requestedByName: 'Someone' })
    const mine = await seedJob({ status: 'QUEUED' })
    const e = await codeOf(() => createCloneJob(users.sellera, { url: LINK, storeId: STORE_A }, deps()))
    expect(e.message).toBe('Bạn đã dán link này rồi.')
    expect(e.extra).toEqual({ jobId: mine.id })
  })

  it('4. job lỗi hoặc đã huỷ, link của store khác, link khác: không chặn', async () => {
    await seedJob({ status: 'FAILED', failKind: 'SOURCE' })
    await seedJob({ status: 'CANCELLED' })
    await seedJob({ status: 'DONE', storeId: STORE_B, productUrl: 'https://b.example.com/p' })
    await seedJob({ status: 'DONE', sourceUrl: 'https://shop.example.com/products/other', sourceKey: 'shop.example.com/products/other', productUrl: 'https://a.example.com/p' })
    const job = await createCloneJob(users.sellera, { url: LINK, storeId: STORE_A }, deps())
    expect(job.status).toBe('QUEUED')
  })

  it('4. force của SUPERADMIN bỏ qua việc dò; force của người khác không', async () => {
    await seedJob({ status: 'DONE', productUrl: 'https://store-a.example.com/p', requestedById: users.sellera2.id, requestedByName: 'Someone' })
    const forced = await createCloneJob(users.super, { url: LINK, storeId: STORE_A, force: true }, deps())
    expect(forced.status).toBe('QUEUED')
    expect(forced.requestedById).toBe(users.super.id)
    for (const who of [users.sellera, users.admin]) {
      const e = await codeOf(() => createCloneJob(who, { url: LINK, storeId: STORE_A, force: true }, deps()))
      expect(e.status).toBe(409)
    }
    for (const force of [false, undefined, 'true', 1]) {
      const e = await codeOf(() => createCloneJob(users.super, { url: LINK, storeId: STORE_A, force }, deps()))
      expect(e.status).toBe(409)
    }
  })

  it('5. cấp mã, tạo job QUEUED và đánh thức hàng chờ', async () => {
    const woke = vi.fn()
    const waiting = waitForCloneQueue(60_000).then(woke)
    const job = await createCloneJob(users.sellera, { url: `  ${LINK}/?variant=1  `, storeId: STORE_A }, deps())
    await waiting
    expect(woke).toHaveBeenCalledTimes(1)
    expect(job).toMatchObject({
      status: 'QUEUED', storeId: STORE_A, sourceUrl: `${LINK}/?variant=1`, sourceKey: LINK_KEY, requestedById: users.sellera.id,
      requestedByName: users.sellera.name, attempts: 0, failKind: null,
    })
    expect(job.skuCode).toMatch(SKU_CODE_RE)
    expect(job.skuCode.startsWith('ZD261106')).toBe(true)
    const stored = await prisma.cloneJob.findUnique({ where: { id: job.id } })
    expect(stored?.skuCode).toBe(job.skuCode)
  })

  it('5. một lỗi từ lớp cấp mã không để lại job', async () => {
    const failing = { ...sku(), random: () => 1, shopifySkuExists: async () => true, storeIds: async () => [STORE_A] }
    await expect(createCloneJob(users.sellera, { url: LINK, storeId: STORE_A }, { sku: failing, now: NOW })).rejects.toThrow('Không cấp được mã SKU')
    expect(await prisma.cloneJob.count({ where: { storeId: STORE_A } })).toBe(0)
  })

  it('SUPERADMIN, ADMIN và SUPPORT tạo được cho mọi store đang kết nối', async () => {
    const staff = [users.super, users.admin, users.support]
    for (let i = 0; i < staff.length; i++) {
      const job = await createCloneJob(staff[i], { url: `https://shop.example.com/p/${i}`, storeId: STORE_B }, deps())
      expect(job.storeId).toBe(STORE_B)
    }
  })
})

describe('xem job', () => {
  it('seller A không thấy job của seller B cùng store', async () => {
    const a = await seedJob({ requestedById: users.sellera.id })
    const b = await seedJob({ sourceKey: 'x.example.com/1', requestedById: users.sellera2.id, requestedByName: 'B' })
    const listed = (await listCloneJobs(users.sellera)).map(j => j.id)
    expect(listed).toEqual([a.id])
    expect((await listCloneJobs(users.sellera2)).map(j => j.id)).toEqual([b.id])
    expect(await getCloneJob(users.sellera, a.id)).toMatchObject({ id: a.id })
    expect(await getCloneJob(users.sellera, b.id)).toBeNull()
  })

  it('seller không thấy job của mình ở store không còn được gán', async () => {
    const mine = await seedJob({ storeId: STORE_B, requestedById: users.sellera.id })
    expect(await listCloneJobs(users.sellera)).toEqual([])
    expect(await getCloneJob(users.sellera, mine.id)).toBeNull()
  })

  it('SUPERADMIN, ADMIN và SUPPORT thấy hết; vai trò lạ không thấy gì', async () => {
    const a = await seedJob()
    const b = await seedJob({ storeId: STORE_B, sourceKey: 'y.example.com/1', requestedById: users.sellerb.id, requestedByName: 'B' })
    for (const who of [users.super, users.admin, users.support]) {
      expect((await listCloneJobs(who)).map(j => j.id).sort()).toEqual([a.id, b.id].sort())
      expect(await getCloneJob(who, b.id)).toMatchObject({ id: b.id })
    }
    expect(await listCloneJobs(users.unknown)).toEqual([])
    expect(await getCloneJob(users.unknown, a.id)).toBeNull()
  })

  it('id không có: null', async () => {
    expect(await getCloneJob(users.super, `${P}-nope`)).toBeNull()
  })

  it('danh sách là 200 job mới nhất, mới nhất trước', async () => {
    const base = Date.UTC(2026, 10, 1)
    await prisma.cloneJob.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({
        storeId: STORE_A, sourceUrl: `https://m.example.com/${i}`, sourceKey: `m.example.com/${i}`, skuCode: `ZZ26110${String(90000 + i)}`,
        requestedById: users.sellera.id, requestedByName: 'A', createdAt: new Date(base + i * 1000),
      })),
    })
    const listed = await listCloneJobs(users.sellera)
    expect(listed).toHaveLength(200)
    expect(listed[0].sourceKey).toBe('m.example.com/204')
    expect(listed[199].sourceKey).toBe('m.example.com/5')
  })
})

describe('cloneJobView', () => {
  it('cloneJobView giấu chi phí với người không phải SUPERADMIN', async () => {
    const row = await seedJob({ costUsd: 1.25, durationMs: 90_000, lockedAt: new Date('2026-11-06T01:00:00Z'), status: 'RUNNING' })
    for (const who of [users.sellera, users.admin, users.support]) {
      const view = cloneJobView(row, who)
      for (const key of ['costUsd', 'durationMs', 'lockedAt']) expect(key in view).toBe(false)
    }
    const full = cloneJobView(row, users.super)
    expect(full).toMatchObject({ costUsd: 1.25, durationMs: 90_000, lockedAt: '2026-11-06T01:00:00.000Z' })
  })

  it('mọi cột còn lại có mặt, ngày là chuỗi ISO', async () => {
    const row = await seedJob({ status: 'FAILED', failKind: 'QA', error: 'boom', finishedAt: new Date('2026-11-06T02:00:00Z'), stage: 'QA' })
    const view = cloneJobView(row, users.sellera) as Record<string, unknown>
    const expected = Object.keys(row).filter(k => !['costUsd', 'durationMs', 'lockedAt'].includes(k)).sort()
    expect(Object.keys(view).sort()).toEqual(expected)
    expect(view.createdAt).toBe(row.createdAt.toISOString())
    expect(view.updatedAt).toBe(row.updatedAt.toISOString())
    expect(view.finishedAt).toBe('2026-11-06T02:00:00.000Z')
    expect(view.startedAt).toBeNull()
    expect(view).toMatchObject({ skuCode: row.skuCode, failKind: 'QA', error: 'boom', stage: 'QA', reused: false })
  })

  it('danh sách, xem một job, huỷ và thử lại đều qua cloneJobView', async () => {
    const row = await seedJob({ costUsd: 3, durationMs: 5, lockedAt: new Date(), status: 'QUEUED' })
    expect('costUsd' in (await listCloneJobs(users.sellera))[0]).toBe(false)
    expect('costUsd' in (await getCloneJob(users.sellera, row.id))!).toBe(false)
    expect('costUsd' in (await getCloneJob(users.super, row.id))!).toBe(true)
    expect('costUsd' in (await cancelCloneJob(users.sellera, row.id))).toBe(false)
    await prisma.cloneJob.update({ where: { id: row.id }, data: { status: 'FAILED', failKind: 'TOOL' } })
    expect('costUsd' in (await retryCloneJob(users.sellera, row.id))).toBe(false)
  })
})

describe('cancelCloneJob', () => {
  it('người tạo huỷ job QUEUED: CANCELLED', async () => {
    const row = await seedJob()
    const view = await cancelCloneJob(users.sellera, row.id)
    expect(view.status).toBe('CANCELLED')
    const stored = await prisma.cloneJob.findUnique({ where: { id: row.id } })
    expect(stored?.status).toBe('CANCELLED')
    expect(stored?.finishedAt).not.toBeNull()
  })

  it('SUPERADMIN huỷ được job của người khác', async () => {
    const row = await seedJob({ storeId: STORE_B })
    expect((await cancelCloneJob(users.super, row.id)).status).toBe('CANCELLED')
  })

  it('ADMIN không phải người tạo: 403, job còn nguyên', async () => {
    const row = await seedJob()
    const e = await codeOf(() => cancelCloneJob(users.admin, row.id))
    expect(e.status).toBe(403)
    expect((await prisma.cloneJob.findUnique({ where: { id: row.id } }))?.status).toBe('QUEUED')
  })

  it('seller khác hoặc id không có: 404 như nhau', async () => {
    const row = await seedJob()
    for (const id of [row.id, `${P}-nope`]) {
      const e = await codeOf(() => cancelCloneJob(users.sellera2, id))
      expect(e.status).toBe(404)
      expect(e.message).toBe('Không tìm thấy job.')
    }
    expect((await prisma.cloneJob.findUnique({ where: { id: row.id } }))?.status).toBe('QUEUED')
  })

  it('job không còn QUEUED: 409', async () => {
    for (const status of ['RUNNING', 'DONE', 'FAILED', 'CANCELLED']) {
      await wipe()
      const row = await seedJob({ status })
      const e = await codeOf(() => cancelCloneJob(users.sellera, row.id))
      expect(e.status).toBe(409)
      expect(e.message).toBe('Chỉ huỷ được job đang chờ.')
      expect((await prisma.cloneJob.findUnique({ where: { id: row.id } }))?.status).toBe(status)
    }
  })

  it('job vừa bị runner nhận giữa chừng: không đè trạng thái RUNNING', async () => {
    const row = await seedJob()
    const original = prisma.cloneJob.findFirst.bind(prisma.cloneJob) as (args: unknown) => Promise<unknown>
    const spy = vi.spyOn(prisma.cloneJob, 'findFirst').mockImplementationOnce((async (args: unknown) => {
      const found = await original(args)
      await prisma.cloneJob.update({ where: { id: row.id }, data: { status: 'RUNNING' } })
      return found
    }) as any)
    const e = await codeOf(() => cancelCloneJob(users.sellera, row.id))
    spy.mockRestore()
    expect(e.status).toBe(409)
    expect((await prisma.cloneJob.findUnique({ where: { id: row.id } }))?.status).toBe('RUNNING')
  })
})

describe('retryCloneJob', () => {
  const failed = (over: Parameters<typeof seedJob>[0] = {}) => seedJob({
    status: 'FAILED', failKind: 'TOOL', error: 'it broke', stage: 'QA', attempts: 2, lockedAt: new Date('2026-11-06T01:00:00Z'), finishedAt: new Date('2026-11-06T02:00:00Z'), ...over,
  })

  it('người tạo thử lại job FAILED: QUEUED, attempts 0, xoá lỗi, giữ skuCode, đánh thức hàng chờ', async () => {
    const row = await failed()
    const woke = vi.fn()
    const waiting = waitForCloneQueue(60_000).then(woke)
    const view = await retryCloneJob(users.sellera, row.id)
    await waiting
    expect(woke).toHaveBeenCalledTimes(1)
    expect(view).toMatchObject({ id: row.id, status: 'QUEUED', attempts: 0, error: null, failKind: null, stage: null, finishedAt: null, skuCode: row.skuCode })
    const stored = await prisma.cloneJob.findUnique({ where: { id: row.id } })
    expect(stored).toMatchObject({ status: 'QUEUED', attempts: 0, error: null, failKind: null, stage: null, lockedAt: null, finishedAt: null, skuCode: row.skuCode })
  })

  it('job không phải FAILED: 409', async () => {
    for (const status of ['QUEUED', 'RUNNING', 'DONE', 'CANCELLED']) {
      await wipe()
      const row = await seedJob({ status })
      const e = await codeOf(() => retryCloneJob(users.sellera, row.id))
      expect(e.status).toBe(409)
      expect(e.message).toBe('Chỉ thử lại được job lỗi.')
    }
  })

  it('TOOL_GAP, UNSUPPORTED, NOT_ENABLED: seller 403, SUPERADMIN thử lại được', async () => {
    for (const failKind of ['TOOL_GAP', 'UNSUPPORTED', 'NOT_ENABLED']) {
      await wipe()
      const row = await failed({ failKind })
      const e = await codeOf(() => retryCloneJob(users.sellera, row.id))
      expect(e.status).toBe(403)
      expect(e.message).toBe('Job này cần quản trị xử lý trước khi thử lại.')
      expect((await prisma.cloneJob.findUnique({ where: { id: row.id } }))?.status).toBe('FAILED')
      expect((await retryCloneJob(users.super, row.id)).status).toBe('QUEUED')
    }
  })

  it('các failKind còn lại seller thử lại được', async () => {
    for (const failKind of ['SOURCE', 'TOOL', 'QA', 'VERIFY', 'TIMEOUT', 'WORKER_LOST']) {
      await wipe()
      const row = await failed({ failKind })
      expect((await retryCloneJob(users.sellera, row.id)).status).toBe('QUEUED')
    }
  })

  it('SUPERADMIN thử lại được job của người khác; ADMIN không phải người tạo thì 403', async () => {
    const row = await failed()
    expect((await codeOf(() => retryCloneJob(users.admin, row.id))).status).toBe(403)
    expect((await retryCloneJob(users.super, row.id)).status).toBe('QUEUED')
  })

  it('seller khác hoặc id không có: 404 như nhau', async () => {
    const row = await failed()
    for (const id of [row.id, `${P}-nope`]) {
      const e = await codeOf(() => retryCloneJob(users.sellera2, id))
      expect(e.status).toBe(404)
      expect(e.message).toBe('Không tìm thấy job.')
    }
    expect((await prisma.cloneJob.findUnique({ where: { id: row.id } }))?.status).toBe('FAILED')
  })
})

describe('đánh thức hàng chờ', () => {
  const waiterCount = () => (globalThis as any).__cloneQueueWaiters?.size ?? 0

  it('notifyCloneQueue đánh thức mọi bên đang chờ và dọn sạch', async () => {
    vi.useFakeTimers()
    const woke = vi.fn()
    const all = [waitForCloneQueue(60_000), waitForCloneQueue(60_000), waitForCloneQueue(1_000)].map(p => p.then(woke))
    expect(waiterCount()).toBe(3)
    expect(vi.getTimerCount()).toBe(3)
    notifyCloneQueue()
    await Promise.all(all)
    expect(woke).toHaveBeenCalledTimes(3)
    expect(waiterCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('hết ms mà không ai gọi thì tự trả về và dọn sạch', async () => {
    vi.useFakeTimers()
    const woke = vi.fn()
    const p = waitForCloneQueue(25_000).then(woke)
    await vi.advanceTimersByTimeAsync(24_999)
    expect(woke).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(woke).toHaveBeenCalledTimes(1)
    expect(waiterCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gọi notify khi không ai chờ thì không để lại gì, và không đánh thức người chờ sau đó', async () => {
    vi.useFakeTimers()
    notifyCloneQueue()
    const woke = vi.fn()
    const p = waitForCloneQueue(1_000).then(woke)
    await vi.advanceTimersByTimeAsync(500)
    expect(woke).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    await p
    expect(waiterCount()).toBe(0)
  })

  it('trạng thái nằm trên globalThis nên một bản module khác vẫn đánh thức được', async () => {
    vi.resetModules()
    const other = await import('@/lib/clone/jobs')
    const woke = vi.fn()
    const p = waitForCloneQueue(60_000).then(woke)
    other.notifyCloneQueue()
    await p
    expect(woke).toHaveBeenCalledTimes(1)
  })
})
