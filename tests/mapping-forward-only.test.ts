import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Mapping-save routes must NOT retroactively re-map already-costed order lines.
// They should call recalculateMissingOrderLineCosts in fill-missing mode
// (refreshExisting falsy) so historical mapped orders keep their snapshot cost;
// only lines without a cost yet get resolved.

const mocks = vi.hoisted(() => ({
  recalc: vi.fn(async () => ({ scannedLines: 0, updatedLines: 0, unresolvedLines: 0, updatedOrders: 0 })),
  saveManualMapping: vi.fn(async () => ({ id: 'm1' })),
  deleteManualMapping: vi.fn(async () => {}),
  getPendingMappingQueue: vi.fn(async () => []),
  listVariantManualMappings: vi.fn(async () => []),
  createProductBase: vi.fn(async () => ({ id: 'b1' })),
  updateProductBase: vi.fn(async () => ({ id: 'b1' })),
  deleteProductBase: vi.fn(async () => {}),
  listProductBases: vi.fn(async () => []),
}))

vi.mock('@/lib/repos/order-costs', () => ({
  recalculateMissingOrderLineCosts: mocks.recalc,
}))

vi.mock('@/lib/repos/mapping', () => ({
  saveManualMapping: mocks.saveManualMapping,
  deleteManualMapping: mocks.deleteManualMapping,
  getPendingMappingQueue: mocks.getPendingMappingQueue,
  listVariantManualMappings: mocks.listVariantManualMappings,
  createProductBase: mocks.createProductBase,
  updateProductBase: mocks.updateProductBase,
  deleteProductBase: mocks.deleteProductBase,
  listProductBases: mocks.listProductBases,
}))

import { POST as manualPOST } from '@/app/api/fulfillment/mapping/manual/route'
import { DELETE as manualDELETE } from '@/app/api/fulfillment/mapping/manual/[id]/route'
import { POST as basePOST } from '@/app/api/fulfillment/mapping/product-bases/route'
import { PUT as basePUT, DELETE as baseDELETE } from '@/app/api/fulfillment/mapping/product-bases/[id]/route'

function jsonReq(body: unknown) {
  return new NextRequest('http://localhost/api/fulfillment/mapping', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

function lastRecalcArg(): { refreshExisting?: boolean } | undefined {
  const calls = mocks.recalc.mock.calls as unknown as unknown[][]
  const last = calls[calls.length - 1]
  return last?.[0] as { refreshExisting?: boolean } | undefined
}

beforeEach(() => {
  mocks.recalc.mockClear()
})

describe('mapping-save routes are fill-missing (do not retroactively re-map costed lines)', () => {
  it('POST /manual does not force refreshExisting', async () => {
    await manualPOST(jsonReq({ shopifyVariantId: 'v1', shopifyProductTitle: 'T', supplierProductId: 'sp1' }))
    expect(mocks.recalc).toHaveBeenCalled()
    expect(lastRecalcArg()?.refreshExisting).not.toBe(true)
  })

  it('DELETE /manual/[id] does not force refreshExisting', async () => {
    await manualDELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), { params: { id: 'm1' } })
    expect(mocks.recalc).toHaveBeenCalled()
    expect(lastRecalcArg()?.refreshExisting).not.toBe(true)
  })

  it('POST /product-bases does not force refreshExisting', async () => {
    await basePOST(jsonReq({ name: 'B', shopifyProductType: 'Tee', variantConditions: '[]' }))
    expect(mocks.recalc).toHaveBeenCalled()
    expect(lastRecalcArg()?.refreshExisting).not.toBe(true)
  })

  it('PUT /product-bases/[id] does not force refreshExisting', async () => {
    await basePUT(jsonReq({ name: 'B', shopifyProductType: 'Tee', variantConditions: '[]' }), { params: { id: 'b1' } })
    expect(mocks.recalc).toHaveBeenCalled()
    expect(lastRecalcArg()?.refreshExisting).not.toBe(true)
  })

  it('DELETE /product-bases/[id] does not force refreshExisting', async () => {
    await baseDELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), { params: { id: 'b1' } })
    expect(mocks.recalc).toHaveBeenCalled()
    expect(lastRecalcArg()?.refreshExisting).not.toBe(true)
  })
})
