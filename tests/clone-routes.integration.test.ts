import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import type { FeaturePermission, UserRole } from '@/lib/roles'
import { saveStoreCredential } from '@/lib/store-connections'
import { notifyCloneQueue } from '@/lib/clone/jobs'
import { CLONE_SETTINGS_KEY, saveCloneSettings } from '@/lib/clone/settings'
import { CLONE_WORKER_SEEN_KEY, CLONE_WORKER_TOKEN_KEY, generateCloneWorkerToken } from '@/lib/clone/worker'
import * as jobsRoute from '@/app/api/fulfillment/clone/jobs/route'
import * as jobRoute from '@/app/api/fulfillment/clone/jobs/[id]/route'
import * as cancelRoute from '@/app/api/fulfillment/clone/jobs/[id]/cancel/route'
import * as retryRoute from '@/app/api/fulfillment/clone/jobs/[id]/retry/route'
import * as settingsRoute from '@/app/api/fulfillment/clone/settings/route'
import * as claimRoute from '@/app/api/clone-worker/claim/route'
import * as heartbeatRoute from '@/app/api/clone-worker/jobs/[id]/heartbeat/route'
import * as resultRoute from '@/app/api/clone-worker/jobs/[id]/result/route'
import * as failRoute from '@/app/api/clone-worker/jobs/[id]/fail/route'

const P = 'cr5'
const STORE_A = `${P}-store-a`
const STORE_B = `${P}-store-b`
const STORE_OFF = `${P}-store-off`
const STORE_TOKEN = `${P}-shpat-store-secret-value`
const GID = 'gid://shopify/Product/9054123557021'
const ONLINE_URL = 'https://litzzy.com/products/alice-mug'
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const BAD_REQUEST = 'Yêu cầu không hợp lệ.'
const NOT_FOUND = 'Không tìm thấy job.'
const SERVER_ERROR = 'Lỗi máy chủ.'
const SECRET_ERROR = `SQLITE_BUSY at C:\\Users\\owner\\secret.db ${STORE_TOKEN}`

const WHO = ['super', 'admin', 'sellerA', 'sellerA2', 'sellerB', 'bare', 'noperm'] as const
type Who = typeof WHO[number]
const EMAILS = WHO.map(k => `${P}-${k}@test.local`)
const NAMES: Record<Who, string> = {
  super: 'Sam Super', admin: 'Ada Admin', sellerA: 'Alice Aone', sellerA2: 'Alice Atwo', sellerB: 'Bob Bone', bare: 'Carl Bare', noperm: 'Nina Noperm',
}
const cookies = {} as Record<Who, string>
const ids = {} as Record<Who, string>

async function makeUser(key: Who, role: UserRole, skuPrefix: string | null, storeIds: string[], permissions: FeaturePermission[] = ['fulfillment_clone']) {
  const email = `${P}-${key}@test.local`
  const row = await prisma.appUser.create({
    data: { name: NAMES[key], email, role, skuPrefix, permissions: JSON.stringify(permissions), storeAccess: { create: storeIds.map(storeId => ({ storeId })) } },
  })
  ids[key] = row.id
  cookies[key] = `${AUTH_COOKIE}=${await signToken({ userId: row.id, email, name: row.name, role, permissions, tv: row.tokenVersion })}`
}

async function makeStore(id: string, enabled = true) {
  await prisma.shopifyStore.create({ data: { id, shop: `${id}.myshopify.com`, orderPrefix: id.slice(-1).toUpperCase(), enabled } })
  await saveStoreCredential(id, { authMode: 'TOKEN', accessToken: STORE_TOKEN })
}

type Init = { method?: string; who?: Who; cookie?: string; bearer?: string; json?: unknown; raw?: string }

function request(path: string, init: Init = {}) {
  const headers: Record<string, string> = {}
  const cookie = init.cookie ?? (init.who ? cookies[init.who] : undefined)
  if (cookie) headers.cookie = cookie
  if (init.bearer !== undefined) headers.authorization = init.bearer
  const body = init.raw ?? (init.json === undefined ? undefined : JSON.stringify(init.json))
  if (body !== undefined) headers['content-type'] = 'application/json'
  return new NextRequest(`http://localhost${path}`, { method: init.method ?? (body === undefined ? 'GET' : 'POST'), headers, body })
}

async function out(res: Response) {
  const text = await res.text()
  let body: any = null
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: res.status, body, text }
}

type Handler = (req: NextRequest, ctx: { params: { id: string } }) => Promise<Response>
const hit = async (handler: Handler, path: string, init: Init = {}, id = 'x') => out(await handler(request(path, init), { params: { id } }))

const listJobs = (init: Init) => hit(jobsRoute.GET as Handler, '/api/fulfillment/clone/jobs', init)
const createJob = (init: Init) => hit(jobsRoute.POST as Handler, '/api/fulfillment/clone/jobs', init)
const getJob = (id: string, init: Init) => hit(jobRoute.GET as Handler, `/api/fulfillment/clone/jobs/${id}`, init, id)
const cancelJob = (id: string, init: Init) => hit(cancelRoute.POST as Handler, `/api/fulfillment/clone/jobs/${id}/cancel`, { method: 'POST', ...init }, id)
const retryJob = (id: string, init: Init) => hit(retryRoute.POST as Handler, `/api/fulfillment/clone/jobs/${id}/retry`, { method: 'POST', ...init }, id)
const getSettings = (init: Init) => hit(settingsRoute.GET as Handler, '/api/fulfillment/clone/settings', init)
const postSettings = (init: Init) => hit(settingsRoute.POST as Handler, '/api/fulfillment/clone/settings', init)

const claim = (init: Init) => hit(claimRoute.POST as Handler, '/api/clone-worker/claim', init)
const heartbeat = (id: string, init: Init) => hit(heartbeatRoute.POST as Handler, `/api/clone-worker/jobs/${id}/heartbeat`, init, id)
const result = (id: string, init: Init) => hit(resultRoute.POST as Handler, `/api/clone-worker/jobs/${id}/result`, init, id)
const fail = (id: string, init: Init) => hit(failRoute.POST as Handler, `/api/clone-worker/jobs/${id}/fail`, init, id)

const bearer = (token: string) => `Bearer ${token}`

const shopify = { fail: false, skuTaken: false, skus: null as string[] | null, product: true, asked: [] as string[] }

