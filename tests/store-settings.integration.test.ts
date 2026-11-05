import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'

const mocks = vi.hoisted(() => ({
  parcelpanel: vi.fn(async (_p: { apiKey: string; storeId?: string }) => ({ ordersChecked: 0, shipmentsUpdated: 0, delivered: 0, errors: [] as string[] })),
}))
vi.mock('@/lib/tracking/parcelpanel-sync', () => ({ syncParcelPanelTracking: mocks.parcelpanel }))

import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { signBody } from '@/lib/pgprints'
import { LITZZY_SHOP, isLitzzyStore } from '@/lib/shopify-shop'
import { saveStoreCredential } from '@/lib/store-connections'
import { StoreJobSkipped } from '@/lib/store-jobs'
import { getStoreSetting, setStoreSetting, storeSettingRowKey, isLitzzyStoreId } from '@/lib/store-settings'
import { PGPRINTS_KEYS, credentialsOf, getPgprintsSettings, pushSwitchAfter } from '@/lib/pgprints-settings'
import { setCsvLocked } from '@/lib/csv-lock'
import { buildPush, cancelPush, pushOrder, refreshPush, syncPgprintsTracking } from '@/lib/repos/pgprints-push'
import { IMPORT_WAIT, buildMerchizePush, pushMerchizeOrder } from '@/lib/repos/merchize-push'
import { merchizeCredentials } from '@/lib/merchize'
import { getParcelPanelApiKey, setParcelPanelApiKey, PARCELPANEL_KEY_SETTING } from '@/lib/tracking/parcelpanel-config'
import { syncParcelPanelForStore } from '@/lib/tracking/parcelpanel-store-sync'
import { runDailyParcelPanelSync } from '@/lib/tracking/parcelpanel-scheduler'
import { handoffStateFor } from '@/lib/supplier-handoff'
import { POST as postTracking } from '@/app/api/public/pgprints/tracking/route'
import { POST as postExport } from '@/app/api/fulfillment/export/route'
import { POST as postParcelSync } from '@/app/api/fulfillment/tracking/parcelpanel-sync/route'
import { GET as getSettings, PUT as putSettings } from '@/app/api/stores/[id]/settings/route'

const SHOP_R = 't15-reminiso.myshopify.com'
const SHOP_X = 't15-nokey.myshopify.com'
const PROJECT_L = 'proj_t15_l'
const PROJECT_R = 'proj_t15_r'
const PROJECT_X = 'proj_t15_x'
const PG_SUP = 'sup_t15_pg'
const MZ_SUP = 'sup_t15_mz'
const OTHER_SUP = 'sup_t15_other'
const SUPPLIER_IDS = [PG_SUP, MZ_SUP, OTHER_SUP]
const G = { storeId: 'g-store-id-111111', secretKey: 'g-secret-key-0123456789', shipClass: 'US Economy' }
const R = { storeId: 'r-store-id-222222', secretKey: 'r-secret-key-9876543210', shipClass: 'US Express' }
const MZ_SERVER = { url: 'https://bo-group-1-1.merchize.com/server/bo-api', token: 'mz-server-token-aaaa' }
const MZ_STORE = { url: 'https://bo-group-2-1.merchize.com/reminiso/bo-api', token: 'mz-reminiso-token-bbbbbb' }
const APP_URL = 'https://tool.shop-example.com'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)])
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't15-storage-'))
const GLOBAL_ROWS = [...Object.values(PGPRINTS_KEYS), PARCELPANEL_KEY_SETTING]
const EMAILS = ['t15-admin@test.local', 't15-super@test.local']
const KNOWN_SECRETS = [
  G.secretKey, G.storeId, R.secretKey, R.storeId, MZ_SERVER.token, MZ_STORE.token,
  'reminiso-pp-key-222222', 'nokey-pp-key-333333', 'shared-pp-key-111111', 'overwrite-attempt-00000', 'overwrite-attempt-11111',
]

let litzzy = ''
let reminiso = ''
let nokey = ''
let adminToken = ''
let superToken = ''
let seq = 0
let pgTemplateId = ''
let otherTemplateId = ''
let originalEnv: Record<string, string | undefined> = {}

type Call = { url: URL; path: string; method: string; headers: Record<string, string>; body: string }
let calls: Call[] = []
let handler: (call: Call) => { status: number; json: unknown } | Promise<{ status: number; json: unknown }>

const pgCalls = (part: string) => calls.filter(c => c.url.origin === 'https://app.pgprints.io' && c.path.includes(part))
const created = (call: Call) => {
  const body = JSON.parse(call.body)
  return { status: 200, json: { success: true, data: { id: `int-${body.order_id}`, pgcOrderId: `PG-${body.order_id}`, orderId: body.order_id, totalCost: 11, shippingFee: 4, handleFee: 1 } } }
}

async function setGlobalPgprints(v: typeof G | null, pushEnabled = true) {
  await prisma.appSetting.deleteMany({ where: { key: { in: Object.values(PGPRINTS_KEYS) } } })
  if (!v) return
  for (const [key, value] of [[PGPRINTS_KEYS.storeId, v.storeId], [PGPRINTS_KEYS.secretKey, v.secretKey], [PGPRINTS_KEYS.defaultShipClass, v.shipClass], [PGPRINTS_KEYS.pushEnabled, String(pushEnabled)]]) {
    await prisma.appSetting.create({ data: { key, value } })
  }
}

async function setStorePgprints(storeId: string, v: typeof R | null, pushEnabled = true) {
  for (const key of ['pgprints.storeId', 'pgprints.secretKey', 'pgprints.defaultShipClass', 'pgprints.pushEnabled'] as const) await setStoreSetting(storeId, key, null)
  if (!v) return
  await setStoreSetting(storeId, 'pgprints.storeId', v.storeId)
  await setStoreSetting(storeId, 'pgprints.secretKey', v.secretKey)
  await setStoreSetting(storeId, 'pgprints.defaultShipClass', v.shipClass)
  await setStoreSetting(storeId, 'pgprints.pushEnabled', String(pushEnabled))
}

async function makeOrder(storeId: string, projectId: string, opts: { supplier?: 'pg' | 'mz' | 'other'; tag?: string } = {}) {
  seq++
  const mz = opts.supplier === 'mz'
  const other = opts.supplier === 'other'
  const id = `gid://test/Order/t15-${seq}`
  const number = `#T15${opts.tag ?? 'L'}${1000 + seq}`
  const lineId = `t15l-${seq}`
  await prisma.order.create({
    data: {
      id, projectId, storeId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 30, expectedPayout: 28, totalFees: 2, refundedAmount: 0, placedAt: new Date('2026-10-01T10:00:00Z'),
      pipelineStatus: 'READY_TO_PRODUCTION', orderType: 'CUSTOM', designReady: true,
      customerEmail: 'mary@example.com', customerName: 'Mary Jane Watson',
      shippingName: 'Mary Jane Watson', shippingAddress1: '12 Main St', shippingAddress2: 'Apt 4', shippingCity: 'Denver',
      shippingZip: '80202', shippingPhone: '+1 303 555 0100', shippingCountry: 'US', shippingState: 'Colorado',
      lines: { create: [{
        shopifyLineId: lineId, sku: 'TUMBLER-A', productTitle: mz ? 'Gildan tee' : 'Custom Tumbler', variantTitle: mz ? 'Tshirt / L / Light Blue' : '20oz', qty: mz ? 1 : 2, linePosition: 1, unitPrice: 15,
        resolvedSupplierId: mz ? MZ_SUP : other ? OTHER_SUP : PG_SUP, resolvedSupplierSku: mz ? '5000US000LTBAA03' : other ? 'OTH-1' : 'UT2-20OZ', customized: !mz,
        previewCdnUrl: 'https://cdn.example.com/preview.png', imageUrl: 'https://cdn.shopify.com/s/files/tee.jpg', designDriveLink: '/api/design-studio/file/placeholder',
      }] },
      designTasks: { create: [{ shopifyLineId: lineId, taskKey: `T15${opts.tag ?? 'L'}${1000 + seq}_1`, status: 'DONE' }] },
    },
  })
  const rel = `design/t15-${seq}/main.png`
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
  fs.writeFileSync(path.join(tmp, rel), PNG)
  await prisma.designArtwork.create({
    data: { orderId: id, shopifyLineId: lineId, printArea: mz ? 'Front' : 'Main', version: 1, fileName: 'main.png', storagePath: rel, size: PNG.length, mimeType: 'image/png', widthPx: mz ? 4200 : 3270, heightPx: mz ? 4800 : 1860 },
  })
  return { id, number: number.replace('#', ''), lineId }
}

