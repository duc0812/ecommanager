import { describe, it, expect } from 'vitest'
import {
  canonicalOptionKey, isCanonicalOptionKey, optionComboLabel, parseArtworkSplits, parseOptionKey, resolveEntryForLine, slotOptionKey, withSplit,
} from '@/lib/artwork-options'
import { productStatus } from '@/lib/artwork-fields'
import { buildSlotDrafts, assignSlotEntries } from '@/lib/artwork-slots'

describe('option keys', () => {
  it('canonicalises a combo with sorted keys and trimmed values; empty means all options', () => {
    expect(canonicalOptionKey({ Size: ' 30oz ', Color: 'Red' })).toBe('{"Color":"Red","Size":"30oz"}')
    expect(canonicalOptionKey({})).toBe('')
    expect(canonicalOptionKey({ Size: '  ' })).toBe('')
  })

  it('parses and validates keys', () => {
    expect(parseOptionKey('')).toEqual({})
    expect(parseOptionKey('{"Size":"30oz"}')).toEqual({ Size: '30oz' })
    for (const bad of ['nope', '[]', '{}', '{"Size":1}', '{"":"x"}']) expect(parseOptionKey(bad)).toBeNull()
    expect(isCanonicalOptionKey('{"Size":"30oz"}')).toBe(true)
    expect(isCanonicalOptionKey('{"Size":"30oz","Color":"Red"}')).toBe(false)
    expect(isCanonicalOptionKey('{ "Size": "30oz" }')).toBe(false)
    expect(optionComboLabel('{"Color":"Red","Size":"30oz"}')).toBe('Color: Red · Size: 30oz')
  })

  it('a line lands in the slot of its split option value, or the shared slot without it', () => {
    expect(slotOptionKey({ Size: '30oz', Ship: 'US' }, 'Size')).toBe('{"Size":"30oz"}')
    expect(slotOptionKey({ Ship: 'US' }, 'Size')).toBe('')
    expect(slotOptionKey({ Size: '30oz' }, null)).toBe('')
  })

  it('stores one split per template', () => {
    const splits = parseArtworkSplits(JSON.stringify([{ printTemplateId: 't1', optionName: 'Size' }, { printTemplateId: 't1', optionName: 'Color' }, { bogus: 1 }]))
    expect(splits).toEqual([{ printTemplateId: 't1', optionName: 'Size' }])
    expect(withSplit(splits, 't1', 'Color')).toEqual([{ printTemplateId: 't1', optionName: 'Color' }])
    expect(withSplit(splits, 't1', null)).toEqual([])
    expect(parseArtworkSplits('not json')).toEqual([])
  })
})

describe('line → entry resolution', () => {
  const shared = { id: 'shared', optionKey: '' }
  const s30 = { id: 's30', optionKey: '{"Size":"30oz"}' }
  const red = { id: 'red', optionKey: '{"Color":"Red"}' }
  const entries = [shared, s30, red]

  it('picks the entry whose option combo matches the line under the current split', () => {
    expect(resolveEntryForLine(entries, { Size: '30oz', Color: 'Red' }, 'Size')?.id).toBe('s30')
    expect(resolveEntryForLine(entries, { Size: '30oz', Color: 'Red' }, 'Color')?.id).toBe('red')
  })

  it('falls back to the "" entry when no split entry matches', () => {
    expect(resolveEntryForLine(entries, { Size: '40oz' }, 'Size')?.id).toBe('shared')
    expect(resolveEntryForLine(entries, {}, 'Size')?.id).toBe('shared')
  })

  it('after "Gộp lại" (no split) every line resolves to the "" entry', () => {
    expect(resolveEntryForLine(entries, { Size: '30oz' }, null)?.id).toBe('shared')
    expect(resolveEntryForLine([s30], { Size: '30oz' }, null)).toBeNull()
  })
})

