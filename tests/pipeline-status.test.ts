import { describe, it, expect } from 'vitest'
import { autoDetectStatus, PIPELINE_STATUSES, STATUS_LABELS } from '@/lib/pipeline-status'

describe('autoDetectStatus', () => {
  it('REFUNDED financialStatus → REFUNDED', () => {
    expect(autoDetectStatus({
      financialStatus: 'REFUNDED', hasUnmappedSku: false, hasCustomDesignLine: false,
    })).toBe('REFUNDED')
  })

  it('PARTIALLY_REFUNDED → REFUNDED', () => {
    expect(autoDetectStatus({
      financialStatus: 'PARTIALLY_REFUNDED', hasUnmappedSku: false, hasCustomDesignLine: false,
    })).toBe('REFUNDED')
  })

  it('VOIDED → CANCELLED', () => {
    expect(autoDetectStatus({
      financialStatus: 'VOIDED', hasUnmappedSku: false, hasCustomDesignLine: false,
    })).toBe('CANCELLED')
  })

  it('CANCELLED financialStatus → CANCELLED', () => {
    expect(autoDetectStatus({
      financialStatus: 'CANCELLED', hasUnmappedSku: false, hasCustomDesignLine: false,
    })).toBe('CANCELLED')
  })

  it('PAID + unmapped SKU → PENDING_DESIGN', () => {
    expect(autoDetectStatus({
      financialStatus: 'PAID', hasUnmappedSku: true, hasCustomDesignLine: false,
    })).toBe('PENDING_DESIGN')
  })

  it('PAID + custom design line → PENDING_DESIGN', () => {
    expect(autoDetectStatus({
      financialStatus: 'PAID', hasUnmappedSku: false, hasCustomDesignLine: true,
    })).toBe('PENDING_DESIGN')
  })

  it('PAID + all mapped + no custom → PENDING', () => {
    expect(autoDetectStatus({
      financialStatus: 'PAID', hasUnmappedSku: false, hasCustomDesignLine: false,
    })).toBe('PENDING')
  })

  it('preserves manual status (EXPORTED) when paid + mapped', () => {
    expect(autoDetectStatus({
      financialStatus: 'PAID', hasUnmappedSku: false, hasCustomDesignLine: false,
      currentStatus: 'EXPORTED',
    })).toBe('EXPORTED')
  })

  it('preserves manual SUPPLIER_PROCESSING when paid + mapped', () => {
    expect(autoDetectStatus({
      financialStatus: 'PAID', hasUnmappedSku: false, hasCustomDesignLine: false,
      currentStatus: 'SUPPLIER_PROCESSING',
    })).toBe('SUPPLIER_PROCESSING')
  })

  it('overrides manual EXPORTED with REFUNDED when refunded in Shopify', () => {
    expect(autoDetectStatus({
      financialStatus: 'REFUNDED', hasUnmappedSku: false, hasCustomDesignLine: false,
      currentStatus: 'EXPORTED',
    })).toBe('REFUNDED')
  })

  it('overrides manual IN_PRODUCTION with CANCELLED when voided', () => {
    expect(autoDetectStatus({
      financialStatus: 'VOIDED', hasUnmappedSku: false, hasCustomDesignLine: false,
      currentStatus: 'IN_PRODUCTION',
    })).toBe('CANCELLED')
  })

  it('preserves manual ON_HOLD even when newly unmapped (rare edge)', () => {
    expect(autoDetectStatus({
      financialStatus: 'PAID', hasUnmappedSku: true, hasCustomDesignLine: false,
      currentStatus: 'ON_HOLD',
    })).toBe('ON_HOLD')
  })

  it('re-evaluates from PENDING_DESIGN when SKU later gets mapped', () => {
    // User had PENDING_DESIGN; later they added the SKU mapping. Re-sync should move it to PENDING.
    expect(autoDetectStatus({
      financialStatus: 'PAID', hasUnmappedSku: false, hasCustomDesignLine: false,
      currentStatus: 'PENDING_DESIGN',
    })).toBe('PENDING')
  })

  it('re-evaluates from PENDING to PENDING_DESIGN if user later flags requiresDesign on a SKU', () => {
    expect(autoDetectStatus({
      financialStatus: 'PAID', hasUnmappedSku: false, hasCustomDesignLine: true,
      currentStatus: 'PENDING',
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
