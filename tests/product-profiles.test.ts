import { describe, expect, it } from 'vitest'
import { fieldsFromLines, fromRouteKey, parseLayerMap, profileStatus, summarizeCoverage, templateCovered, toRouteKey } from '@/lib/product-profiles'

const ok = { templateCovered: true }

const base = {
  printTemplateId: 'tpl1',
  masterArtworkUrl: 'https://cdn.example/master.png',
  masterArtworkId: null,
  layerMap: JSON.stringify([{ field: 'Name', layer: 'name_text', fit: 'shrink' }]),
}

describe('route key', () => {
  it('round-trips a product GID through a URL-safe key', () => {
    const key = toRouteKey('cstore1', 'gid://shopify/Product/9054123557021')
    expect(key).toBe('cstore1~9054123557021')
    expect(encodeURIComponent(key)).toBe(key)
    expect(fromRouteKey(key)).toEqual({ storeId: 'cstore1', shopifyProductId: 'gid://shopify/Product/9054123557021' })
  })

  it('rejects malformed keys', () => {
    for (const k of ['', 'cstore1', 'cstore1~', '~123', 'cstore1~abc', 'cstore1|gid://shopify/Product/1', 'a/b~1']) {
      expect(fromRouteKey(k)).toBeNull()
    }
  })
})

describe('profileStatus', () => {
  it('NONE without a profile', () => {
    expect(profileStatus(null, ['Name'], ok)).toBe('NONE')
  })
  it('NO_TEMPLATE when the lines are not covered by a template', () => {
    expect(profileStatus(base, ['Name'], { templateCovered: false })).toBe('NO_TEMPLATE')
  })
  it('NO_MASTER without a master link or upload', () => {
    expect(profileStatus({ ...base, masterArtworkUrl: null }, ['Name'], ok)).toBe('NO_MASTER')
    expect(profileStatus({ ...base, masterArtworkUrl: null, masterArtworkId: 'art1' }, ['Name'], ok)).toBe('READY')
  })
  it('NO_LAYERS when an observed field has no layer entry', () => {
    expect(profileStatus(base, ['Name', 'Year'], ok)).toBe('NO_LAYERS')
  })
  it('READY when every observed field is mapped, case-insensitively', () => {
    expect(profileStatus(base, ['name'], ok)).toBe('READY')
    expect(profileStatus(base, [], ok)).toBe('READY')
  })
  it('READY when only size and yes/no toggle fields are unmapped', () => {
    expect(profileStatus(base, ['Name', 'Size', 'Custom Name: Yes Or No?'], ok)).toBe('READY')
  })
})

describe('template coverage', () => {
  it('counts lines with a template and lists distinct missing SKUs', () => {
    const c = summarizeCoverage([
      { sku: 'A', hasTemplate: true }, { sku: 'TU20-40OZ', hasTemplate: false },
      { sku: 'TU20-40OZ', hasTemplate: false }, { sku: null, hasTemplate: false },
    ])
    expect(c).toEqual({ covered: 1, total: 4, missingSkus: ['TU20-40OZ', '(không SKU)'] })
  })
  it('is satisfied only when every mapped line has a template', () => {
    expect(templateCovered({ printTemplateId: null }, { covered: 3, total: 3, missingSkus: [] })).toBe(true)
    expect(templateCovered({ printTemplateId: 'tpl1' }, { covered: 2, total: 3, missingSkus: ['X'] })).toBe(false)
  })
  it('falls back to the profile template when no observed line is mapped', () => {
    const none = { covered: 0, total: 0, missingSkus: [] }
    expect(templateCovered({ printTemplateId: 'tpl1' }, none)).toBe(true)
    expect(templateCovered({ printTemplateId: null }, none)).toBe(false)
  })
})

describe('parseLayerMap', () => {
  it('keeps valid entries and drops broken ones', () => {
    const json = JSON.stringify([
      { field: 'Name', layer: 'n', fit: 'wrap', maxChars: 12, font: 'Inter' },
      { field: '', layer: 'x', fit: 'none' },
      { field: 'Year', layer: 'y', fit: 'bogus', maxChars: -1 },
    ])
    expect(parseLayerMap(json)).toEqual([
      { field: 'Name', layer: 'n', fit: 'wrap', maxChars: 12, font: 'Inter' },
      { field: 'Year', layer: 'y', fit: 'none' },
    ])
    expect(parseLayerMap('not json')).toEqual([])
  })
})

describe('fieldsFromLines', () => {
  it('collects distinct visible personalization keys', () => {
    const lines = [
      { customAttributesJson: JSON.stringify([{ key: 'Name', value: 'Ann' }, { key: '_print_files', value: '[]' }]) },
      { customAttributesJson: JSON.stringify([{ key: 'name', value: 'Bob' }, { key: 'Year', value: '1990' }]) },
      { customAttributesJson: null },
    ]
    expect(fieldsFromLines(lines)).toEqual(['Name', 'Year'])
  })
  it('drops size and yes/no toggle fields, which are never printed', () => {
    const lines = [{ customAttributesJson: JSON.stringify([
      { key: 'Size', value: 'XL' }, { key: 'Custom Name: Yes Or No?', value: 'Yes' }, { key: 'Custom Name', value: 'Ann' },
    ]) }]
    expect(fieldsFromLines(lines)).toEqual(['Custom Name'])
  })
})
