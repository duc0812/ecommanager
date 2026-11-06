import { describe, it, expect } from 'vitest'
import { normalizeBaseOrder, orderLineKey, groupByOrder, mergeSheetGroups, buildFulfillmentPlan, type OrderRow } from './build-fulfill-plan'

const NOW = new Date('2026-09-05T00:00:00Z')
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000)

describe('normalizeBaseOrder / orderLineKey', () => {
  it('strips # and sub-order suffix for base', () => {
    expect(normalizeBaseOrder('#LIT2604_2')).toBe('LIT2604')
    expect(normalizeBaseOrder('LIT2604')).toBe('LIT2604')
    expect(normalizeBaseOrder('#LIT2713_2_1')).toBe('LIT2713')
  })
  it('lineKey strips only the leading #', () => {
    expect(orderLineKey('#LIT2604_2')).toBe('LIT2604_2')
    expect(orderLineKey('#LIT2604')).toBe('LIT2604')
  })
  it('preserves revision tokens like R/R1 — they are distinct orders, not sub-order suffixes', () => {
    expect(normalizeBaseOrder('#LIT2362R1')).toBe('LIT2362R1')
    expect(normalizeBaseOrder('#LIT2736R')).toBe('LIT2736R')
  })
})

describe('groupByOrder', () => {
  it('groups rows under their base order', () => {
    const g = groupByOrder([
      { orderToken: '#LIT1_1', tracking: 'AA' },
      { orderToken: '#LIT1_2', tracking: 'AA' },
      { orderToken: '#LIT2', tracking: 'BB' },
    ])
    expect(g.get('LIT1')).toEqual([{ lineKey: 'LIT1_1', tracking: 'AA' }, { lineKey: 'LIT1_2', tracking: 'AA' }])
    expect(g.get('LIT2')).toEqual([{ lineKey: 'LIT2', tracking: 'BB' }])
  })
})

describe('mergeSheetGroups', () => {
  it('merges the same order across supplier sheets (multi-supplier order must not lose lines)', () => {
    // Real case #LIT3498: _1 lives in the Mangoshao sheet, _2/_3 in the Jomall sheet.
    const target = new Map<string, { rows: Array<{ lineKey: string; tracking: string }> }>()
    mergeSheetGroups(target, groupByOrder([{ orderToken: '#LIT3498_1', tracking: 'UL481452389YP' }]))
    mergeSheetGroups(target, groupByOrder([
      { orderToken: '#LIT3498_2', tracking: 'SWX859060000168964562' },
      { orderToken: '#LIT3498_3', tracking: 'SWX859060000168964562' },
    ]))

    const entry = target.get('LIT3498')!
    expect(entry.rows).toEqual([
      { lineKey: 'LIT3498_1', tracking: 'UL481452389YP' },
      { lineKey: 'LIT3498_2', tracking: 'SWX859060000168964562' },
      { lineKey: 'LIT3498_3', tracking: 'SWX859060000168964562' },
    ])
  })

  it('dedupes identical rows but keeps a conflicting tracking for the same line', () => {
    const target = new Map<string, { rows: Array<{ lineKey: string; tracking: string }> }>()
    mergeSheetGroups(target, groupByOrder([{ orderToken: '#LIT1_1', tracking: 'AA' }]))
    mergeSheetGroups(target, groupByOrder([
      { orderToken: '#LIT1_1', tracking: 'AA' },  // exact duplicate → dropped
      { orderToken: '#LIT1_1', tracking: 'BB' },  // conflict → kept so the plan flags needs_manual
    ]))
    expect(target.get('LIT1')!.rows).toEqual([
      { lineKey: 'LIT1_1', tracking: 'AA' },
      { lineKey: 'LIT1_1', tracking: 'BB' },
    ])
  })
})

