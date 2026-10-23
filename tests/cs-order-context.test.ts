import { describe, it, expect } from 'vitest'
import { extractOrderNumbers, factoryStateOf } from '@/lib/cs/order-context'

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
