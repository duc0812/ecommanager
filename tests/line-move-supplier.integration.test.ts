import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { signToken, AUTH_COOKIE } from '@/lib/auth'
import { POST } from '@/app/api/design-studio/tasks/[key]/move-supplier/route'
import { MOVE_EVENT_PREFIX } from '@/lib/repos/line-move-supplier'
import { upsertOrderWithLines, type UpsertOrderInput } from '@/lib/repos/orders'
import { productionOverride } from '@/lib/production-override'
import { buildMerchizePush } from '@/lib/repos/merchize-push'

const P = 'move-line-test'
const JOMALL = `${P}-jomall`
const MERCHIZE = `${P}-merchize`
const ORDER = `${P}-order`
const KEY = 'MV5707_1'
const HOODIE = `${P}-line-hoodie`
const TEE = `${P}-line-tee`
const CSV_AT = new Date('2026-11-04T12:53:10.696Z')
const PUSH_AT = new Date('2026-11-06T09:24:43.923Z')
let storeId = '', superToken = '', adminToken = ''

function input(): UpsertOrderInput {
  return { id: ORDER, projectId: P, storeId, shopifyOrderNumber: '#MV5707', customerEmail: null, customerName: null, shippingCountry: 'US', shippingState: null,
    financialStatus: 'PAID', fulfillmentStatus: 'PARTIALLY_FULFILLED', currency: 'USD', grossAmount: 120, expectedPayout: 110, totalFees: 10, refundedAmount: 0, defaultSupplierId: JOMALL,
    placedAt: new Date('2026-10-28'), pipelineStatus: 'EXPORTED', shippingZone: 'US',
    lines: [
      { shopifyLineId: HOODIE, shopifyVariantId: `${P}-v-hoodie`, sku: 'TN2605261643-HOODIE-L', variantTitle: 'Hoodie / L', variantOptions: JSON.stringify({ Style: 'Hoodie', Size: 'L' }), productTitle: 'Old Woman Jeep Hoodie', shopifyProductId: `${P}-p1`, qty: 1, unitPrice: 60, resolvedSupplierId: JOMALL, resolvedSupplierSku: 'GAF-L', resolvedBaseCost: 21, customized: false },
      { shopifyLineId: TEE, shopifyVariantId: `${P}-v-tee`, sku: 'DN2708261742-T-SHIRT', variantTitle: 'T-Shirt / 2XL', variantOptions: JSON.stringify({ Style: 'T-Shirt', Size: '2XL' }), productTitle: 'Duck Jeep Tee', shopifyProductId: `${P}-p2`, qty: 1, unitPrice: 60, resolvedSupplierId: MERCHIZE, resolvedSupplierSku: 'MZ-TEE-2XL', resolvedBaseCost: 12, customized: false },
    ],
  }
}
const post = (body: Record<string, unknown>, token = superToken) => new NextRequest(`http://localhost/api/design-studio/tasks/${KEY}/move-supplier`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `${AUTH_COOKIE}=${token}` }, body: JSON.stringify(body),
})
const move = (token = superToken) => POST(post({ supplierProductId: `${P}-mwhd-L`, reason: 'CSV Jomall 11/04 không lên sheet — chủ shop chuyển Merchize' }, token), { params: { key: KEY } })
const lineOf = (shopifyLineId: string) => prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER, shopifyLineId } })

async function clean() {
  await prisma.supplierOrderPush.deleteMany({ where: { orderId: ORDER } })
  await prisma.supplierSheetWrite.deleteMany({ where: { orderId: ORDER } })
  await prisma.order.deleteMany({ where: { id: ORDER } })
  await prisma.supplierProduct.deleteMany({ where: { supplierId: { in: [JOMALL, MERCHIZE] } } })
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'move-line-test-secret-is-long-enough-for-auth'
  await prisma.project.create({ data: { id: P, name: P, startDate: new Date() } })
  storeId = (await prisma.shopifyStore.create({ data: { shop: `${P}.myshopify.com`, projectId: P, orderPrefix: 'MV' } })).id
  await prisma.supplier.create({ data: { id: JOMALL, name: 'Jomall Test', code: `${P}-jm` } })
  await prisma.supplier.create({ data: { id: MERCHIZE, name: 'merchize', code: `${P}-mz`, apiType: 'merchize' } })
  const sa = await prisma.appUser.create({ data: { name: 'Super Admin', email: `${P}-sa@test.local`, role: 'SUPERADMIN', permissions: '[]' } })
  superToken = await signToken({ userId: sa.id, email: sa.email, name: sa.name, role: 'SUPERADMIN', permissions: [], tv: 0 })
  const ad = await prisma.appUser.create({ data: { name: 'Admin', email: `${P}-ad@test.local`, role: 'ADMIN', permissions: '[]' } })
  adminToken = await signToken({ userId: ad.id, email: ad.email, name: ad.name, role: 'ADMIN', permissions: [], tv: 0 })
})