// Every request this suite makes to Shopify lands here: nothing reaches the network, and an unexpected URL fails the test.
function installShopify() {
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (!/^https:\/\/[a-z0-9-]+\.myshopify\.com\/admin\/api\/[\d-]+\/graphql\.json$/.test(url)) throw new Error(`unexpected request to ${url}`)
    const query = String(JSON.parse(String(init?.body)).query)
    shopify.asked.push(query)
    if (query.includes('productVariants')) {
      return answer({ data: { productVariants: { edges: shopify.skuTaken ? [{ node: { id: 'gid://shopify/ProductVariant/1' } }] : [] } } })
    }
    if (shopify.fail) return answer({ errors: `Invalid token ${STORE_TOKEN}` }, 500)
    if (!shopify.product) return answer({ data: { product: null } })
    const nodes = (shopify.skus ?? []).map(sku => ({ sku }))
    return answer({
      data: { product: { status: 'ACTIVE', onlineStoreUrl: ONLINE_URL, handle: 'alice-mug', productType: 'Mug', variants: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } },
    })
  })
}

let n = 0
async function seedJob(over: Partial<{
  storeId: string; status: string; failKind: string | null; requestedById: string; requestedByName: string; sourceUrl: string; skuCode: string
  attempts: number; lockedAt: Date | null; error: string | null; costUsd: number | null; qaNote: string | null; productType: string | null
  productUrl: string | null; stage: string | null
}> = {}) {
  n++
  return prisma.cloneJob.create({
    data: {
      storeId: STORE_A, sourceUrl: `https://shop.example.com/products/p${n}`, sourceKey: `shop.example.com/products/p${n}`,
      skuCode: `ZY26110${String(n).padStart(5, '0')}`, requestedById: ids.sellerA, requestedByName: NAMES.sellerA, ...over,
    },
  })
}

const rowOf = (id: string) => prisma.cloneJob.findUniqueOrThrow({ where: { id } })

async function wipe() {
  await prisma.cloneJob.deleteMany({})
  await prisma.appSetting.deleteMany({ where: { key: { in: [CLONE_SETTINGS_KEY, CLONE_WORKER_TOKEN_KEY, CLONE_WORKER_SEEN_KEY] } } })
}

beforeAll(async () => {
  process.env.AUTH_SECRET ||= 'test-secret-that-is-long-enough-32chars'
  await wipe()
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  await prisma.shopifyStore.deleteMany({ where: { id: { startsWith: `${P}-` } } })
  await makeStore(STORE_A)
  await makeStore(STORE_B)
  await makeStore(STORE_OFF, false)
  await makeUser('super', 'SUPERADMIN', 'ZA', [])
  await makeUser('admin', 'ADMIN', 'ZB', [])
  await makeUser('sellerA', 'SELLER', 'ZD', [STORE_A, STORE_OFF])
  await makeUser('sellerA2', 'SELLER', 'ZE', [STORE_A])
  await makeUser('sellerB', 'SELLER', 'ZF', [STORE_B])
  await makeUser('bare', 'SELLER', null, [STORE_A])
  await makeUser('noperm', 'SELLER', 'ZG', [STORE_A], [])
})

beforeEach(async () => {
  await wipe()
  Object.assign(shopify, { fail: false, skuTaken: false, skus: null, product: true, asked: [] })
  installShopify()
})

afterEach(() => {
  vi.restoreAllMocks()
  notifyCloneQueue()
})

afterAll(async () => {
  await wipe()
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  await prisma.shopifyStore.deleteMany({ where: { id: { startsWith: `${P}-` } } })
})

const RUNNER_ROUTES: Record<string, (init: Init) => ReturnType<typeof out>> = {
  claim: init => claim({ json: { waitSeconds: 0 }, ...init }),
  heartbeat: init => heartbeat('any-job', { json: { attempts: 1 }, ...init }),
  result: init => result('any-job', { json: { attempts: 1, productGid: GID, qaVerdict: 'PASS' }, ...init }),
  fail: init => fail('any-job', { json: { attempts: 1, failKind: 'TOOL', error: 'x' }, ...init }),
}

describe('mọi route', () => {
  it('khai dynamic = force-dynamic', () => {
    const all = [jobsRoute, jobRoute, cancelRoute, retryRoute, settingsRoute, claimRoute, heartbeatRoute, resultRoute, failRoute]
    for (const mod of all) expect(mod.dynamic).toBe('force-dynamic')
  })
})

describe('route runner: token', () => {
  it('không có Bearer hoặc sai Bearer: cả bốn route runner trả 401, không đổi job, không ghi lastSeenAt', async () => {
    const queued = await seedJob()
    const running = await seedJob({ status: 'RUNNING', attempts: 1, lockedAt: new Date('2026-11-06T01:00:00Z'), stage: 'clone' })
    const before = await rowOf(running.id)

    const rounds: { label: string; init: Init }[] = [
      { label: 'không có header', init: {} },
      { label: 'Bearer rỗng', init: { bearer: 'Bearer ' } },
      { label: 'không có chữ Bearer', init: { bearer: 'cqw_nothing-configured' } },
      { label: 'chưa cấu hình token', init: { bearer: bearer('cqw_nothing-configured') } },
    ]
    for (const round of rounds) {
      for (const [name, call] of Object.entries(RUNNER_ROUTES)) {
        const res = await call(round.init)
        expect(res.status, `${name} / ${round.label}`).toBe(401)
        expect(res.body).toEqual({ error: 'Unauthorized' })
      }
    }
    expect(await prisma.appSetting.findUnique({ where: { key: CLONE_WORKER_SEEN_KEY } })).toBeNull()

    const token = await generateCloneWorkerToken()
    const seen = '2026-11-06T00:00:00.000Z'
    await prisma.appSetting.create({ data: { key: CLONE_WORKER_SEEN_KEY, value: seen } })
    const wrong = [bearer(`${token}x`), bearer(token.slice(0, -1)), token, bearer('cqw_wrong'), bearer(`dsw_${token.slice(4)}`)]
    for (const header of wrong) {
      for (const [name, call] of Object.entries(RUNNER_ROUTES)) {
        const res = await call({ bearer: header })
        expect(res.status, `${name} / ${header.slice(0, 12)}`).toBe(401)
        expect(res.text).not.toContain(token)
      }
    }
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: CLONE_WORKER_SEEN_KEY } })).value).toBe(seen)

    const rowQueued = await rowOf(queued.id)
    expect(rowQueued).toMatchObject({ status: 'QUEUED', attempts: 0, lockedAt: null })
    expect(await rowOf(running.id)).toEqual(before)
  })

  it('đúng Bearer: claim đánh dấu máy đã thấy', async () => {
    const token = await generateCloneWorkerToken()
    const res = await claim({ bearer: bearer(token), json: { waitSeconds: 0 } })
    expect(res.status).toBe(200)
    const seen = await prisma.appSetting.findUniqueOrThrow({ where: { key: CLONE_WORKER_SEEN_KEY } })
    expect(seen.value).toMatch(ISO_RE)
  })
})

