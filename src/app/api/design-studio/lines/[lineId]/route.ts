import { NextRequest, NextResponse } from 'next/server'
import { updateLine } from '@/lib/design-studio'

export async function PATCH(req: NextRequest, { params }: { params: { lineId: string } }) {
  const body = await req.json().catch(() => ({} as any))
  const patch: { note?: string | null; done?: boolean } = {}
  if (body.note !== undefined) patch.note = body.note === null ? null : String(body.note)
  if (typeof body.done === 'boolean') patch.done = body.done
  if (patch.note === undefined && patch.done === undefined) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }
  try {
    const r = await updateLine(params.lineId, patch)
    if (!r) return NextResponse.json({ error: 'Line not found' }, { status: 404 })
    return NextResponse.json(r)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }
}
