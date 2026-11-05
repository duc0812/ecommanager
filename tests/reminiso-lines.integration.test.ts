import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { saveStoreCredential } from '@/lib/store-connections'
import { syncStoreOrders } from '@/lib/shopify-order-sync'
import { listTasks, loadTask, syncDesignTasks } from '@/lib/design-tasks'
import { loadWorkspace } from '@/lib/design-studio'
import { saveManualMapping } from '@/lib/repos/mapping'
import { reevaluateOrdersForDesignEntry } from '@/lib/repos/design-reeval'
import { hasUnresolvedProductLine } from '@/lib/order-lines'
import { POST as manualMappingPost } from '@/app/api/fulfillment/mapping/manual/route'
import { runAutoFulfill } from '@/lib/fulfillment/auto-fulfill'
import { queueRenderLine, queueScheduledRenders } from '@/lib/repos/artwork-render'
import { TEEINBLUE_REASON } from '@/lib/artwork-render-eligibility'
import { isAutoNotRendered, needsArtwork } from '@/app/design-studio/components/model'

// tests/fixtures/reminiso-order.json is four real Reminiso orders (#REMI1110, 1147, 1142, 1089) in the shape Shopify's GraphQL
// returns to the sync, renumbered #REMI9001-9004. Customer, address and every typed personalisation value are placeholders;
// attribute keys, titles, variant titles, SKUs (null = none), quantities and prices are the real ones.
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'reminiso-order.json'), 'utf8'))
const fixtureNodes: any[] = fixture.data.orders.nodes
const fixtureOrder = (name: string) => structuredClone(fixtureNodes.find(n => n.name === name))
const fixtureLine = (id: string) => fixtureNodes.flatMap(n => n.lineItems.nodes).find((l: any) => l.id === id)
const lineId = (order: number, position: number) => `gid://shopify/LineItem/remi-test-${order}-${position}`

const SHOP = 'remi14.myshopify.com'
const PROJECT = 'proj_remi14'
const SUP = 'sup_remi14'
const TPL = 'tpl_remi14'
const ADVENT_VARIANT = 'gid://shopify/ProductVariant/67881906831645'
const TOPPER_VARIANT = 'gid://shopify/ProductVariant/67882273276189'
const TOTE_VARIANT = 'gid://shopify/ProductVariant/67920004088093'
const LEGGINGS_VARIANT = 'gid://shopify/ProductVariant/67740383478045'
const TB_PRODUCT = 'gid://shopify/Product/remi14-tb'
const TB_ART_ONLY_PRODUCT = 'gid://shopify/Product/remi14-tb-art-only'
const ART_SHA = 'remi14-art-'
const ACTOR = { id: 'remi14-actor', name: 'Remi14', role: 'ADMIN' }
const NAME_FIELD = { field: 'Enter Name', layer: '@Enter Name', sample: 'Sample', font: 'Sample', sizePx: 120, color: '#000000', align: 'left',
  box: { x: 100, y: 100, w: 1000, h: 300 }, anchor: 'center', fit: 'shrink' }

let storeId = ''
const realFetch = global.fetch
let served: any[] = []
let servedFulfillmentOrders: any[] = []

function installFetch() {
  global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const query = String(JSON.parse(String(init?.body ?? '{}')).query ?? '')
    const data = query.includes('ShopInfo')
      ? { shop: { ianaTimezone: 'America/Chicago', timezoneAbbreviation: 'CST' } }
      : query.includes('fulfillmentOrders')
        ? { orders: { nodes: servedFulfillmentOrders } }
        : { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: served } }
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

const sync = (...orders: any[]) => { served = orders; return syncStoreOrders(storeId) }
const orderRow = (name: string) => prisma.order.findFirstOrThrow({ where: { storeId, shopifyOrderNumber: name }, include: { lines: { orderBy: { linePosition: 'asc' } } } })
const taskFor = (orderId: string, shopifyLineId: string) => prisma.designTask.findUnique({ where: { orderId_shopifyLineId: { orderId, shopifyLineId } } })
const attrsOf = (line: { customAttributesJson: string | null }) => JSON.parse(line.customAttributesJson ?? '[]')
const ours = <T extends { orderNumber: string }>(rows: T[]) => rows.filter(r => r.orderNumber.startsWith('#REMI9'))