async function pushIt(orderId: string) {
  const built = await buildPush(orderId)
  return pushOrder(orderId, { payloadHash: built!.preview.payloadHash!, userId: null })
}

function hook(body: unknown, secret: string | null) {
  return postTracking(new NextRequest('http://x/api/public/pgprints/tracking', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Store-Secret': secret } : {}) },
  }))
}

const tracking = (o: { number: string }, n: string) => ({ orderId: o.number, sku: 'UT2-One_size', trackingNumber: n, carrierCode: 'yunexpress' })

async function cleanup() {
  const stores = await prisma.shopifyStore.findMany({ where: { shop: { in: [LITZZY_SHOP, SHOP_R, SHOP_X] } }, select: { id: true } })
  for (const store of stores) await prisma.appSetting.deleteMany({ where: { key: { startsWith: `store.${store.id}.` } } })
  await prisma.order.deleteMany({ where: { OR: [{ projectId: { in: [PROJECT_L, PROJECT_R, PROJECT_X] } }, { store: { shop: LITZZY_SHOP } }] } })
  await prisma.csvTemplate.deleteMany({ where: { supplierId: { in: SUPPLIER_IDS } } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: { in: SUPPLIER_IDS } } })
  await prisma.printTemplate.deleteMany({ where: { supplierId: { in: SUPPLIER_IDS } } })
  await prisma.supplier.deleteMany({ where: { id: { in: SUPPLIER_IDS } } })
  await prisma.shopifyStore.deleteMany({ where: { shop: { in: [LITZZY_SHOP, SHOP_R, SHOP_X] } } })
  await prisma.project.deleteMany({ where: { id: { in: [PROJECT_L, PROJECT_R, PROJECT_X] } } })
  await prisma.appSetting.deleteMany({ where: { key: { in: GLOBAL_ROWS } } })
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  process.env.DESIGN_STORAGE_DIR = tmp
  await cleanup()
  for (const [id, name] of [[PROJECT_L, 'T15 Litzzy'], [PROJECT_R, 'T15 Reminiso'], [PROJECT_X, 'T15 Nokey']]) {
    await prisma.project.create({ data: { id, name, startDate: new Date('2026-06-01') } })
  }
  litzzy = (await prisma.shopifyStore.create({ data: { shop: LITZZY_SHOP, projectId: PROJECT_L, orderPrefix: 'LIT', connectedAt: new Date('2026-01-01') } })).id
  reminiso = (await prisma.shopifyStore.create({ data: { shop: SHOP_R, projectId: PROJECT_R, orderPrefix: 'REM', connectedAt: new Date('2026-01-02') } })).id
  nokey = (await prisma.shopifyStore.create({ data: { shop: SHOP_X, projectId: PROJECT_X, orderPrefix: 'NOK', connectedAt: new Date('2026-01-03') } })).id

  await prisma.supplier.create({ data: { id: PG_SUP, name: 'Pgprints', code: 'pgprints' } })
  await prisma.supplier.create({ data: { id: MZ_SUP, name: 'Merchize', code: 'merchize' } })
  await prisma.supplier.create({ data: { id: OTHER_SUP, name: 'Other Factory', code: 'other_t15' } })
  await setCsvLocked(false)
  const orderColumn = JSON.stringify([{ header: 'Order', source: 'order.shopifyOrderNumber' }])
  pgTemplateId = (await prisma.csvTemplate.create({ data: { supplierId: PG_SUP, name: 'PG csv', rowMode: 'PER_ORDER', columns: orderColumn } })).id
  otherTemplateId = (await prisma.csvTemplate.create({ data: { supplierId: OTHER_SUP, name: 'Other csv', rowMode: 'PER_ORDER', columns: orderColumn } })).id
  const pgTemplate = await prisma.printTemplate.create({
    data: { supplierId: PG_SUP, supplierSku: 'UT2-20OZ', name: 'Tumbler 20oz', widthPx: 3270, heightPx: 1860, areas: JSON.stringify([{ name: 'Main', x: 0, y: 0, w: 3270, h: 1860 }]) },
  })
  await prisma.supplierProduct.create({ data: { supplierId: PG_SUP, sku: 'UT2-20OZ', baseSku: 'UT2', baseCost: 8, printTemplateId: pgTemplate.id, apiSku: 'UT2-One_size' } })
  const mzTemplate = await prisma.printTemplate.create({
    data: { supplierId: MZ_SUP, supplierSku: '5000US', name: 'Merchize Gildan 5000US', widthPx: 4200, heightPx: 4800, areas: JSON.stringify([{ name: 'Front', x: 0, y: 0, w: 4200, h: 4800 }]) },
  })
  await prisma.supplierProduct.create({
    data: {
      supplierId: MZ_SUP, sku: '5000US000LTBAA03', apiSku: '5000US000LTBAA03', baseSku: '5000US', productName: 'Classic Unisex T-Shirt Gildan 5000',
      variant1Name: 'Size', variant1Value: 'L', variant2Name: 'Color', variant2Value: 'Light Blue', baseCost: 5.25, printTemplateId: mzTemplate.id,
    },
  })

  for (const email of EMAILS) {
    const role = email.includes('super') ? 'SUPERADMIN' : 'ADMIN'
    const u = await prisma.appUser.create({ data: { name: role, email, role, permissions: '[]' } })
    const token = await signToken({ userId: u.id, email, name: role, role, permissions: [], tv: u.tokenVersion })
    if (role === 'SUPERADMIN') superToken = token
    else adminToken = token
  }
})

afterAll(async () => {
  await cleanup()
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
  delete process.env.NEXT_PUBLIC_APP_URL
})

