import { describe, expect, it } from 'vitest'
import { fieldsFromLines, fromRouteKey, parseLayerMap, profileStatus, toRouteKey } from '@/lib/product-profiles'

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
    expect(profileStatus(null, ['Name'])).toBe('NONE')
  })
  it('NO_TEMPLATE without a print template', () => {
    expect(profileStatus({ ...base, printTemplateId: null }, ['Name'])).toBe('NO_TEMPLATE')
  })
  it('NO_MASTER without a master link or upload', () => {
    expect(profileStatus({ ...base, masterArtworkUrl: null }, ['Name'])).toBe('NO_MASTER')
    expect(profileStatus({ ...base, masterArtworkUrl: null, masterArtworkId: 'art1' }, ['Name'])).toBe('READY')
  })
  it('NO_LAYERS when an observed field has no layer entry', () => {
    expect(profileStatus(base, ['Name', 'Year'])).toBe('NO_LAYERS')
  })
  it('READY when every observed field is mapped, case-insensitively', () => {
    expect(profileStatus(base, ['name'])).toBe('READY')
    expect(profileStatus(base, [])).toBe('READY')
  })
  it('READY when only size and yes/no toggle fields are unmapped', () => {
    expect(profileStatus(base, ['Name', 'Size', 'Custom Name: Yes Or No?'])).toBe('READY')
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