async function mapVariant(shopifyVariantId: string, supplierProductId: string) {
  await prisma.variantManualMapping.create({ data: { shopifyVariantId, shopifyProductTitle: 'Reminiso test', supplierProductId } })
}

async function mapTote() {
  const tote = await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'REMI14-TOTE-L', baseCost: 14 } })
  await mapVariant(TOTE_VARIANT, tote.id)
}

async function wipe() {
  const orders = await prisma.order.findMany({ where: { storeId }, select: { id: true } })
  await prisma.artworkJob.deleteMany({ where: { orderId: { in: orders.map(o => o.id) } } })
  await prisma.order.deleteMany({ where: { storeId } })
  await prisma.artworkEntry.deleteMany({ where: { storeId } })
  await prisma.libraryFile.deleteMany({ where: { sha256: { startsWith: ART_SHA } } })
  await prisma.productProfile.deleteMany({ where: { storeId } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: SUP } })
}

// A Teeinblue leggings product the library can render a name onto: supplier product, template, READY artwork entry with `fields`.
async function leggingsProduct(productId: string, variantIds: string[], fields: unknown[]) {
  const tail = productId.split('/').pop()!
  const sp = await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: `REMI14-${tail}`, baseCost: 12 } })
  for (const v of variantIds) await mapVariant(v, sp.id)
  await prisma.productProfile.create({ data: { storeId, shopifyProductId: productId, title: 'Teeinblue leggings', printTemplateId: TPL } })
  const art = await prisma.libraryFile.create({ data: { kind: 'ARTWORK', fileName: 'artwork.png', mimeType: 'image/png', size: 1, sha256: `${ART_SHA}${tail}`, storagePath: `library/remi14/${tail}.png` } })
  await prisma.artworkEntry.create({ data: {
    storeId, shopifyProductId: productId, printTemplateId: TPL, supplierId: SUP, title: 'Teeinblue leggings', status: 'READY',
    artworkFileId: art.id, fields: JSON.stringify(fields), parsedAt: new Date(),
  } })
}

// The leggings line of #REMI9004 on another product and variant, carrying only `attrs`.
function leggingsOrder(name: string, productId: string, variantId: string, attrs: Array<{ key: string; value: string }>) {
  const node = fixtureOrder('#REMI9004')
  const line = node.lineItems.nodes[0]
  node.id = `gid://shopify/Order/remi14-${name}`
  node.name = `#${name}`
  line.id = `gid://shopify/LineItem/remi14-${name}`
  line.product.id = productId
  line.variant.id = variantId
  line.customAttributes = attrs
  return node
}

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'Remi14', startDate: new Date('2026-05-01') }, update: { archivedAt: null } })
  storeId = (await prisma.shopifyStore.upsert({
    where: { shop: SHOP },
    create: { shop: SHOP, projectId: PROJECT, orderPrefix: 'REMI', syncSinceDate: new Date('2026-05-01'), connectedAt: new Date('2026-09-01') },
    update: { projectId: PROJECT, orderPrefix: 'REMI', syncSinceDate: new Date('2026-05-01') },
  })).id
  await saveStoreCredential(storeId, { authMode: 'TOKEN', accessToken: 'token-remi14' })
  await prisma.supplier.create({ data: { id: SUP, name: 'Remi14 Sup', code: 'REMI14', firstItemShipFee: 5, additionalItemShipFee: 2 } })
  await prisma.printTemplate.create({ data: {
    id: TPL, supplierId: SUP, name: 'Remi14 leggings', widthPx: 3000, heightPx: 3000, dpi: 300, areas: JSON.stringify([{ name: 'Print', x: 0, y: 0, w: 3000, h: 3000 }]),
  } })
})

beforeEach(async () => {
  installFetch()
  await wipe()
})

afterEach(() => { global.fetch = realFetch })

