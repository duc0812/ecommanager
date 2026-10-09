import { describe, it, expect } from 'vitest'
import { layerRowsToMap, overrideRowsToPayload, referencedSupplierIds, toLayerRows, toOverrideRows } from '@/app/design-studio/products/components/profile-form'
import { layerHint, mergeLayerHints } from '@/app/design-studio/components/model'

describe('layer rows', () => {
  it('appends observed fields that the layer map lacks, matching case-insensitively', () => {
    const rows = toLayerRows([{ field: 'Name', layer: 'name_text', fit: 'shrink', maxChars: 12 }], ['name', 'Pet Photo'])
    expect(rows).toEqual([
      { field: 'Name', observed: true, layer: 'name_text', font: '', maxChars: '12', fit: 'shrink' },
      { field: 'Pet Photo', observed: true, layer: '', font: '', maxChars: '', fit: 'shrink' },
    ])
  })

  it('drops observed rows without a layer but rejects new rows missing one', () => {
    const observed = { field: 'Pet Photo', observed: true, layer: '', font: '', maxChars: '', fit: 'none' as const }
    expect(layerRowsToMap([observed])).toEqual({ ok: true, layerMap: [] })
    const fresh = { field: 'Extra', observed: false, layer: ' ', font: '', maxChars: '', fit: 'none' as const }
    expect(layerRowsToMap([fresh]).ok).toBe(false)
  })

  it('validates max chars and duplicate fields', () => {
    const row = { field: 'Name', observed: false, layer: 'n', font: ' Arial ', maxChars: '10', fit: 'wrap' as const }
    expect(layerRowsToMap([row])).toEqual({ ok: true, layerMap: [{ field: 'Name', layer: 'n', font: 'Arial', maxChars: 10, fit: 'wrap' }] })
    expect(layerRowsToMap([{ ...row, maxChars: '1.5' }]).ok).toBe(false)
    expect(layerRowsToMap([row, { ...row, field: 'name' }]).ok).toBe(false)
  })
})

describe('override rows', () => {
  it('round-trips multi-key combos through the extra pairs', () => {
    const overrides = [{ combo: { Size: '6XL', Color: 'Black' }, supplierProductId: 'sp1' }]
    const rows = toOverrideRows(overrides)
    expect(rows[0]).toMatchObject({ option: 'Size', value: '6XL', extra: { Color: 'Black' } })
    const payload = overrideRowsToPayload(rows)
    expect(payload.ok && JSON.stringify(payload.overrides)).toBe(JSON.stringify(overrides))
  })

  it('skips blank rows and rejects half-filled ones', () => {
    expect(overrideRowsToPayload([{ option: '', value: '', extra: {}, supplierProductId: '' }])).toEqual({ ok: true, overrides: [] })
    expect(overrideRowsToPayload([{ option: 'Size', value: '', extra: {}, supplierProductId: 'sp1' }]).ok).toBe(false)
    expect(overrideRowsToPayload([{ option: 'Size', value: 'XL', extra: {}, supplierProductId: '' }]).ok).toBe(false)
  })

  it('collects the suppliers of the referenced products', () => {
    const products = [{ id: 'a', supplierId: 's1' }, { id: 'b', supplierId: 's2' }] as any
    expect(Array.from(referencedSupplierIds(products, ['b', 'missing']))).toEqual(['s2'])
  })
})

describe('mergeLayerHints', () => {
  it('adds hints only for unmapped fields and skips size-like fields', () => {
    const existing = [{ field: 'name', layer: 'custom_layer', fit: 'wrap' as const }]
    const { merged, added } = mergeLayerHints(existing, ['Name', 'Number', 'Size', 'Pet Type'])
    expect(merged[0]).toEqual(existing[0])
    expect(added).toEqual([
      { field: 'Number', layer: 'number', fit: 'shrink' },
      { field: 'Pet Type', layer: 'pet_type', fit: 'none' },
    ])
    expect(merged).toHaveLength(3)
    expect(layerHint('Size')).toBeNull()
  })
})
