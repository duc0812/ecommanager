import { describe, it, expect, vi } from 'vitest'
import { checkSuspectItems, verdictOf, sheetLookupOf, withChecks } from '@/lib/cs/factory-check'
import { itemSummaryVi } from '@/lib/cs/order-context'
import { itemPromptLine } from '@/lib/cs/agent-prompt'

const parcel = { trackingNumber: 'UL648908989YP', carrier: 'Intelcom', status: 'DELIVERED', lastEvent: null, lastEventAt: null, deliveredAt: new Date('2026-11-11T09:07:58Z'), trackingUrl: null, fromSupplier: 'Mangoshao', sharedWith: ['LIT5554_1'] }
const malek = { lineKey: 'LIT5554_2', title: 'Tumbler', variant: '20oz', qty: 1, send: { supplier: 'Pgprints', via: 'CSV' as const, ref: null, sentAt: new Date('2026-10-30T03:09:29Z'), factoryStatus: null, checkedAt: null }, parcel, warning: 'Tracking UL648908989YP của xưởng Mangoshao nhưng sản phẩm gửi xưởng Pgprints' }
const belle = { ...malek, lineKey: 'LIT5554_1', variant: '30oz', send: { ...malek.send, supplier: 'Mangoshao' }, parcel: { ...parcel, sharedWith: ['LIT5554_2'] }, warning: null }
const order = { shopifyOrderNumber: '#LIT5554', placedAt: new Date('2026-10-26T00:00:20Z'), items: [belle, malek] } as any

describe('verdictOf', () => {
  it('predicts a missed send when no factory has the item (owner 11/12, LIT5554)', () => {
    const v = verdictOf(malek, { supplier: 'Pgprints', found: false, detail: 'không có đơn LIT5554' }, { supplier: 'Mangoshao', found: false, detail: 'chỉ có LIT5554_1' })
    expect(v.verdict).toBe('NOT_SENT')
    expect(v.conclusion).toBe('Dự đoán gửi thiếu: không có thông tin gửi LIT5554_2 ở xưởng nào (Pgprints: không có đơn LIT5554; Mangoshao: chỉ có LIT5554_1), kiện UL648908989YP không chứa sản phẩm này')
  })
  it('an item with no send record that the tracking factory lacks is a missed send too', () => {
    expect(verdictOf({ ...malek, send: null }, null, { supplier: 'Mangoshao', found: false, detail: 'chỉ có LIT5554_1' }).verdict).toBe('NOT_SENT')
  })
  it('fulfillment is missing, item unknown, when the sent factory cannot be read', () => {
    const v = verdictOf(malek, { supplier: 'Pgprints', found: null, detail: 'chưa có key PGprints' }, { supplier: 'Mangoshao', found: false, detail: 'chỉ có LIT5554_1' })
    expect(v.verdict).toBe('NOT_IN_PARCEL')
    expect(v.conclusion).toBe('Fulfillment thiếu: xưởng Mangoshao không có LIT5554_2 (chỉ có LIT5554_1), kiện UL648908989YP không chứa sản phẩm này; chưa tra được Pgprints (chưa có key PGprints)')
  })
  it('the parcel holds the item when its factory has the line', () => {
    const v = verdictOf(malek, { supplier: 'Pgprints', found: false, detail: 'x' }, { supplier: 'Mangoshao', found: true, detail: 'dòng LIT5554_2 ở tab ORDER FULFILL' })
    expect(v.verdict).toBe('IN_PARCEL')
    expect(v.conclusion).toBe('Xưởng Mangoshao có LIT5554_2 (dòng LIT5554_2 ở tab ORDER FULFILL) → kiện UL648908989YP có chứa sản phẩm này, fulfillment đúng')
  })
  it('names where the item is when the factory it was sent to has it', () => {
    const v = verdictOf(malek, { supplier: 'Pgprints', found: true, detail: 'PG1-2 in-production' }, { supplier: 'Mangoshao', found: false, detail: 'chỉ có LIT5554_1' })
    expect(v.verdict).toBe('NOT_IN_PARCEL')
    expect(v.conclusion).toContain('; sản phẩm đang ở Pgprints: PG1-2 in-production')
  })
  it('stays unknown when the tracking factory cannot be read', () => {
    const v = verdictOf(malek, null, { supplier: 'Mangoshao', found: null, detail: 'lỗi tra: timeout' })
    expect(v.verdict).toBe('UNKNOWN')
    expect(v.conclusion).toContain('Chưa tra được xưởng Mangoshao (lỗi tra: timeout)')
  })
})

