import { describe, it, expect } from 'vitest'
import { detectOrderTasks, TASK_META, type TaskLine } from './order-tasks'

const line = (o: Partial<TaskLine>): TaskLine => ({
  sku: 'SKU1', productTitle: 'Tee', shopifyProductType: 'Shirt',
  resolvedSupplierId: 'sup1', resolvedBaseCost: 5, manualBaseCost: null, ...o,
})

describe('detectOrderTasks', () => {
  it('clean order → no tasks', () => {
    expect(detectOrderTasks({ orderType: 'NON_CUSTOM', designReady: true, lines: [line({})] })).toEqual([])
  })

  it('MISSING_SKU when a product line has no sku', () => {
    const t = detectOrderTasks({ orderType: 'CUSTOM', designReady: true, lines: [line({ sku: null })] })
    expect(t.map(x => x.type)).toEqual(['MISSING_SKU'])
    expect(t[0].dept).toBe('MAPPING')
  })

  it('UNMAPPED when line has sku but no resolved supplier', () => {
    const t = detectOrderTasks({ orderType: 'CUSTOM', designReady: true, lines: [line({ resolvedSupplierId: null })] })
    expect(t.map(x => x.type)).toEqual(['UNMAPPED'])
  })

  it('MISSING_BASE_COST when mapped but no cost', () => {
    const t = detectOrderTasks({ orderType: 'CUSTOM', designReady: true, lines: [line({ resolvedBaseCost: null, manualBaseCost: null })] })
    expect(t.map(x => x.type)).toEqual(['MISSING_BASE_COST'])
  })

  it('manual base cost satisfies the cost check', () => {
    const t = detectOrderTasks({ orderType: 'CUSTOM', designReady: true, lines: [line({ resolvedBaseCost: null, manualBaseCost: 4 })] })
    expect(t).toEqual([])
  })

  it('MISSING_DESIGN only for non-custom without design', () => {
    expect(detectOrderTasks({ orderType: 'NON_CUSTOM', designReady: false, lines: [line({})] }).map(x => x.type)).toEqual(['MISSING_DESIGN'])
    expect(detectOrderTasks({ orderType: 'CUSTOM', designReady: false, lines: [line({})] })).toEqual([])
  })

  it('multiple tasks on one order', () => {
    const t = detectOrderTasks({
      orderType: 'NON_CUSTOM', designReady: false,
      lines: [line({ sku: null }), line({ sku: 'X', resolvedSupplierId: null })],
    })
    expect(t.map(x => x.type).sort()).toEqual(['MISSING_DESIGN', 'MISSING_SKU', 'UNMAPPED'])
  })

  it('ignores non-product (digital) lines', () => {
    const t = detectOrderTasks({
      orderType: 'CUSTOM', designReady: true,
      lines: [line({ sku: null, productTitle: 'Custom Text', shopifyProductType: 'Custom Text' })],
    })
    // digital add-on lines (type/title "custom text") are excluded from product checks
    expect(t).toEqual([])
  })

  it('exposes task metadata', () => {
    expect(TASK_META.MISSING_DESIGN.dept).toBe('DESIGN')
    expect(TASK_META.MISSING_SKU.label).toBeTruthy()
  })
})