beforeEach(async () => {
  await clean()
  await prisma.supplierProduct.create({ data: { id: `${P}-gaf-L`, supplierId: JOMALL, sku: 'GAF-L', baseSku: 'GAF', productName: 'AOP Hoodie', baseCost: 21, variant1Name: 'Size', variant1Value: 'L', requiresDesign: true } })
  await prisma.supplierProduct.create({ data: { id: `${P}-mwhd-L`, supplierId: MERCHIZE, sku: 'MWHDVN000000AA03', baseSku: 'MWHDVN', productName: 'All-over Print Hoodie (Midweight)', baseCost: 23.5, variant1Name: 'Size', variant1Value: 'L', requiresDesign: true, apiSku: 'MWHDVN000000AA03' } })
  await prisma.supplierProduct.create({ data: { id: `${P}-tee`, supplierId: MERCHIZE, sku: 'MZ-TEE-2XL', baseSku: 'MZTEE', productName: 'Tee', baseCost: 12, variant1Name: 'Size', variant1Value: '2XL', requiresDesign: true } })
  await upsertOrderWithLines(input())
  const hoodie = await lineOf(HOODIE)
  const tee = await lineOf(TEE)
  await prisma.orderLine.update({ where: { id: hoodie.id }, data: { exportedAt: CSV_AT, exportedToSupplierId: JOMALL, designDriveLink: 'https://drive.google.com/drive/folders/hoodie' } })
  await prisma.orderLine.update({ where: { id: tee.id }, data: { exportedAt: PUSH_AT, exportedToSupplierId: MERCHIZE, designDriveLink: 'https://drive.google.com/drive/folders/tee' } })
  await prisma.order.update({ where: { id: ORDER }, data: { exportedAt: PUSH_AT, exportedToSupplierId: MERCHIZE, supplierHandoffAt: PUSH_AT } })
  await prisma.supplierOrderPush.create({ data: {
    orderId: ORDER, supplierId: MERCHIZE, externalOrderId: 'MV5707', activeKey: `${ORDER}::${MERCHIZE}`, status: 'CREATED', requestJson: '{}', pushedAt: PUSH_AT, exportMarked: true,
    prevExportJson: JSON.stringify({ pipelineStatus: 'READY_TO_PRODUCTION', lineIds: [tee.id], shopifyLineIds: [TEE] }),
  } })
  await prisma.shipment.create({ data: { orderId: ORDER, projectId: P, lineKey: KEY, shopifyLineId: HOODIE, supplierId: JOMALL, status: 'PENDING' } })
  await prisma.designTask.create({ data: { taskKey: KEY, orderId: ORDER, shopifyLineId: HOODIE, status: 'DONE', readiness: 'AUTO' } })
})

afterAll(async () => {
  await clean()
  await prisma.supplier.deleteMany({ where: { id: { in: [JOMALL, MERCHIZE] } } })
  await prisma.appUser.deleteMany({ where: { email: { startsWith: P } } })
  await prisma.shopifyStore.delete({ where: { id: storeId } })
  await prisma.project.delete({ where: { id: P } })
})