beforeEach(async () => {
  originalEnv = { url: process.env.MERCHIZE_API_URL, token: process.env.MERCHIZE_API_TOKEN, pp: process.env.PARCELPANEL_API_KEY }
  delete process.env.MERCHIZE_API_URL
  delete process.env.MERCHIZE_API_TOKEN
  delete process.env.PARCELPANEL_API_KEY
  process.env.NEXT_PUBLIC_APP_URL = APP_URL
  await prisma.order.deleteMany({ where: { projectId: { in: [PROJECT_L, PROJECT_R, PROJECT_X] } } })
  for (const id of [litzzy, reminiso, nokey]) {
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: `store.${id}.` } } })
  }
  await setGlobalPgprints(G)
  await prisma.appSetting.deleteMany({ where: { key: PARCELPANEL_KEY_SETTING } })
  calls = []
  mocks.parcelpanel.mockClear()
  handler = call => {
    if (call.path === '/app/v1/orders/create') return created(call)
    if (call.path === '/api/v1/users/balance') return { status: 200, json: { success: true, data: { availableAmount: 100, pendingAmount: 0, paidAmount: 0, upcomingAmount: 0 } } }
    if (call.path === '/api/v1/order/cancel') return { status: 200, json: { success: true } }
    return { status: 404, json: { success: false, message: 'unexpected path in test' } }
  }
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input))
    const call: Call = { url, path: url.pathname, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') }
    calls.push(call)
    const reply = await handler(call)
    return new Response(JSON.stringify(reply.json), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const [key, value] of [['MERCHIZE_API_URL', originalEnv.url], ['MERCHIZE_API_TOKEN', originalEnv.token], ['PARCELPANEL_API_KEY', originalEnv.pp]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('store settings', () => {
  it('keeps a value under store.<id>.<key>, trims it, and a blank value removes the row', async () => {
    await setStoreSetting(reminiso, 'pgprints.defaultShipClass', '  US Express  ')
    expect(await getStoreSetting(reminiso, 'pgprints.defaultShipClass')).toBe('US Express')
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: `store.${reminiso}.pgprints.defaultShipClass` } })).value).toBe('US Express')
    expect(storeSettingRowKey(reminiso, 'merchize.token')).toBe(`store.${reminiso}.merchize.token`)
    await setStoreSetting(reminiso, 'pgprints.defaultShipClass', '   ')
    expect(await getStoreSetting(reminiso, 'pgprints.defaultShipClass')).toBeNull()
    expect(await prisma.appSetting.count({ where: { key: `store.${reminiso}.pgprints.defaultShipClass` } })).toBe(0)
  })

  it('Litzzy is the Litzzy shop, whatever else is true of a store', async () => {
    expect(await isLitzzyStoreId(litzzy)).toBe(true)
    expect(await isLitzzyStoreId(reminiso)).toBe(false)
    expect(await isLitzzyStoreId('no-such-store')).toBe(false)
    expect(isLitzzyStore({ shop: LITZZY_SHOP })).toBe(true)
    expect(isLitzzyStore({ shop: SHOP_R })).toBe(false)
  })

  it('PGprints settings: Litzzy reads the global key, another store only its own, an unknown store nothing', async () => {
    expect(credentialsOf(await getPgprintsSettings(litzzy))).toEqual({ storeId: G.storeId, secretKey: G.secretKey })
    expect(credentialsOf(await getPgprintsSettings())).toEqual({ storeId: G.storeId, secretKey: G.secretKey })
    expect(credentialsOf(await getPgprintsSettings(reminiso))).toBeNull()
    expect(credentialsOf(await getPgprintsSettings('no-such-store'))).toBeNull()
    await setStorePgprints(reminiso, R)
    expect(await getPgprintsSettings(reminiso)).toEqual({ storeId: R.storeId, secretKey: R.secretKey, defaultShipClass: R.shipClass, pushEnabled: true })
    expect((await getPgprintsSettings(litzzy)).secretKey).toBe(G.secretKey)
  })
})

describe('PGprints push', () => {
  it("a Reminiso order pushes with Reminiso's PGprints key, a Litzzy order with the global key", async () => {
    await setStorePgprints(reminiso, R)
    const lz = await makeOrder(litzzy, PROJECT_L, { tag: 'L' })
    const rm = await makeOrder(reminiso, PROJECT_R, { tag: 'R' })

    const lzPreview = (await buildPush(lz.id, { withBalance: true }))!
    const rmPreview = (await buildPush(rm.id, { withBalance: true }))!
    expect(lzPreview.preview.issues.filter(i => i.level === 'error')).toEqual([])
    expect(rmPreview.preview.issues.filter(i => i.level === 'error')).toEqual([])
    expect((lzPreview.preview.payload as any).line_items[0].shipClass).toBe(G.shipClass)
    expect((rmPreview.preview.payload as any).line_items[0].shipClass).toBe(R.shipClass)
    const balanceHeaders = pgCalls('/users/balance').map(c => c.headers['X-PGPrints-Store-Id'])
    expect(balanceHeaders).toEqual([G.storeId, R.storeId])

    calls = []
    await pushIt(lz.id)
    await pushIt(rm.id)
    const [first, second] = pgCalls('/orders/create')
    expect(first.headers['X-PGPrints-Store-Id']).toBe(G.storeId)
    expect(first.headers['X-PGPrints-Hmac-Sha256']).toBe(signBody(G.secretKey, first.body))
    expect(JSON.parse(first.body).order_id).toBe(lz.number)
    expect(second.headers['X-PGPrints-Store-Id']).toBe(R.storeId)
    expect(second.headers['X-PGPrints-Hmac-Sha256']).toBe(signBody(R.secretKey, second.body))
    expect(JSON.parse(second.body).order_id).toBe(rm.number)
    expect(pgCalls('/orders/create')).toHaveLength(2)
  })

  it('a store with no PGprints key is refused with a clear message and sends nothing', async () => {
    const o = await makeOrder(nokey, PROJECT_X, { tag: 'X' })
    const built = (await buildPush(o.id, { withBalance: true }))!
    expect(built.preview).toMatchObject({ hasCredentials: false, canPush: false, balance: null })
    const issue = built.preview.issues.find(i => i.code === 'NO_CREDENTIALS')!
    expect(issue.level).toBe('error')
    expect(issue.message).toContain('T15 Nokey')
    expect(issue.message).toContain('Setup')

    const refused = await pushOrder(o.id, { payloadHash: built.preview.payloadHash ?? 'x', userId: null }).catch(e => e)
    expect(refused).toMatchObject({ name: 'PushError', status: 400, code: 'NO_CREDENTIALS' })
    expect(refused.message).toContain('T15 Nokey')
    expect(refused.message).toContain('Setup')

    await prisma.supplierOrderPush.create({
      data: { orderId: o.id, supplierId: PG_SUP, externalOrderId: `${o.number}-X`, activeKey: `${o.id}::${PG_SUP}`, status: 'CREATED', supplierOrderCode: 'PG-X', requestJson: '{}' },
    })
    expect(await cancelPush(o.id).catch(e => e)).toMatchObject({ status: 400, code: 'NO_CREDENTIALS' })
    expect(await refreshPush(o.id).catch(e => e)).toMatchObject({ status: 400, code: 'NO_CREDENTIALS' })
    expect(await prisma.supplierOrderPush.count({ where: { orderId: o.id } })).toBe(1)
    expect(calls).toHaveLength(0)
    expect(await prisma.supplierOrderPush.count({ where: { externalOrderId: { in: [o.number] } } })).toBe(0)
  })

  it('a store with half a key (no secret) is refused the same way, and the other store\'s key is still not used', async () => {
    await setStoreSetting(nokey, 'pgprints.storeId', R.storeId)
    await setStoreSetting(nokey, 'pgprints.pushEnabled', 'true')
    const o = await makeOrder(nokey, PROJECT_X, { tag: 'X' })
    expect(await pushOrder(o.id, { payloadHash: 'x', userId: null }).catch(e => e)).toMatchObject({ status: 400, code: 'NO_CREDENTIALS' })
    expect(calls).toHaveLength(0)
  })

  it('a store with a key but the switch off is refused naming the store', async () => {
    await setStorePgprints(reminiso, R, false)
    const o = await makeOrder(reminiso, PROJECT_R, { tag: 'R' })
    const built = (await buildPush(o.id))!
    const refused = await pushOrder(o.id, { payloadHash: built.preview.payloadHash!, userId: null }).catch(e => e)
    expect(refused).toMatchObject({ status: 403, code: 'PUSH_DISABLED' })
    expect(refused.message).toContain('T15 Reminiso')
    expect(calls).toHaveLength(0)
  })

  it('the tracking pull uses each store\'s own key and skips, with a log line, a store that has none', async () => {
    await setStorePgprints(reminiso, R)
    const lz = await makeOrder(litzzy, PROJECT_L, { tag: 'L' })
    const rm = await makeOrder(reminiso, PROJECT_R, { tag: 'R' })
    await pushIt(lz.id)
    await pushIt(rm.id)
    const orphan = await makeOrder(nokey, PROJECT_X, { tag: 'X' })
    await prisma.supplierOrderPush.create({
      data: { orderId: orphan.id, supplierId: PG_SUP, externalOrderId: orphan.number, activeKey: `${orphan.id}::${PG_SUP}`, status: 'CREATED', supplierOrderCode: 'PG-O', requestJson: '{}' },
    })
    calls = []
    handler = call => {
      if (call.path !== '/api/v1/orders/search') return { status: 404, json: {} }
      const mine = call.headers['X-PGPrints-Store-Id'] === G.storeId ? lz : rm
      return { status: 200, json: { success: true, data: [{ id: 'i1', pgcOrderId: `PG-${mine.number}`, orderId: mine.number, itemStatuses: ['fulfilled'], childDetails: [{ sku: 'UT2-One_size', status: 'fulfilled', trackingNumber: `TRK-${mine.number}`, carrierCode: 'usps' }] }] } }
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const r = await syncPgprintsTracking()
      expect(pgCalls('/orders/search').map(c => c.headers['X-PGPrints-Store-Id']).sort()).toEqual([G.storeId, R.storeId].sort())
      for (const c of pgCalls('/orders/search')) {
        const key = c.headers['X-PGPrints-Store-Id'] === G.storeId ? G.secretKey : R.secretKey
        expect(c.headers['X-PGPrints-Hmac-Sha256']).toBe(signBody(key, c.body))
      }
      expect(r).toMatchObject({ pushes: 2, found: 2, shipments: 2, skipped: expect.stringContaining('T15 Nokey') })
      expect(log.mock.calls.some(c => String(c[0]).includes('T15 Nokey') && String(c[0]).includes('no PGprints key'))).toBe(true)
    } finally {
      log.mockRestore()
    }
    expect((await prisma.shipment.findFirstOrThrow({ where: { orderId: lz.id } })).trackingNumber).toBe(`TRK-${lz.number}`)
    expect((await prisma.shipment.findFirstOrThrow({ where: { orderId: rm.id } })).trackingNumber).toBe(`TRK-${rm.number}`)
    expect(await prisma.shipment.count({ where: { orderId: orphan.id } })).toBe(0)
  })
})

