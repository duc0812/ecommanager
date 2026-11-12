import { describe, it, expect } from 'vitest'
import { extractOrderNumbers, factoryStateOf, orderItemsOf, personalizationOf } from '@/lib/cs/order-context'

const base = { supplierHandoffAt: null as Date | null, pipelineStatus: 'READY_TO_PRODUCTION', fulfillmentStatus: null as string | null, supplierPushes: [] as { status: string }[], shipments: [] as { status: string }[] }

describe('extractOrderNumbers', () => {
  it('finds a hashed number in a subject', () => {
    expect(extractOrderNumbers('Re: Order #LIT5037 confirmed')).toEqual(['#LIT5037'])
  })
  it('finds a bare number with no hash', () => {
    expect(extractOrderNumbers('LIT3910')).toEqual(['#LIT3910'])
  })
  it('normalises case and spacing, dedupes', () => {
    expect(extractOrderNumbers('my order lit 4525 and #lit4525 again')).toEqual(['#LIT4525'])
  })
  it('returns empty when nothing matches', () => {
    expect(extractOrderNumbers('no order here')).toEqual([])
  })
})

describe('personalizationOf', () => {
  it('reads the visible checkout properties and skips hidden ones', () => {
    const attrs = JSON.stringify([{ key: 'Custom Name', value: 'Maree' }, { key: '_pers', value: 'mvm1hmx02onb' }, { key: '_product_url', value: 'https://x' }])
    expect(personalizationOf({ customAttributesJson: attrs, customallFieldsJson: null, designNote: null })).toBe('Custom Name: Maree')
  })
  it("merges Customall fields and the design note, keeping the customer's exact text", () => {
    const attrs = JSON.stringify([{ key: '_customall_preview', value: 'https://p' }])
    const ca = JSON.stringify([{ key: 'Choose Back Dessign', value: 'Yes' }, { key: 'Custom Name', value: 'BURNAM' }, { key: 'Custom Number', value: '35' }])
    expect(personalizationOf({ customAttributesJson: attrs, customallFieldsJson: ca, designNote: 'print name on both sides' }))
      .toBe('Choose Back Dessign: Yes; Custom Name: BURNAM; Custom Number: 35; note: print name on both sides')
  })
  it('keeps trailing spaces visible so staff see what the customer typed', () => {
    const attrs = JSON.stringify([{ key: 'Custom Name', value: 'Trenton ' }])
    expect(personalizationOf({ customAttributesJson: attrs, customallFieldsJson: null, designNote: null })).toBe('Custom Name: "Trenton "')
  })
  it('falls back to the cm1 design payload text when no visible property exists', () => {
    const attrs = JSON.stringify([{ key: '_design', value: JSON.stringify({ v: 'cm1', data: { _vfmen: { text: 'Trenton' } } }) }])
    expect(personalizationOf({ customAttributesJson: attrs, customallFieldsJson: null, designNote: null })).toBe('text: Trenton')
  })
  it('is null when nothing was typed or the json is broken', () => {
    expect(personalizationOf({ customAttributesJson: '[{"key":"_product_url","value":"x"}]', customallFieldsJson: null, designNote: null })).toBeNull()
    expect(personalizationOf({ customAttributesJson: 'not json', customallFieldsJson: null, designNote: null })).toBeNull()
    expect(personalizationOf({ customAttributesJson: null, customallFieldsJson: null, designNote: null })).toBeNull()
  })
})

describe('factoryStateOf', () => {
  it('NOT_SENT before handoff', () => {
    expect(factoryStateOf(base)).toBe('NOT_SENT')
  })
  it('AT_FACTORY once a live push exists', () => {
    expect(factoryStateOf({ ...base, supplierPushes: [{ status: 'CREATED' }] })).toBe('AT_FACTORY')
  })
  it('AT_FACTORY once handed off manually', () => {
    expect(factoryStateOf({ ...base, supplierHandoffAt: new Date() })).toBe('AT_FACTORY')
  })
  it('SHIPPED when a shipment is moving', () => {
    expect(factoryStateOf({ ...base, pipelineStatus: 'EXPORTED', shipments: [{ status: 'IN_TRANSIT' }] })).toBe('SHIPPED')
  })
  it('DELIVERED when every shipment is delivered', () => {
    expect(factoryStateOf({ ...base, shipments: [{ status: 'DELIVERED' }] })).toBe('DELIVERED')
  })
  it('CANCELLED pipeline wins', () => {
    expect(factoryStateOf({ ...base, pipelineStatus: 'CANCELLED', shipments: [{ status: 'DELIVERED' }] })).toBe('CANCELLED')
  })
})

