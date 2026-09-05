import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { computeSupplierPerformance, type PerfShipment } from '@/lib/fulfillment/supplier-performance'

// Supplier delivery-time stats over shipments DELIVERED in the last `days` (default 30).
export async function GET(req: NextRequest) {
  const daysRaw = Number(req.nextUrl.searchParams.get('days'))
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, Math.floor(daysRaw)) : 30
  const since = new Date(Date.now() - days * 86_400_000)

  const rows = await prisma.shipment.findMany({
    where: { status: 'DELIVERED', lastCheckpointAt: { gte: since } },
    select: {
      supplierId: true,
      supplier: { select: { name: true } },
      checkpointsJson: true,
      ppTimingJson: true,
      lastCheckpointAt: true,
      order: { select: { placedAt: true } },
    },
  })

  const shipments: PerfShipment[] = rows.map(s => ({
    supplierId: s.supplierId,
    supplierName: s.supplier?.name ?? 'Chưa gán supplier',
    placedAt: s.order?.placedAt ?? null,
    deliveredAt: s.lastCheckpointAt ?? null,
    checkpointsJson: s.checkpointsJson,
    ppTimingJson: s.ppTimingJson,
  }))

  return NextResponse.json(computeSupplierPerformance(shipments, days))
}