describe('PGprints tracking webhook', () => {
  it("matches an order whichever store's key it was signed with, and rejects an unknown key", async () => {
    await setStorePgprints(reminiso, R)
    const lz = await makeOrder(litzzy, PROJECT_L, { tag: 'L' })
    const rm = await makeOrder(reminiso, PROJECT_R, { tag: 'R' })
    await pushIt(lz.id)
    await pushIt(rm.id)

    const asLitzzy = await hook(tracking(lz, 'GLZ1'), G.secretKey)
    expect(asLitzzy.status).toBe(200)
    expect(await asLitzzy.json()).toMatchObject({ ok: true, ignored: false, shipments: 1 })
    const asReminiso = await hook(tracking(rm, 'RMS1'), R.secretKey)
    expect(asReminiso.status).toBe(200)
    expect(await asReminiso.json()).toMatchObject({ ok: true, ignored: false, shipments: 1 })
    expect((await prisma.shipment.findFirstOrThrow({ where: { orderId: lz.id } })).trackingNumber).toBe('GLZ1')
    expect((await prisma.shipment.findFirstOrThrow({ where: { orderId: rm.id } })).trackingNumber).toBe('RMS1')

    // A key only reaches the orders of the stores it belongs to.
    expect(await (await hook(tracking(rm, 'WRONG1'), G.secretKey)).json()).toMatchObject({ ignored: true, reason: 'unknown order', shipments: 0 })
    expect(await (await hook(tracking(lz, 'WRONG2'), R.secretKey)).json()).toMatchObject({ ignored: true, reason: 'unknown order', shipments: 0 })
    expect((await prisma.shipment.findFirstOrThrow({ where: { orderId: rm.id } })).trackingNumber).toBe('RMS1')
    expect((await prisma.shipment.findFirstOrThrow({ where: { orderId: lz.id } })).trackingNumber).toBe('GLZ1')

    // The PGprints account id in the body must be the account of the store the key belongs to.
    expect(await (await hook({ ...tracking(lz, 'GLZ2'), storeId: R.storeId }, G.secretKey)).json()).toMatchObject({ ignored: true, reason: 'other store' })
    expect(await (await hook({ ...tracking(lz, 'GLZ3'), storeId: G.storeId }, G.secretKey)).json()).toMatchObject({ ignored: false })

    const unknown = await hook(tracking(lz, 'EVIL'), 'not-a-known-key-at-all')
    const near = await hook(tracking(lz, 'EVIL'), `${G.secretKey}x`)
    const missing = await hook(tracking(lz, 'EVIL'), null)
    for (const res of [unknown, near, missing]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Unauthorized' })
    }
    expect((await prisma.shipment.findFirstOrThrow({ where: { orderId: lz.id } })).trackingNumber).not.toBe('EVIL')
  })

  it('a removed key stops working at once, and a store with no key cannot sign', async () => {
    await setStorePgprints(reminiso, R)
    expect((await hook({ orderId: 'x' }, R.secretKey)).status).toBe(200)
    await setStorePgprints(reminiso, null)
    expect((await hook({ orderId: 'x' }, R.secretKey)).status).toBe(401)
    await setGlobalPgprints(null)
    expect((await hook({ orderId: 'x' }, G.secretKey)).status).toBe(401)
    expect((await hook({ orderId: 'x' }, '')).status).toBe(401)
  })
})

describe('Merchize credentials', () => {
  it('falls back to the server token only when the store has none', async () => {
    expect(await merchizeCredentials(reminiso)).toBeNull()
    process.env.MERCHIZE_API_URL = `${MZ_SERVER.url}/`
    process.env.MERCHIZE_API_TOKEN = MZ_SERVER.token
    expect(await merchizeCredentials(reminiso)).toEqual({ baseUrl: MZ_SERVER.url, token: MZ_SERVER.token })
    expect(await merchizeCredentials()).toEqual({ baseUrl: MZ_SERVER.url, token: MZ_SERVER.token })

    await setStoreSetting(reminiso, 'merchize.apiUrl', `${MZ_STORE.url}//`)
    await setStoreSetting(reminiso, 'merchize.token', MZ_STORE.token)
    expect(await merchizeCredentials(reminiso)).toEqual({ baseUrl: MZ_STORE.url, token: MZ_STORE.token })
    expect(await merchizeCredentials(nokey)).toEqual({ baseUrl: MZ_SERVER.url, token: MZ_SERVER.token })

    // Half an account is not the server's account: nothing is sent.
    await setStoreSetting(reminiso, 'merchize.apiUrl', null)
    expect(await merchizeCredentials(reminiso)).toBeNull()
    await setStoreSetting(reminiso, 'merchize.token', null)
    expect(await merchizeCredentials(reminiso)).toEqual({ baseUrl: MZ_SERVER.url, token: MZ_SERVER.token })
  })

  it('a push goes out under the order\'s store account, and a store with neither is refused naming it', async () => {
    const body = { success: true, data: { total: 1, products: [{
      _id: 'cat-5000us', sku: '5000US', title: 'Gildan 5000', printing_methods: ['DTF', 'DTG'], fulfillment_location: { name: 'US', code: 'US' }, mockup_and_templates_link: null, production_time: null,
      variants: [{ _id: 'v1', sku: '5000US000LTBAA03', attributes: [{ name: 'color', type: 'color', value_text: 'Light Blue', value_code: 'lightblue' }, { name: 'size', type: 'size', value_text: 'L', value_code: 'l' }], shipping_prices: [], tiers: [{ name: 'dtf_tier1', price: 5.25 }] }],
    }] } }
    handler = call => {
      if (call.path.endsWith('/product/catalog')) return { status: 200, json: body }
      if (call.path.endsWith('/order/external/orders') && call.method === 'POST') return { status: 200, json: { success: true, data: { _id: 'mz-1', status: 'created', data: JSON.parse(call.body) } } }
      if (call.path.endsWith('/order/external/orders/push')) return { status: 200, json: { success: true, data: true } }
      if (call.path.endsWith('/order/external/orders/order-detail')) return { status: 200, json: { success: true, data: { _id: 'mz-1', code: 'RX-1', order_status: 'in_production', fulfillments: [] } } }
      return { status: 404, json: { success: false, message: 'unexpected path in test' } }
    }
    IMPORT_WAIT.delayMs = 5
    const a = await makeOrder(reminiso, PROJECT_R, { tag: 'M', supplier: 'mz' })
    const refusedPreview = (await buildMerchizePush(a.id))!
    expect(refusedPreview.preview).toMatchObject({ hasCredentials: false, canPush: false })
    const issue = refusedPreview.preview.issues.find(i => i.code === 'NO_CREDENTIALS')!
    expect(issue.message).toContain('T15 Reminiso')
    expect(await pushMerchizeOrder(a.id, { payloadHash: 'x', userId: null }).catch(e => e)).toMatchObject({ status: 400, code: 'NO_CREDENTIALS' })
    expect(calls).toHaveLength(0)

    process.env.MERCHIZE_API_URL = MZ_SERVER.url
    process.env.MERCHIZE_API_TOKEN = MZ_SERVER.token
    await setStoreSetting(reminiso, 'merchize.apiUrl', MZ_STORE.url)
    await setStoreSetting(reminiso, 'merchize.token', MZ_STORE.token)
    const own = (await buildMerchizePush(a.id))!
    expect(own.preview).toMatchObject({ hasCredentials: true, canPush: true })
    await pushMerchizeOrder(a.id, { payloadHash: own.preview.payloadHash!, userId: null })
    const sent = calls.filter(c => c.path.endsWith('/order/external/orders') && c.method === 'POST')
    expect(sent).toHaveLength(1)
    expect(sent[0].url.origin).toBe(new URL(MZ_STORE.url).origin)
    expect(sent[0].headers.Authorization).toBe(`Bearer ${MZ_STORE.token}`)
    expect(calls.every(c => c.url.origin === new URL(MZ_STORE.url).origin)).toBe(true)

    // Another store without its own account still goes out under the server's.
    calls = []
    const b = await makeOrder(nokey, PROJECT_X, { tag: 'M', supplier: 'mz' })
    const viaServer = (await buildMerchizePush(b.id))!
    expect(viaServer.preview.hasCredentials).toBe(true)
    expect(calls.every(c => c.headers.Authorization === `Bearer ${MZ_SERVER.token}`)).toBe(true)
  })
})

