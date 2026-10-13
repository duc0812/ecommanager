import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const SHOP = 'trello-mode.myshopify.com'
type Card = { id: string; name: string; url: string; attachments: { name: string; url: string }[] }
const state: { cards: Card[] } = { cards: [] }

vi.mock('@/lib/token-store', () => ({
  getShopifyConnection: vi.fn(async () => ({ shop: 'trello-mode.myshopify.com', token: 'test_token', connectedAt: new Date() })),
}))
vi.mock('@/lib/trello', () => ({
  getTrelloConfig: vi.fn(async () => ({ apiKey: 'k', token: 't', boardId: 'b', listId: 'todo', doneListId: 'done', syncFromOrderName: '' })),
  createTrelloCard: vi.fn(async (_cfg: unknown, name: string) => ({ id: `card-${name}`, name, url: `https://trello.com/c/${encodeURIComponent(name)}` })),
  addAttachmentToCard: vi.fn(async () => {}),
  shouldCreateCard: vi.fn(() => true),
  getCardsByList: vi.fn(async () => state.cards),
  getCardDesc: vi.fn(async () => ''),
  updateCardDesc: vi.fn(async () => {}),
}))

import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { DEFAULT_DESIGN_SETTINGS, getDesignSettings, saveDesignSettings, type TrelloMode } from '@/lib/design-settings'
import { createTrelloCard, getCardsByList, getCardDesc } from '@/lib/trello'
import { POST as trelloSync } from '@/app/api/trello/sync/route'
import { POST as backfill } from '@/app/api/trello/backfill-custom-info/route'
import { GET as diagnose } from '@/app/api/fulfillment/design-diagnose/route'
import { POST as ordersSync } from '@/app/api/shopify/orders/sync/route'
import { GET as getSettings, PUT as putSettings } from '@/app/api/design-studio/settings/route'
import { loadWorkspace } from '@/lib/design-studio'

const PROJECT = 'proj_trello_mode'
const SUP = 'sup_trello_mode'
const VARIANT_ID = 'gid://shopify/ProductVariant/trello-mode-1'
let storeId = ''
let superToken = ''
let userId = ''

const setMode = (trelloMode: TrelloMode) => saveDesignSettings({ ...DEFAULT_DESIGN_SETTINGS, trelloMode })

function shopifyOrder(n: number) {
  return {
    id: `gid://shopify/Order/trello-mode-${n}`, name: `#TMS${n}`,
    createdAt: '2026-10-10T07:06:00Z', processedAt: '2026-10-10T07:06:00Z',
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', currencyCode: 'USD',
    currentTotalPriceSet: { shopMoney: { amount: '30' } }, currentSubtotalPriceSet: { shopMoney: { amount: '30' } },
    currentTotalTaxSet: { shopMoney: { amount: '0' } }, currentShippingPriceSet: { shopMoney: { amount: '0' } },
    customer: { email: 'a@b.test', displayName: 'A B' },
    shippingAddress: { country: 'United States', countryCodeV2: 'US', province: 'CA' },
    taxLines: [],
    lineItems: { nodes: [{
      id: `gid://shopify/LineItem/trello-mode-${n}`, sku: 'TM-TEE', title: 'Trello Tee', variantTitle: 'M', quantity: 1,
      originalUnitPriceSet: { shopMoney: { amount: '30' } },
      product: { tags: [], productType: 'T-Shirt' },
      variant: { id: VARIANT_ID, selectedOptions: [{ name: 'Size', value: 'M' }] },
    }] },
    transactions: [], refunds: [],
  }
}

async function syncShopifyOrder(n: number) {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true, text: async () => '',
    json: async () => ({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [shopifyOrder(n)] } } }),
  } as Response)
  try {
    const res = await ordersSync(new Request('http://test/api/shopify/orders/sync', { method: 'POST' }) as any)
    return { body: await res.json(), order: await prisma.order.findUnique({ where: { id: `gid://shopify/Order/trello-mode-${n}` } }) }
  } finally { fetchSpy.mockRestore() }
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'Trello mode', startDate: new Date('2026-05-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({
    where: { shop: SHOP }, create: { shop: SHOP, syncSinceDate: new Date('2026-05-01'), projectId: PROJECT }, update: { projectId: PROJECT },
  })).id
  await prisma.supplier.upsert({ where: { code: 'TRELLOMODE' }, create: { id: SUP, name: 'Trello Mode Supplier', code: 'TRELLOMODE' }, update: { isActive: true } })
  const sp = await prisma.supplierProduct.upsert({
    where: { supplierId_sku: { supplierId: SUP, sku: 'TM-TEE-M' } }, create: { supplierId: SUP, sku: 'TM-TEE-M', baseCost: 5 }, update: {},
  })
  await prisma.variantManualMapping.upsert({
    where: { shopifyVariantId: VARIANT_ID },
    create: { shopifyVariantId: VARIANT_ID, shopifyProductTitle: 'Trello Tee', variantTitle: 'M', supplierProductId: sp.id },
    update: { supplierProductId: sp.id },
  })
  const user = await prisma.appUser.upsert({ where: { email: 'super@trello-mode.test' }, create: { name: 'Super', email: 'super@trello-mode.test', role: 'SUPERADMIN' }, update: {} })
  userId = user.id
  superToken = await signToken({ userId, email: user.email, name: 'Super', role: 'SUPERADMIN', permissions: [], tv: 0 })
})

