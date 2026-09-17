import { describe, it, expect } from 'vitest'
import { detectOrderTasks, detectStuckTrackingTask, TASK_META, type TaskLine, type TaskShipment } from './order-tasks'

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

describe('detectStuckTrackingTask', () => {
  const NOW = new Date('2026-09-18T00:00:00Z')
  const placed = (n: number) => new Date(NOW.getTime() - n * 86_400_000)
  const ship = (o: Partial<TaskShipment>): TaskShipment => ({ lineKey: 'LIT1_1', trackingNumber: 'JM123456789', status: 'PENDING', ...o })

  it('flags a JM tracking that never got a checkpoint', () => {
    const t = detectStuckTrackingTask({ placedAt: placed(30), pipelineStatus: 'FULFILLED', shipments: [ship({})], now: NOW })
    expect(t?.type).toBe('TRACKING_STUCK')
    expect(t?.dept).toBe('FULFILLMENT')
    expect(t?.detail).toContain('JM123456789')
    expect(t?.detail).toContain('LIT1_1')
  })

  it('ignores a JM tracking that is moving or delivered', () => {
    expect(detectStuckTrackingTask({ placedAt: placed(30), shipments: [ship({ status: 'IN_TRANSIT' })], now: NOW })).toBeNull()
    expect(detectStuckTrackingTask({ placedAt: placed(30), shipments: [ship({ status: 'DELIVERED' })], now: NOW })).toBeNull()
  })

  it('ignores other carriers still pending', () => {
    expect(detectStuckTrackingTask({ placedAt: placed(30), shipments: [ship({ trackingNumber: 'LZ439195516CN' })], now: NOW })).toBeNull()
    expect(detectStuckTrackingTask({ placedAt: placed(30), shipments: [ship({ trackingNumber: null })], now: NOW })).toBeNull()
  })

  it('waits out the grace period — a fresh tracking is not a task yet', () => {
    expect(detectStuckTrackingTask({ placedAt: placed(3), shipments: [ship({})], now: NOW })).toBeNull()
  })

  it('never nags on cancelled/refunded orders', () => {
    expect(detectStuckTrackingTask({ placedAt: placed(30), pipelineStatus: 'CANCELLED', shipments: [ship({})], now: NOW })).toBeNull()
    expect(detectStuckTrackingTask({ placedAt: placed(30), pipelineStatus: 'REFUNDED', shipments: [ship({})], now: NOW })).toBeNull()
  })

  it('lists every stuck line of the order in one task', () => {
    const t = detectStuckTrackingTask({
      placedAt: placed(30), pipelineStatus: 'FULFILLED', now: NOW,
      shipments: [ship({ lineKey: 'LIT1_1' }), ship({ lineKey: 'LIT1_2', trackingNumber: 'JM987' }), ship({ lineKey: 'LIT1_3', trackingNumber: 'UL1', status: 'PENDING' })],
    })
    expect(t?.detail).toContain('LIT1_1')
    expect(t?.detail).toContain('JM987')
    expect(t?.detail).not.toContain('UL1')
  })
})