describe('checkSuspectItems', () => {
  it('checks the sent factory first, then the tracking factory, only for items with a warning', async () => {
    const lookup = vi.fn(async (supplier: string, _q: any) => ({ supplier, found: false, detail: supplier === 'Mangoshao' ? 'chỉ có LIT5554_1' : 'không có đơn LIT5554' }))
    const checks = await checkSuspectItems(order, lookup)
    expect(lookup.mock.calls.map(c => c[0])).toEqual(['Pgprints', 'Mangoshao'])
    expect(lookup.mock.calls[0][1]).toMatchObject({ orderNumber: '#LIT5554', lineKey: 'LIT5554_2' })
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ lineKey: 'LIT5554_2', verdict: 'NOT_SENT' })
  })
  it('an item with no send record only checks the tracking factory', async () => {
    const lookup = vi.fn(async (supplier: string, _q: any) => ({ supplier, found: true, detail: 'ok' }))
    const checks = await checkSuspectItems({ ...order, items: [{ ...malek, send: null }] }, lookup)
    expect(lookup.mock.calls.map(c => c[0])).toEqual(['Mangoshao'])
    expect(checks[0].verdict).toBe('IN_PARCEL')
  })
  it('a failing lookup is recorded, not thrown', async () => {
    const checks = await checkSuspectItems(order, async () => { throw new Error('boom') })
    expect(checks[0].verdict).toBe('UNKNOWN')
    expect(checks[0].lookups.at(-1)).toMatchObject({ supplier: 'Mangoshao', found: null, detail: 'lỗi tra: boom' })
  })
})

describe('sheetLookupOf', () => {
  const rows = [
    ['a', 'Order Number', 'Order Vendor ', 'SKU'],
    ['CN_POD_MS-20261029', '#LIT5554', 'LIT5554_1', 'C450-12'],
    ['CN_POD_MS-20261029', '#LIT5555', 'LIT5555_1', 'C450-12'],
  ]
  it('finds the line by its line key in Order Vendor', () => {
    expect(sheetLookupOf('Mangoshao', [{ tab: 'ORDER FULFILL', rows }], '#LIT5554', 'LIT5554_1')).toEqual({ supplier: 'Mangoshao', found: true, detail: 'dòng LIT5554_1 ở tab ORDER FULFILL (CN_POD_MS-20261029)' })
  })
  it('says which lines of the order the sheet holds when this one is not there', () => {
    expect(sheetLookupOf('Mangoshao', [{ tab: 'ORDER FULFILL', rows }], '#LIT5554', 'LIT5554_2')).toEqual({ supplier: 'Mangoshao', found: false, detail: 'chỉ có LIT5554_1' })
  })
  it('no row of the order at all', () => {
    expect(sheetLookupOf('Mangoshao', [{ tab: 'ORDER FULFILL', rows }], '#LIT9999', 'LIT9999_1')).toEqual({ supplier: 'Mangoshao', found: false, detail: 'không có đơn #LIT9999 trong tab ORDER FULFILL' })
  })
  it('rows of the order without line keys cannot decide', () => {
    const old = [['Order Number', 'Order Vendor'], ['#LIT5554', '']]
    expect(sheetLookupOf('Mangoshao', [{ tab: 'T', rows: old }], '#LIT5554', 'LIT5554_2').found).toBeNull()
  })
})

describe('item lines carry the conclusion', () => {
  const check = { lineKey: 'LIT5554_2', lookups: [], verdict: 'NOT_IN_PARCEL' as const, conclusion: 'Fulfillment thiếu: …' }
  it('withChecks attaches by line key', () => {
    const items = withChecks([belle, malek], [check])
    expect(items[0].check ?? null).toBeNull()
    expect(items[1].check).toEqual(check)
  })
  it('staff line and prompt line show it', () => {
    const [, m] = withChecks([belle, malek], [check])
    expect(itemSummaryVi(m)).toContain(' · Kết luận: Fulfillment thiếu: …')
    expect(itemPromptLine(m)).toContain('; FACTORY CHECK: NOT in parcel UL648908989YP — the factory that shipped it has no record of this item, so our fulfillment is missing it')
    expect(itemPromptLine({ ...m, check: { ...check, verdict: 'NOT_SENT' } })).toContain('; FACTORY CHECK: MISSED SEND — no factory has any record of this item, so it was never sent to production; parcel UL648908989YP does not hold it')
  })
})
