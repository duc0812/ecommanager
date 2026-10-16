import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { compressToBase64 } from 'lz-string'
import { pack } from 'jsonpack'
import { prisma } from '@/lib/db'
import { upsertOrderWithLines } from '@/lib/repos/orders'
import { loadWorkspace } from '@/lib/design-studio'
import { encodeRequest, fillCustomallFields } from '@/lib/customall-fields'

const ORDER_ID = 'gid://test/Order/customall-1'
const SHOP = 'customall-test.myshopify.com'
const PRODUCT = 'gid://shopify/Product/8913496703133'
const CID = '2026-09-27/eqq4sfkshuulnq5zvbcodk'
const API = 'https://apis-v2.customall.io/app'

const CAMPAIGN = {
  artworks: [{
    id: 'AhbLWbU1L',
    templates: [{ title: 'Default', layers: [
      { id: '_kl07k', type: 'Option', title: 'Choose Back Dessign', options: [{ label: 'No', value: 'option-1' }, { label: 'Yes', value: 'frkhqFIap' }] },
      { id: '_4j531', type: 'Text', title: 'Custom Name' },
      { id: '_ey6w2', type: 'Text', title: 'Custom Number' },
    ] }],
  }],
}

function orderInput(storeId: string) {
  return {
    id: ORDER_ID, projectId: 'proj_customall', storeId, shopifyOrderNumber: '#CA1',
    customerEmail: null, customerName: null, shippingCountry: null, shippingState: null,
    financialStatus: 'PAID', fulfillmentStatus: null, currency: 'USD',
    grossAmount: 50, expectedPayout: 48, totalFees: 2, refundedAmount: 0,
    defaultSupplierId: null, placedAt: new Date('2026-09-27T00:00:00Z'),
    lines: [
      {
        shopifyLineId: 'ca-line-1', sku: 'PK05111508-K6Y', variantTitle: 'Kid 6Y', productTitle: 'PoMo jersey',
        qty: 1, linePosition: 1, unitPrice: 50, resolvedSupplierId: null, resolvedBaseCost: null, customized: true,
        shopifyProductId: PRODUCT,
        customAttributesJson: JSON.stringify([
          { key: '_customall_print_file', value: 'https://cdn.customall.io/kovSFNW33/2026-09-27/x5warakraczsqhr2e8uxqf.png' },
          { key: '_customallcustomid', value: CID },
        ]),
      },
      {
        shopifyLineId: 'ca-line-2', sku: null, variantTitle: 'Add Text', productTitle: 'Custom Text TN915',
        qty: 1, linePosition: 2, unitPrice: 5, resolvedSupplierId: null, resolvedBaseCost: null,
        customAttributesJson: JSON.stringify([{ key: '_add_on_customallcustomid', value: CID }]),
      },
    ],
  }
}

function customallServer(opts: { orderInfo?: unknown; failOrderInfo?: boolean } = {}) {
  const packed = (v: unknown) => new Response(JSON.stringify({ data: compressToBase64(pack(v)) }))
  const urls: string[] = []
  const fetchMock = vi.fn(async (input: any) => {
    const url = String(input)
    urls.push(url)
    if (url === `${API}/order-info/${encodeRequest({ customization_id: CID })}`) {
      if (opts.failOrderInfo) return new Response('{"message":"Internal Server Error"}', { status: 500 })
      return new Response(JSON.stringify(opts.orderInfo ?? { AhbLWbU1L: { template: 0, _kl07k: 'frkhqFIap', _4j531: 'Ianetta', _ey6w2: '26' } }))
    }
    if (url === `${API}/${encodeRequest({ uri: `hash/${SHOP}/8913496703133` })}.json`) return packed({ hash: 'bcdbf232' })
    if (url === `${API}/${encodeRequest({ uri: `${SHOP}/8913496703133/bcdbf232` })}.json`) return packed(CAMPAIGN)
    return new Response('not found', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return urls
}

let storeId = ''
beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_customall' }, create: { id: 'proj_customall', name: 'Customall', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_customall' }, update: {} })).id
})
afterEach(() => { vi.unstubAllGlobals() })
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
})

async function productLine() {
  return prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID, shopifyLineId: 'ca-line-1' } })
}

describe('fillCustomallFields', () => {
  it('shows a Customall line as pending until its text is read', async () => {
    await upsertOrderWithLines(orderInput(storeId))
    const ws = await loadWorkspace(ORDER_ID)
    const line = ws!.lines.find(l => l.shopifyLineId === 'ca-line-1')!
    expect(line.customallPending).toBe(true)
    expect(line.personalization).toEqual([])
    expect(ws!.lines.find(l => l.shopifyLineId === 'ca-line-2')!.customallPending).toBe(false)
  })

  it('leaves the line unread when Customall does not answer', async () => {
    customallServer({ failOrderInfo: true })
    const r = await fillCustomallFields([ORDER_ID])
    expect(r).toMatchObject({ filled: 0, failed: 1 })
    expect((await productLine()).customallFieldsJson).toBeNull()
  })

  it('a throttled run does not ask again right after a failure', async () => {
    const urls = customallServer()
    const r = await fillCustomallFields([ORDER_ID], { throttle: true })
    expect(r).toMatchObject({ filled: 0, failed: 0 })
    expect(urls).toEqual([])
  })

  it('stores the typed text named by the campaign, and only on the product line', async () => {
    customallServer()
    const r = await fillCustomallFields([ORDER_ID])
    expect(r).toMatchObject({ filled: 1, failed: 0 })
    expect(JSON.parse((await productLine()).customallFieldsJson!)).toEqual([
      { key: 'Choose Back Dessign', value: 'Yes' },
      { key: 'Custom Name', value: 'Ianetta' },
      { key: 'Custom Number', value: '26' },
    ])
    const addOn = await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID, shopifyLineId: 'ca-line-2' } })
    expect(addOn.customallFieldsJson).toBeNull()
  })

  it('does not ask Customall again for a line already read', async () => {
    const urls = customallServer()
    expect(await fillCustomallFields([ORDER_ID])).toMatchObject({ filled: 0, failed: 0 })
    expect(urls).toEqual([])
  })

  it('keeps the stored text when the next Shopify sync recreates the lines', async () => {
    await upsertOrderWithLines(orderInput(storeId))
    expect(JSON.parse((await productLine()).customallFieldsJson!)).toHaveLength(3)
  })

  it('puts the text in the workspace personalization, marked as Customall', async () => {
    const ws = await loadWorkspace(ORDER_ID)
    const line = ws!.lines.find(l => l.shopifyLineId === 'ca-line-1')!
    expect(line.customallPending).toBe(false)
    expect(line.personalization).toEqual([
      { key: 'Choose Back Dessign', value: 'Yes', source: 'customall' },
      { key: 'Custom Name', value: 'Ianetta', source: 'customall' },
      { key: 'Custom Number', value: '26', source: 'customall' },
    ])
  })

  it('force reads it again', async () => {
    customallServer({ orderInfo: { AhbLWbU1L: { template: 0, _4j531: 'Ianetta', _ey6w2: '6' } } })
    expect(await fillCustomallFields([ORDER_ID], { force: true })).toMatchObject({ filled: 1 })
    expect(JSON.parse((await productLine()).customallFieldsJson!)).toEqual([
      { key: 'Custom Name', value: 'Ianetta' },
      { key: 'Custom Number', value: '6' },
    ])
  })
})
