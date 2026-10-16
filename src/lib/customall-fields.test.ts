import { describe, it, expect } from 'vitest'
import { compressToBase64 } from 'lz-string'
import { pack } from 'jsonpack'
import {
  customallFields,
  customizationIdOf,
  decodePacked,
  encodeRequest,
  numericProductId,
  parseCustomallFields,
} from '@/lib/customall-fields'

// Layers of the PoMo jersey (product 8913496703133) as Customall served them on 2026-10-16.
const POMO = {
  artworks: [{
    id: 'AhbLWbU1L',
    templates: [{
      title: 'Default',
      layers: [
        { id: '_l8n04', type: 'Image', title: 'Image #1' },
        { id: '_kl07k', type: 'Option', title: 'Choose Back Dessign', options: [{ label: 'No', value: 'option-1' }, { label: 'Yes', value: 'frkhqFIap' }] },
        { id: '_4j531', type: 'Text', title: 'Custom Name' },
        { id: '_i4yhm', type: 'Text', title: 'Custom Name' },
        { id: '_ey6w2', type: 'Text', title: 'Custom Number' },
      ],
    }],
  }],
}

// #LIT4156, line 1: what order-info answers for its _customallcustomid.
const LIT4156 = { AhbLWbU1L: { template: 0, _kl07k: 'frkhqFIap', _4j531: 'Ianetta', _i4yhm: 'Ianetta', _ey6w2: '26' } }

describe('customallFields', () => {
  it('names each text by its layer title, in layer order, and spells out the option picked', () => {
    expect(customallFields(LIT4156, POMO)).toEqual([
      { key: 'Choose Back Dessign', value: 'Yes' },
      { key: 'Custom Name', value: 'Ianetta' },
      { key: 'Custom Number', value: '26' },
    ])
  })

  it('keeps both texts when two layers with one title hold different values', () => {
    const v = { AhbLWbU1L: { template: 0, _4j531: 'Sam', _i4yhm: 'Samson' } }
    expect(customallFields(v, POMO)).toEqual([
      { key: 'Custom Name', value: 'Sam' },
      { key: 'Custom Name', value: 'Samson' },
    ])
  })

  it('trims what the shopper typed and drops empty values', () => {
    const v = { AhbLWbU1L: { template: 0, _4j531: 'Martinez ', _ey6w2: '  ' } }
    expect(customallFields(v, POMO)).toEqual([{ key: 'Custom Name', value: 'Martinez' }])
  })

  it('leaves out picture layers: their value is an item id, not text', () => {
    const v = { AhbLWbU1L: { template: 0, _l8n04: 'VjjWXYWEK', _ey6w2: '7' } }
    expect(customallFields(v, POMO)).toEqual([{ key: 'Custom Number', value: '7' }])
  })

  it('names the template when the artwork offers more than one', () => {
    const campaign = {
      artworks: [{
        id: 'A', templateDisplayLabel: 'Style',
        templates: [{ title: 'Classic', layers: [] }, { title: 'Retro', layers: [{ id: '_t', type: 'Text', title: 'Name' }] }],
      }],
    }
    expect(customallFields({ A: { template: 1, _t: 'Ann' } }, campaign)).toEqual([
      { key: 'Style', value: 'Retro' },
      { key: 'Name', value: 'Ann' },
    ])
  })

  it('skips artworks the shopper did not personalise', () => {
    const v = { '0eG7YLc0M': { template: 0 }, AhbLWbU1L: { template: 0, _4j531: 'Lumepa' } }
    expect(customallFields(v, POMO)).toEqual([{ key: 'Custom Name', value: 'Lumepa' }])
  })

  it('still shows a value whose layer is gone from the campaign, under its layer id', () => {
    const v = { AhbLWbU1L: { template: 0, _gone1: 'Jesse' } }
    expect(customallFields(v, POMO)).toEqual([{ key: 'Layer _gone1', value: 'Jesse' }])
  })

  it('shows every value under its layer id when the campaign could not be read', () => {
    expect(customallFields({ HEonD7VCY: { template: 0, _nxup4: 'Jesse' } }, null)).toEqual([{ key: 'Layer _nxup4', value: 'Jesse' }])
  })
})

describe('customizationIdOf', () => {
  it('reads _customallcustomid', () => {
    expect(customizationIdOf([{ key: '_customallcustomid', value: '2026-09-27/eqq4sfkshuulnq5zvbcodk' }])).toBe('2026-09-27/eqq4sfkshuulnq5zvbcodk')
  })
  it('ignores the add-on fee line and anything not shaped like an id', () => {
    expect(customizationIdOf([{ key: '_add_on_customallcustomid', value: '2026-09-27/eqq4sfkshuulnq5zvbcodk' }])).toBeNull()
    expect(customizationIdOf([{ key: '_customallcustomid', value: '../../x' }])).toBeNull()
  })
})

describe('wire format', () => {
  it('encodes a request the way Customall reads it (JSON, each byte XOR 0x47, hex)', () => {
    expect(encodeRequest({ customization_id: '2026-09-27/eqq4sfkshuulnq5zvbcodk' }))
      .toBe('3c6524323433282a2e3d26332e2829182e23657d65757775716a777e6a7570682236367334212c342f32322b2936723d31252428232c653a')
  })
  it('unpacks lz-string base64 around jsonpack', () => {
    expect(decodePacked(compressToBase64(pack({ hash: 'abc', n: [1, 2] })))).toEqual({ hash: 'abc', n: [1, 2] })
  })
  it('takes the number out of a product gid', () => {
    expect(numericProductId('gid://shopify/Product/8913496703133')).toBe('8913496703133')
    expect(numericProductId(null)).toBeNull()
  })
})

describe('parseCustomallFields', () => {
  it('reads a stored list and tells "not fetched" (null) from "nothing typed" ([])', () => {
    expect(parseCustomallFields('[{"key":"Custom Name","value":"Ianetta"}]')).toEqual([{ key: 'Custom Name', value: 'Ianetta' }])
    expect(parseCustomallFields('[]')).toEqual([])
    expect(parseCustomallFields(null)).toBeNull()
    expect(parseCustomallFields('nope')).toBeNull()
  })
})