describe('ParcelPanel key', () => {
  it('Litzzy reads the shared key; another store reads only its own, never the shared one or the env', async () => {
    process.env.PARCELPANEL_API_KEY = 'env-pp-key-000000'
    expect(await getParcelPanelApiKey()).toBe('env-pp-key-000000')
    expect(await getParcelPanelApiKey(litzzy)).toBe('env-pp-key-000000')
    await setParcelPanelApiKey('shared-pp-key-111111')
    expect(await getParcelPanelApiKey()).toBe('shared-pp-key-111111')
    expect(await getParcelPanelApiKey(litzzy)).toBe('shared-pp-key-111111')
    expect(await getParcelPanelApiKey(reminiso)).toBeNull()
    await setStoreSetting(reminiso, 'parcelpanel.apiKey', 'reminiso-pp-key-222222')
    expect(await getParcelPanelApiKey(reminiso)).toBe('reminiso-pp-key-222222')
    expect(await getParcelPanelApiKey(litzzy)).toBe('shared-pp-key-111111')
    expect(await getParcelPanelApiKey('no-such-store')).toBeNull()
  })

  it('the daily sync runs each store under its own key and skips, with a log line, a store that has none', async () => {
    await setParcelPanelApiKey('shared-pp-key-111111')
    await setStoreSetting(reminiso, 'parcelpanel.apiKey', 'reminiso-pp-key-222222')
    for (const id of [litzzy, reminiso, nokey]) await saveStoreCredential(id, { authMode: 'TOKEN', accessToken: `tok-${id}` })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runDailyParcelPanelSync()
      const mine = mocks.parcelpanel.mock.calls.map(c => c[0]).filter(p => [litzzy, reminiso, nokey].includes(p.storeId ?? ''))
      expect(mine.map(p => [p.storeId, p.apiKey])).toEqual([[litzzy, 'shared-pp-key-111111'], [reminiso, 'reminiso-pp-key-222222']])
      expect(log.mock.calls.some(c => String(c[0]).includes(SHOP_X) && String(c[0]).includes('no ParcelPanel API key'))).toBe(true)
    } finally {
      log.mockRestore()
      await prisma.shopifyStoreCredential.deleteMany({ where: { storeId: { in: [litzzy, reminiso, nokey] } } })
    }
  })

  it('a sync of a store with no key is a skip, not a run with zeros', async () => {
    await expect(syncParcelPanelForStore({ storeId: nokey }, { includeDelivered: true })).rejects.toBeInstanceOf(StoreJobSkipped)
    expect(mocks.parcelpanel).not.toHaveBeenCalled()
  })
})

describe('Duyệt sản xuất cards', () => {
  it('a card offers the API only to a store that has its own PGprints key', async () => {
    await setStorePgprints(reminiso, R)
    const lz = await makeOrder(litzzy, PROJECT_L, { tag: 'L' })
    const rm = await makeOrder(reminiso, PROJECT_R, { tag: 'R' })
    const none = await makeOrder(nokey, PROJECT_X, { tag: 'X' })
    expect(await handoffStateFor(lz.id)).toMatchObject({ mode: 'API', apiName: 'PGprints', apiNote: null })
    expect(await handoffStateFor(rm.id)).toMatchObject({ mode: 'API', apiName: 'PGprints', apiNote: null })
    const state = (await handoffStateFor(none.id))!
    expect(state.mode).toBe('CSV')
    expect(state.apiNote).toContain('T15 Nokey')
    expect(state.apiNote).toContain('Store ID')
  })
})

