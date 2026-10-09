import { describe, it, expect } from 'vitest'
import { overrideRowsToPayload, referencedSupplierIds, toOverrideRows } from '@/app/design-studio/products/components/profile-form'
import { layerForField } from '@/app/design-studio/components/model'

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

describe('workspace Layer column source', () => {
  const library = (layers: { field: string; layer: string; fit: string; maxChars?: number }[], entryId: string | null = 'e1') => ({
    key: 'k', entryId, status: 'READY', label: 'Sẵn sàng', optionKey: '{"Size":"30oz"}', optionLabel: 'Size: 30oz', layers,
  }) as any
  const legacy = [{ field: 'Name', layer: 'name_text', fit: 'shrink' as const, maxChars: 12 }]

  it('uses the resolved library entry fields, matching the field name case-insensitively', () => {
    expect(layerForField('name', library([{ field: 'Name', layer: '@Name', fit: 'wrap', maxChars: 10 }]), legacy))
      .toEqual({ source: 'library', layer: '@Name', fit: 'wrap', maxChars: 10, optionLabel: 'Size: 30oz' })
  })

  it('flags a customer field the parsed PSD has no layer for', () => {
    expect(layerForField('Year', library([{ field: 'Name', layer: '@Name', fit: 'wrap' }]), legacy)).toEqual({ source: 'library-missing', layer: '@Year', optionLabel: 'Size: 30oz' })
  })

  it('falls back to the old layerMap when there is no entry or it is not parsed yet', () => {
    expect(layerForField('Name', null, legacy)).toEqual({ source: 'profile', layer: 'name_text', fit: 'shrink', maxChars: 12 })
    expect(layerForField('Name', library([], null), legacy)).toMatchObject({ source: 'profile' })
    expect(layerForField('Name', library([]), legacy)).toMatchObject({ source: 'profile' })
  })

  it('guesses from the field name without entry or layerMap, and skips size-like fields', () => {
    expect(layerForField('Pet Name', null, [])).toEqual({ source: 'guess', layer: 'TXT · pet_name' })
    expect(layerForField('Size', library([{ field: 'Name', layer: '@Name', fit: 'wrap' }]), legacy)).toEqual({ source: 'none', layer: '—' })
  })
})
