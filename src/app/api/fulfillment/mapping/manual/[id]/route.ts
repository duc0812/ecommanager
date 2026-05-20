import { NextRequest, NextResponse } from 'next/server'
import { deleteManualMapping } from '@/lib/repos/mapping'

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await deleteManualMapping(params.id)
  return NextResponse.json({ ok: true })
}