describe('/api/stores/[id]/settings', () => {
  const url = (id: string) => `http://x/api/stores/${id}/settings`
  const request = (id: string, token: string | null, init: ConstructorParameters<typeof NextRequest>[1] = {}) => {
    const r = new NextRequest(url(id), init)
    if (token) r.cookies.set(AUTH_COOKIE, token)
    return r
  }
  // Every answer of the route, whatever its status, is checked for the full value of any secret this file ever stored.
  const noSecrets = async (res: Response) => {
    const text = await res.clone().text()
    for (const secret of KNOWN_SECRETS) expect(text).not.toContain(secret)
    return res
  }
  const put = async (id: string, token: string | null, body: unknown) =>
    noSecrets(await putSettings(request(id, token, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), { params: { id } }))
  const get = async (id: string, token: string | null) => noSecrets(await getSettings(request(id, token), { params: { id } }))

  it('GET returns masked values and never a full secret; PUT needs a Super Admin', async () => {
    await setStorePgprints(reminiso, R)
    await setStoreSetting(reminiso, 'merchize.apiUrl', MZ_STORE.url)
    await setStoreSetting(reminiso, 'merchize.token', MZ_STORE.token)
    await setStoreSetting(reminiso, 'parcelpanel.apiKey', 'reminiso-pp-key-222222')

    const res = await get(reminiso, superToken)
    expect(res.status).toBe(200)
    const text = await res.text()
    for (const secret of [R.secretKey, MZ_STORE.token, 'reminiso-pp-key-222222', R.storeId]) expect(text).not.toContain(secret)
    expect(JSON.parse(text)).toMatchObject({
      storeId: reminiso, shared: false,
      pgprints: { hasStoreId: true, storeIdMasked: 'r-st…2222', hasSecretKey: true, secretKeyMasked: expect.stringMatching(/^•+$/), defaultShipClass: R.shipClass, pushEnabled: true },
      merchize: { hasApiUrl: true, apiUrlHost: new URL(MZ_STORE.url).host, hasToken: true, tokenMasked: 'mz-r…bbbb', source: 'store' },
      parcelpanel: { hasApiKey: true, apiKeyMasked: 'remi…2222' },
    })

    expect((await get(reminiso, adminToken)).status).toBe(403)
    expect((await get(reminiso, null)).status).toBe(401)
    expect((await put(reminiso, adminToken, { pgprints: { pushEnabled: false } })).status).toBe(403)
    expect((await put(reminiso, null, { pgprints: { pushEnabled: false } })).status).toBe(401)
    expect(await getStoreSetting(reminiso, 'pgprints.pushEnabled')).toBe('true')
    expect((await get('no-such-store', superToken)).status).toBe(404)
    expect((await put('no-such-store', superToken, { pgprints: {} })).status).toBe(404)
  })

  it('PUT saves a store\'s keys, never echoes the secret, keeps a blank secret and clears on null', async () => {
    const saved = await put(nokey, superToken, {
      pgprints: { storeId: R.storeId, secretKey: R.secretKey, defaultShipClass: R.shipClass, pushEnabled: true },
      merchize: { apiUrl: MZ_STORE.url, token: MZ_STORE.token },
      parcelpanel: { apiKey: 'nokey-pp-key-333333' },
    })
    expect(saved.status).toBe(200)
    const savedText = await saved.text()
    for (const secret of [R.secretKey, MZ_STORE.token, 'nokey-pp-key-333333']) expect(savedText).not.toContain(secret)
    expect(await getStoreSetting(nokey, 'pgprints.secretKey')).toBe(R.secretKey)
    expect(credentialsOf(await getPgprintsSettings(nokey))).toEqual({ storeId: R.storeId, secretKey: R.secretKey })
    expect(await getParcelPanelApiKey(nokey)).toBe('nokey-pp-key-333333')
    expect(await merchizeCredentials(nokey)).toEqual({ baseUrl: MZ_STORE.url, token: MZ_STORE.token })
    expect((await getPgprintsSettings(litzzy)).secretKey).toBe(G.secretKey)

    const blank = await put(nokey, superToken, { pgprints: { secretKey: '', defaultShipClass: 'US Standard' }, merchize: { token: '' }, parcelpanel: { apiKey: '' } })
    expect(blank.status).toBe(200)
    expect(await getStoreSetting(nokey, 'pgprints.secretKey')).toBe(R.secretKey)
    expect(await getStoreSetting(nokey, 'pgprints.defaultShipClass')).toBe('US Standard')
    expect(await getStoreSetting(nokey, 'merchize.token')).toBe(MZ_STORE.token)
    expect(await getParcelPanelApiKey(nokey)).toBe('nokey-pp-key-333333')

    const cleared = await put(nokey, superToken, { pgprints: { secretKey: null }, parcelpanel: { apiKey: null } })
    expect(cleared.status).toBe(200)
    expect(await getStoreSetting(nokey, 'pgprints.secretKey')).toBeNull()
    expect(await getParcelPanelApiKey(nokey)).toBeNull()
    // Without its secret the store is switched off, not left on with half a key.
    expect(await getStoreSetting(nokey, 'pgprints.pushEnabled')).toBe('false')
    expect((await (await get(nokey, superToken)).json()).pgprints).toMatchObject({ hasSecretKey: false, pushEnabled: false })
  })

  it('refuses what cannot be right: switching on without a key, half a Merchize account, a foreign host, unknown fields', async () => {
    expect((await put(nokey, superToken, { pgprints: { pushEnabled: true } })).status).toBe(400)
    expect(await getStoreSetting(nokey, 'pgprints.pushEnabled')).toBeNull()
    expect((await put(nokey, superToken, { merchize: { token: MZ_STORE.token } })).status).toBe(400)
    expect(await getStoreSetting(nokey, 'merchize.token')).toBeNull()
    expect((await put(nokey, superToken, { merchize: { apiUrl: 'https://evil.example.com/bo-api', token: MZ_STORE.token } })).status).toBe(400)
    expect((await put(nokey, superToken, { merchize: { apiUrl: 'http://bo.merchize.com/x', token: MZ_STORE.token } })).status).toBe(400)
    expect((await put(nokey, superToken, { pgprints: { secretKey: 5 } })).status).toBe(400)
    expect((await put(nokey, superToken, { pgprints: { storeId: 'x'.repeat(201) } })).status).toBe(400)
    expect((await put(nokey, superToken, { other: {} })).status).toBe(400)
    expect((await put(nokey, superToken, [])).status).toBe(400)
  })

  it('Litzzy\'s PGprints and ParcelPanel keys are the shared ones and cannot be written here; its Merchize account can', async () => {
    const res = await get(litzzy, superToken)
    expect(await res.json()).toMatchObject({ shared: true, pgprints: { hasSecretKey: true, hasStoreId: true } })
    const refused = await put(litzzy, superToken, { pgprints: { secretKey: 'overwrite-attempt-00000' } })
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toContain('Litzzy')
    expect((await put(litzzy, superToken, { parcelpanel: { apiKey: 'overwrite-attempt-11111' } })).status).toBe(400)
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: PGPRINTS_KEYS.secretKey } })).value).toBe(G.secretKey)
    expect(await prisma.appSetting.count({ where: { key: { startsWith: `store.${litzzy}.` } } })).toBe(0)

    expect((await put(litzzy, superToken, { merchize: { apiUrl: MZ_STORE.url, token: MZ_STORE.token } })).status).toBe(200)
    expect(await merchizeCredentials(litzzy)).toEqual({ baseUrl: MZ_STORE.url, token: MZ_STORE.token })
  })
})

describe('PGprints tracking pull: one store failing', () => {
  it('a store whose search is refused is logged and skipped, and the next store is still pulled', async () => {
    await setStorePgprints(reminiso, R)
    const lz = await makeOrder(litzzy, PROJECT_L, { tag: 'L' })
    const rm = await makeOrder(reminiso, PROJECT_R, { tag: 'R' })
    await pushIt(lz.id)
    await pushIt(rm.id)
    calls = []
    handler = call => {
      if (call.path !== '/api/v1/orders/search') return { status: 404, json: {} }
      if (call.headers['X-PGPrints-Store-Id'] === G.storeId) return { status: 401, json: { success: false, message: `Permission denied for ${G.secretKey}` } }
      return { status: 200, json: { success: true, data: [{ id: 'i2', pgcOrderId: `PG-${rm.number}`, orderId: rm.number, itemStatuses: ['fulfilled'], childDetails: [{ sku: 'UT2-One_size', status: 'fulfilled', trackingNumber: `TRK-${rm.number}`, carrierCode: 'usps' }] }] } }
    }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await syncPgprintsTracking()
      expect(pgCalls('/orders/search').map(c => c.headers['X-PGPrints-Store-Id'])).toEqual([G.storeId, R.storeId])
      expect(r).toMatchObject({ pushes: 1, found: 1, shipments: 1 })
      expect(r.stores).toEqual([
        { store: 'T15 Litzzy', outcome: 'failed', pushes: 1, found: 0, shipments: 0, error: expect.stringContaining('Permission denied') },
        { store: 'T15 Reminiso', outcome: 'pulled', pushes: 1, found: 1, shipments: 1 },
      ])
      expect(JSON.stringify(r)).not.toContain(G.secretKey)
      const logged = err.mock.calls.map(c => c.map(String).join(' ')).join('\n')
      expect(logged).toContain('T15 Litzzy')
      expect(logged).not.toContain(G.secretKey)
    } finally {
      err.mockRestore()
    }
    expect((await prisma.shipment.findFirstOrThrow({ where: { orderId: rm.id } })).trackingNumber).toBe(`TRK-${rm.number}`)
    expect(await prisma.shipment.count({ where: { orderId: lz.id } })).toBe(0)
  })

  it('a store with no key shows in the same list as skipped', async () => {
    const orphan = await makeOrder(nokey, PROJECT_X, { tag: 'X' })
    await prisma.supplierOrderPush.create({
      data: { orderId: orphan.id, supplierId: PG_SUP, externalOrderId: orphan.number, activeKey: `${orphan.id}::${PG_SUP}`, status: 'CREATED', supplierOrderCode: 'PG-O', requestJson: '{}' },
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const r = await syncPgprintsTracking()
      expect(r.stores).toEqual([{ store: 'T15 Nokey', outcome: 'no-key', pushes: 1, found: 0, shipments: 0 }])
      expect(r).toMatchObject({ pushes: 0, skipped: expect.stringContaining('T15 Nokey') })
    } finally {
      log.mockRestore()
    }
  })
})