describe('combined product status', () => {
  it('is the worst of mapping, template and artwork across active slots', () => {
    expect(productStatus({ active: ['READY', 'READY'], stale: [], unmapped: 0 })).toBe('READY')
    expect(productStatus({ active: ['READY', 'NEEDS_REVIEW'], stale: [], unmapped: 0 })).toBe('NEEDS_REVIEW')
    expect(productStatus({ active: ['READY', 'EMPTY', 'NO_TEMPLATE'], stale: [], unmapped: 0 })).toBe('NO_TEMPLATE')
    expect(productStatus({ active: ['READY'], stale: [], unmapped: 2 })).toBe('NO_MAPPING')
    expect(productStatus({ active: ['READY'], stale: ['ERROR'], unmapped: 0 })).toBe('READY')
    expect(productStatus({ active: [], stale: ['NEEDS_REVIEW'], unmapped: 0 })).toBe('NEEDS_REVIEW')
    expect(productStatus({ active: [], stale: [], unmapped: 0 })).toBe('NO_TEMPLATE')
  })
})

describe('slot drafts', () => {
  const tpl = { id: 't1', name: 'Tumbler', widthPx: 1, heightPx: 1, dpi: 300, bleedIn: 0, safeIn: 0, mirror: false, areas: '[]', guideImagePath: null, templateUrl: null, supplierId: 'sup', supplierSku: 'T' }
  const ctx = { byId: new Map(), productTemplate: new Map(), bySupplier: new Map([['sup', [tpl]]]) }
  const noTplCtx = { byId: new Map(), productTemplate: new Map(), bySupplier: new Map() }
  const line = (sku: string, opts: Record<string, string>, supplier: string | null = 'sup') => ({
    orderId: 'o', shopifyLineId: `${sku}-${JSON.stringify(opts)}`, resolvedSupplierId: supplier, resolvedSupplierSku: supplier ? sku : null,
    variantOptions: JSON.stringify(opts), variantTitle: null,
  })

  it('splits lines without a template by supplier SKU', () => {
    const { slots, unmapped } = buildSlotDrafts([
      line('C450-30OZ', { Size: '30oz', Ship: 'US' }), line('TU20-40OZ', { Size: '40oz', Ship: 'US' }),
      line('C450-30OZ', { Size: '30oz', Ship: 'Overseas' }), line('x', {}, null),
    ], null, noTplCtx as any)
    expect(unmapped).toBe(1)
    expect(slots.map(s => [s.skus, s.title, s.lines.length])).toEqual([
      [['C450-30OZ'], 'Size: 30oz · Ship: Overseas, US', 2],
      [['TU20-40OZ'], 'Size: 40oz · Ship: US', 1],
    ])
  })

  it('splits a template slot per option value and keeps lines without that option in the shared slot', () => {
    const lines = [line('T', { Size: '30oz' }), line('T', { Size: '40oz' }), line('T', { Color: 'Red' })]
    const { slots } = buildSlotDrafts(lines, { printTemplateId: null, artworkSplits: JSON.stringify([{ printTemplateId: 't1', optionName: 'Size' }]) }, ctx as any)
    expect(slots.map(s => s.optionKey)).toEqual(['', '{"Size":"30oz"}', '{"Size":"40oz"}'])
    expect(slots.every(s => s.splitOption === 'Size')).toBe(true)
    expect(slots[0].splitChoices.map(c => c.name)).toEqual(['Size', 'Color'])

    const { slots: assigned, stale } = assignSlotEntries(slots, [
      { id: 'shared', printTemplateId: 't1', optionKey: '', status: 'READY' },
      { id: 's30', printTemplateId: 't1', optionKey: '{"Size":"30oz"}', status: 'NEEDS_REVIEW' },
      { id: 'old', printTemplateId: 't1', optionKey: '{"Color":"Red"}', status: 'READY' },
    ])
    expect(assigned.map(s => [s.optionKey, s.entry?.id, s.inherited, s.status])).toEqual([
      ['', 'shared', false, 'READY'],
      ['{"Size":"30oz"}', 's30', false, 'NEEDS_REVIEW'],
      ['{"Size":"40oz"}', 'shared', true, 'READY'],
    ])
    expect(stale.map(e => e.id)).toEqual(['old'])
  })

  it('merging back makes split entries stale', () => {
    const { slots } = buildSlotDrafts([line('T', { Size: '30oz' })], null, ctx as any)
    const { slots: assigned, stale } = assignSlotEntries(slots, [
      { id: 'shared', printTemplateId: 't1', optionKey: '', status: 'EMPTY' },
      { id: 's30', printTemplateId: 't1', optionKey: '{"Size":"30oz"}', status: 'READY' },
    ])
    expect(assigned.map(s => s.entry?.id)).toEqual(['shared'])
    expect(stale.map(e => e.id)).toEqual(['s30'])
  })
})