describe('route settings và token', () => {
  it('mint-token trả token một lần; GET settings sau đó không chứa chuỗi "cqw_"', async () => {
    const minted = await postSettings({ who: 'super', json: { action: 'mint-token' } })
    expect(minted.status).toBe(200)
    expect(Object.keys(minted.body)).toEqual(['token'])
    const token: string = minted.body.token
    expect(token).toMatch(/^cqw_[A-Za-z0-9_-]{43}$/)

    const settings = await getSettings({ who: 'super' })
    expect(settings.status).toBe(200)
    expect(settings.text).not.toContain('cqw_')
    expect(settings.text).not.toContain(token)
    const hash = crypto.createHash('sha256').update(token, 'utf8').digest('hex')
    expect(settings.text).not.toContain(hash)
    expect(settings.text).not.toMatch(/tokenHash/i)
    expect(settings.body).toMatchObject({ paused: false, targets: [], worker: { configured: true, online: false, lastSeenAt: null } })
    expect(settings.body.worker.tokenUpdatedAt).toMatch(ISO_RE)

    expect((await claim({ bearer: bearer(token), json: { waitSeconds: 0 } })).status).toBe(200)

    const second = await postSettings({ who: 'super', json: { action: 'mint-token' } })
    expect(second.body.token).not.toBe(token)
    expect((await claim({ bearer: bearer(token), json: { waitSeconds: 0 } })).status).toBe(401)
  })

  it('revoke-token trả { ok: true } và token cũ hết hiệu lực', async () => {
    const token = (await postSettings({ who: 'super', json: { action: 'mint-token' } })).body.token
    const revoked = await postSettings({ who: 'super', json: { action: 'revoke-token' } })
    expect(revoked).toMatchObject({ status: 200, body: { ok: true } })
    expect(revoked.text).not.toContain(token)
    expect((await claim({ bearer: bearer(token), json: { waitSeconds: 0 } })).status).toBe(401)
    expect((await getSettings({ who: 'super' })).body.worker).toMatchObject({ configured: false, tokenUpdatedAt: null })
  })

  it('ADMIN gọi mint-token bị 403, GET settings cũng 403; seller và người chưa đăng nhập không qua', async () => {
    for (const who of ['admin', 'sellerA', 'noperm'] as Who[]) {
      expect((await postSettings({ who, json: { action: 'mint-token' } })).status, who).toBe(403)
      expect((await postSettings({ who, json: { action: 'revoke-token' } })).status, who).toBe(403)
      expect((await postSettings({ who, json: { paused: true } })).status, who).toBe(403)
      expect((await getSettings({ who })).status, who).toBe(403)
    }
    expect((await postSettings({ json: { action: 'mint-token' } })).status).toBe(401)
    expect((await getSettings({})).status).toBe(401)
    expect(await prisma.appSetting.findUnique({ where: { key: CLONE_WORKER_TOKEN_KEY } })).toBeNull()
    expect(await prisma.appSetting.findUnique({ where: { key: CLONE_SETTINGS_KEY } })).toBeNull()
  })

  it('quyền kiểm theo cơ sở dữ liệu, không theo cookie: cookie ghi SUPERADMIN của người đã là ADMIN bị 403', async () => {
    const stale = `${AUTH_COOKIE}=${await signToken({ userId: ids.admin, email: EMAILS[1], name: NAMES.admin, role: 'SUPERADMIN', permissions: [], tv: 0 })}`
    expect((await postSettings({ cookie: stale, json: { action: 'mint-token' } })).status).toBe(403)
    expect((await getSettings({ cookie: stale })).status).toBe(403)
    expect(await prisma.appSetting.findUnique({ where: { key: CLONE_WORKER_TOKEN_KEY } })).toBeNull()
  })

  it('GET settings trả { paused, targets, worker }; POST lưu paused và targets', async () => {
    const first = await getSettings({ who: 'super' })
    expect(first.body).toEqual({ paused: false, targets: [], worker: { configured: false, tokenUpdatedAt: null, lastSeenAt: null, online: false } })

    const saved = await postSettings({ who: 'super', json: { paused: true, targets: ['customily:REMI', 'customall:LITZ'] } })
    expect(saved).toMatchObject({ status: 200, body: { paused: true, targets: ['customily:REMI', 'customall:LITZ'] } })
    expect(Object.keys(saved.body).sort()).toEqual(['paused', 'targets'])
    expect((await getSettings({ who: 'super' })).body).toMatchObject({ paused: true, targets: ['customily:REMI', 'customall:LITZ'] })

    const partial = await postSettings({ who: 'super', json: { paused: false } })
    expect(partial.body).toEqual({ paused: false, targets: ['customily:REMI', 'customall:LITZ'] })
  })

  it('giá trị sai: 400 với câu của lib, không lưu gì; action lạ: 400', async () => {
    const cases: { init: Init; error: string }[] = [
      { init: { json: { paused: 'yes' } }, error: 'Giá trị tạm dừng không hợp lệ.' },
      { init: { json: { targets: ['not-a-target'] } }, error: 'Danh sách nền tảng và store không hợp lệ.' },
      { init: { json: [] }, error: 'Cài đặt không hợp lệ.' },
      { init: { raw: 'not json' }, error: 'Cài đặt không hợp lệ.' },
      { init: { raw: '"mint-token"' }, error: 'Cài đặt không hợp lệ.' },
      { init: { json: { action: 'mint-tokens' } }, error: BAD_REQUEST },
      { init: { json: { action: 7, paused: true } }, error: BAD_REQUEST },
    ]
    for (const c of cases) {
      const res = await postSettings({ who: 'super', ...c.init })
      expect(res, JSON.stringify(c.init)).toMatchObject({ status: 400, body: { error: c.error } })
    }
    expect(await prisma.appSetting.findUnique({ where: { key: CLONE_SETTINGS_KEY } })).toBeNull()
    expect(await prisma.appSetting.findUnique({ where: { key: CLONE_WORKER_TOKEN_KEY } })).toBeNull()
  })
})