describe('orderItemsOf', () => {
  const names = new Map([['mango', 'Mangoshao'], ['pg', 'Pgprints']])
  const line = (n: number, extra: Record<string, unknown> = {}) => ({
    id: `ol-${n}`, shopifyLineId: `gid/${n}`, productTitle: `Item ${n}`, variantTitle: 'One', qty: 1, linePosition: n, sku: `SKU${n}`, shopifyProductType: 'Tumbler',
    resolvedSupplierId: 'mango', exportedToSupplierId: null as string | null, exportedAt: null as Date | null, ...extra,
  })
  const ship = (lineId: string, extra: Record<string, unknown> = {}) => ({
    shopifyLineId: lineId, lineKey: null, trackingNumber: 'UL1', carrier: 'Other', detectedCarrier: 'Yanwen', lastMileCarrier: 'Yodel', status: 'DELIVERED', supplierId: 'mango',
    lastCheckpointAt: new Date('2026-11-09T12:55:01Z'), trackingUrl: null,
    checkpointsJson: JSON.stringify([{ time: '2026-11-09T10:35:18', desc: 'Driver enroute, NANTGARW', status: 'IN_TRANSIT' }, { time: '2026-11-09T12:55:01', desc: 'Delivered, handed to customer, NANTGARW', status: 'DELIVERED' }]),
    ppTimingJson: JSON.stringify({ deliveryDate: '2026-11-09T12:55:01' }), ...extra,
  })
  const input = (o: Partial<Parameters<typeof orderItemsOf>[0]>) => ({ orderNumber: '#LIT4987', lines: [], pushes: [], sheetWrites: [], shipments: [], supplierNames: names, ...o })

  it('reads the factory, the way and the date each item was sent, skipping add-ons', () => {
    const items = orderItemsOf(input({
      lines: [
        line(1),
        line(2, { productTitle: 'Shipping protection', sku: null, shopifyProductType: 'Kaching Cart Upsell Toggle' }),
        line(3, { exportedToSupplierId: 'mango', exportedAt: new Date('2026-10-28T01:52:59Z') }),
        line(4, { resolvedSupplierId: 'pg' }),
      ],
      pushes: [{ supplierId: 'pg', status: 'CREATED', supplierOrderCode: 'PG8160-1060', pushedAt: new Date('2026-10-26T05:44:26Z'), remoteStatus: 'in-production', lastSyncedAt: new Date('2026-11-07T20:30:00Z'), prevExportJson: JSON.stringify({ shopifyLineIds: ['gid/4'] }) }],
      sheetWrites: [{ orderLineId: 'ol-1', lineKey: 'LIT4987_1', supplierId: 'mango', tabName: 'CN_POD_MS-20261028', status: 'WRITTEN', createdAt: new Date('2026-10-28T02:00:00Z') }],
    }))
    expect(items.map(i => i.lineKey)).toEqual(['LIT4987_1', 'LIT4987_2', 'LIT4987_3'])
    expect(items[0].send).toMatchObject({ supplier: 'Mangoshao', via: 'SHEET', ref: 'CN_POD_MS-20261028' })
    expect(items[1].send).toMatchObject({ supplier: 'Mangoshao', via: 'CSV', sentAt: new Date('2026-10-28T01:52:59Z') })
    expect(items[2].send).toMatchObject({ supplier: 'Pgprints', via: 'API', ref: 'PG8160-1060', factoryStatus: 'in-production' })
  })
  it('gives the newest scan, the delivery date and the items sharing a tracking', () => {
    const items = orderItemsOf(input({
      lines: [line(1, { exportedToSupplierId: 'mango', exportedAt: new Date('2026-10-28T00:00:00Z') }), line(2, { exportedToSupplierId: 'mango', exportedAt: new Date('2026-10-28T00:00:00Z') })],
      shipments: [ship('gid/1'), ship('gid/2')],
    }))
    expect(items[0].parcel).toMatchObject({ trackingNumber: 'UL1', carrier: 'Yodel', status: 'DELIVERED', lastEvent: 'Delivered, handed to customer, NANTGARW', sharedWith: ['LIT4987_2'] })
    expect(items[0].parcel?.deliveredAt?.toISOString()).toBe('2026-11-09T12:55:01.000Z')
    expect(items[0].warning).toBeNull()
  })
  it('warns when an item carries a tracking but no record of being sent (LIT4987 tumbler)', () => {
    const items = orderItemsOf(input({
      lines: [line(1), line(2, { exportedToSupplierId: 'mango', exportedAt: new Date('2026-10-28T00:00:00Z') })],
      shipments: [ship('gid/1'), ship('gid/2')],
    }))
    expect(items[0].send).toBeNull()
    expect(items[0].warning).toMatch(/không tìm được thông tin gửi xưởng/i)
    expect(items[1].warning).toBeNull()
  })
  it('warns when the tracking came from another factory than the one the item was sent to', () => {
    const items = orderItemsOf(input({
      lines: [line(1, { exportedToSupplierId: 'pg', exportedAt: new Date('2026-10-26T00:00:00Z') })],
      shipments: [ship('gid/1')],
    }))
    expect(items[0].warning).toMatch(/Mangoshao.*Pgprints/)
  })
  it('an item with no send record and no tracking just says so, without a warning', () => {
    const [item] = orderItemsOf(input({ lines: [line(1)] }))
    expect(item.send).toBeNull()
    expect(item.parcel).toBeNull()
    expect(item.warning).toBeNull()
  })
  it('ignores a failed push and a failed sheet write', () => {
    const [item] = orderItemsOf(input({
      lines: [line(1)],
      pushes: [{ supplierId: 'pg', status: 'FAILED', supplierOrderCode: null, pushedAt: new Date('2026-10-26T00:00:00Z'), remoteStatus: null, lastSyncedAt: null, prevExportJson: JSON.stringify({ shopifyLineIds: ['gid/1'] }) }],
      sheetWrites: [{ orderLineId: 'ol-1', lineKey: 'LIT4987_1', supplierId: 'mango', tabName: 'X', status: 'FAILED', createdAt: new Date('2026-10-26T00:00:00Z') }],
    }))
    expect(item.send).toBeNull()
  })
})