beforeEach(async () => {
  state.cards = []
  vi.mocked(createTrelloCard).mockClear()
  vi.mocked(getCardsByList).mockClear()
  vi.mocked(getCardDesc).mockClear()
  await setMode('BOTH')
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { storeId } })
  await prisma.variantManualMapping.deleteMany({ where: { shopifyVariantId: VARIANT_ID } })
  await prisma.skuSupplierDesign.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
})

describe('trelloMode setting', () => {
  const put = (body: Record<string, unknown>) => {
    const req = new NextRequest('http://x/api/design-studio/settings', {
      method: 'PUT', body: JSON.stringify({ slaCustomHours: 24, slaNonCustomHours: 48, kpiByType: { default: 0.3 }, rejectReasons: ['x'], ...body }),
    })
    req.cookies.set(AUTH_COOKIE, superToken)
    return putSettings(req)
  }

  it('defaults to BOTH, also for settings saved before the field existed', async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
    expect((await getDesignSettings()).trelloMode).toBe('BOTH')
    await prisma.appSetting.create({ data: { key: 'design.settings', value: JSON.stringify({ slaCustomHours: 10, trelloMode: 'nonsense' }) } })
    expect(await getDesignSettings()).toMatchObject({ slaCustomHours: 10, trelloMode: 'BOTH' })
  })

  it('PUT saves a valid mode, keeps it when the field is left out, and refuses an unknown one', async () => {
    const saved = await put({ trelloMode: 'READ_ONLY' })
    expect(saved.status).toBe(200)
    expect((await saved.json()).trelloMode).toBe('READ_ONLY')
    expect((await (await put({})).json()).trelloMode).toBe('READ_ONLY')
    expect((await put({ trelloMode: 'SOMETIMES' })).status).toBe(400)
    const req = new NextRequest('http://x/api/design-studio/settings')
    req.cookies.set(AUTH_COOKIE, superToken)
    expect((await (await getSettings(req)).json()).trelloMode).toBe('READ_ONLY')
  })
})

describe('Trello card creation at order sync', () => {
  it('BOTH creates a card for an order whose design is missing', async () => {
    const { body, order } = await syncShopifyOrder(1)
    expect(body.totalSynced).toBe(1)
    expect(createTrelloCard).toHaveBeenCalledTimes(1)
    expect(order?.trelloCardId).toBeTruthy()
    expect((await loadWorkspace(order!.id))?.order.trelloCardUrl).toBe(order?.trelloCardUrl)
  })

  it.each(['READ_ONLY', 'OFF'] as TrelloMode[])('%s creates no card, the order still gets its design task', async (mode) => {
    await setMode(mode)
    const n = mode === 'READ_ONLY' ? 2 : 3
    const { body, order } = await syncShopifyOrder(n)
    expect(body.totalSynced).toBe(1)
    expect(createTrelloCard).not.toHaveBeenCalled()
    expect(order?.trelloCardId).toBeNull()
    expect(order?.pipelineStatus).toBe('PENDING_DESIGN')
    expect(await prisma.designTask.count({ where: { orderId: order!.id } })).toBe(1)
  })
})