describe('tạo job', () => {
  it('seller POST job cho store của mình: 201, cho store khác hay store tắt: 403', async () => {
    const ok = await createJob({ who: 'sellerA', json: { url: 'https://Shop.Example.com/products/abc?utm=1', storeId: STORE_A } })
    expect(ok.status).toBe(201)
    expect(Object.keys(ok.body)).toEqual(['job'])
    expect(ok.body.job).toMatchObject({
      storeId: STORE_A, sourceUrl: 'https://shop.example.com/products/abc', status: 'QUEUED', requestedById: ids.sellerA, requestedByName: NAMES.sellerA,
      attempts: 0, reused: false,
    })
    expect(ok.body.job.skuCode).toMatch(/^ZD\d{10}$/)
    expect(ok.body.job.createdAt).toMatch(ISO_RE)
    for (const key of ['costUsd', 'durationMs', 'lockedAt', 'qaNote', 'productType', 'sourceUrlRaw']) expect(ok.body.job).not.toHaveProperty(key)

    const other = await createJob({ who: 'sellerA', json: { url: 'https://shop.example.com/products/other', storeId: STORE_B } })
    expect(other).toMatchObject({ status: 403, body: { error: 'Bạn không có quyền xem store này.' } })
    const off = await createJob({ who: 'sellerA', json: { url: 'https://shop.example.com/products/other', storeId: STORE_OFF } })
    expect(off.status).toBe(403)
    expect(await prisma.cloneJob.count()).toBe(1)
  })

  it('SUPERADMIN tạo cho store nào cũng được và thấy cả số liệu riêng; seller gửi force bị bỏ qua', async () => {
    const link = { url: 'https://shop.example.com/products/force', storeId: STORE_A }
    const mine = await createJob({ who: 'sellerA', json: link })
    expect(mine.status).toBe(201)
    const again = await createJob({ who: 'sellerA', json: { ...link, force: true } })
    expect(again).toMatchObject({ status: 409, body: { error: 'Bạn đã dán link này rồi.', jobId: mine.body.job.id } })
    const forced = await createJob({ who: 'super', json: { ...link, force: true } })
    expect(forced.status).toBe(201)
    expect(forced.body.job).toHaveProperty('costUsd', null)
    expect(forced.body.job).toHaveProperty('force', true)
    expect(forced.body.job.skuCode).toMatch(/^ZA\d{10}$/)
    expect(mine.body.job).not.toHaveProperty('force')
    expect((await rowOf(mine.body.job.id)).force).toBe(false)
  })

  it('job SUPERADMIN ép clone lại: claim mang force: true; seller gửi force: true thì job ghi false', async () => {
    const token = await generateCloneWorkerToken()
    const forced = await createJob({ who: 'super', json: { url: 'https://shop.example.com/products/forced', storeId: STORE_A, force: true } })
    const plain = await createJob({ who: 'sellerA', json: { url: 'https://shop.example.com/products/plain', storeId: STORE_A, force: true } })
    expect(plain.status).toBe(201)
    expect((await rowOf(plain.body.job.id)).force).toBe(false)

    const first = await claim({ bearer: bearer(token), json: { waitSeconds: 0 } })
    expect(first.body.job).toMatchObject({ id: forced.body.job.id, force: true })
    await fail(forced.body.job.id, { bearer: bearer(token), json: { attempts: 1, failKind: 'TOOL', error: 'x' } })
    const second = await claim({ bearer: bearer(token), json: { waitSeconds: 0 } })
    expect(second.body.job).toMatchObject({ id: plain.body.job.id, force: false })
  })

  it('lỗi của lib đi qua nguyên văn: link sai 400, trùng link đã xong 409 kèm productUrl, thiếu mã SKU 2 chữ cái 400', async () => {
    const bad = await createJob({ who: 'sellerA', json: { url: 'http://localhost/x', storeId: STORE_A } })
    expect(bad).toMatchObject({ status: 400, body: { error: 'Link không hợp lệ.' } })

    await seedJob({ requestedById: ids.sellerA2, requestedByName: NAMES.sellerA2, status: 'DONE', sourceUrl: 'https://shop.example.com/products/done', productUrl: ONLINE_URL })
    await prisma.cloneJob.updateMany({ data: { sourceKey: 'shop.example.com/products/done' } })
    const dup = await createJob({ who: 'sellerA', json: { url: 'https://shop.example.com/products/done', storeId: STORE_A } })
    expect(dup).toMatchObject({ status: 409, body: { error: 'Link này đã có sản phẩm trên store.', productUrl: ONLINE_URL } })

    const bare = await createJob({ who: 'bare', json: { url: 'https://shop.example.com/products/bare', storeId: STORE_A } })
    expect(bare.status).toBe(400)
    expect(bare.body.error).toMatch(/SKU/)
  })

  it('thân không phải object JSON: 400 { error: "Yêu cầu không hợp lệ." }, không tạo job', async () => {
    const bodies: Init[] = [{ raw: 'not json' }, { raw: '[]' }, { raw: '"str"' }, { raw: 'null' }, { raw: '7' }, { raw: '' }]
    for (const init of bodies) {
      const res = await createJob({ who: 'sellerA', method: 'POST', ...init })
      expect(res, JSON.stringify(init)).toMatchObject({ status: 400, body: { error: BAD_REQUEST } })
    }
    expect(await prisma.cloneJob.count()).toBe(0)
  })

  it('không đăng nhập 401; tài khoản không có quyền fulfillment_clone 403; không tạo job', async () => {
    const json = { url: 'https://shop.example.com/products/anon', storeId: STORE_A }
    expect((await createJob({ json })).status).toBe(401)
    expect((await createJob({ who: 'noperm', json })).status).toBe(403)
    expect((await listJobs({})).status).toBe(401)
    expect((await listJobs({ who: 'noperm' })).status).toBe(403)
    expect(await prisma.cloneJob.count()).toBe(0)
  })

  it('SKU đã có trên Shopify mọi lần thử: 503 với câu cố định; lỗi lạ: 500 "Lỗi máy chủ." và chi tiết chỉ nằm trong log', async () => {
    shopify.skuTaken = true
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const gaveUp = await createJob({ who: 'sellerA', json: { url: 'https://shop.example.com/products/taken', storeId: STORE_A } })
    expect(gaveUp).toMatchObject({ status: 503, body: { error: 'Không cấp được mã SKU, thử lại sau.' } })

    shopify.skuTaken = false
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(prisma.cloneJob, 'create').mockRejectedValueOnce(new Error(SECRET_ERROR))
    const broken = await createJob({ who: 'sellerA', json: { url: 'https://shop.example.com/products/broken', storeId: STORE_A } })
    expect(broken).toMatchObject({ status: 500, body: { error: SERVER_ERROR } })
    expect(broken.text).not.toContain('SQLITE')
    expect(broken.text).not.toContain(STORE_TOKEN)
    expect(logged.mock.calls.flat().some(x => x instanceof Error && x.message === SECRET_ERROR)).toBe(true)
    expect(await prisma.cloneJob.count()).toBe(0)
  })
})