describe('what the push window is told', () => {
  it('a store other than Litzzy gets its own text for a missing key or a switch that is off, and never the shared-key page', async () => {
    const x = await makeOrder(nokey, PROJECT_X, { tag: 'X' })
    const keyless = (await buildPush(x.id))!.preview
    expect(keyless.storeNote).toContain('T15 Nokey')
    expect(keyless.storeNote).toContain('Setup')
    expect(keyless.storeNote).not.toContain('trang cài đặt xưởng Pgprints')

    await setStorePgprints(reminiso, R, false)
    const r = await makeOrder(reminiso, PROJECT_R, { tag: 'R' })
    const off = (await buildPush(r.id))!.preview
    expect(off).toMatchObject({ hasCredentials: true, pushEnabled: false })
    expect(off.storeNote).toContain('T15 Reminiso')
    expect(off.storeNote).toContain('Setup')
    expect(off.storeNote).not.toContain('trang cài đặt xưởng Pgprints')

    await setStorePgprints(reminiso, R, true)
    expect((await buildPush(r.id))!.preview.storeNote).toBeNull()
  })

  it('Litzzy keeps today\'s texts: no store note and no extra issue, key missing or switch off', async () => {
    const l = await makeOrder(litzzy, PROJECT_L, { tag: 'L' })
    await setGlobalPgprints(null)
    const none = (await buildPush(l.id))!.preview
    expect(none).toMatchObject({ hasCredentials: false, pushEnabled: false, storeNote: null })
    expect(none.issues.map(i => i.code)).not.toContain('NO_CREDENTIALS')
    await setGlobalPgprints(G, false)
    const off = (await buildPush(l.id))!.preview
    expect(off).toMatchObject({ hasCredentials: true, pushEnabled: false, storeNote: null })
  })

  it('a half Merchize account is the store missing its URL or token, never the server missing its variables', async () => {
    process.env.MERCHIZE_API_URL = MZ_SERVER.url
    process.env.MERCHIZE_API_TOKEN = MZ_SERVER.token
    const a = await makeOrder(reminiso, PROJECT_R, { tag: 'M', supplier: 'mz' })

    await setStoreSetting(reminiso, 'merchize.apiUrl', MZ_STORE.url)
    const urlOnly = (await buildMerchizePush(a.id))!.preview
    const urlOnlyIssue = urlOnly.issues.find(i => i.code === 'NO_CREDENTIALS')!
    for (const text of [urlOnly.storeNote!, urlOnlyIssue.message]) {
      expect(text).toContain('T15 Reminiso')
      expect(text).toContain('token')
      expect(text).not.toContain('MERCHIZE_API_URL')
    }
    const refused = await pushMerchizeOrder(a.id, { payloadHash: 'x', userId: null }).catch(e => e)
    expect(refused).toMatchObject({ status: 400, code: 'NO_CREDENTIALS' })
    expect(refused.message).toContain('token')
    expect(refused.message).not.toContain('MERCHIZE_API_URL')

    await setStoreSetting(reminiso, 'merchize.apiUrl', null)
    await setStoreSetting(reminiso, 'merchize.token', MZ_STORE.token)
    const tokenOnly = (await buildMerchizePush(a.id))!.preview
    expect(tokenOnly.storeNote).toContain('URL')
    expect(tokenOnly.storeNote).not.toContain('MERCHIZE_API_URL')

    await setStoreSetting(reminiso, 'merchize.token', null)
    delete process.env.MERCHIZE_API_URL
    delete process.env.MERCHIZE_API_TOKEN
    const neither = (await buildMerchizePush(a.id))!.preview
    expect(neither.storeNote).toContain('T15 Reminiso')
    expect(neither.storeNote).toContain('MERCHIZE_API_URL')
    expect(calls).toHaveLength(0)
  })
})

describe('the push switch rule', () => {
  const on = { storeId: 'a', secretKey: 'b', pushEnabled: true }
  it('turning it on needs a Store ID and a secret key; a key taken away turns it off', () => {
    expect(pushSwitchAfter(on, {})).toEqual({ pushEnabled: undefined })
    expect(pushSwitchAfter({ ...on, pushEnabled: false }, { pushEnabled: true })).toEqual({ pushEnabled: true })
    expect(pushSwitchAfter({ ...on, secretKey: null, pushEnabled: false }, { pushEnabled: true })).toEqual({ error: expect.stringContaining('Store ID') })
    expect(pushSwitchAfter({ ...on, pushEnabled: false }, { secretKey: null, pushEnabled: true })).toEqual({ error: expect.stringContaining('Store ID') })
    expect(pushSwitchAfter(on, { secretKey: null })).toEqual({ pushEnabled: false })
    expect(pushSwitchAfter(on, { storeId: '' })).toEqual({ pushEnabled: false })
    expect(pushSwitchAfter(on, { pushEnabled: false })).toEqual({ pushEnabled: false })
    expect(pushSwitchAfter({ ...on, pushEnabled: false, secretKey: null }, { defaultShipClass: 'x' } as never)).toEqual({ pushEnabled: undefined })
  })
})

describe('the refusal order', () => {
  it('Litzzy: switch off is answered before a missing key, as before; another store: the missing key first', async () => {
    const l = await makeOrder(litzzy, PROJECT_L, { tag: 'L' })
    await setGlobalPgprints(null)
    expect(await pushOrder(l.id, { payloadHash: 'x', userId: null }).catch(e => e)).toMatchObject({ status: 403, code: 'PUSH_DISABLED', message: 'Chưa bật gửi đơn sang PGprints — bật ở trang cài đặt xưởng Pgprints' })
    await setGlobalPgprints(G)
    await prisma.appSetting.deleteMany({ where: { key: PGPRINTS_KEYS.secretKey } })
    expect(await pushOrder(l.id, { payloadHash: 'x', userId: null }).catch(e => e)).toMatchObject({ status: 400, code: 'NO_CREDENTIALS', message: 'Chưa cấu hình Store ID / Secret key PGprints' })

    const x = await makeOrder(nokey, PROJECT_X, { tag: 'X' })
    expect(await pushOrder(x.id, { payloadHash: 'x', userId: null }).catch(e => e)).toMatchObject({ status: 400, code: 'NO_CREDENTIALS' })
    expect(calls).toHaveLength(0)
  })
})

