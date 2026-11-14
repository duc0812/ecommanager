import { describe, expect, it } from 'vitest'
import { needsDesign } from '@/lib/order-lines'
import { isLineApproved } from '@/lib/public-artwork'
import { isDesignOpen } from '@/lib/line-export'

const line = { shopifyLineId: 'L1', productTitle: 'Christmas Grump Hooded Robe', resolvedSupplierId: 'sup', designDriveLink: null as string | null }

describe('dropship gates', () => {
  it('a dropship line needs no design, a POD line does', () => {
    expect(needsDesign({ ...line, dropship: true })).toBe(false)
    expect(needsDesign(line)).toBe(true)
    expect(needsDesign({ ...line, resolvedSupplierId: null })).toBe(false)
    expect(needsDesign({ ...line, productTitle: 'Shipping Protection' })).toBe(false)
  })
  it('a dropship line is approved without a link or a DONE task', () => {
    expect(isLineApproved({ designDriveLink: null, dropship: true }, { status: 'NEW' })).toBe(true)
    expect(isLineApproved({ designDriveLink: null }, null)).toBe(false)
  })
  it('a dropship line is never design-open', () => {
    const order = { designReady: false, designTasks: [{ shopifyLineId: 'L1', status: 'REJECTED' }] }
    expect(isDesignOpen(order, { ...line, dropship: true })).toBe(false)
    expect(isDesignOpen(order, line)).toBe(true)
  })
})
