import { NextRequest, NextResponse } from 'next/server'
import { deleteDesignEntry } from '@/lib/repos/design-library'

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await deleteDesignEntry(params.id)
  return NextResponse.json({ ok: true })
}
