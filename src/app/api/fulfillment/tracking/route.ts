import { NextRequest, NextResponse } from 'next/server'
import { listShipments } from '@/lib/repos/shipments'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get('projectId') || undefined
  const supplierId = searchParams.get('supplierId') || undefined
  const search = searchParams.get('search')?.trim() || undefined
  const trackingParam = searchParams.get('hasTracking')
  const hasTracking = trackingParam === 'yes' ? true : trackingParam === 'no' ? false : undefined

  const shipments = await listShipments({ projectId, supplierId, search, hasTracking })

  const total = shipments.length
  const withTracking = shipments.filter(s => s.trackingNumber).length
  const internallyTracked = shipments.filter(s => s.internalStatus).length
  return NextResponse.json({
    shipments,
    stats: {
      total,
      withTracking,
      withoutTracking: total - withTracking,
      internallyTracked,
      internalDelivered: shipments.filter(s => s.internalStatus === 'DELIVERED').length,
    },
  })
}