describe('Trello readers', () => {
  it('OFF: POST /api/trello/sync reads nothing and says why', async () => {
    await setMode('OFF')
    const body = await (await trelloSync()).json()
    expect(body).toMatchObject({ skipped: true, updated: 0, cardsChecked: 0 })
    expect(body.message).toContain('Trello đang tắt')
    expect(getCardsByList).not.toHaveBeenCalled()
  })

  it('OFF: the card backfill and the design diagnosis refuse to read Trello', async () => {
    await setMode('OFF')
    const b = await backfill(new Request('http://x/api/trello/backfill-custom-info', { method: 'POST', body: JSON.stringify({ dryRun: true }) }))
    expect(b.status).toBe(400)
    expect((await b.json()).error).toContain('Trello đang tắt')
    const d = await diagnose(new NextRequest('http://x/api/fulfillment/design-diagnose?order=TMS1'))
    expect(d.status).toBe(400)
    expect(getCardsByList).not.toHaveBeenCalled()
    expect(getCardDesc).not.toHaveBeenCalled()
  })

  it.each(['BOTH', 'READ_ONLY'] as TrelloMode[])('%s: POST /api/trello/sync still reads the Done list', async (mode) => {
    await setMode(mode)
    const body = await (await trelloSync()).json()
    expect(body.skipped).toBeUndefined()
    expect(getCardsByList).toHaveBeenCalledTimes(1)
  })
})

describe('Trello sync never overwrites Design Studio work', () => {
  const ORDER = 'gid://test/Order/trello-mode-own'
  const STUDIO_LINK = '/api/design-studio/file/tm-art'
  const OLD_TRELLO = 'https://drive.google.com/file/d/old-trello'
  const att = (n: number) => `https://drive.google.com/file/d/new-trello-${n}`

  beforeAll(async () => {
    const line = (n: number, link: string | null) => ({
      shopifyLineId: `o${n}`, sku: `TMO-${n}`, productTitle: 'Mug', qty: 1, linePosition: n, unitPrice: 1, resolvedSupplierId: SUP, designDriveLink: link,
    })
    await prisma.order.create({ data: {
      id: ORDER, projectId: PROJECT, storeId, shopifyOrderNumber: '#TMO1', financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-09'),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM', trelloCardId: 'card-own', trelloCardUrl: 'https://trello.com/c/own',
      lines: { create: [line(1, null), line(2, STUDIO_LINK), line(3, null), line(4, OLD_TRELLO), line(5, null), line(6, OLD_TRELLO)] },
    } })
    const art = (lineId: string, removed = false) => prisma.designArtwork.create({ data: {
      orderId: ORDER, shopifyLineId: lineId, printArea: 'Artwork', version: 1, fileName: 'a.png', storagePath: 'x/a.png', size: 1, mimeType: 'image/png',
      removedAt: removed ? new Date() : null,
    } })
    await art('o2')
    await art('o5', true)
    await prisma.designTask.create({ data: { orderId: ORDER, shopifyLineId: 'o2', taskKey: 'TMO1_2', status: 'DONE' } })
    await prisma.designTask.create({ data: { orderId: ORDER, shopifyLineId: 'o3', taskKey: 'TMO1_3', status: 'DOING', assigneeId: userId,
      events: { create: { type: 'STATUS', message: 'Nhận việc', actorId: userId } } } })
    await prisma.designTask.create({ data: { orderId: ORDER, shopifyLineId: 'o4', taskKey: 'TMO1_4', status: 'REJECTED', rejectReasons: JSON.stringify(['Xưởng trả file']),
      events: { create: { type: 'SYSTEM', message: 'Xưởng trả file — mở lại task' } } } })
    await prisma.designTask.create({ data: { orderId: ORDER, shopifyLineId: 'o6', taskKey: 'TMO1_6', status: 'DONE',
      events: { create: [{ type: 'STATUS', message: 'Nhận việc', actorId: userId }, { type: 'STATUS', message: 'Duyệt design', actorId: userId }] } } })
  })

  it('fills untouched lines, leaves lines with a file or a task a person moved, and counts what it kept', async () => {
    state.cards = [{
      id: 'card-own', name: '#TMO1 - TMO-1 / TMO-2', url: 'https://trello.com/c/own',
      attachments: [1, 2, 3, 4, 5, 6].map(n => ({ name: `TMO1_${n}`, url: att(n) })),
    }]
    const body = await (await trelloSync()).json()
    const links = Object.fromEntries((await prisma.orderLine.findMany({ where: { orderId: ORDER } })).map(l => [l.shopifyLineId, l.designDriveLink]))
    expect(links).toEqual({
      o1: att(1),          // nobody touched it
      o2: STUDIO_LINK,     // approved in the studio, has a file
      o3: null,            // a designer took the task
      o4: att(4),          // reopened by the system only — Trello still owns it
      o5: att(5),          // its only file was removed
      o6: OLD_TRELLO,      // approved by a person in the studio
    })
    expect(body.studioLinesKept).toBe(3)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: ORDER } })
    expect(order.designReady).toBe(false)
    expect(order.pipelineStatus).toBe('PENDING_DESIGN')
    expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'TMO1_3' } })).status).toBe('DOING')
  })
})
