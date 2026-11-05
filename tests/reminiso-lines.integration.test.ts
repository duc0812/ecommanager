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
import { hasUnresolvedProductLine, isNonProductLine } from '@/lib/order-lines'
import { PIPELINE_STATUSES } from '@/lib/pipeline-status'
import { POST as manualMappingPost } from '@/app/api/fulfillment/mapping/manual/route'
import { runAutoFulfill } from '@/lib/fulfillment/auto-fulfill'
import { RENDER_LINE, queueRenderLine, queueScheduledRenders, renderClaimFor } from '@/lib/repos/artwork-render'
import { handoffCardFor, listHandoffHub } from '@/lib/supplier-handoff'
import { UNMAPPED_TAB } from '@/lib/handoff-shared'
import { TEEINBLUE_REASON } from '@/lib/artwork-render-eligibility'
import { isAutoNotRendered, needsArtwork } from '@/app/design-studio/components/model'

// tests/fixtures/reminiso-order.json is four real Reminiso orders in the shape Shopify's GraphQL returns to the sync,
// renumbered #REMI9001-9004. Customer, address and every typed personalisation value are placeholders;
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

    it('synced before the rule are put right by the normal sync: untouched tasks on them go, started ones stay, PENDING_MAPPING clears', async () => {
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

      expect(sweep).toMatchObject({ created: 0, cancelled: 0 })
      expect(await taskState()).toEqual({ REMI9002_1: ['NEW', 2], REMI9002_2: ['DOING', 1] })
      expect(await taskFor(order.id, protect.shopifyLineId)).toBeNull()
      const rekey = await prisma.designTaskEvent.findFirstOrThrow({ where: { task: { taskKey: 'REMI9002_1' }, type: 'SYSTEM' }, orderBy: { createdAt: 'desc' } })
      expect(rekey.message).toContain('REMI9002_3 → REMI9002_1')
      expect((await orderRow('#REMI9002')).pipelineStatus).toBe('PENDING_MAPPING')

      const result = await sync(fixtureOrder('#REMI9002'))

      expect(result).toMatchObject({ totalSynced: 1, errors: [] })
      const after = await orderRow('#REMI9002')
      expect(after.pipelineStatus).toBe('PENDING_DESIGN')
      expect(after.lines.map(l => l.resolvedBaseCost)).toEqual([0, 0, 14])
      expect(await taskState()).toEqual({ REMI9002_1: ['NEW', 2], REMI9002_2: ['DOING', 1] })
      expect(await syncDesignTasks(order.id)).toMatchObject({ created: 0, cancelled: 0 })
      expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'REMI9002_1' } })).shopifyLineId).toBe(tote.shopifyLineId)
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

    // The statuses saveManualMapping recomputed before Task 14 (git show 8cdf782:src/lib/repos/mapping.ts).
    const RECOMPUTED = ['PENDING_MAPPING', 'PENDING_DESIGN', 'AWAITING_PAYMENT', 'WARNING']
    const outcome = (o: { pipelineStatus: string; designReady: boolean }) => ({ pipelineStatus: o.pipelineStatus, designReady: o.designReady })

    // mixed: a SKU line (mapped) and a no-SKU line (the one being mapped); skus: two SKU lines, the second being mapped.
    const shapes = {
      mixed: { name: '#REMI9001', mapped: TOPPER_VARIANT, mapping: ADVENT_VARIANT, node: () => fixtureOrder('#REMI9001') },
      skus: { name: '#REMI9041', mapped: TOPPER_VARIANT, mapping: LEGGINGS_VARIANT, node: () => {
        const n = rename(fixtureOrder('#REMI9001'), 'REMI9041')
        n.lineItems.nodes = [n.lineItems.nodes[1], { ...fixtureOrder('#REMI9004').lineItems.nodes[0], id: 'gid://shopify/LineItem/remi14-REMI9041-2' }]
        return n
      } },
    } as const

    for (const status of RECOMPUTED) {
      for (const [shape, def] of Object.entries(shapes)) {
        it(`an order in ${status} (${shape} lines): a mapping save gives the status and designReady a re-sync gives`, async () => {
          const node = def.node()
          if (status === 'AWAITING_PAYMENT') node.displayFinancialStatus = 'PENDING'
          await mapVariant(def.mapped, (await supplierProduct('REMI14-FIRST', 8)).id)
          await sync(node)
          const before = await orderRow(def.name)
          await prisma.order.update({ where: { id: before.id }, data: { pipelineStatus: status, designReady: false } })

          await saveOnly(def.mapping, (await supplierProduct('REMI14-SECOND', 21)).id)
          const afterSave = outcome(await orderRow(def.name))
          await sync(node)
          const afterSync = outcome(await orderRow(def.name))

          expect(afterSave).toEqual(afterSync)
          expect(afterSave).toEqual({ pipelineStatus: status === 'AWAITING_PAYMENT' ? 'AWAITING_PAYMENT' : 'PENDING_DESIGN', designReady: false })
        })
      }
    }

    it('an order in PENDING_DESIGN whose design flag stands (Trello card) becomes ready on the save, as before and as a re-sync', async () => {
      const node = shapes.skus.node()
      await mapVariant(TOPPER_VARIANT, (await supplierProduct('REMI14-FIRST', 8)).id)
      await sync(node)
      const before = await orderRow('#REMI9041')
      await prisma.order.update({ where: { id: before.id }, data: { pipelineStatus: 'PENDING_DESIGN', designReady: true, trelloCardId: 'card-remi14' } })

      await saveOnly(LEGGINGS_VARIANT, (await supplierProduct('REMI14-SECOND', 12)).id)

      expect(outcome(await orderRow('#REMI9041'))).toEqual({ pipelineStatus: 'READY_TO_PRODUCTION', designReady: true })
      await sync(node)
      expect(outcome(await orderRow('#REMI9041'))).toEqual({ pipelineStatus: 'READY_TO_PRODUCTION', designReady: true })
    })

    it('an order in PENDING_DESIGN whose lines already carry their library design becomes ready on the save, as before and as a re-sync', async () => {
      const node = shapes.skus.node()
      await mapVariant(TOPPER_VARIANT, (await supplierProduct('REMI14-FIRST', 8)).id)
      await sync(node)
      const before = await orderRow('#REMI9041')
      await prisma.orderLine.updateMany({ where: { orderId: before.id }, data: { designDriveLink: 'https://example.test/library-design.png' } })
      await prisma.order.update({ where: { id: before.id }, data: { pipelineStatus: 'PENDING_DESIGN', designReady: true } })

      await saveOnly(LEGGINGS_VARIANT, (await supplierProduct('REMI14-SECOND', 12)).id)

      expect(outcome(await orderRow('#REMI9041'))).toEqual({ pipelineStatus: 'READY_TO_PRODUCTION', designReady: true })
      await sync(node)
      expect(outcome(await orderRow('#REMI9041'))).toEqual({ pipelineStatus: 'READY_TO_PRODUCTION', designReady: true })
    })

    it('never touches an order in a status it did not recompute before, whatever its lines', async () => {
      const held = PIPELINE_STATUSES.filter(status => !RECOMPUTED.includes(status))
      expect(held).toEqual(['READY_TO_PRODUCTION', 'EXPORTED', 'ON_HOLD', 'FULFILLED', 'DESIGN_REJECTED', 'ERROR', 'CANCELLED', 'REFUNDED'])
      const names = held.map((_, i) => `REMI904${i + 1}`)
      await sync(...names.map(name => rename(fixtureOrder('#REMI9001'), name)))
      for (let i = 0; i < held.length; i++) {
        await prisma.order.update({ where: { id: `gid://shopify/Order/remi14-${names[i]}` }, data: { pipelineStatus: held[i], designReady: i % 2 === 0 } })
      }

      await saveOnly(TOPPER_VARIANT, (await supplierProduct('REMI14-TOPPER-6IN', 8)).id)

      for (let i = 0; i < held.length; i++) {
        const order = await orderRow(`#${names[i]}`)
        expect([order.pipelineStatus, order.designReady], held[i]).toEqual([held[i], i % 2 === 0])
        expect(order.lines[1].resolvedSupplierId, held[i]).toBe(SUP)
        expect(order.lines[0].resolvedSupplierId, held[i]).toBeNull()
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
  describe('the hidden fee product (type PPLR_HIDDEN_PRODUCT)', () => {
    // Shaped like #LIT5566: a normal product line and the personalisation app's fee line, which has no SKU and no supplier.
    const feeOrder = () => {
      const node = fixtureOrder('#REMI9004')
      node.id = 'gid://shopify/Order/remi14-REMI9051'
      node.name = '#REMI9051'
      node.lineItems.nodes[0].id = 'gid://shopify/LineItem/remi14-REMI9051-1'
      node.lineItems.nodes.push({
        id: 'gid://shopify/LineItem/remi14-REMI9051-2', sku: null, title: 'Item Personalization', variantTitle: null, quantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: '0.50' } }, customAttributes: [], image: null,
        product: { id: 'gid://shopify/Product/remi14-fee', tags: [], productType: 'PPLR_HIDDEN_PRODUCT', onlineStoreUrl: null, featuredImage: null },
        variant: { id: 'gid://shopify/ProductVariant/remi14-fee', image: null, selectedOptions: [] },
      })
      return node
    }

    it('gets no design task and does not hold a mapped order in PENDING_MAPPING', async () => {
      await mapVariant(LEGGINGS_VARIANT, (await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'REMI14-LEGGINGS-M', baseCost: 12 } })).id)

      const result = await sync(feeOrder())

      expect(result).toMatchObject({ totalSynced: 1, withUnmappedSku: 0, errors: [] })
      const order = await orderRow('#REMI9051')
      expect(order.pipelineStatus).toBe('PENDING_DESIGN')
      expect(order.lines[1]).toMatchObject({ sku: null, resolvedSupplierId: null, resolvedBaseCost: 0 })
      const tasks = await prisma.designTask.findMany({ where: { orderId: order.id } })
      expect(tasks.map(t => [t.shopifyLineId, t.taskKey])).toEqual([[order.lines[0].shopifyLineId, 'REMI9051_1']])
    })

    it('does not hold an order in PENDING_MAPPING through a mapping save either', async () => {
      await sync(feeOrder())
      expect((await orderRow('#REMI9051')).pipelineStatus).toBe('PENDING_MAPPING')

      await saveManualMapping({
        shopifyVariantId: LEGGINGS_VARIANT, shopifyProductTitle: 'Leggings',
        supplierProductId: (await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'REMI14-LEGGINGS-M', baseCost: 12 } })).id,
      })

      expect((await orderRow('#REMI9051')).pipelineStatus).toBe('PENDING_DESIGN')
      await sync(feeOrder())
      expect((await orderRow('#REMI9051')).pipelineStatus).toBe('PENDING_DESIGN')
    })
  })
  describe("a design task's key follows its line key", () => {
    const fixtureLines = (name: string) => fixtureOrder(name).lineItems.nodes
    const PROTECT = () => fixtureLines('#REMI9002')[0]
    const ADVENT = () => fixtureLines('#REMI9001')[0]
    const TOPPER = () => fixtureLines('#REMI9001')[1]
    const LEGGINGS = () => fixtureLines('#REMI9004')[0]
    const FEE = () => ({
      sku: null, title: 'Item Personalization', variantTitle: null, quantity: 1, originalUnitPriceSet: { shopMoney: { amount: '0.50' } }, customAttributes: [], image: null,
      product: { id: 'gid://shopify/Product/remi14-fee', tags: [], productType: 'PPLR_HIDDEN_PRODUCT', onlineStoreUrl: null, featuredImage: null },
      variant: { id: 'gid://shopify/ProductVariant/remi14-fee', image: null, selectedOptions: [] },
    })
    const TIP = () => ({
      ...PROTECT(), sku: null, title: 'Tip', variantTitle: null, customAttributes: [],
      product: { id: 'gid://shopify/Product/remi14-tip', tags: [], productType: null, onlineStoreUrl: null, featuredImage: null },
      variant: { id: 'gid://shopify/ProductVariant/remi14-tip', image: null, selectedOptions: [] },
    })
    const orderOf = (name: string, lines: any[]) => {
      const node = fixtureOrder('#REMI9001')
      node.id = `gid://shopify/Order/remi14-${name}`
      node.name = `#${name}`
      node.lineItems.nodes = lines.map((l, i) => ({ ...structuredClone(l), id: `gid://shopify/LineItem/remi14-${name}-${i + 1}` }))
      return node
    }
    const CREATED = { type: 'SYSTEM', message: 'Đơn vào từ Shopify — tạo task' }

    // What a sync before Task 14 left: each task keyed by its line's position (add-ons and the fee line counted), and a task
    // with its one creation event on every line in `addOns`. `status` sets a task's status by line position.
    async function legacyKeys(name: string, opts: { addOns?: number[]; status?: Record<number, string> } = {}) {
      const order = await orderRow(name)
      const tasks = await prisma.designTask.findMany({ where: { orderId: order.id } })
      for (const t of tasks) await prisma.designTask.update({ where: { id: t.id }, data: { taskKey: `~${t.id}` } })
      const ids: Record<number, string> = {}
      for (const l of order.lines) {
        const taskKey = `${name.slice(1)}_${l.linePosition}`
        const status = opts.status?.[l.linePosition]
        const t = tasks.find(x => x.shopifyLineId === l.shopifyLineId)
        if (t) ids[l.linePosition] = (await prisma.designTask.update({ where: { id: t.id }, data: { taskKey, ...(status ? { status } : {}) } })).id
        else if (opts.addOns?.includes(l.linePosition)) {
          ids[l.linePosition] = (await prisma.designTask.create({ data: { orderId: order.id, shopifyLineId: l.shopifyLineId, taskKey, status: status ?? 'NEW', events: { create: CREATED } } })).id
        }
      }
      return { order, ids }
    }
    const snapshot = async (orderId: string) => (await prisma.designTask.findMany({ where: { orderId }, include: { events: true }, orderBy: { taskKey: 'asc' } }))
      .map(t => ({ id: t.id, taskKey: t.taskKey, status: t.status, updatedAt: t.updatedAt.toISOString(), events: t.events.length }))
    const keyEvents = async (taskId: string) => (await prisma.designTaskEvent.findMany({ where: { taskId, message: { startsWith: 'Đổi mã task' } } })).map(e => [e.type, e.message])
    const artworkOn = (orderId: string, shopifyLineId: string) => prisma.designArtwork.create({
      data: { orderId, shopifyLineId, kind: 'PRINT', printArea: 'Print', version: 1, fileName: 'print.png', size: 1, mimeType: 'image/png' },
    })

    it('an order synced while its add-ons were numbered: one sync removes the untouched add-on tasks and gives the tote task _1; a second changes nothing', async () => {
      await sync(fixtureOrder('#REMI9002'))
      const { order, ids } = await legacyKeys('#REMI9002', { addOns: [1, 2] })
      expect((await snapshot(order.id)).map(t => [t.taskKey, t.status])).toEqual([['REMI9002_1', 'NEW'], ['REMI9002_2', 'NEW'], ['REMI9002_3', 'NEW']])

      expect((await sync(fixtureOrder('#REMI9002'))).errors).toEqual([])

      const after = await snapshot(order.id)
      expect(after.map(t => [t.id, t.taskKey, t.status])).toEqual([[ids[3], 'REMI9002_1', 'NEW']])
      expect(await keyEvents(ids[3])).toEqual([['SYSTEM', expect.stringContaining('REMI9002_3 → REMI9002_1')]])
      expect(await prisma.designTaskEvent.count({ where: { taskId: { in: [ids[1], ids[2]] } } })).toBe(0)

      expect((await sync(fixtureOrder('#REMI9002'))).errors).toEqual([])
      expect(await snapshot(order.id)).toEqual(after)
    })

    it("an add-on ahead of two products: A takes _1 and B _2 (B's new key is A's old one), the same tasks, no unique-key error", async () => {
      const node = orderOf('REMI9062', [PROTECT(), ADVENT(), TOPPER()])
      await sync(node)
      const { order, ids } = await legacyKeys('#REMI9062', { addOns: [1] })

      expect((await sync(node)).errors).toEqual([])

      expect((await snapshot(order.id)).map(t => [t.id, t.taskKey])).toEqual([[ids[2], 'REMI9062_1'], [ids[3], 'REMI9062_2']])
      expect((await taskFor(order.id, order.lines[1].shopifyLineId))!.taskKey).toBe('REMI9062_1')
      expect((await taskFor(order.id, order.lines[2].shopifyLineId))!.taskKey).toBe('REMI9062_2')
      expect(await keyEvents(ids[2])).toEqual([['SYSTEM', expect.stringContaining('REMI9062_2 → REMI9062_1')]])
      expect(await keyEvents(ids[3])).toEqual([['SYSTEM', expect.stringContaining('REMI9062_3 → REMI9062_2')]])
    })

    it('the hidden fee line ahead of a finished product: the DONE task takes _1 and keeps its status, Drive folder, files and time', async () => {
      await mapVariant(LEGGINGS_VARIANT, (await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'REMI14-LEGGINGS-M', baseCost: 12 } })).id)
      const node = orderOf('REMI9063', [FEE(), LEGGINGS()])
      await sync(node)
      const { order, ids } = await legacyKeys('#REMI9063')
      await prisma.designTask.update({ where: { id: ids[2] }, data: {
        status: 'DONE', assigneeId: 'remi14-designer', driveFolderId: 'remi14-folder', driveFolderUrl: 'https://drive.google.com/drive/folders/remi14-folder',
      } })
      const art = await artworkOn(order.id, order.lines[1].shopifyLineId)
      const before = await prisma.designTask.findUniqueOrThrow({ where: { id: ids[2] } })
      expect(before.taskKey).toBe('REMI9063_2')

      expect((await sync(node)).errors).toEqual([])

      expect(await prisma.designTask.findUniqueOrThrow({ where: { id: ids[2] } })).toEqual({ ...before, taskKey: 'REMI9063_1' })
      expect(await prisma.designTask.count({ where: { orderId: order.id } })).toBe(1)
      expect(await prisma.designArtwork.findMany({ where: { orderId: order.id } })).toEqual([art])
      expect(await keyEvents(ids[2])).toEqual([['SYSTEM', expect.stringContaining('REMI9063_2 → REMI9063_1')]])
      expect((await loadTask('REMI9063_1'))?.task).toMatchObject({ id: ids[2], status: 'DONE', shopifyLineId: order.lines[1].shopifyLineId })
      expect(await loadTask('REMI9063_2')).toBeNull()
    })

    it('an add-on task with work, in a key a product needs, is kept with its work and status under another key; the tote takes _1', async () => {
      await sync(fixtureOrder('#REMI9002'))
      const { order, ids } = await legacyKeys('#REMI9002', { addOns: [1, 2], status: { 2: 'DOING' } })
      const art = await artworkOn(order.id, order.lines[0].shopifyLineId)
      const row = (id: string) => prisma.designTask.findUniqueOrThrow({ where: { id } })
      const [withFile, started] = [await row(ids[1]), await row(ids[2])]

      expect((await sync(fixtureOrder('#REMI9002'))).errors).toEqual([])

      expect(await row(ids[1])).toEqual({ ...withFile, taskKey: 'REMI9002_1-addon' })
      expect(await keyEvents(ids[1])).toEqual([['SYSTEM', expect.stringContaining('REMI9002_1 → REMI9002_1-addon')]])
      expect(await prisma.designArtwork.findUniqueOrThrow({ where: { id: art.id } })).toEqual(art)
      expect(await row(ids[2])).toEqual(started)
      expect(await prisma.designTaskEvent.count({ where: { taskId: ids[2] } })).toBe(1)
      expect((await row(ids[3])).taskKey).toBe('REMI9002_1')
    })

    it('an add-on task the earlier sweep cancelled, in a key a product needs, moves out of the way still CANCELLED; the tote takes _1', async () => {
      await sync(fixtureOrder('#REMI9002'))
      const { order, ids } = await legacyKeys('#REMI9002', { addOns: [1, 2], status: { 1: 'CANCELLED' } })
      await prisma.designTaskEvent.create({ data: { taskId: ids[1], type: 'SYSTEM', message: 'Dòng là add-on, không phải sản phẩm — task tự huỷ' } })
      const cancelled = await prisma.designTask.findUniqueOrThrow({ where: { id: ids[1] } })

      expect((await sync(fixtureOrder('#REMI9002'))).errors).toEqual([])

      expect(await prisma.designTask.findUniqueOrThrow({ where: { id: ids[1] } })).toEqual({ ...cancelled, taskKey: 'REMI9002_1-addon' })
      expect(await prisma.designTask.findUnique({ where: { id: ids[2] } })).toBeNull()
      expect((await snapshot(order.id)).map(t => [t.id, t.taskKey, t.status])).toEqual([[ids[3], 'REMI9002_1', 'NEW'], [ids[1], 'REMI9002_1-addon', 'CANCELLED']])
    })

    it("the hand-off card opens each product line's own task while the tasks still carry their old keys, the swap case too", async () => {
      await sync(fixtureOrder('#REMI9002'), orderOf('REMI9062', [PROTECT(), ADVENT(), TOPPER()]))
      await legacyKeys('#REMI9002', { addOns: [1, 2] })
      const swap = await legacyKeys('#REMI9062', { addOns: [1] })
      const expected = {
        '#REMI9002': { lineKeys: ['REMI9002_1'], taskKeys: ['REMI9002_3'] },
        '#REMI9062': { lineKeys: ['REMI9062_1', 'REMI9062_2'], taskKeys: ['REMI9062_2', 'REMI9062_3'] },
      }

      for (const [name, want] of Object.entries(expected)) {
        const order = await orderRow(name)
        const hub = await listHandoffHub({ q: name, supplier: UNMAPPED_TAB })
        const cards = [hub.pending.find(c => c.order.id === order.id)!, (await handoffCardFor(order.id))!]
        for (const card of cards) {
          expect(card.lines.map(l => l.line.shopifyLineId), name).toEqual(order.lines.filter(l => !isNonProductLine(l)).map(l => l.shopifyLineId))
          expect(card.lines.map(l => [l.lineKey, l.taskKey]), name).toEqual(want.lineKeys.map((k, i) => [k, want.taskKeys[i]]))
          for (const l of card.lines) expect((await loadTask(l.taskKey!))?.task.shopifyLineId, `${name} ${l.lineKey}`).toBe(l.line.shopifyLineId)
        }
      }

      await prisma.designTask.delete({ where: { id: swap.ids[3] } })
      expect((await handoffCardFor(swap.order.id))!.lines.map(l => [l.lineKey, l.taskKey])).toEqual([['REMI9062_1', 'REMI9062_2'], ['REMI9062_2', null]])
    })

    it('an order with nothing to put right (a Tip ahead of two mapped products): no key event, and a re-sync changes no task', async () => {
      await mapVariant(ADVENT_VARIANT, (await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'REMI14-ADVENT', baseCost: 21 } })).id)
      await mapVariant(TOPPER_VARIANT, (await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'REMI14-TOPPER-6IN', baseCost: 8 } })).id)
      const node = orderOf('REMI9065', [TIP(), ADVENT(), TOPPER()])

      expect((await sync(node)).errors).toEqual([])

      const order = await orderRow('#REMI9065')
      const first = await snapshot(order.id)
      expect(first.map(t => [t.taskKey, t.events])).toEqual([['REMI9065_1', 1], ['REMI9065_2', 1]])
      expect(await prisma.designTaskEvent.count({ where: { task: { orderId: order.id }, message: { startsWith: 'Đổi mã task' } } })).toBe(0)

      expect((await sync(node)).errors).toEqual([])
      expect(await syncDesignTasks(order.id)).toEqual({ created: 0, cancelled: 0, completed: 0, reopened: 0 })
      expect(await snapshot(order.id)).toEqual(first)
    })

    it('an order edit adds a product line whose key a cancelled add-on task held: the sync creates its task without an error', async () => {
      await sync(fixtureOrder('#REMI9002'))
      const { order } = await legacyKeys('#REMI9002', { addOns: [1, 2], status: { 1: 'CANCELLED', 2: 'CANCELLED' } })
      const edited = fixtureOrder('#REMI9002')
      edited.lineItems.nodes.push({ ...ADVENT(), id: lineId(9002, 4) })

      const result = await sync(edited)

      expect(result.errors).toEqual([])
      const tasks = await prisma.designTask.findMany({ where: { orderId: order.id } })
      expect(Object.fromEntries(tasks.map(t => [t.shopifyLineId, [t.taskKey, t.status]]))).toEqual({
        [lineId(9002, 1)]: ['REMI9002_1-addon', 'CANCELLED'],
        [lineId(9002, 2)]: ['REMI9002_2-addon', 'CANCELLED'],
        [lineId(9002, 3)]: ['REMI9002_1', 'NEW'],
        [lineId(9002, 4)]: ['REMI9002_2', 'NEW'],
      })
    })

    it('the worker claim refuses a render job queued for a _tb_design line, and still claims the control line', async () => {
      const tbDesign = fixtureLine(lineId(9004, 1)).customAttributes.find((a: any) => a.key === '_tb_design')
      await leggingsProduct(TB_PRODUCT, ['gid://shopify/ProductVariant/remi14-tb-with-name', 'gid://shopify/ProductVariant/remi14-tb-control'], [NAME_FIELD])
      await sync(
        leggingsOrder('REMI9014', TB_PRODUCT, 'gid://shopify/ProductVariant/remi14-tb-with-name', [{ key: 'Enter Name', value: 'Name One' }, tbDesign]),
        leggingsOrder('REMI9012', TB_PRODUCT, 'gid://shopify/ProductVariant/remi14-tb-control', [{ key: 'Enter Name', value: 'Name One' }]),
      )
      const entry = await prisma.artworkEntry.findFirstOrThrow({ where: { storeId, shopifyProductId: TB_PRODUCT } })
      // A job queued before the Teeinblue rule reached the render button.
      const queued = async (name: string) => {
        const order = await orderRow(name)
        return prisma.artworkJob.create({ data: { kind: RENDER_LINE, entryId: entry.id, orderId: order.id, shopifyLineId: order.lines[0].shopifyLineId, printArea: 'Print' } })
      }

      expect(await renderClaimFor(await queued('#REMI9014'))).toEqual({ error: TEEINBLUE_REASON })
      expect(await renderClaimFor(await queued('#REMI9012'))).toMatchObject({ target: { orderNumber: '#REMI9012', taskKey: 'REMI9012_1', printArea: 'Print' } })
    })
  })
})