describe('xem, huỷ, thử lại', () => {
  it('GET jobs của seller không chứa job, tên, mã của seller khác', async () => {
    const mine = await seedJob({ requestedByName: NAMES.sellerA, sourceUrl: 'https://mine.example.com/p/mine' })
    const sameStore = await seedJob({
      requestedById: ids.sellerA2, requestedByName: NAMES.sellerA2, sourceUrl: 'https://colleague.example.com/p/colleague-secret', skuCode: 'ZE2611000002',
    })
    const otherStore = await seedJob({
      storeId: STORE_B, requestedById: ids.sellerB, requestedByName: NAMES.sellerB, sourceUrl: 'https://rival.example.com/p/rival-secret', skuCode: 'ZF2611000003',
    })

    const res = await listJobs({ who: 'sellerA' })
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(['hasSkuPrefix', 'jobs', 'paused', 'stores', 'worker'])
    expect(res.body.jobs.map((j: { id: string }) => j.id)).toEqual([mine.id])
    for (const marker of [
      NAMES.sellerA2, NAMES.sellerB, 'ZE2611000002', 'ZF2611000003', 'colleague-secret', 'rival-secret', sameStore.id, otherStore.id, STORE_B, `${STORE_B}.myshopify.com`,
    ]) {
      expect(res.text, marker).not.toContain(marker)
    }
    expect(res.body.stores).toEqual([{ id: STORE_A, shop: `${STORE_A}.myshopify.com`, orderPrefix: 'A' }])
    expect(res.body).toMatchObject({ hasSkuPrefix: true, paused: false, worker: { online: false, lastSeenAt: null } })
  })

  it('seller không thấy chi phí, khoá thuê, ghi chú QA, loại sản phẩm, lỗi do runner ghi; SUPERADMIN thấy; ADMIN thấy job của mọi người nhưng không thấy số riêng', async () => {
    const failed = await seedJob({
      status: 'FAILED', failKind: 'TOOL', error: 'crash at C:\\Users\\owner\\tools\\clone.py', costUsd: 1.25, qaNote: 'note-xyz', productType: 'Mug',
      lockedAt: new Date('2026-11-06T01:00:00Z'),
    })
    await seedJob({ requestedById: ids.sellerA2, requestedByName: NAMES.sellerA2 })

    const seller = await listJobs({ who: 'sellerA' })
    expect(seller.body.jobs).toHaveLength(1)
    for (const key of ['costUsd', 'durationMs', 'lockedAt', 'qaNote', 'productType']) expect(seller.body.jobs[0]).not.toHaveProperty(key)
    expect(seller.body.jobs[0].error).toBeNull()
    for (const secret of ['crash at', 'C:\\\\Users', 'note-xyz', '1.25']) expect(seller.text).not.toContain(secret)

    const admin = await listJobs({ who: 'admin' })
    expect(admin.body.jobs).toHaveLength(2)
    expect(admin.body.jobs.find((j: { id: string }) => j.id === failed.id)).not.toHaveProperty('costUsd')
    expect(admin.text).not.toContain('note-xyz')

    const owner = await listJobs({ who: 'super' })
    expect(owner.body.jobs).toHaveLength(2)
    expect(owner.body.jobs.find((j: { id: string }) => j.id === failed.id)).toMatchObject({
      costUsd: 1.25, qaNote: 'note-xyz', productType: 'Mug', error: 'crash at C:\\Users\\owner\\tools\\clone.py',
    })
  })

  it('stores: chỉ store đang kết nối trong phạm vi người gọi; hasSkuPrefix, paused và worker theo trạng thái thật', async () => {
    const staff = await listJobs({ who: 'super' })
    const mine = staff.body.stores.filter((s: { id: string }) => s.id.startsWith(P))
    expect(mine).toEqual([
      { id: STORE_A, shop: `${STORE_A}.myshopify.com`, orderPrefix: 'A' },
      { id: STORE_B, shop: `${STORE_B}.myshopify.com`, orderPrefix: 'B' },
    ])
    expect(staff.text).not.toContain(STORE_TOKEN)
    expect((await listJobs({ who: 'sellerB' })).body.stores).toEqual([{ id: STORE_B, shop: `${STORE_B}.myshopify.com`, orderPrefix: 'B' }])

    expect((await listJobs({ who: 'bare' })).body.hasSkuPrefix).toBe(false)
    expect((await listJobs({ who: 'sellerA' })).body.hasSkuPrefix).toBe(true)

    await saveCloneSettings({ paused: true })
    const token = await generateCloneWorkerToken()
    await claim({ bearer: bearer(token), json: { waitSeconds: 0 } })
    const res = await listJobs({ who: 'sellerA' })
    expect(res.body.paused).toBe(true)
    expect(Object.keys(res.body.worker).sort()).toEqual(['lastSeenAt', 'online'])
    expect(res.body.worker).toEqual({ online: true, lastSeenAt: expect.stringMatching(ISO_RE) })
    expect(res.text).not.toContain('configured')
    expect(res.text).not.toContain('tokenUpdatedAt')
  })

  it('GET job: người tạo thấy; seller khác, seller store khác và id lạ đều 404', async () => {
    const job = await seedJob()
    const own = await getJob(job.id, { who: 'sellerA' })
    expect(own.status).toBe(200)
    expect(Object.keys(own.body)).toEqual(['job'])
    expect(own.body.job).toMatchObject({ id: job.id, status: 'QUEUED' })
    expect(own.body.job).not.toHaveProperty('costUsd')
    expect((await getJob(job.id, { who: 'super' })).body.job).toHaveProperty('costUsd')
    for (const who of ['sellerA2', 'sellerB'] as Who[]) {
      expect(await getJob(job.id, { who }), who).toMatchObject({ status: 404, body: { error: NOT_FOUND } })
    }
    expect(await getJob('nope', { who: 'sellerA' })).toMatchObject({ status: 404, body: { error: NOT_FOUND } })
    expect((await getJob(job.id, {})).status).toBe(401)
    expect((await getJob(job.id, { who: 'noperm' })).status).toBe(403)
  })

  it('cancel: người tạo huỷ job đang chờ; người khác 404; job không còn chờ 409; SUPERADMIN huỷ được job của người khác', async () => {
    const job = await seedJob()
    expect(await cancelJob(job.id, { who: 'sellerA2' })).toMatchObject({ status: 404, body: { error: NOT_FOUND } })
    expect(await cancelJob(job.id, { who: 'sellerB' })).toMatchObject({ status: 404 })
    expect((await cancelJob(job.id, {})).status).toBe(401)
    expect((await rowOf(job.id)).status).toBe('QUEUED')

    const done = await cancelJob(job.id, { who: 'sellerA' })
    expect(done.status).toBe(200)
    expect(done.body.job).toMatchObject({ id: job.id, status: 'CANCELLED' })
    expect(done.body.job).not.toHaveProperty('costUsd')
    expect(await cancelJob(job.id, { who: 'sellerA' })).toMatchObject({ status: 409, body: { error: 'Chỉ huỷ được job đang chờ.' } })

    const other = await seedJob()
    const byOwner = await cancelJob(other.id, { who: 'super' })
    expect(byOwner).toMatchObject({ status: 200, body: { job: { status: 'CANCELLED' } } })
    expect(byOwner.body.job).toHaveProperty('costUsd')
  })

  it('retry: chỉ job FAILED, giữ nguyên mã SKU; lỗi cần quản trị: seller 403, SUPERADMIN qua; job khác trạng thái 409', async () => {
    const failed = await seedJob({ status: 'FAILED', failKind: 'TOOL', error: 'boom', attempts: 2 })
    const retried = await retryJob(failed.id, { who: 'sellerA' })
    expect(retried.status).toBe(200)
    expect(retried.body.job).toMatchObject({ id: failed.id, status: 'QUEUED', attempts: 0, skuCode: failed.skuCode, error: null })
    expect(await retryJob(failed.id, { who: 'sellerA' })).toMatchObject({ status: 409, body: { error: 'Chỉ thử lại được job lỗi.' } })

    const gap = await seedJob({ status: 'FAILED', failKind: 'TOOL_GAP', error: 'missing' })
    expect(await retryJob(gap.id, { who: 'sellerA' })).toMatchObject({ status: 403, body: { error: 'Job này cần quản trị xử lý trước khi thử lại.' } })
    expect((await rowOf(gap.id)).status).toBe('FAILED')
    expect(await retryJob(gap.id, { who: 'super' })).toMatchObject({ status: 200, body: { job: { status: 'QUEUED' } } })

    const colleague = await seedJob({ status: 'FAILED', failKind: 'TOOL', requestedById: ids.sellerA2, requestedByName: NAMES.sellerA2 })
    expect(await retryJob(colleague.id, { who: 'sellerA' })).toMatchObject({ status: 404 })
    expect((await retryJob(failed.id, {})).status).toBe(401)
  })
})