const foOneOpenLine = [{ id: 'fo1', status: 'OPEN', lineItems: [
  { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
] }]
// The order in the DB with its one product line, sent: a bare order number then stands for that line.
const oneLine = [{ shopifyLineId: 'gid://li/A', lineKey: 'LIT1_1', sent: true }]

describe('buildFulfillmentPlan', () => {
  const base = { displayFulfillmentStatus: 'UNFULFILLED', now: NOW, minAgeDays: 5 }

  it('not_found when Shopify order missing', () => {
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1', tracking: 'AA' }], shipments: [], fulfillmentOrders: null, placedAt: days(10) })
    expect(p.status).toBe('not_found')
  })

  it('too_recent when younger than the age gate', () => {
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1', tracking: 'AA' }], shipments: [], fulfillmentOrders: foOneOpenLine, placedAt: days(4) })
    expect(p.status).toBe('too_recent')
    expect(p.ageDays).toBe(4)
  })

  it('will_fulfill at exactly the age threshold, whole-order one tracking', () => {
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1', tracking: 'AA' }], shipments: [], fulfillmentOrders: foOneOpenLine, productLines: oneLine, placedAt: days(5) })
    expect(p.status).toBe('will_fulfill')
    expect(p.fulfillments).toEqual([{ fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-A', quantity: 1 }], tracking: 'AA', shipmentIds: [] }])
  })

  it('already_fulfilled when Shopify reports FULFILLED', () => {
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1', tracking: 'AA' }], shipments: [], fulfillmentOrders: [], displayFulfillmentStatus: 'FULFILLED', placedAt: days(10) })
    expect(p.status).toBe('already_fulfilled')
  })

  it('splits by tracking per line, mapping via shipments', () => {
    const fo = [{ id: 'fo1', status: 'OPEN', lineItems: [
      { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
      { id: 'foli-B', remainingQuantity: 1, shopifyLineId: 'gid://li/B', sku: 'B' },
    ] }]
    const shipments = [
      { id: 's1', lineKey: 'LIT1_1', shopifyLineId: 'gid://li/A' },
      { id: 's2', lineKey: 'LIT1_2', shopifyLineId: 'gid://li/B' },
    ]
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [
      { lineKey: 'LIT1_1', tracking: 'AA' },
      { lineKey: 'LIT1_2', tracking: 'BB' },
    ], shipments, fulfillmentOrders: fo, placedAt: days(9) })
    expect(p.status).toBe('will_fulfill')
    expect(p.fulfillments).toEqual([
      { fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-A', quantity: 1 }], tracking: 'AA', shipmentIds: ['s1'] },
      { fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-B', quantity: 1 }], tracking: 'BB', shipmentIds: ['s2'] },
    ])
  })

  it('same tracking across all listed sub-orders → merged into ONE fulfillment (whole order)', () => {
    const fo = [{ id: 'fo1', status: 'OPEN', lineItems: [
      { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
      { id: 'foli-B', remainingQuantity: 1, shopifyLineId: 'gid://li/B', sku: 'B' },
      { id: 'foli-C', remainingQuantity: 1, shopifyLineId: 'gid://li/C', sku: 'C' },
    ] }]
    const shipments = [
      { id: 's1', lineKey: 'LIT1_1', shopifyLineId: 'gid://li/A' },
      { id: 's2', lineKey: 'LIT1_2', shopifyLineId: 'gid://li/B' },
      { id: 's3', lineKey: 'LIT1_3', shopifyLineId: 'gid://li/C' },
    ]
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [
      { lineKey: 'LIT1_1', tracking: 'AA' },
      { lineKey: 'LIT1_2', tracking: 'AA' },
      { lineKey: 'LIT1_3', tracking: 'AA' },
    ], shipments, fulfillmentOrders: fo, placedAt: days(9) })
    expect(p.status).toBe('will_fulfill')
    expect(p.fulfillments).toEqual([
      { fulfillmentOrderId: 'fo1', lineItems: [
        { id: 'foli-A', quantity: 1 }, { id: 'foli-B', quantity: 1 }, { id: 'foli-C', quantity: 1 },
      ], tracking: 'AA', shipmentIds: ['s1', 's2', 's3'] },
    ])
  })

  it('partial: 3 of 4 items listed (same tracking) → fulfill those 3, leave the unlisted line untouched', () => {
    const fo = [{ id: 'fo1', status: 'OPEN', lineItems: [
      { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
      { id: 'foli-B', remainingQuantity: 1, shopifyLineId: 'gid://li/B', sku: 'B' },
      { id: 'foli-C', remainingQuantity: 1, shopifyLineId: 'gid://li/C', sku: 'C' },
      { id: 'foli-D', remainingQuantity: 1, shopifyLineId: 'gid://li/D', sku: 'D' }, // supplier B — no tracking yet, NOT in sheet
    ] }]
    const shipments = [
      { id: 's1', lineKey: 'LIT1_1', shopifyLineId: 'gid://li/A' },
      { id: 's2', lineKey: 'LIT1_2', shopifyLineId: 'gid://li/B' },
      { id: 's3', lineKey: 'LIT1_3', shopifyLineId: 'gid://li/C' },
      { id: 's4', lineKey: 'LIT1_4', shopifyLineId: 'gid://li/D' },
    ]
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [
      { lineKey: 'LIT1_1', tracking: 'AA' },
      { lineKey: 'LIT1_2', tracking: 'AA' },
      { lineKey: 'LIT1_3', tracking: 'AA' },
    ], shipments, fulfillmentOrders: fo, displayFulfillmentStatus: 'UNFULFILLED', placedAt: days(9) })
    expect(p.status).toBe('will_fulfill')
    expect(p.fulfillments).toEqual([
      { fulfillmentOrderId: 'fo1', lineItems: [
        { id: 'foli-A', quantity: 1 }, { id: 'foli-B', quantity: 1 }, { id: 'foli-C', quantity: 1 },
      ], tracking: 'AA', shipmentIds: ['s1', 's2', 's3'] },
    ])
    // foli-D (supplier B, unlisted) must NOT appear in any fulfillment
    const allLineIds = p.fulfillments.flatMap(f => f.lineItems.map(li => li.id))
    expect(allLineIds).not.toContain('foli-D')
  })

  it('mixed trackings 3+1 (all listed) → one fulfillment per tracking (3 lines T1, 1 line T2)', () => {
    const fo = [{ id: 'fo1', status: 'OPEN', lineItems: [
      { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
      { id: 'foli-B', remainingQuantity: 1, shopifyLineId: 'gid://li/B', sku: 'B' },
      { id: 'foli-C', remainingQuantity: 1, shopifyLineId: 'gid://li/C', sku: 'C' },
      { id: 'foli-D', remainingQuantity: 1, shopifyLineId: 'gid://li/D', sku: 'D' },
    ] }]
    const shipments = [
      { id: 's1', lineKey: 'LIT1_1', shopifyLineId: 'gid://li/A' },
      { id: 's2', lineKey: 'LIT1_2', shopifyLineId: 'gid://li/B' },
      { id: 's3', lineKey: 'LIT1_3', shopifyLineId: 'gid://li/C' },
      { id: 's4', lineKey: 'LIT1_4', shopifyLineId: 'gid://li/D' },
    ]
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [
      { lineKey: 'LIT1_1', tracking: 'T1' },
      { lineKey: 'LIT1_2', tracking: 'T1' },
      { lineKey: 'LIT1_3', tracking: 'T1' },
      { lineKey: 'LIT1_4', tracking: 'T2' },
    ], shipments, fulfillmentOrders: fo, placedAt: days(9) })
    expect(p.status).toBe('will_fulfill')
    expect(p.fulfillments).toEqual([
      { fulfillmentOrderId: 'fo1', lineItems: [
        { id: 'foli-A', quantity: 1 }, { id: 'foli-B', quantity: 1 }, { id: 'foli-C', quantity: 1 },
      ], tracking: 'T1', shipmentIds: ['s1', 's2', 's3'] },
      { fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-D', quantity: 1 }], tracking: 'T2', shipmentIds: ['s4'] },
    ])
  })

  it('needs_manual when a sub-order line cannot be mapped', () => {
    const fo = [{ id: 'fo1', status: 'OPEN', lineItems: [
      { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
    ] }]
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [
      { lineKey: 'LIT1_1', tracking: 'AA' },
      { lineKey: 'LIT1_2', tracking: 'BB' },
    ], shipments: [{ id: 's1', lineKey: 'LIT1_1', shopifyLineId: 'gid://li/A' }], fulfillmentOrders: fo, placedAt: days(9) })
    expect(p.status).toBe('needs_manual')
  })

  it('needs_manual when the sheet mixes a whole-order row with per-line rows for the same order', () => {
    const fo = [{ id: 'fo1', status: 'OPEN', lineItems: [
      { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
      { id: 'foli-B', remainingQuantity: 1, shopifyLineId: 'gid://li/B', sku: 'B' },
    ] }]
    const shipments = [{ id: 's2', lineKey: 'LIT1_2', shopifyLineId: 'gid://li/B' }]
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [
      { lineKey: 'LIT1', tracking: 'AA' },    // whole-order (unsuffixed) row
      { lineKey: 'LIT1_2', tracking: 'AA' },  // per-line row for the same order
    ], shipments, fulfillmentOrders: fo, placedAt: days(9) })
    expect(p.status).toBe('needs_manual')
  })

  it('needs_manual when two rows map to the same line with different trackings', () => {
    const fo = [{ id: 'fo1', status: 'OPEN', lineItems: [
      { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
    ] }]
    const shipments = [{ id: 's1', lineKey: 'LIT1_1', shopifyLineId: 'gid://li/A' }]
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [
      { lineKey: 'LIT1_1', tracking: 'AA' },
      { lineKey: 'LIT1_1', tracking: 'BB' }, // same sub-order line, conflicting tracking
    ], shipments, fulfillmentOrders: fo, placedAt: days(9) })
    expect(p.status).toBe('needs_manual')
  })

  it('needs_manual when a listed line sits on an on-hold FO (not silently skipped as fulfilled)', () => {
    const fo = [
      { id: 'fo1', status: 'OPEN', lineItems: [
        { id: 'foli-B', remainingQuantity: 1, shopifyLineId: 'gid://li/B', sku: 'B' },
      ] },
      { id: 'fo2', status: 'ON_HOLD', lineItems: [
        { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
      ] },
    ]
    const shipments = [
      { id: 's1', lineKey: 'LIT1_1', shopifyLineId: 'gid://li/A' }, // listed, but its line is on hold
      { id: 's2', lineKey: 'LIT1_2', shopifyLineId: 'gid://li/B' },
    ]
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [
      { lineKey: 'LIT1_1', tracking: 'AA' },
      { lineKey: 'LIT1_2', tracking: 'BB' },
    ], shipments, fulfillmentOrders: fo, placedAt: days(9) })
    expect(p.status).toBe('needs_manual')
  })

  it('needs_manual when order date is unknown', () => {
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1', tracking: 'AA' }], shipments: [], fulfillmentOrders: foOneOpenLine, placedAt: null })
    expect(p.status).toBe('needs_manual')
  })

  it('idempotent-skip: a sub-order line already fulfilled (remainingQuantity 0) is skipped, not needs_manual', () => {
    const fo = [{ id: 'fo1', status: 'OPEN', lineItems: [
      { id: 'foli-A', remainingQuantity: 0, shopifyLineId: 'gid://li/A', sku: 'A' },
      { id: 'foli-B', remainingQuantity: 1, shopifyLineId: 'gid://li/B', sku: 'B' },
    ] }]
    const shipments = [
      { id: 's1', lineKey: 'LIT1_1', shopifyLineId: 'gid://li/A' },
      { id: 's2', lineKey: 'LIT1_2', shopifyLineId: 'gid://li/B' },
    ]
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [
      { lineKey: 'LIT1_1', tracking: 'AA' },
      { lineKey: 'LIT1_2', tracking: 'BB' },
    ], shipments, fulfillmentOrders: fo, placedAt: days(9) })
    expect(p.status).toBe('will_fulfill')
    expect(p.fulfillments).toEqual([
      { fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-B', quantity: 1 }], tracking: 'BB', shipmentIds: ['s2'] },
    ])
  })

  it('no-open-lines: FO is OPEN but all lines have remainingQuantity 0 → already_fulfilled', () => {
    const fo = [{ id: 'fo1', status: 'OPEN', lineItems: [
      { id: 'foli-A', remainingQuantity: 0, shopifyLineId: 'gid://li/A', sku: 'A' },
    ] }]
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1', tracking: 'AA' }], shipments: [], fulfillmentOrders: fo, displayFulfillmentStatus: 'PARTIALLY_FULFILLED', placedAt: days(9) })
    expect(p.status).toBe('already_fulfilled')
  })

  it('FO on hold: a single FO with status ON_HOLD and an open-qty line → needs_manual', () => {
    const fo = [{ id: 'fo1', status: 'ON_HOLD', lineItems: [
      { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
    ] }]
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1', tracking: 'AA' }], shipments: [], fulfillmentOrders: fo, placedAt: days(9) })
    expect(p.status).toBe('needs_manual')
  })

  it('FO in progress: status IN_PROGRESS with a remaining line still gets fulfilled', () => {
    const fo = [{ id: 'fo1', status: 'IN_PROGRESS', lineItems: [
      { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
    ] }]
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1', tracking: 'AA' }], shipments: [], fulfillmentOrders: fo, productLines: oneLine, placedAt: days(9) })
    expect(p.status).toBe('will_fulfill')
    expect(p.fulfillments).toEqual([{ fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-A', quantity: 1 }], tracking: 'AA', shipmentIds: [] }])
  })
})

describe('buildFulfillmentPlan — add-on lines (Shipping protection / Tip / Custom Text)', () => {
  const base = { displayFulfillmentStatus: 'UNFULFILLED', now: NOW, minAgeDays: 5 }
  // Real shape from Shopify: a non-shippable add-on gets its OWN open fulfillment order.
  const productFo = { id: 'fo1', status: 'OPEN', lineItems: [{ id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' }] }
  const protectionFo = { id: 'fo2', status: 'OPEN', lineItems: [{ id: 'foli-P', remainingQuantity: 1, shopifyLineId: 'gid://li/P', sku: null }] }
  const ship1 = { id: 's1', lineKey: 'LIT1_1', shopifyLineId: 'gid://li/A' }

  it('closes the protection line (own FO, no tracking) once every product line is covered', () => {
    const p = buildFulfillmentPlan({
      ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1_1', tracking: 'AA' }],
      shipments: [ship1], fulfillmentOrders: [productFo, protectionFo],
      addOnLineIds: ['gid://li/P'], placedAt: days(9),
    })
    expect(p.status).toBe('will_fulfill')
    expect(p.fulfillments).toEqual([
      { fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-A', quantity: 1 }], tracking: 'AA', shipmentIds: ['s1'] },
      { fulfillmentOrderId: 'fo2', lineItems: [{ id: 'foli-P', quantity: 1 }], tracking: '', shipmentIds: [], addOn: true },
    ])
    expect(p.openLineCount).toBe(2) // both covered → caller marks the order FULFILLED
  })

  it('repairs an order already shipped short: products fulfilled, only the protection FO left open', () => {
    // #LIT3498 / #LIT3534 on prod: product FO CLOSED, protection FO still OPEN → PARTIALLY_FULFILLED.
    const closedProductFo = { id: 'fo1', status: 'CLOSED', lineItems: [{ id: 'foli-A', remainingQuantity: 0, shopifyLineId: 'gid://li/A', sku: 'A' }] }
    const p = buildFulfillmentPlan({
      ...base, displayFulfillmentStatus: 'PARTIALLY_FULFILLED', baseOrder: 'LIT1',
      rows: [{ lineKey: 'LIT1_1', tracking: 'AA' }], shipments: [ship1],
      fulfillmentOrders: [closedProductFo, protectionFo], addOnLineIds: ['gid://li/P'], placedAt: days(15),
    })
    expect(p.status).toBe('will_fulfill')
    expect(p.fulfillments).toEqual([
      { fulfillmentOrderId: 'fo2', lineItems: [{ id: 'foli-P', quantity: 1 }], tracking: '', shipmentIds: [], addOn: true },
    ])
  })

  it('leaves the add-on alone while a product line is still unshipped (partial fulfillment)', () => {
    const twoProductFo = { id: 'fo1', status: 'OPEN', lineItems: [
      { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
      { id: 'foli-B', remainingQuantity: 1, shopifyLineId: 'gid://li/B', sku: 'B' },
    ] }
    const p = buildFulfillmentPlan({
      ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1_1', tracking: 'AA' }],
      shipments: [ship1, { id: 's2', lineKey: 'LIT1_2', shopifyLineId: 'gid://li/B' }],
      fulfillmentOrders: [twoProductFo, protectionFo], addOnLineIds: ['gid://li/P'], placedAt: days(9),
    })
    expect(p.status).toBe('will_fulfill')
    expect(p.fulfillments).toEqual([
      { fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-A', quantity: 1 }], tracking: 'AA', shipmentIds: ['s1'] },
    ])
  })

  it('an add-on sharing the product FO rides along on that fulfillment (one email, same tracking)', () => {
    // "Custom Text ... - Add Text" sits in the SAME fulfillment order as the goods.
    const fo = { id: 'fo1', status: 'OPEN', lineItems: [
      { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
      { id: 'foli-T', remainingQuantity: 1, shopifyLineId: 'gid://li/T', sku: 'TXT' },
    ] }
    const p = buildFulfillmentPlan({
      ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1_1', tracking: 'AA' }],
      shipments: [ship1], fulfillmentOrders: [fo], addOnLineIds: ['gid://li/T'], placedAt: days(9),
    })
    expect(p.fulfillments).toEqual([
      { fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-A', quantity: 1 }, { id: 'foli-T', quantity: 1 }], tracking: 'AA', shipmentIds: ['s1'] },
    ])
  })

  it('whole-order row: the add-on is closed without tracking, not merged into the shipment', () => {
    const p = buildFulfillmentPlan({
      ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1', tracking: 'AA' }],
      shipments: [], fulfillmentOrders: [productFo, protectionFo], addOnLineIds: ['gid://li/P'], productLines: oneLine, placedAt: days(9),
    })
    expect(p.fulfillments).toEqual([
      { fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-A', quantity: 1 }], tracking: 'AA', shipmentIds: [] },
      { fulfillmentOrderId: 'fo2', lineItems: [{ id: 'foli-P', quantity: 1 }], tracking: '', shipmentIds: [], addOn: true },
    ])
  })

  it('without addOnLineIds (order not in the DB) nothing extra is fulfilled', () => {
    const p = buildFulfillmentPlan({
      ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1_1', tracking: 'AA' }],
      shipments: [ship1], fulfillmentOrders: [productFo, protectionFo], placedAt: days(9),
    })
    expect(p.fulfillments).toEqual([
      { fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-A', quantity: 1 }], tracking: 'AA', shipmentIds: ['s1'] },
    ])
  })
})

describe('a product line is fulfilled only after it went to a supplier', () => {
  const base = { displayFulfillmentStatus: 'UNFULFILLED', now: NOW, minAgeDays: 5, placedAt: days(9) }
  const twoLineFo = [{ id: 'fo1', status: 'OPEN', lineItems: [
    { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
    { id: 'foli-B', remainingQuantity: 1, shopifyLineId: 'gid://li/B', sku: 'B' },
  ] }]
  const shipments = [
    { id: 's1', lineKey: 'LIT1_1', shopifyLineId: 'gid://li/A' },
    { id: 's2', lineKey: 'LIT1_2', shopifyLineId: 'gid://li/B' },
  ]
  const productLines = (sentA: boolean, sentB: boolean) => [
    { shopifyLineId: 'gid://li/A', lineKey: 'LIT1_1', sent: sentA },
    { shopifyLineId: 'gid://li/B', lineKey: 'LIT1_2', sent: sentB },
  ]
  const perLine = (rows: Array<{ lineKey: string; tracking: string }>, lines?: ReturnType<typeof productLines>) =>
    buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows, shipments, fulfillmentOrders: twoLineFo, ...(lines ? { productLines: lines } : {}) })

  it('a per-line row for an exported line plans exactly what it planned before the rule', () => {
    const rows = [{ lineKey: 'LIT1_1', tracking: 'AA' }, { lineKey: 'LIT1_2', tracking: 'BB' }]
    const before = perLine(rows)
    const after = perLine(rows, productLines(true, true))
    expect(after).toEqual(before)
    expect(after.status).toBe('will_fulfill')
    expect(after.fulfillments).toEqual([
      { fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-A', quantity: 1 }], tracking: 'AA', shipmentIds: ['s1'] },
      { fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-B', quantity: 1 }], tracking: 'BB', shipmentIds: ['s2'] },
    ])
  })

  it('a per-line row for a line never sent holds the order and names the line', () => {
    const p = perLine([{ lineKey: 'LIT1_2', tracking: 'BB' }], productLines(true, false))
    expect(p.status).toBe('needs_manual')
    expect(p.fulfillments).toEqual([])
    expect(p.message).toContain('LIT1_2')
    expect(p.message).toContain('chưa export sang xưởng')
  })

  it('two per-line rows, one line sent and one not: nothing of the order is fulfilled', () => {
    const p = perLine([{ lineKey: 'LIT1_1', tracking: 'AA' }, { lineKey: 'LIT1_2', tracking: 'AA' }], productLines(true, false))
    expect(p.status).toBe('needs_manual')
    expect(p.fulfillments).toEqual([])
    expect(p.message).toContain('LIT1_2')
    expect(p.message).not.toContain('LIT1_1')
  })

  it('an unsent line that no row lists does not stop the listed, sent line (partial, as before)', () => {
    const p = perLine([{ lineKey: 'LIT1_1', tracking: 'AA' }], productLines(true, false))
    expect(p.status).toBe('will_fulfill')
    expect(p.fulfillments).toEqual([{ fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-A', quantity: 1 }], tracking: 'AA', shipmentIds: ['s1'] }])
  })

  it('a line Shopify has open but the tool does not know counts as not sent', () => {
    const p = perLine([{ lineKey: 'LIT1_2', tracking: 'BB' }], [{ shopifyLineId: 'gid://li/A', lineKey: 'LIT1_1', sent: true }])
    expect(p.status).toBe('needs_manual')
    expect(p.message).toContain('LIT1_2')
  })

  describe('whole-order row', () => {
    it('a one-line order whose line was not sent is held, naming the line', () => {
      const p = buildFulfillmentPlan({
        ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1', tracking: 'T' }], shipments: [], fulfillmentOrders: foOneOpenLine,
        productLines: [{ shopifyLineId: 'gid://li/A', lineKey: 'LIT1_1', sent: false }],
      })
      expect(p.status).toBe('needs_manual')
      expect(p.message).toContain('LIT1_1')
      expect(p.message).toContain('chưa export sang xưởng')
    })
  })

  it('add-ons on their own fulfillment order still close without tracking once the product lines are sent', () => {
    const productFo = { id: 'fo1', status: 'OPEN', lineItems: [{ id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' }] }
    const protectionFo = { id: 'fo2', status: 'OPEN', lineItems: [{ id: 'foli-P', remainingQuantity: 1, shopifyLineId: 'gid://li/P', sku: null }] }
    const input = { ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1_1', tracking: 'AA' }], shipments: [shipments[0]], fulfillmentOrders: [productFo, protectionFo], addOnLineIds: ['gid://li/P'] }
    const p = buildFulfillmentPlan({ ...input, productLines: [{ shopifyLineId: 'gid://li/A', lineKey: 'LIT1_1', sent: true }] })
    expect(p).toEqual(buildFulfillmentPlan(input))
    expect(p.fulfillments).toEqual([
      { fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-A', quantity: 1 }], tracking: 'AA', shipmentIds: ['s1'] },
      { fulfillmentOrderId: 'fo2', lineItems: [{ id: 'foli-P', quantity: 1 }], tracking: '', shipmentIds: [], addOn: true },
    ])
    expect(buildFulfillmentPlan({ ...input, productLines: [{ shopifyLineId: 'gid://li/A', lineKey: 'LIT1_1', sent: false }] }).fulfillments).toEqual([])
  })
})

describe('rows keep where they came from', () => {
  it('groupByOrder keeps a row the sheet wrote by the bare order number', () => {
    expect(groupByOrder([{ orderToken: 'LIT1_2', tracking: 'AA', byOrderNumber: true }]).get('LIT1')).toEqual([{ lineKey: 'LIT1_2', tracking: 'AA', byOrderNumber: true }])
  })

  it('mergeSheetGroups tags each row with its sheet and merges the same line and tracking across sheets and pushes', () => {
    const target = new Map<string, { rows: OrderRow[] }>()
    mergeSheetGroups(target, groupByOrder([{ orderToken: '#LIT1_1', tracking: 'AA' }]), 'Jomall')
    mergeSheetGroups(target, groupByOrder([{ orderToken: '#LIT1_1', tracking: 'AA' }, { orderToken: 'LIT1_2', tracking: 'AA', byOrderNumber: true }]), 'Mangoshao')
    mergeSheetGroups(target, new Map([['LIT1', [{ lineKey: 'LIT1_1', tracking: 'AA', pushed: true }, { lineKey: 'LIT1_2', tracking: 'AA', pushed: true }]]]))
    expect(target.get('LIT1')!.rows).toEqual([
      { lineKey: 'LIT1_1', tracking: 'AA', sheets: ['Jomall', 'Mangoshao'], pushed: true },
      { lineKey: 'LIT1_2', tracking: 'AA', byOrderNumber: true, sheets: ['Mangoshao'] },
      { lineKey: 'LIT1_2', tracking: 'AA', pushed: true },
    ])
  })
})

describe('a fulfilment covers exactly the line a row names, from the supplier the line was sent to', () => {
  const base = { displayFulfillmentStatus: 'UNFULFILLED', now: NOW, minAgeDays: 7, placedAt: days(10) }
  // Every product line open on one fulfillment order, the Shipping protection on its own. No Shipment rows: an open order has none yet.
  const fo = (ids: string[]) => [
    { id: 'FO1', status: 'OPEN', lineItems: ids.map(id => ({ id: `fol-${id}`, remainingQuantity: 1, shopifyLineId: id, sku: id })) },
    { id: 'FO2', status: 'OPEN', lineItems: [{ id: 'fol-FEE', remainingQuantity: 1, shopifyLineId: 'FEE', sku: null }] },
  ]
  const lines = (...suppliers: Array<string | null>) => suppliers.map((supplier, i) => ({ shopifyLineId: `L${i + 1}`, lineKey: `LIT1_${i + 1}`, sent: true, supplier }))
  type Input = Parameters<typeof buildFulfillmentPlan>[0]
  const plan = (rows: OrderRow[], productLines?: ReturnType<typeof lines>, more: Partial<Input> = {}) => buildFulfillmentPlan({
    ...base, baseOrder: 'LIT1', rows, shipments: [], fulfillmentOrders: fo((productLines ?? []).map(l => l.shopifyLineId)), addOnLineIds: ['FEE'],
    ...(productLines ? { productLines } : {}), ...more,
  })
  const mango = (lineKey: string): OrderRow => ({ lineKey, tracking: 'T', byOrderNumber: true, sheets: ['Mangoshao'] })
  const twoShipments = [{ id: 's1', lineKey: 'LIT1_1', shopifyLineId: 'L1' }, { id: 's2', lineKey: 'LIT1_2', shopifyLineId: 'L2' }]

  it('a Mango row (bare order number, line key in Order Vendor) fulfils only its line of a three-line order', () => {
    const p = plan([mango('LIT1_2')], lines('Mangoshao', 'Mangoshao', 'Mangoshao'))
    expect(p.status).toBe('will_fulfill')
    expect(p.fulfillments).toEqual([{ fulfillmentOrderId: 'FO1', lineItems: [{ id: 'fol-L2', quantity: 1 }], tracking: 'T', shipmentIds: [] }])
  })

  it('a Mango row naming a line key the order does not have is not mapped', () => {
    const p = plan([mango('LIT1_4')], lines('Mangoshao', 'Mangoshao', 'Mangoshao'))
    expect(p).toMatchObject({ status: 'needs_manual', fulfillments: [] })
    expect(p.message).toContain('LIT1_4')
  })

  it('a Mango row beside a per-line row of another sheet is held as mixed, as when the Mango row read as the whole order', () => {
    const rows: OrderRow[] = [mango('LIT1_1'), { lineKey: 'LIT1_2', tracking: 'J', sheets: ['Jomall'] }]
    const p = plan(rows, lines('Mangoshao', 'Jomall'), { shipments: twoShipments })
    expect(p).toMatchObject({ status: 'needs_manual', fulfillments: [], message: 'Sheet vừa có dòng cả đơn vừa có dòng lẻ cho cùng đơn' })
  })

  it('a Mango row beside a pushed or per-line row naming the same line and tracking is held as mixed too', () => {
    const target = new Map<string, { rows: OrderRow[] }>()
    mergeSheetGroups(target, new Map([['LIT1', [{ lineKey: 'LIT1_2', tracking: 'T', byOrderNumber: true }]]]), 'Mangoshao')
    mergeSheetGroups(target, new Map([['LIT1', [{ lineKey: 'LIT1_2', tracking: 'T', pushed: true }]]]))
    const p = plan(target.get('LIT1')!.rows, lines('Mangoshao', 'Mangoshao'), { shipments: twoShipments })
    expect(p).toMatchObject({ status: 'needs_manual', fulfillments: [], message: 'Sheet vừa có dòng cả đơn vừa có dòng lẻ cho cùng đơn' })
  })

  it('two Mango rows naming the same line and tracking are one row', () => {
    const target = new Map<string, { rows: OrderRow[] }>()
    for (const sheet of ['Mangoshao', 'Mangoshao 2']) mergeSheetGroups(target, new Map([['LIT1', [{ lineKey: 'LIT1_2', tracking: 'T', byOrderNumber: true }]]]), sheet)
    expect(target.get('LIT1')!.rows).toEqual([{ lineKey: 'LIT1_2', tracking: 'T', byOrderNumber: true, sheets: ['Mangoshao', 'Mangoshao 2'] }])
  })

  it('a Mango row for a line sent to another supplier is held', () => {
    const p = plan([mango('LIT1_2')], lines('Mangoshao', 'Jomall'))
    expect(p).toMatchObject({ status: 'needs_manual', fulfillments: [] })
    expect(p.message).toContain('LIT1_2')
    expect(p.message).toContain('Jomall')
  })

  it('a bare order number on a one-line order is that line: fulfilled, the add-on closed without tracking as before', () => {
    const p = plan([{ lineKey: 'LIT1', tracking: 'T', sheets: ['Mangoshao'] }], lines('Mangoshao'))
    expect(p.status).toBe('will_fulfill')
    expect(p.fulfillments).toEqual([
      { fulfillmentOrderId: 'FO1', lineItems: [{ id: 'fol-L1', quantity: 1 }], tracking: 'T', shipmentIds: [] },
      { fulfillmentOrderId: 'FO2', lineItems: [{ id: 'fol-FEE', quantity: 1 }], tracking: '', shipmentIds: [], addOn: true },
    ])
  })

  it('a bare order number on a one-line order records the Shipment row of that line when there is one', () => {
    const p = plan([{ lineKey: 'LIT1', tracking: 'T' }], lines('Mangoshao'), { shipments: [twoShipments[0]] })
    expect(p.fulfillments[0]).toMatchObject({ lineItems: [{ id: 'fol-L1', quantity: 1 }], shipmentIds: ['s1'] })
  })

  it('a bare order number on a two-line order fulfils nothing, even when both lines went to that supplier with their files', () => {
    const p = plan([{ lineKey: 'LIT1', tracking: 'T', sheets: ['Mangoshao'] }], lines('Mangoshao', 'Mangoshao'))
    expect(p).toMatchObject({ status: 'needs_manual', fulfillments: [] })
    expect(p.message).toContain('mã dòng')
    expect(p.message).toContain('LIT1_1, LIT1_2')
    expect(p.message).toContain('Mangoshao')
  })

  it('a bare order number is held when Shopify has another open line the tool does not know', () => {
    const p = plan([{ lineKey: 'LIT1', tracking: 'T' }], lines('Mangoshao'), { fulfillmentOrders: fo(['L1', 'L9']) })
    expect(p).toMatchObject({ status: 'needs_manual', fulfillments: [] })
  })

  it('a bare order number of an order the tool does not have fulfils nothing', () => {
    const p = plan([{ lineKey: 'LIT1', tracking: 'T' }], undefined, { fulfillmentOrders: fo(['L1']), addOnLineIds: undefined })
    expect(p).toMatchObject({ status: 'needs_manual', fulfillments: [] })
  })

  it("a per-line row in one supplier's sheet for a line sent to another is held, naming the line, its supplier and the sheet", () => {
    const p = plan([{ lineKey: 'LIT1_2', tracking: 'T', sheets: ['Jomall'] }], lines('Jomall', 'Mangoshao'), { shipments: twoShipments })
    expect(p).toMatchObject({ status: 'needs_manual', fulfillments: [] })
    expect(p.message).toContain('LIT1_2')
    expect(p.message).toContain('Mangoshao')
    expect(p.message).toContain('Jomall')
  })

  it('the same row when the line went to that supplier is fulfilled exactly as before, whatever the case and spaces of the names', () => {
    const rows = [{ lineKey: 'LIT1_2', tracking: 'T' }]
    const before = plan(rows, lines('Jomall', ' jomall '), { shipments: twoShipments })
    const after = plan([{ ...rows[0], sheets: ['JOMALL'] }], lines('Jomall', ' jomall '), { shipments: twoShipments })
    expect(after).toEqual(before)
    expect(after.status).toBe('will_fulfill')
    expect(after.fulfillments).toEqual([{ fulfillmentOrderId: 'FO1', lineItems: [{ id: 'fol-L2', quantity: 1 }], tracking: 'T', shipmentIds: ['s2'] }])
  })

  it('a line that went to no supplier by name is held when a sheet names it', () => {
    const p = plan([{ lineKey: 'LIT1_1', tracking: 'T', sheets: ['Jomall'] }], lines(null), { shipments: [twoShipments[0]] })
    expect(p).toMatchObject({ status: 'needs_manual', fulfillments: [] })
  })

  it('a row from an API push is not checked against a sheet: the push names its supplier', () => {
    const p = plan([{ lineKey: 'LIT1_1', tracking: 'T', sheets: ['Jomall'], pushed: true }], lines('Pgprints'), { shipments: [twoShipments[0]] })
    expect(p.status).toBe('will_fulfill')
  })

  it('a pushed row whose key is the bare order number never fulfils the whole order', () => {
    const shipments = [{ id: 's0', lineKey: 'LIT1', shopifyLineId: 'L1' }]
    for (const productLines of [lines('Pgprints'), lines('Pgprints', 'Pgprints')]) {
      const p = plan([{ lineKey: 'LIT1', tracking: 'T', pushed: true }], productLines, { shipments })
      expect(p).toMatchObject({ status: 'needs_manual', fulfillments: [] })
    }
  })
})
