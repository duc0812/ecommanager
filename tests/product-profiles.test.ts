import { describe, expect, it } from 'vitest'
import { fieldsFromLines, fromRouteKey, parseLayerMap, toRouteKey } from '@/lib/product-profiles'

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