afterAll(async () => {
  await wipe()
  await prisma.printTemplate.deleteMany({ where: { id: TPL } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.shopifyStore.deleteMany({ where: { id: storeId } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
})

describe('Reminiso order lines', () => {
  it('a line with no SKU and a VariantManualMapping resolves its supplier', async () => {
    const advent = await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'REMI14-ADVENT', baseCost: 21.5 } })
    const topper = await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'REMI14-TOPPER-6IN', baseCost: 8.25 } })
    await mapVariant(ADVENT_VARIANT, advent.id)
    await mapVariant(TOPPER_VARIANT, topper.id)

    const result = await sync(fixtureOrder('#REMI9001'))

    expect(result).toMatchObject({ totalSynced: 1, withUnmappedSku: 0, errors: [] })
    const order = await orderRow('#REMI9001')
    const [noSku, withSku] = order.lines
    expect(noSku.sku).toBeNull()
    expect(withSku.sku).toBe('RM-TOP-TRACTOR-6IN')
    expect(noSku).toMatchObject({ resolvedSupplierId: SUP, resolvedSupplierSku: 'REMI14-ADVENT', resolvedBaseCost: 21.5 })
    expect(withSku).toMatchObject({ resolvedSupplierId: SUP, resolvedSupplierSku: 'REMI14-TOPPER-6IN', resolvedBaseCost: 8.25 })
    expect(order).toMatchObject({ pipelineStatus: 'PENDING_DESIGN', defaultSupplierId: SUP })
    expect((await taskFor(order.id, noSku.shopifyLineId))?.supplierSnapshot).toBe('Remi14 Sup')
  })

  it('a line with no SKU and no mapping is PENDING_MAPPING, has a design task, and does not throw', async () => {
    const result = await sync(fixtureOrder('#REMI9002'))

    expect(result.errors).toEqual([])
    expect(result.totalSynced).toBe(1)
    expect(result.withUnmappedSku).toBe(1)
    const order = await orderRow('#REMI9002')
    expect(order.pipelineStatus).toBe('PENDING_MAPPING')
    const tote = order.lines.find(l => l.sku === null)!
    expect(tote.productTitle).toContain('Quilted Tote Bag')
    expect(tote).toMatchObject({ resolvedSupplierId: null, resolvedBaseCost: null })

    const task = await taskFor(order.id, tote.shopifyLineId)
    expect(task).toMatchObject({ status: 'NEW', readiness: 'MANUAL', supplierSnapshot: null })
    expect(task!.taskKey).toBe('REMI9002_1')
    const row = (await listTasks({ taskKeys: [task!.taskKey] }))[0]
    expect(row).toMatchObject({ sku: null, unmapped: true, orderNumber: '#REMI9002' })
  })

  it('lines with Custom Name, Enter Name, _design and _tb_design keep their attributes and get a task', async () => {
    const result = await sync(...['#REMI9001', '#REMI9002', '#REMI9003', '#REMI9004'].map(fixtureOrder))
    expect(result).toMatchObject({ totalSynced: 4, errors: [] })

    const cases = [
      { label: 'Custom Name + _design, no SKU', order: '#REMI9003', line: lineId(9003, 2), sku: null, keys: ['Custom Name', '_design'] },
      { label: 'Custom Name + _design, with SKU', order: '#REMI9001', line: lineId(9001, 2), sku: 'RM-TOP-TRACTOR-6IN', keys: ['Custom Name', '_design'] },
      { label: 'Custom Name, no SKU', order: '#REMI9002', line: lineId(9002, 3), sku: null, keys: ['Custom Name'] },
      { label: 'Enter Name + _tb_design', order: '#REMI9004', line: lineId(9004, 1), sku: 'RM-LEG-HEART-M', keys: ['Skin Color', 'Enter Name', '_tb_design'] },
    ]
    for (const c of cases) {
      const order = await orderRow(c.order)
      const line = order.lines.find(l => l.shopifyLineId === c.line)!
      expect(line, c.label).toBeTruthy()
      expect(line.sku, c.label).toBe(c.sku)
      const original = fixtureLine(c.line)
      const stored = attrsOf(line)
      expect(stored.map((a: any) => a.key), c.label).toEqual([...c.keys, '_product_url'])
      expect(stored.slice(0, -1), c.label).toEqual(original.customAttributes)
      expect(stored.at(-1), c.label).toEqual({ key: '_product_url', value: original.product.onlineStoreUrl })
      expect(line.customized, c.label).toBe(true)
      expect(await taskFor(order.id, line.shopifyLineId), c.label).toMatchObject({ status: 'NEW' })
    }

    const found = ours(await listTasks({ q: 'name one' })).map(r => `${r.orderNumber}:${r.sku}`)
    expect(found).toEqual(expect.arrayContaining(['#REMI9001:RM-TOP-TRACTOR-6IN', '#REMI9002:null', '#REMI9003:null', '#REMI9004:RM-LEG-HEART-M']))
    expect(ours(await listTasks({ q: 'tb1' }))).toEqual([])
    expect(ours(await listTasks({ q: '369d6c43ca19' }))).toEqual([])
  })

  it('a line with only _tb_design is routed to manual design, not auto-render', async () => {
    // No real line carries only _tb_design: all eight also carry visible fields (Enter Name, Choose ...). These are the leggings
    // line of #REMI9004 with its visible fields taken off, on products whose library entry is READY.
    const tbDesign = fixtureLine(lineId(9004, 1)).customAttributes.find((a: any) => a.key === '_tb_design')
    await leggingsProduct(TB_PRODUCT, ['gid://shopify/ProductVariant/remi14-tb-only', 'gid://shopify/ProductVariant/remi14-tb-control', 'gid://shopify/ProductVariant/remi14-tb-with-name'], [NAME_FIELD])
    await leggingsProduct(TB_ART_ONLY_PRODUCT, ['gid://shopify/ProductVariant/remi14-tb-art-only'], [])

    const result = await sync(
      leggingsOrder('REMI9011', TB_PRODUCT, 'gid://shopify/ProductVariant/remi14-tb-only', [tbDesign]),
      leggingsOrder('REMI9012', TB_PRODUCT, 'gid://shopify/ProductVariant/remi14-tb-control', [{ key: 'Enter Name', value: 'Name One' }]),
      leggingsOrder('REMI9013', TB_ART_ONLY_PRODUCT, 'gid://shopify/ProductVariant/remi14-tb-art-only', [tbDesign]),
      leggingsOrder('REMI9014', TB_PRODUCT, 'gid://shopify/ProductVariant/remi14-tb-with-name', [{ key: 'Enter Name', value: 'Name One' }, tbDesign]),
    )
    expect(result).toMatchObject({ totalSynced: 4, errors: [] })

    const taskKeyOf = async (name: string) => {
      const order = await orderRow(`#${name}`)
      expect(order.lines[0].resolvedSupplierId).toBe(SUP)
      return (await taskFor(order.id, order.lines[0].shopifyLineId))!.taskKey
    }
    const tbOnly = await taskKeyOf('REMI9011')
    const control = await taskKeyOf('REMI9012')
    const tbArtOnly = await taskKeyOf('REMI9013')
    const tbWithName = await taskKeyOf('REMI9014')

    const rows = await listTasks({ taskKeys: [tbOnly, control, tbArtOnly, tbWithName] })
    const row = (k: string) => rows.find(r => r.taskKey === k)!
    expect(row(control).readiness).toBe('AUTO')
    expect(isAutoNotRendered(row(control))).toBe(true)
    const teeinblue = [
      ['only _tb_design, entry with a name field', tbOnly],
      ['only _tb_design, entry with no fields', tbArtOnly],
      ['_tb_design beside a filled Enter Name', tbWithName],
    ]
    for (const [label, k] of teeinblue) {
      expect(row(k), label).toMatchObject({ readiness: 'MANUAL', hasPrint: false, fromLibrary: false, unmapped: false })
      expect(isAutoNotRendered(row(k)), label).toBe(false)
      expect(needsArtwork(row(k)), label).toBe(true)
      await expect(queueRenderLine(k, ACTOR), label).rejects.toMatchObject({ status: 409, message: TEEINBLUE_REASON })
    }

    expect((await loadTask(control))!.teeinblue).toBe(false)
    for (const [label, k] of teeinblue) expect((await loadTask(k))!.teeinblue, label).toBe(true)

    const queued = (await queueScheduledRenders()).queued.map(q => q.taskKey)
    expect(queued).toContain(control)
    for (const [label, k] of teeinblue) expect(queued, label).not.toContain(k)
  })
  describe('add-on lines (product type "Add-on")', () => {
    const forTitle = () => fixtureLine(lineId(9002, 2)).customAttributes.find((a: any) => a.key === 'For').value

    it('are not product lines: the unmapped tote alone gets a task and holds the order in PENDING_MAPPING', async () => {
      const result = await sync(fixtureOrder('#REMI9002'))

      expect(result).toMatchObject({ totalSynced: 1, withUnmappedSku: 1, errors: [] })
      const order = await orderRow('#REMI9002')
      const [protect, nameAddOn, tote] = order.lines
      expect(order.pipelineStatus).toBe('PENDING_MAPPING')
      const tasks = await prisma.designTask.findMany({ where: { orderId: order.id } })
      expect(tasks.map(t => [t.shopifyLineId, t.taskKey])).toEqual([[tote.shopifyLineId, 'REMI9002_1']])
      for (const l of [protect, nameAddOn]) expect(l).toMatchObject({ resolvedSupplierId: null, resolvedBaseCost: 0 })
      expect(tote).toMatchObject({ resolvedSupplierId: null, resolvedBaseCost: null })
      expect(await prisma.orderLine.count({ where: { orderId: order.id } })).toBe(3)
      expect(attrsOf(protect).map((a: any) => a.key)).toEqual(['_product_url'])
      expect(attrsOf(nameAddOn).map((a: any) => a.key)).toEqual(['For', 'Custom Name', '_product_url'])
      expect(attrsOf(nameAddOn).find((a: any) => a.key === 'Custom Name').value).toBe('Name One')
    })

    it('leave the order to the mapped tote: PENDING_DESIGN, one task, and the add-on summary Design Studio shows', async () => {
      await mapTote()
      const result = await sync(fixtureOrder('#REMI9002'))

      expect(result).toMatchObject({ totalSynced: 1, withUnmappedSku: 0, errors: [] })
      const order = await orderRow('#REMI9002')
      expect(order).toMatchObject({ pipelineStatus: 'PENDING_DESIGN', defaultSupplierId: SUP })
      const tasks = await prisma.designTask.findMany({ where: { orderId: order.id } })
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({ shopifyLineId: order.lines[2].shopifyLineId, supplierSnapshot: 'Remi14 Sup' })

      const workspace = (await loadWorkspace(order.id))!
      expect(workspace.lines.map(l => l.isNonProduct)).toEqual([true, true, false])
      expect(workspace.order.addOns).toEqual([
        { title: 'Worry-Free Protection', variantTitle: null, qty: 1, details: '' },
        { title: 'Custom Name Add-on', variantTitle: null, qty: 1, details: `For: ${forTitle()}, Custom Name: Name One` },
      ])
    })

    it("alone in an order behave like the first store's Tip: no error, no task, the same state", async () => {
      const base = fixtureOrder('#REMI9002')
      const addOnOnly = { ...base, id: 'gid://shopify/Order/remi14-REMI9021', name: '#REMI9021',
        lineItems: { nodes: base.lineItems.nodes.slice(0, 2).map((l: any, i: number) => ({ ...l, id: `gid://shopify/LineItem/remi14-REMI9021-${i + 1}` })) } }
      const tipOnly = { ...structuredClone(base), id: 'gid://shopify/Order/remi14-REMI9022', name: '#REMI9022',
        lineItems: { nodes: [{ ...structuredClone(base.lineItems.nodes[0]), id: 'gid://shopify/LineItem/remi14-REMI9022-1', sku: null, title: 'Tip', variantTitle: null,
          customAttributes: [], product: { id: 'gid://shopify/Product/remi14-tip', tags: [], productType: null, onlineStoreUrl: null, featuredImage: null },
          variant: { id: 'gid://shopify/ProductVariant/remi14-tip', image: null, selectedOptions: [] } }] } }

      const result = await sync(addOnOnly, tipOnly)

      expect(result).toMatchObject({ totalSynced: 2, withUnmappedSku: 0, errors: [] })
      const state = async (name: string) => {
        const o = await orderRow(name)
        return { pipelineStatus: o.pipelineStatus, designReady: o.designReady, orderType: o.orderType, defaultSupplierId: o.defaultSupplierId, tasks: await prisma.designTask.count({ where: { orderId: o.id } }) }
      }
      expect(await state('#REMI9021')).toEqual(await state('#REMI9022'))
      expect(await state('#REMI9021')).toEqual({ pipelineStatus: 'READY_TO_PRODUCTION', designReady: true, orderType: 'UNKNOWN', defaultSupplierId: null, tasks: 0 })
    })

    it('synced before the rule are put right by the normal sync: NEW tasks on them close, started ones stay, PENDING_MAPPING clears', async () => {
      await mapTote()
      await sync(fixtureOrder('#REMI9002'))
      const order = await orderRow('#REMI9002')
      const [protect, nameAddOn, tote] = order.lines
      // The order as it was while add-ons still counted as product lines: three tasks numbered 1-3, held in PENDING_MAPPING by the add-ons.
      await prisma.order.update({ where: { id: order.id }, data: { pipelineStatus: 'PENDING_MAPPING' } })
      await prisma.orderLine.updateMany({ where: { id: { in: [protect.id, nameAddOn.id] } }, data: { resolvedBaseCost: null } })
      await prisma.designTask.update({ where: { taskKey: 'REMI9002_1' }, data: { taskKey: 'REMI9002_3' } })
      const legacy = (shopifyLineId: string, taskKey: string, status: string) => prisma.designTask.create({
        data: { orderId: order.id, shopifyLineId, taskKey, status, events: { create: { type: 'SYSTEM', message: 'Đơn vào từ Shopify — tạo task' } } },
      })
      await legacy(protect.shopifyLineId, 'REMI9002_1', 'NEW')
      await legacy(nameAddOn.shopifyLineId, 'REMI9002_2', 'DOING')
      const taskState = async () => Object.fromEntries((await prisma.designTask.findMany({ where: { orderId: order.id }, include: { events: true } })).map(t => [t.taskKey, [t.status, t.events.length]]))

      const sweep = await syncDesignTasks(order.id)

      expect(sweep).toMatchObject({ created: 0, cancelled: 1 })
      expect(await taskState()).toEqual({ REMI9002_1: ['CANCELLED', 2], REMI9002_2: ['DOING', 1], REMI9002_3: ['NEW', 1] })
      const closing = await prisma.designTaskEvent.findFirstOrThrow({ where: { task: { taskKey: 'REMI9002_1' }, type: 'SYSTEM' }, orderBy: { createdAt: 'desc' } })
      expect(closing.message).toContain('add-on')
      expect((await orderRow('#REMI9002')).pipelineStatus).toBe('PENDING_MAPPING')

      const result = await sync(fixtureOrder('#REMI9002'))

      expect(result).toMatchObject({ totalSynced: 1, errors: [] })
      const after = await orderRow('#REMI9002')
      expect(after.pipelineStatus).toBe('PENDING_DESIGN')
      expect(after.lines.map(l => l.resolvedBaseCost)).toEqual([0, 0, 14])
      expect(await taskState()).toEqual({ REMI9002_1: ['CANCELLED', 2], REMI9002_2: ['DOING', 1], REMI9002_3: ['NEW', 1] })
      expect(await syncDesignTasks(order.id)).toMatchObject({ created: 0, cancelled: 0 })
      expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'REMI9002_3' } })).shopifyLineId).toBe(tote.shopifyLineId)
    })

    it('are fulfilled with the product when it ships, or closed without tracking on their own fulfillment order', async () => {
      await mapTote()
      await sync(fixtureOrder('#REMI9002'))
      const order = await orderRow('#REMI9002')
      const [protect, nameAddOn, tote] = order.lines
      await prisma.shipment.create({ data: { orderId: order.id, projectId: PROJECT, lineKey: 'REMI9002_1', shopifyLineId: tote.shopifyLineId } })
      const foLine = (id: string, line: { shopifyLineId: string; sku: string | null }) => ({ id, remainingQuantity: 1, lineItem: { id: line.shopifyLineId, sku: line.sku } })
      servedFulfillmentOrders = [{
        id: order.id, name: '#REMI9002', createdAt: '2026-11-02T12:00:00Z', displayFulfillmentStatus: 'UNFULFILLED',
        fulfillmentOrders: { nodes: [
          { id: 'gid://shopify/FulfillmentOrder/remi14-1', status: 'OPEN', lineItems: { nodes: [foLine('fo-tote', tote), foLine('fo-name', nameAddOn)] } },
          { id: 'gid://shopify/FulfillmentOrder/remi14-2', status: 'OPEN', lineItems: { nodes: [foLine('fo-protect', protect)] } },
        ] },
      }]

      const summary = await runAutoFulfill({
        shop: SHOP, accessToken: 'token-remi14', storeId, sheets: [],
        sheetData: [{ name: 'Sheet', groups: new Map([['REMI9002', [{ lineKey: 'REMI9002_1', tracking: 'TRK1' }]]]) }],
        minAgeDays: 0, apply: false, now: new Date('2026-11-06T00:00:00Z'),
      })

      expect(summary.rows).toHaveLength(1)
      expect(summary.rows[0]).toMatchObject({ baseOrder: 'REMI9002', status: 'will_fulfill', fulfilledLines: 3 })
      expect(summary.rows[0].fulfillments).toEqual([
        { tracking: 'TRK1', lineKeys: ['REMI9002_1'], lineCount: 2 },
        { tracking: '', lineKeys: [], lineCount: 1, addOn: true },
      ])
    })
  })
  describe('the Mapping page decides "every line is resolved" like the order sync', () => {
    const supplierProduct = (sku: string, baseCost = 10) => prisma.supplierProduct.create({ data: { supplierId: SUP, sku, baseCost } })
    const mapAsPage = async (shopifyVariantId: string, supplierProductId: string) => {
      const res = await manualMappingPost(new NextRequest('http://test/api/fulfillment/mapping/manual', {
        method: 'POST', body: JSON.stringify({ shopifyVariantId, shopifyProductTitle: 'Reminiso test', supplierProductId }),
      }))
      expect(res.status).toBe(201)
    }
    const saveOnly = (shopifyVariantId: string, supplierProductId: string) =>
      saveManualMapping({ shopifyVariantId, shopifyProductTitle: 'Reminiso test', supplierProductId })
    const rename = (node: any, name: string) => {
      const n = structuredClone(node)
      n.id = `gid://shopify/Order/remi14-${name}`
      n.name = `#${name}`
      n.lineItems.nodes.forEach((l: any, i: number) => { l.id = `gid://shopify/LineItem/remi14-${name}-${i + 1}` })
      return n
    }
    const statusOf = async (name: string) => (await orderRow(name)).pipelineStatus

    it('saving the mapping of the only (no-SKU) product line gives the status a re-sync gives', async () => {
      await sync(fixtureOrder('#REMI9002'))
      expect(await statusOf('#REMI9002')).toBe('PENDING_MAPPING')

      await saveOnly(TOTE_VARIANT, (await supplierProduct('REMI14-TOTE-L', 14)).id)

      const order = await orderRow('#REMI9002')
      expect(order.lines[2]).toMatchObject({ sku: null, resolvedSupplierId: SUP })
      expect(order.pipelineStatus).toBe('PENDING_DESIGN')
      expect(hasUnresolvedProductLine(order.lines)).toBe(false)
      await sync(fixtureOrder('#REMI9002'))
      expect(await statusOf('#REMI9002')).toBe('PENDING_DESIGN')
    })

    it('the page action (save, then cost refresh) lands on PENDING_DESIGN too, with the cost filled', async () => {
      await sync(fixtureOrder('#REMI9002'))

      await mapAsPage(TOTE_VARIANT, (await supplierProduct('REMI14-TOTE-L', 14)).id)

      const order = await orderRow('#REMI9002')
      expect(order).toMatchObject({ pipelineStatus: 'PENDING_DESIGN', designReady: false, defaultSupplierId: SUP })
      expect(order.lines[2].resolvedBaseCost).toBe(14)
      await sync(fixtureOrder('#REMI9002'))
      expect(await statusOf('#REMI9002')).toBe('PENDING_DESIGN')
    })

    it('mapping only the SKU line of an order with a no-SKU line does not advance it; mapping the no-SKU line does', async () => {
      await sync(fixtureOrder('#REMI9001'))
      expect(await statusOf('#REMI9001')).toBe('PENDING_MAPPING')

      await mapAsPage(TOPPER_VARIANT, (await supplierProduct('REMI14-TOPPER-6IN', 8)).id)

      expect(await statusOf('#REMI9001')).toBe('PENDING_MAPPING')
      expect((await orderRow('#REMI9001')).lines.map(l => !!l.resolvedSupplierId)).toEqual([false, true])
      await sync(fixtureOrder('#REMI9001'))
      expect(await statusOf('#REMI9001')).toBe('PENDING_MAPPING')

      await mapAsPage(ADVENT_VARIANT, (await supplierProduct('REMI14-ADVENT', 21)).id)

      expect(await statusOf('#REMI9001')).toBe('PENDING_DESIGN')
      await sync(fixtureOrder('#REMI9001'))
      expect(await statusOf('#REMI9001')).toBe('PENDING_DESIGN')
    })

    it('an order whose lines all have SKUs behaves as before: it advances when its last line is mapped', async () => {
      const node = rename(fixtureOrder('#REMI9001'), 'REMI9041')
      node.lineItems.nodes = [node.lineItems.nodes[1], { ...fixtureOrder('#REMI9004').lineItems.nodes[0], id: 'gid://shopify/LineItem/remi14-REMI9041-2' }]
      await sync(node)
      expect((await orderRow('#REMI9041')).lines.map(l => l.sku)).toEqual(['RM-TOP-TRACTOR-6IN', 'RM-LEG-HEART-M'])
      expect(await statusOf('#REMI9041')).toBe('PENDING_MAPPING')

      await saveOnly(TOPPER_VARIANT, (await supplierProduct('REMI14-TOPPER-6IN', 8)).id)
      expect(await statusOf('#REMI9041')).toBe('PENDING_MAPPING')

      await saveOnly(LEGGINGS_VARIANT, (await supplierProduct('REMI14-LEGGINGS-M', 12)).id)
      expect(await statusOf('#REMI9041')).toBe('PENDING_DESIGN')
      await sync(node)
      expect(await statusOf('#REMI9041')).toBe('PENDING_DESIGN')
    })

    it('never touches an order in another status, whatever its lines', async () => {
      const held = [['PENDING_DESIGN', true], ['READY_TO_PRODUCTION', true], ['WARNING', false], ['AWAITING_PAYMENT', false], ['DESIGN_REJECTED', true]] as const
      const names = held.map((_, i) => `REMI903${i + 1}`)
      await sync(...names.map(name => rename(fixtureOrder('#REMI9001'), name)))
      for (let i = 0; i < held.length; i++) {
        await prisma.order.update({ where: { id: `gid://shopify/Order/remi14-${names[i]}` }, data: { pipelineStatus: held[i][0], designReady: held[i][1] } })
      }

      await saveOnly(TOPPER_VARIANT, (await supplierProduct('REMI14-TOPPER-6IN', 8)).id)

      for (let i = 0; i < held.length; i++) {
        const [pipelineStatus, designReady] = held[i]
        const order = await orderRow(`#${names[i]}`)
        expect([order.pipelineStatus, order.designReady], pipelineStatus).toEqual([pipelineStatus, designReady])
        expect(order.lines[1].resolvedSupplierId, pipelineStatus).toBe(SUP)
        expect(order.lines[0].resolvedSupplierId, pipelineStatus).toBeNull()
      }
    })

    it('a design finished on the SKU line before the no-SKU line was mapped does not skip the design of the newly mapped line', async () => {
      await mapVariant(TOPPER_VARIANT, (await supplierProduct('REMI14-TOPPER-6IN', 8)).id)
      await sync(fixtureOrder('#REMI9001'))
      const order = await orderRow('#REMI9001')
      // What Design Studio leaves after the topper's design is approved while the advent calendar is still unmapped.
      await prisma.orderLine.update({ where: { id: order.lines[1].id }, data: { designDriveLink: 'https://example.test/design.png' } })
      await prisma.order.update({ where: { id: order.id }, data: { designReady: true } })
      expect(await statusOf('#REMI9001')).toBe('PENDING_MAPPING')

      await mapAsPage(ADVENT_VARIANT, (await supplierProduct('REMI14-ADVENT', 21)).id)

      expect(await orderRow('#REMI9001')).toMatchObject({ pipelineStatus: 'PENDING_DESIGN', designReady: false })
      await sync(fixtureOrder('#REMI9001'))
      expect(await orderRow('#REMI9001')).toMatchObject({ pipelineStatus: 'PENDING_DESIGN', designReady: false })
    })

    it('a design-library save does not move an order out of PENDING_MAPPING while a no-SKU product line is unmapped', async () => {
      await mapVariant(TOPPER_VARIANT, (await supplierProduct('REMI14-TOPPER-6IN', 8)).id)
      await sync(fixtureOrder('#REMI9001'))
      expect(await statusOf('#REMI9001')).toBe('PENDING_MAPPING')

      const touched = await reevaluateOrdersForDesignEntry({ sku: 'RM-TOP-TRACTOR-6IN', supplierId: SUP, matchMode: 'VARIANT' })

      expect(touched).toBe(1)
      expect(await statusOf('#REMI9001')).toBe('PENDING_MAPPING')
    })
  })
})
