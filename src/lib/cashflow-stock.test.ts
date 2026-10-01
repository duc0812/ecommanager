import { describe, expect, it } from 'vitest'
import { buildLiveStock, emptyStock, liveStockAppliesTo, stockFromSnapshot } from './cashflow-stock'

const TODAY = '2026-09-30'

describe('liveStockAppliesTo', () => {
  it('accepts a period that runs to today or beyond', () => {
    expect(liveStockAppliesTo(TODAY, TODAY)).toBe(true)
    expect(liveStockAppliesTo('2026-10-31', TODAY)).toBe(true)
  })

  it('rejects a closed period, because the live balance says nothing about it', () => {
    expect(liveStockAppliesTo('2026-08-31', TODAY)).toBe(false)
    expect(liveStockAppliesTo('2026-09-29', TODAY)).toBe(false)
  })

  it('allows a grace window so the month-end cron can still capture the close', () => {
    // Cron fires 00:00 on the 1st for a period that ended the day before.
    expect(liveStockAppliesTo('2026-09-30', '2026-10-01', 2)).toBe(true)
    // A backfill run weeks later must not stamp today's balance onto February.
    expect(liveStockAppliesTo('2026-02-28', '2026-09-13', 2)).toBe(false)
  })
})

describe('buildLiveStock', () => {
  it('nets the money Shopify still owes against the unbilled Meta debt', () => {
    expect(buildLiveStock({ shopifyBalance: 4315.88, inTransitPayout: 2261.99, pendingInvoiceCharge: 1002.18 }, TODAY)).toEqual({
      source: 'LIVE',
      asOf: TODAY,
      shopifyBalance: 4315.88,
      inTransitPayout: 2261.99,
      pendingInvoiceCharge: 1002.18,
      projectedCashflow: 5575.69,
    })
  })
})

describe('stockFromSnapshot', () => {
  it('reads a month-end snapshot that actually recorded its own balance', () => {
    expect(stockFromSnapshot({
      asOfDate: '2026-08-31',
      shopifyBalance: 1000,
      inTransitPayout: 250,
      pendingInvoiceCharge: 400,
    })).toEqual({
      source: 'SNAPSHOT',
      asOf: '2026-08-31',
      shopifyBalance: 1000,
      inTransitPayout: 250,
      pendingInvoiceCharge: 400,
      projectedCashflow: 850,
    })
  })

  it('reports nothing when the snapshot never recorded a trustworthy balance', () => {
    expect(stockFromSnapshot({
      asOfDate: '2026-02-28',
      shopifyBalance: null,
      inTransitPayout: null,
      pendingInvoiceCharge: null,
    })).toEqual(emptyStock())
    expect(stockFromSnapshot(null)).toEqual(emptyStock())
  })

  it('has no stock at all as its empty shape', () => {
    expect(emptyStock()).toEqual({
      source: 'NONE',
      asOf: null,
      shopifyBalance: null,
      inTransitPayout: null,
      pendingInvoiceCharge: null,
      projectedCashflow: null,
    })
  })
})