describe('PGprints webhook with one key on two stores', () => {
  it('both stores match that key; each order is found by its own external id and nothing else changes', async () => {
    await setStorePgprints(reminiso, R)
    await setStorePgprints(nokey, R)
    const rm = await makeOrder(reminiso, PROJECT_R, { tag: 'R' })
    const nk = await makeOrder(nokey, PROJECT_X, { tag: 'X' })
    const lz = await makeOrder(litzzy, PROJECT_L, { tag: 'L' })
    for (const o of [rm, nk, lz]) await pushIt(o.id)

    expect(await (await hook(tracking(rm, 'RM1'), R.secretKey)).json()).toMatchObject({ ignored: false, shipments: 1 })
    expect(await (await hook(tracking(nk, 'NK1'), R.secretKey)).json()).toMatchObject({ ignored: false, shipments: 1 })
    expect((await prisma.shipment.findFirstOrThrow({ where: { orderId: rm.id } })).trackingNumber).toBe('RM1')
    expect((await prisma.shipment.findFirstOrThrow({ where: { orderId: nk.id } })).trackingNumber).toBe('NK1')
    // The shared key says nothing about Litzzy's order, which has a key of its own.
    expect(await (await hook(tracking(lz, 'LZ-WRONG'), R.secretKey)).json()).toMatchObject({ ignored: true, reason: 'unknown order' })
    expect(await prisma.shipment.count({ where: { orderId: lz.id } })).toBe(0)
    expect(await (await hook(tracking(lz, 'LZ1'), G.secretKey)).json()).toMatchObject({ ignored: false, shipments: 1 })
    expect(await prisma.shipment.count({ where: { orderId: { in: [rm.id, nk.id] } } })).toBe(2)
  })
})

describe('CSV export never mixes stores for PGprints', () => {
  const exportCsv = (body: Record<string, unknown>) => postExport(new NextRequest('http://x/api/fulfillment/export', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }))

  it('answers 400 naming the stores, with no file and nothing marked, when the orders belong to more than one store', async () => {
    const lz = await makeOrder(litzzy, PROJECT_L, { tag: 'L' })
    const rm = await makeOrder(reminiso, PROJECT_R, { tag: 'R' })
    for (const extra of [{ preview: true }, { markExported: true }]) {
      const res = await exportCsv({ templateId: pgTemplateId, ...extra })
      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = await res.json()
      expect(body.code).toBe('MIXED_STORES')
      expect(body.error).toContain('T15 Litzzy')
      expect(body.error).toContain('T15 Reminiso')
    }
    expect(await prisma.orderLine.count({ where: { orderId: { in: [lz.id, rm.id] }, exportedAt: { not: null } } })).toBe(0)
  })

  it('one store picked: the file holds that store only and its name carries the store prefix', async () => {
    const lz = await makeOrder(litzzy, PROJECT_L, { tag: 'L' })
    const rm = await makeOrder(reminiso, PROJECT_R, { tag: 'R' })
    const res = await exportCsv({ templateId: pgTemplateId, storeId: reminiso })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="pgprints_REM_all_to_all.csv"')
    const csv = await res.text()
    expect(csv).toContain(rm.number)
    expect(csv).not.toContain(lz.number)
  })

  it('only one store has PGprints orders: the same CSV as before, with the prefix in the name', async () => {
    const rm = await makeOrder(reminiso, PROJECT_R, { tag: 'R' })
    const res = await exportCsv({ templateId: pgTemplateId, dateFrom: '2026-10-01', dateTo: '2026-10-31' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="pgprints_REM_2026-10-01_to_2026-10-31.csv"')
    expect((await res.text()).replace(/^﻿/, '').trim().split(/\r?\n/).map(line => line.replace('#', ''))).toEqual(['Order', rm.number])
  })

  it('another supplier keeps exporting every store together under its old file name', async () => {
    const lz = await makeOrder(litzzy, PROJECT_L, { tag: 'L', supplier: 'other' })
    const rm = await makeOrder(reminiso, PROJECT_R, { tag: 'R', supplier: 'other' })
    const res = await exportCsv({ templateId: otherTemplateId })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="other_t15_all_to_all.csv"')
    const csv = await res.text()
    expect(csv).toContain(lz.number)
    expect(csv).toContain(rm.number)
  })
})

describe('ParcelPanel runs', () => {
  const expired = { authMode: 'CLIENT_CREDENTIALS', clientId: 'cid', clientSecret: 'csecret', accessToken: null, tokenExpiresAt: null } as const

  it('with no key on any store the daily run stops before opening a Shopify connection', async () => {
    for (const id of [litzzy, reminiso, nokey]) await saveStoreCredential(id, { ...expired })
    await prisma.appSetting.deleteMany({ where: { key: PARCELPANEL_KEY_SETTING } })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runDailyParcelPanelSync()
    } finally {
      log.mockRestore()
      await prisma.shopifyStoreCredential.deleteMany({ where: { storeId: { in: [litzzy, reminiso, nokey] } } })
    }
    expect(calls).toHaveLength(0)
    expect(mocks.parcelpanel).not.toHaveBeenCalled()
  })

  it('a store without a key is reported as skipped in the run summary, and its Shopify connection is not opened', async () => {
    await setParcelPanelApiKey('shared-pp-key-111111')
    await saveStoreCredential(litzzy, { authMode: 'TOKEN', accessToken: 'tok-l' })
    await saveStoreCredential(reminiso, { ...expired })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const res = await postParcelSync()
      const lines = (await res.text()).trim().split('\n').map(l => JSON.parse(l))
      const done = lines.at(-1)
      expect(done.type).toBe('done')
      const mine = done.stores.filter((s: { shop: string }) => [LITZZY_SHOP, SHOP_R].includes(s.shop))
      expect(mine).toEqual([
        { storeId: litzzy, shop: LITZZY_SHOP, ok: true },
        { storeId: reminiso, shop: SHOP_R, ok: false, skipped: true, error: expect.stringContaining('ParcelPanel') },
      ])
    } finally {
      log.mockRestore()
      await prisma.shopifyStoreCredential.deleteMany({ where: { storeId: { in: [litzzy, reminiso] } } })
    }
    expect(calls).toHaveLength(0)
  })
})

describe('/api/stores/[id]/settings: one write, no stray fields', () => {
  const request = (id: string, body: unknown) => new NextRequest(`http://x/api/stores/${id}/settings`, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
  const put = async (id: string, body: unknown) => {
    const r = request(id, body)
    r.cookies.set(AUTH_COOKIE, superToken)
    return putSettings(r, { params: { id } })
  }

  it('a field the section does not have is a 400 naming it, and nothing is written', async () => {
    const res = await put(nokey, { merchize: { url: MZ_STORE.url, token: MZ_STORE.token } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('merchize.url')
    expect(await prisma.appSetting.count({ where: { key: { startsWith: `store.${nokey}.` } } })).toBe(0)
    const pg = await put(nokey, { pgprints: { secret: 'typo-secret-value' } })
    expect(pg.status).toBe(400)
    expect((await pg.json()).error).toContain('pgprints.secret')
    expect((await put(nokey, { parcelpanel: { key: 'x' } })).status).toBe(400)
  })

  it('all the writes of one PUT are one transaction: a failure part way leaves no half Merchize pair', async () => {
    const real = prisma.$transaction.bind(prisma) as (run: (tx: any) => Promise<unknown>) => Promise<unknown>
    let upserts = 0
    const spy = vi.spyOn(prisma, '$transaction').mockImplementationOnce(((run: (tx: any) => Promise<unknown>) => real(async tx => {
      const appSetting = new Proxy(tx.appSetting, {
        get(target, prop) {
          const value = target[prop]
          if (prop !== 'upsert') return typeof value === 'function' ? value.bind(target) : value
          return (...args: unknown[]) => {
            upserts++
            if (upserts === 2) throw new Error('disk full')
            return value.apply(target, args)
          }
        },
      })
      return run(new Proxy(tx, { get: (target, prop) => (prop === 'appSetting' ? appSetting : target[prop]) }))
    })) as never)
    try {
      await expect(put(nokey, { merchize: { apiUrl: MZ_STORE.url, token: MZ_STORE.token } })).rejects.toThrow('disk full')
    } finally {
      spy.mockRestore()
    }
    expect(upserts).toBe(2)
    expect(await getStoreSetting(nokey, 'merchize.apiUrl')).toBeNull()
    expect(await getStoreSetting(nokey, 'merchize.token')).toBeNull()
  })
})
