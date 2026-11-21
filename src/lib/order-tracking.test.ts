import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { orderTrackingNumbers, type ShipmentTrackingSource } from '@/lib/order-tracking'
import TrackingNumbers from '@/components/orders/TrackingNumbers'

const ship = (over: Partial<ShipmentTrackingSource>): ShipmentTrackingSource => ({
  lineKey: 'REMI1001_1', trackingNumber: null, carrier: null, trackingUrl: null, detectedCarrier: null,
  lastMileCarrier: null, lastMileTrackingNumber: null, status: 'IN_TRANSIT', ...over,
})

describe('orderTrackingNumbers', () => {
  it('lists every distinct number when the lines ship in two parcels', () => {
    const out = orderTrackingNumbers([
      ship({ lineKey: 'LIT5001_2', trackingNumber: 'YT2611200001', carrier: 'Yun Express', trackingUrl: 'https://t.example/YT2611200001' }),
      ship({ lineKey: 'LIT5001_1', trackingNumber: '9400111899223344556677', carrier: 'USPS' }),
    ])
    expect(out.map(t => t.number)).toEqual(['9400111899223344556677', 'YT2611200001'])
    expect(out[0]).toMatchObject({ carrier: 'USPS', lineKeys: ['LIT5001_1'], url: 'https://parcelsapp.com/en/tracking/9400111899223344556677' })
    expect(out[1]).toMatchObject({ carrier: 'Yun Express', url: 'https://t.example/YT2611200001', lastMile: false })
  })

  it('collapses lines that share one parcel into one entry', () => {
    const out = orderTrackingNumbers([
      ship({ lineKey: 'LIT5002_1', trackingNumber: 'SPXVN0123' }),
      ship({ lineKey: 'LIT5002_2', trackingNumber: ' spxvn0123 ' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ number: 'SPXVN0123', lineKeys: ['LIT5002_1', 'LIT5002_2'], carrier: 'Shopee Xpress' })
  })

  it('adds the last-mile number when it differs (Bondre first leg + US last mile)', () => {
    const out = orderTrackingNumbers([
      ship({ trackingNumber: 'SDH1234567', carrier: 'Other', detectedCarrier: 'SDH Express', lastMileTrackingNumber: 'LZ439195516CN', lastMileCarrier: 'USPS' }),
    ])
    expect(out).toEqual([
      expect.objectContaining({ number: 'SDH1234567', carrier: 'SDH Express', lastMile: false }),
      expect.objectContaining({ number: 'LZ439195516CN', carrier: 'USPS', lastMile: true }),
    ])
  })

  it('does not repeat a last-mile number equal to the main one, and skips lines without tracking', () => {
    const out = orderTrackingNumbers([
      ship({ trackingNumber: 'GFUS01', lastMileTrackingNumber: 'gfus01' }),
      ship({ lineKey: 'REMI1001_2' }),
    ])
    expect(out.map(t => t.number)).toEqual(['GFUS01'])
  })
})

describe('TrackingNumbers', () => {
  it('renders both numbers of a two-parcel order with links and line keys', () => {
    const items = orderTrackingNumbers([
      ship({ lineKey: 'REMI1003_1', trackingNumber: 'YT1', carrier: 'Yun Express', trackingUrl: 'https://t.example/YT1' }),
      ship({ lineKey: 'REMI1003_2', trackingNumber: 'UUS2' }),
    ])
    const html = renderToStaticMarkup(React.createElement(TrackingNumbers, { items }))
    expect(html).toContain('href="https://t.example/YT1"')
    expect(html).toContain('href="https://parcelsapp.com/en/tracking/UUS2"')
    expect(html).toContain('Yun Express')
    expect(html).toContain('UniUni')
    expect(html).toContain('_1')
    expect(html).toContain('_2')
  })

  it('renders nothing without tracking', () => {
    expect(renderToStaticMarkup(React.createElement(TrackingNumbers, { items: [] }))).toBe('')
  })
})
