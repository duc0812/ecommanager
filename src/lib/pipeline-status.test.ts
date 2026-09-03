import { describe, it, expect } from 'vitest'
import { autoDetectStatus } from './pipeline-status'

const base = {
  financialStatus: 'PAID', fulfillmentStatus: null,
  hasUnmappedSku: false, hasPendingMapping: false, hasCustomDesignLine: false,
}

describe('autoDetectStatus', () => {
  it('hasDesignLine && !designReady => PENDING_DESIGN', () => {
    expect(autoDetectStatus({ ...base, hasDesignLine: true, hasDesignReady: false }))
      .toBe('PENDING_DESIGN')
  })

  it('hasDesignLine && designReady => READY_TO_PRODUCTION', () => {
    expect(autoDetectStatus({ ...base, hasDesignLine: true, hasDesignReady: true }))
      .toBe('READY_TO_PRODUCTION')
  })

  it('falls back to hasCustomDesignLine when hasDesignLine absent', () => {
    expect(autoDetectStatus({ ...base, hasCustomDesignLine: true, hasDesignReady: false }))
      .toBe('PENDING_DESIGN')
  })

  it('pending mapping wins over design', () => {
    expect(autoDetectStatus({ ...base, hasPendingMapping: true, hasDesignLine: true }))
      .toBe('PENDING_MAPPING')
  })
})
