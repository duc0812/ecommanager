import { describe, it, expect } from 'vitest'
import { planStatusNormalization } from './order-normalize'

describe('planStatusNormalization', () => {
  it('updates fulfillmentStatus when Shopify differs from DB', () => {
    expect(planStatusNormalization('FULFILLED', 'UNFULFILLED', 'EXPORTED'))
      .toEqual({ fulfillmentStatus: 'FULFILLED', pipelineStatus: 'FULFILLED' })
  })

  it('moves pipeline to FULFILLED once Shopify is fulfilled (non-terminal pipeline)', () => {
    expect(planStatusNormalization('FULFILLED', 'FULFILLED', 'READY_TO_PRODUCTION'))
      .toEqual({ pipelineStatus: 'FULFILLED' })
  })

  it('does not touch pipeline that is already FULFILLED/terminal', () => {
    expect(planStatusNormalization('FULFILLED', 'FULFILLED', 'FULFILLED')).toEqual({})
    expect(planStatusNormalization('FULFILLED', 'FULFILLED', 'CANCELLED')).toEqual({})
    expect(planStatusNormalization('FULFILLED', 'FULFILLED', 'REFUNDED')).toEqual({})
  })

  it('no change when Shopify matches DB and not fulfilled', () => {
    expect(planStatusNormalization('UNFULFILLED', 'UNFULFILLED', 'EXPORTED')).toEqual({})
  })

  it('updates fulfillmentStatus for partial without touching pipeline', () => {
    expect(planStatusNormalization('PARTIALLY_FULFILLED', 'UNFULFILLED', 'EXPORTED'))
      .toEqual({ fulfillmentStatus: 'PARTIALLY_FULFILLED' })
  })

  it('ignores null Shopify status (keeps DB value)', () => {
    expect(planStatusNormalization(null, 'UNFULFILLED', 'EXPORTED')).toEqual({})
  })

  it('is case-insensitive on the fulfilled check', () => {
    expect(planStatusNormalization('fulfilled', 'UNFULFILLED', 'EXPORTED'))
      .toEqual({ fulfillmentStatus: 'fulfilled', pipelineStatus: 'FULFILLED' })
  })
})