describe('route runner: thân yêu cầu', () => {
  const badBodies: Init[] = [{ raw: 'not json' }, { raw: '[]' }, { raw: '"str"' }, { raw: 'null' }, { raw: '7' }, { raw: '' }]

  it('thân không phải object JSON: 400 ở cả bốn route, job không đổi', async () => {
    const token = await generateCloneWorkerToken()
    const queued = await seedJob()
    const running = await seedJob({ status: 'RUNNING', attempts: 1, lockedAt: new Date('2026-11-06T01:00:00Z') })
    const before = await rowOf(running.id)
    const calls: [string, (init: Init) => ReturnType<typeof out>][] = [
      ['claim', init => claim(init)],
      ['heartbeat', init => heartbeat(running.id, init)],
      ['result', init => result(running.id, init)],
      ['fail', init => fail(running.id, init)],
    ]
    for (const [name, call] of calls) {
      for (const body of badBodies) {
        const res = await call({ bearer: bearer(token), method: 'POST', ...body })
        expect(res, `${name} ${JSON.stringify(body)}`).toMatchObject({ status: 400, body: { error: BAD_REQUEST } })
      }
    }
    expect(await rowOf(running.id)).toEqual(before)
    expect((await rowOf(queued.id)).status).toBe('QUEUED')
  })

  it('attempts phải là số nguyên dương ở heartbeat, result và fail: thiếu, 0, âm, lẻ, chuỗi, null, true, quá lớn đều 400', async () => {
    const token = await generateCloneWorkerToken()
    const running = await seedJob({ status: 'RUNNING', attempts: 1, lockedAt: new Date('2026-11-06T01:00:00Z') })
    const before = await rowOf(running.id)
    const full = { productGid: GID, qaVerdict: 'PASS', failKind: 'TOOL', error: 'x' }
    const values: unknown[] = [undefined, 0, -1, 1.5, '1', null, true, [1], { n: 1 }, 2 ** 60]
    const calls: [string, (json: unknown) => ReturnType<typeof out>][] = [
      ['heartbeat', json => heartbeat(running.id, { bearer: bearer(token), json })],
      ['result', json => result(running.id, { bearer: bearer(token), json })],
      ['fail', json => fail(running.id, { bearer: bearer(token), json })],
    ]
    for (const [name, call] of calls) {
      for (const attempts of values) {
        const res = await call({ ...full, ...(attempts === undefined ? {} : { attempts }) })
        expect(res, `${name} attempts=${JSON.stringify(attempts)}`).toMatchObject({ status: 400, body: { error: BAD_REQUEST } })
      }
    }
    expect(await rowOf(running.id)).toEqual(before)
  })

  it('attempts lớn hơn 32 bit là số nguyên hợp lệ: không job nào khớp, không lỗi máy chủ', async () => {
    const token = await generateCloneWorkerToken()
    const running = await seedJob({ status: 'RUNNING', attempts: 1, lockedAt: new Date('2026-11-06T01:00:00Z') })
    const json = { attempts: 2 ** 40, productGid: GID, qaVerdict: 'PASS', failKind: 'TOOL', error: 'x' }
    expect(await heartbeat(running.id, { bearer: bearer(token), json })).toMatchObject({ status: 200, body: { ok: false, cancelled: false } })
    expect((await result(running.id, { bearer: bearer(token), json })).status).toBe(404)
    expect((await fail(running.id, { bearer: bearer(token), json })).status).toBe(404)
    expect((await rowOf(running.id)).status).toBe('RUNNING')
  })

  it('claim: waitSeconds không phải số thì không chờ; hàng chờ rỗng trả { job: null, paused: false }', async () => {
    const token = await generateCloneWorkerToken()
    const started = Date.now()
    for (const waitSeconds of ['25', null, undefined, -3, 'x']) {
      const res = await claim({ bearer: bearer(token), json: { waitSeconds } })
      expect(res).toMatchObject({ status: 200, body: { job: null, paused: false } })
    }
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('claim khi đang tạm dừng: { job: null, paused: true } và job vẫn QUEUED', async () => {
    const token = await generateCloneWorkerToken()
    const job = await seedJob()
    await saveCloneSettings({ paused: true })
    expect(await claim({ bearer: bearer(token), json: { waitSeconds: 0 } })).toMatchObject({ status: 200, body: { job: null, paused: true } })
    expect((await rowOf(job.id)).status).toBe('QUEUED')
  })
})

describe('luồng của runner', () => {
  it('claim giữ kết nối: job dán qua POST jobs sau ~150 ms được trả ngay trong lần claim đó, dưới 2 giây', async () => {
    const token = await generateCloneWorkerToken()
    const started = Date.now()
    const pending = claim({ bearer: bearer(token), json: { waitSeconds: 2 } })
    await new Promise(r => setTimeout(r, 150))
    const created = await createJob({ who: 'sellerA', json: { url: 'https://shop.example.com/products/held', storeId: STORE_A } })
    expect(created.status).toBe(201)
    const held = await pending
    expect(Date.now() - started).toBeLessThan(2000)
    expect(held.status).toBe(200)
    expect(held.body).toMatchObject({ job: { id: created.body.job.id, attempts: 1 }, paused: false })
  })

  it('claim → heartbeat → result với Shopify giả: job DONE và GET jobs của người dán thấy productUrl', async () => {
    const created = await createJob({ who: 'sellerA', json: { url: 'https://shop.example.com/products/flow', storeId: STORE_A } })
    expect(created.status).toBe(201)
    const id: string = created.body.job.id
    const skuCode: string = created.body.job.skuCode
    await saveCloneSettings({ targets: ['customily:REMI'] })
    const token = (await postSettings({ who: 'super', json: { action: 'mint-token' } })).body.token
    const auth = bearer(token)
    const seen: string[] = []

    const claimed = await claim({ bearer: auth, json: { waitSeconds: 0 } })
    seen.push(claimed.text)
    expect(claimed.status).toBe(200)
    expect(claimed.body).toEqual({
      job: {
        id, sourceUrl: 'https://shop.example.com/products/flow', skuCode, attempts: 1, requestedByName: NAMES.sellerA,
        store: { id: STORE_A, orderPrefix: 'A', shop: `${STORE_A}.myshopify.com` }, targets: ['customily:REMI'], force: false,
      },
      paused: false,
    })
    expect(await claim({ bearer: auth, json: { waitSeconds: 0 } })).toMatchObject({ body: { job: null, paused: false } })

    const beat = await heartbeat(id, { bearer: auth, json: { attempts: 1, stage: 'clone', platform: 'customily' } })
    seen.push(beat.text)
    expect(beat).toMatchObject({ status: 200, body: { ok: true, cancelled: false } })
    expect(await rowOf(id)).toMatchObject({ status: 'RUNNING', stage: 'clone', platform: 'customily' })
    expect((await heartbeat(id, { bearer: auth, json: { attempts: 2 } })).body).toEqual({ ok: false, cancelled: false })

    shopify.skus = [skuCode, `${skuCode}-S`, `${skuCode}-M`]
    const done = await result(id, {
      bearer: auth,
      json: { attempts: 1, productGid: GID, handle: 'ignored-by-server', qaVerdict: 'PASS', qaNote: 'looks right', costUsd: 0.42, durationMs: 61000 },
    })
    seen.push(done.text)
    expect(done).toMatchObject({ status: 200, body: { status: 'DONE' } })
    expect(await rowOf(id)).toMatchObject({ status: 'DONE', productUrl: ONLINE_URL, handle: 'alice-mug', productType: 'Mug', productGid: GID, lockedAt: null })

    const list = await listJobs({ who: 'sellerA' })
    seen.push(list.text)
    expect(list.body.jobs).toHaveLength(1)
    expect(list.body.jobs[0]).toMatchObject({ id, status: 'DONE', productUrl: ONLINE_URL, handle: 'alice-mug', qaVerdict: 'PASS', error: null })
    expect(list.body.jobs[0]).not.toHaveProperty('costUsd')
    expect((await getJob(id, { who: 'sellerA' })).body.job).toMatchObject({ status: 'DONE', productUrl: ONLINE_URL })
    expect((await listJobs({ who: 'super' })).body.jobs[0]).toMatchObject({ costUsd: 0.42, qaNote: 'looks right', productType: 'Mug' })

    const hash = crypto.createHash('sha256').update(token, 'utf8').digest('hex')
    for (const text of seen) {
      expect(text).not.toContain(token)
      expect(text).not.toContain(hash)
      expect(text).not.toContain(STORE_TOKEN)
      expect(text).not.toContain('cqw_')
    }
    expect(shopify.asked.some(q => q.includes('product(id'))).toBe(true)
  })

  it('result khi Shopify lỗi: 502 và job vẫn RUNNING; gửi lại khi Shopify trả lời được thì DONE', async () => {
    const token = await generateCloneWorkerToken()
    const job = await seedJob()
    const { body: claimed } = await claim({ bearer: bearer(token), json: { waitSeconds: 0 } })
    expect(claimed.job.id).toBe(job.id)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    shopify.fail = true
    const down = await result(job.id, { bearer: bearer(token), json: { attempts: 1, productGid: GID, qaVerdict: 'PASS' } })
    expect(down).toMatchObject({ status: 502, body: { error: 'Chưa hỏi được Shopify, gửi lại kết quả sau.' } })
    expect(down.text).not.toContain(STORE_TOKEN)
    expect(await rowOf(job.id)).toMatchObject({ status: 'RUNNING', productUrl: null, finishedAt: null })

    shopify.fail = false
    shopify.skus = [job.skuCode]
    const again = await result(job.id, { bearer: bearer(token), json: { attempts: 1, productGid: GID, qaVerdict: 'PASS' } })
    expect(again).toMatchObject({ status: 200, body: { status: 'DONE' } })
    expect((await rowOf(job.id)).status).toBe('DONE')
  })

  it('result: lib trả null → 404; QA không đạt → 200 FAILED với câu cố định; Shopify thiếu sản phẩm → FAILED/VERIFY; SKU lạ → FAILED/VERIFY', async () => {
    const token = await generateCloneWorkerToken()
    const auth = bearer(token)
    expect(await result('no-such-job', { bearer: auth, json: { attempts: 1, productGid: GID, qaVerdict: 'PASS' } })).toMatchObject({ status: 404, body: { error: NOT_FOUND } })

    const first = await seedJob()
    expect((await claim({ bearer: auth, json: { waitSeconds: 0 } })).body.job.id).toBe(first.id)
    expect(await result(first.id, { bearer: auth, json: { attempts: 9, productGid: GID, qaVerdict: 'PASS' } })).toMatchObject({ status: 404, body: { error: NOT_FOUND } })
    const qa = await result(first.id, { bearer: auth, json: { attempts: 1, productGid: GID, qaVerdict: 'FAIL', qaNote: 'colour is off' } })
    expect(qa).toEqual({ status: 200, body: { status: 'FAILED', error: 'QA không đạt.' }, text: expect.any(String) })
    expect(await rowOf(first.id)).toMatchObject({ status: 'FAILED', failKind: 'QA' })
    expect(await result(first.id, { bearer: auth, json: { attempts: 1, productGid: GID, qaVerdict: 'PASS' } })).toMatchObject({ status: 404 })

    const second = await seedJob()
    expect((await claim({ bearer: auth, json: { waitSeconds: 0 } })).body.job.id).toBe(second.id)
    shopify.product = false
    expect(await result(second.id, { bearer: auth, json: { attempts: 1, productGid: GID, qaVerdict: 'PASS' } })).toMatchObject({
      status: 200, body: { status: 'FAILED', error: 'Sản phẩm không có trên store.' },
    })
    expect(await rowOf(second.id)).toMatchObject({ status: 'FAILED', failKind: 'VERIFY' })

    const third = await seedJob()
    expect((await claim({ bearer: auth, json: { waitSeconds: 0 } })).body.job.id).toBe(third.id)
    shopify.product = true
    shopify.skus = [third.skuCode, 'COMPETITOR-SKU']
    expect(await result(third.id, { bearer: auth, json: { attempts: 1, productGid: GID, qaVerdict: 'PASS' } })).toMatchObject({
      status: 200, body: { status: 'FAILED', error: 'Còn variant mang SKU khác mã đã cấp.' },
    })
    expect(await rowOf(third.id)).toMatchObject({ status: 'FAILED', failKind: 'VERIFY', productUrl: null })
  })

  it('fail: job đang chạy → 200 { status }; retryable còn lượt → QUEUED; sai attempts hoặc id lạ → 404', async () => {
    const token = await generateCloneWorkerToken()
    const auth = bearer(token)
    const job = await seedJob()
    expect((await claim({ bearer: auth, json: { waitSeconds: 0 } })).body.job.id).toBe(job.id)

    expect(await fail(job.id, { bearer: auth, json: { attempts: 5, failKind: 'TOOL', error: 'x' } })).toMatchObject({ status: 404, body: { error: NOT_FOUND } })
    expect(await fail('no-such-job', { bearer: auth, json: { attempts: 1, failKind: 'TOOL', error: 'x' } })).toMatchObject({ status: 404, body: { error: NOT_FOUND } })

    const again = await fail(job.id, { bearer: auth, json: { attempts: 1, failKind: 'SOURCE', error: 'page gone', retryable: true } })
    expect(again).toEqual({ status: 200, body: { status: 'QUEUED' }, text: expect.any(String) })
    expect(await rowOf(job.id)).toMatchObject({ status: 'QUEUED', lockedAt: null })

    expect((await claim({ bearer: auth, json: { waitSeconds: 0 } })).body.job).toMatchObject({ id: job.id, attempts: 2 })
    const last = await fail(job.id, { bearer: auth, json: { attempts: 2, failKind: 'UNSUPPORTED', error: 'no personaliser', retryable: true, productGid: GID } })
    expect(last).toEqual({ status: 200, body: { status: 'FAILED' }, text: expect.any(String) })
    expect(await rowOf(job.id)).toMatchObject({ status: 'FAILED', failKind: 'UNSUPPORTED', error: 'no personaliser', productGid: GID })
    expect((await listJobs({ who: 'sellerA' })).body.jobs[0].error).toBeNull()
  })

  it('heartbeat báo job đã bị huỷ: { ok: false, cancelled: true }', async () => {
    const token = await generateCloneWorkerToken()
    const job = await seedJob({ status: 'CANCELLED' })
    expect(await heartbeat(job.id, { bearer: bearer(token), json: { attempts: 1 } })).toMatchObject({ status: 200, body: { ok: false, cancelled: true } })
    expect(await heartbeat('no-such-job', { bearer: bearer(token), json: { attempts: 1 } })).toMatchObject({ status: 200, body: { ok: false, cancelled: false } })
  })
})
