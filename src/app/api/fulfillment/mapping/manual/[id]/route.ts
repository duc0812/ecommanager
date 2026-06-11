import { NextRequest, NextResponse } from 'next/server'
import { deleteManualMapping } from '@/lib/repos/mapping'
import { recalculateMissingOrderLineCosts } from '@/lib/repos/order-costs'

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await deleteManualMapping(params.id)
  const refresh = await recalculateMissingOrderLineCosts({ refreshExisting: true })
  return NextResponse.json({ ok: true, refresh })
}
