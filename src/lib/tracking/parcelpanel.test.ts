import { describe, it, expect } from 'vitest'
import { mapParcelPanelShipment } from './parcelpanel'

describe('mapParcelPanelShipment', () => {
  it('maps a real in-transit shipment (status, carrier, last-mile, checkpoints)', () => {
    const m = mapParcelPanelShipment({
      status: 'IN_TRANSIT',
      tracking_number: 'JMWL1',
      carrier: { name: 'China Post', code: 'china-post' },
      last_mile: { carrier_name: 'USPS', carrier_code: 'usps', tracking_number: 'LZ442544106CN' },
      checkpoints: [
        { detail: 'Arrival at the Destination', status: 'IN_TRANSIT', checkpoint_time: '2026-08-28T15:25:00' },
        { detail: 'Departed', status: 'IN_TRANSIT', checkpoint_time: '2026-08-20T10:00:00' },
      ],
    })
    expect(m.status).toBe('IN_TRANSIT')
    expect(m.detectedCarrier).toBe('China Post')
    expect(m.detectedCarrierCode).toBe('china-post')
    expect(m.lastMileCarrier).toBe('USPS')
    expect(m.lastMileTrackingNumber).toBe('LZ442544106CN')
    expect(m.lastCheckpointAt).toEqual(new Date('2026-08-28T15:25:00'))
    expect(JSON.parse(m.checkpointsJson!)).toHaveLength(2)
  })

  it('handles a pending shipment with no checkpoints / no last-mile', () => {
    const m = mapParcelPanelShipment({ status: 'PENDING', carrier: { name: 'Cainiao', code: 'cainiao' } })
    expect(m.status).toBe('PENDING')
    expect(m.detectedCarrier).toBe('Cainiao')
    expect(m.lastMileCarrier).toBeNull()
    expect(m.checkpointsJson).toBeNull()
    expect(m.lastCheckpointAt).toBeNull()
  })

  it('defaults missing status to PENDING and uppercases', () => {
    expect(mapParcelPanelShipment({}).status).toBe('PENDING')
    expect(mapParcelPanelShipment({ status: 'delivered' }).status).toBe('DELIVERED')
  })
})
