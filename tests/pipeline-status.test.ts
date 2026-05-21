import { describe, it, expect } from 'vitest'
import { autoDetectStatus, PIPELINE_STATUSES, STATUS_LABELS } from '@/lib/pipeline-status'

describe('autoDetectStatus', () => {
  it('REFUNDED financialStatus → REFUNDED', () => {
    expect(autoDetectStatus({
      financialStatus: 'REFUNDED', hasUnmappedSku: false, hasPendingMapping: false, hasCustomDesignLine: false,
    })).toBe('REFUNDED')
  })

  it('PARTIALLY_REFUNDED → REFUNDED', () => {
    expect(autoDetectStatus({
      financialStatus: 'PARTIALLY_REFUNDED', hasUnmappedSku: false, hasPendingMapping: false, hasCustomDesignLine: false,
    })).toBe('REFUNDED')
  })

  it('VOIDED → CANCELLED', () => {
    expect(autoDetectStatus({
      financialStatus: 'VOIDED', hasUnmappedSku: false, hasPendingMapping: false, hasCustomDesignLine: false,
    })).toBe('CANCELLED')
  })

  it('CANCELLED financialStatus → CANCELLED', () => {
    expect(autoDetectStatus({
      financialStatus: 'CANCELLED', hasUnmappedSku: false, hasPendingMapping: false, hasCustomDesignLine: false,
    })).toBe('CANCELLED')
  })

  it('PAID + unmapped SKU → PENDING_MAPPING', () => {
    expect(autoDetectStatus({
      financialStatus: 'PAID', hasUnmappedSku: true, hasPendingMapping: false, hasCustomDesignLine: false,
    })).toBe('PENDING_MAPPING')
  })

  it('PAID + custom design line → PENDING_DESIGN', () => {
    expect(autoDetectStatus({
      financialStatus: 'PAID', hasUnmappedSku: false, hasPendingMapping: false, hasCustomDesignLine: true,
    })).toBe('PENDING_DESIGN')
  })

  it('PAID + all mapped + no custom → READY_TO_PRODUCTION', () => {
    expect(autoDetectStatus({
      financialStatus: 'PAID', hasUnmappedSku: false, hasPendingMapping: false, hasCustomDesignLine: false,
    })).toBe('READY_TO_PRODUCTION')
  })

  it('preserves manual status (EXPORTED) when paid + mapped', () => {
    expect(autoDetectStatus({
      financialStatus: 'PAID', hasUnmappedSku: false, hasPendingMapping: false, hasCustomDesignLine: false,
      currentStatus: 'EXPORTED',
    })).toBe('EXPORTED')
  })

  it('overrides manual EXPORTED with REFUNDED when refunded in Shopify', () => {
    expect(autoDetectStatus({
      financialStatus: 'REFUNDED', hasUnmappedSku: false, hasPendingMapping: false, hasCustomDesignLine: false,
      currentStatus: 'EXPORTED',
    })).toBe('REFUNDED')
  })

  it('overrides manual WARNING with CANCELLED when voided', () => {
    expect(autoDetectStatus({
      financialStatus: 'VOIDED', hasUnmappedSku: false, hasPendingMapping: false, hasCustomDesignLine: false,
      currentStatus: 'WARNING',
    })).toBe('CANCELLED')
  })

  it('preserves manual ON_HOLD even when newly unmapped (rare edge)', () => {
    expect(autoDetectStatus({
      financialStatus: 'PAID', hasUnmappedSku: true, hasPendingMapping: false, hasCustomDesignLine: false,
      currentStatus: 'ON_HOLD',
    })).toBe('ON_HOLD')
  })

  it('re-evaluates from PENDING_DESIGN when SKU later gets mapped', () => {
    // User had PENDING_DESIGN; later they added the SKU mapping. Re-sync should move it to ready.
    expect(autoDetectStatus({
      financialStatus: 'PAID', hasUnmappedSku: false, hasPendingMapping: false, hasCustomDesignLine: false,
      currentStatus: 'PENDING_DESIGN',
    })).toBe('READY_TO_PRODUCTION')
  })

  it('re-evaluates from WARNING to PENDING_DESIGN if user later flags requiresDesign on a SKU', () => {
    expect(autoDetectStatus({
      financialStatus: 'PAID', hasUnmappedSku: false, hasPendingMapping: false, hasCustomDesignLine: true,
      currentStatus: 'WARNING',
    })).toBe('PENDING_DESIGN')
  })
})

describe('PIPELINE_STATUSES', () => {
  it('has 11 statuses', () => {
    expect(PIPELINE_STATUSES).toHaveLength(11)
  })

  it('STATUS_LABELS covers all statuses', () => {
    for (const s of PIPELINE_STATUSES) {
      expect(STATUS_LABELS[s]).toBeTruthy()
    }
  })
})
