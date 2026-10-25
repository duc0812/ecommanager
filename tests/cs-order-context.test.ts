import { describe, it, expect } from 'vitest'
import { extractOrderNumbers, factoryStateOf, personalizationOf } from '@/lib/cs/order-context'

const base = { supplierHandoffAt: null as Date | null, pipelineStatus: 'READY_TO_PRODUCTION', fulfillmentStatus: null as string | null, supplierPushes: [] as { status: string }[], shipments: [] as { status: string }[] }

describe('extractOrderNumbers', () => {
  it('finds a hashed number in a subject', () => {
    expect(extractOrderNumbers('Re: Order #LIT5037 confirmed')).toEqual(['#LIT5037'])
  })
  it('finds a bare number with no hash', () => {
    expect(extractOrderNumbers('LIT3910')).toEqual(['#LIT3910'])
  })
  it('normalises case and spacing, dedupes', () => {
    expect(extractOrderNumbers('my order lit 4525 and #lit4525 again')).toEqual(['#LIT4525'])
  })
  it('returns empty when nothing matches', () => {
    expect(extractOrderNumbers('no order here')).toEqual([])
  })
})

describe('personalizationOf', () => {
  it('reads the visible checkout properties and skips hidden ones', () => {
    const attrs = JSON.stringify([{ key: 'Custom Name', value: 'Maree' }, { key: '_pers', value: 'mvm1hmx02onb' }, { key: '_product_url', value: 'https://x' }])
    expect(personalizationOf({ customAttributesJson: attrs, customallFieldsJson: null, designNote: null })).toBe('Custom Name: Maree')
  })
  it("merges Customall fields and the design note, keeping the customer's exact text", () => {
    const attrs = JSON.stringify([{ key: '_customall_preview', value: 'https://p' }])
    const ca = JSON.stringify([{ key: 'Choose Back Dessign', value: 'Yes' }, { key: 'Custom Name', value: 'BURNAM' }, { key: 'Custom Number', value: '35' }])
    expect(personalizationOf({ customAttributesJson: attrs, customallFieldsJson: ca, designNote: 'print name on both sides' }))
      .toBe('Choose Back Dessign: Yes; Custom Name: BURNAM; Custom Number: 35; note: print name on both sides')
  })
  it('keeps trailing spaces visible so staff see what the customer typed', () => {
    const attrs = JSON.stringify([{ key: 'Custom Name', value: 'Trenton ' }])
    expect(personalizationOf({ customAttributesJson: attrs, customallFieldsJson: null, designNote: null })).toBe('Custom Name: "Trenton "')
  })
  it('falls back to the cm1 design payload text when no visible property exists', () => {
    const attrs = JSON.stringify([{ key: '_design', value: JSON.stringify({ v: 'cm1', data: { _vfmen: { text: 'Trenton' } } }) }])
    expect(personalizationOf({ customAttributesJson: attrs, customallFieldsJson: null, designNote: null })).toBe('text: Trenton')
  })
  it('is null when nothing was typed or the json is broken', () => {
    expect(personalizationOf({ customAttributesJson: '[{"key":"_product_url","value":"x"}]', customallFieldsJson: null, designNote: null })).toBeNull()
    expect(personalizationOf({ customAttributesJson: 'not json', customallFieldsJson: null, designNote: null })).toBeNull()
    expect(personalizationOf({ customAttributesJson: null, customallFieldsJson: null, designNote: null })).toBeNull()
  })
})

describe('factoryStateOf', () => {
  it('NOT_SENT before handoff', () => {
    expect(factoryStateOf(base)).toBe('NOT_SENT')
  })
  it('AT_FACTORY once a live push exists', () => {
    expect(factoryStateOf({ ...base, supplierPushes: [{ status: 'CREATED' }] })).toBe('AT_FACTORY')
  })
  it('AT_FACTORY once handed off manually', () => {
    expect(factoryStateOf({ ...base, supplierHandoffAt: new Date() })).toBe('AT_FACTORY')
  })
  it('SHIPPED when a shipment is moving', () => {
    expect(factoryStateOf({ ...base, pipelineStatus: 'EXPORTED', shipments: [{ status: 'IN_TRANSIT' }] })).toBe('SHIPPED')
  })
  it('DELIVERED when every shipment is delivered', () => {
    expect(factoryStateOf({ ...base, shipments: [{ status: 'DELIVERED' }] })).toBe('DELIVERED')
  })
  it('CANCELLED pipeline wins', () => {
    expect(factoryStateOf({ ...base, pipelineStatus: 'CANCELLED', shipments: [{ status: 'DELIVERED' }] })).toBe('CANCELLED')
  })
})