describe('moving a line no supplier received (owner 11/21/2026, #LIT5707_1)', () => {
  it('drops the false CSV mark, resolves the line to the new supplier product, keeps the sibling and reopens the order', async () => {
    const r = await move()
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body).toMatchObject({ taskKey: KEY, clearedExportMark: true, orderReopened: true, from: 'Jomall Test GAF-L', to: 'merchize MWHDVN000000AA03' })
    const hoodie = await lineOf(HOODIE)
    expect(hoodie).toMatchObject({ resolvedSupplierId: MERCHIZE, resolvedSupplierSku: 'MWHDVN000000AA03', resolvedBaseCost: 23.5, exportedAt: null, exportedToSupplierId: null, variantTitle: 'Hoodie / L' })
    const override = productionOverride(hoodie.productionOverrideJson)
    expect(override).toMatchObject({ supplierId: MERCHIZE, supplierSku: 'MWHDVN000000AA03', supplierProductId: `${P}-mwhd-L`, customName: null })
    expect(override!.source.resolvedSupplierSku).toBe('GAF-L')
    const tee = await lineOf(TEE)
    expect(tee).toMatchObject({ exportedAt: PUSH_AT, exportedToSupplierId: MERCHIZE })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: ORDER } })
    expect(order.pipelineStatus).toBe('READY_TO_PRODUCTION')
    const ship = await prisma.shipment.findFirstOrThrow({ where: { orderId: ORDER, lineKey: KEY } })
    expect(ship.supplierId).toBe(MERCHIZE)
    const task = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: KEY }, include: { events: true } })
    expect(task.status).toBe('DONE')
    expect(task.events.find(e => e.message.startsWith(MOVE_EVENT_PREFIX))?.message).toMatch(/Jomall Test GAF-L → merchize MWHDVN000000AA03, gỡ dấu đã xuất 2026-11-04 12:53 UTC\. Lý do: CSV Jomall/)
  })

  it('the Merchize send then carries the moved line alone as a later send with a fresh external number', async () => {
    await move()
    const built = await buildMerchizePush(ORDER)
    expect(built).not.toBeNull()
    expect(built!.externalOrderId).toBe('MV5707-R2')
    expect(built!.preview.lines.map((l: any) => l.lineKey ?? l.key ?? l.refId)).toEqual([KEY])
    expect(built!.preview.issues.map((i: any) => i.code)).not.toContain('ACTIVE_PUSH')
  })

  it('only a super admin may move a line', async () => {
    const r = await move(adminToken)
    expect(r.status).toBe(403)
    expect((await lineOf(HOODIE)).resolvedSupplierId).toBe(JOMALL)
  })

  it('refuses a line already written to a supplier sheet', async () => {
    const hoodie = await lineOf(HOODIE)
    await prisma.supplierSheetWrite.create({ data: { supplierId: JOMALL, orderId: ORDER, orderLineId: hoodie.id, lineKey: KEY, spreadsheetId: 's', tabName: 'ORDER 11-2026', status: 'WRITTEN' } })
    const r = await move()
    expect(r.status).toBe(409)
    expect((await r.json()).error).toMatch(/sheet/)
    expect(await lineOf(HOODIE)).toMatchObject({ resolvedSupplierId: JOMALL, exportedAt: CSV_AT })
  })

  it('refuses a line carried by a live API push', async () => {
    const hoodie = await lineOf(HOODIE)
    await prisma.supplierOrderPush.updateMany({ where: { orderId: ORDER }, data: { prevExportJson: JSON.stringify({ lineIds: [hoodie.id], shopifyLineIds: [HOODIE] }) } })
    const r = await move()
    expect(r.status).toBe(409)
    expect((await r.json()).error).toMatch(/gửi API/)
  })

  it('refuses a line with its own tracking', async () => {
    await prisma.shipment.updateMany({ where: { orderId: ORDER, lineKey: KEY }, data: { trackingNumber: 'UL123456789YP' } })
    const r = await move()
    expect(r.status).toBe(409)
    expect((await r.json()).error).toMatch(/UL123456789YP/)
    expect((await lineOf(HOODIE)).exportedAt).toEqual(CSV_AT)
  })

  it('a tracking number borrowed from a sibling parcel (unsent line, same number as another line) does not block the move', async () => {
    const hoodie = await lineOf(HOODIE)
    await prisma.orderLine.update({ where: { id: hoodie.id }, data: { exportedAt: null, exportedToSupplierId: null } })
    await prisma.shipment.updateMany({ where: { orderId: ORDER, lineKey: KEY }, data: { trackingNumber: 'UL648909030YP' } })
    await prisma.shipment.create({ data: { orderId: ORDER, projectId: P, lineKey: 'MV5707_2', shopifyLineId: TEE, supplierId: MERCHIZE, trackingNumber: 'UL648909030YP', status: 'DELIVERED' } })
    const r = await move()
    expect(r.status).toBe(200)
    expect(await lineOf(HOODIE)).toMatchObject({ resolvedSupplierId: MERCHIZE, resolvedSupplierSku: 'MWHDVN000000AA03' })
    const ship = await prisma.shipment.findFirstOrThrow({ where: { orderId: ORDER, lineKey: KEY } })
    expect(ship.trackingNumber).toBe('UL648909030YP')
  })

  it('a shared number on a line that carries its own export mark still blocks the move', async () => {
    await prisma.shipment.updateMany({ where: { orderId: ORDER, lineKey: KEY }, data: { trackingNumber: 'UL648909030YP' } })
    await prisma.shipment.create({ data: { orderId: ORDER, projectId: P, lineKey: 'MV5707_2', shopifyLineId: TEE, supplierId: MERCHIZE, trackingNumber: 'UL648909030YP', status: 'DELIVERED' } })
    const r = await move()
    expect(r.status).toBe(409)
  })

  it('refuses a cancelled order and a missing reason', async () => {
    const bad = await POST(post({ supplierProductId: `${P}-mwhd-L`, reason: '' }), { params: { key: KEY } })
    expect(bad.status).toBe(400)
    await prisma.order.update({ where: { id: ORDER }, data: { pipelineStatus: 'CANCELLED' } })
    const r = await move()
    expect(r.status).toBe(409)
  })
})
