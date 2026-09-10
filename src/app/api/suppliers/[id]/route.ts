import { NextRequest, NextResponse } from 'next/server'
import { deactivateSupplier, getSupplierById, updateSupplier } from '@/lib/repos/suppliers'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const sup = await getSupplierById(params.id)
  if (!sup) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(sup)
}

const UPDATABLE_FIELDS = ['name', 'code', 'apiType', 'apiKey', 'firstItemShipFee', 'additionalItemShipFee', 'currency', 'preferenceRank', 'note', 'isActive'] as const

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  const input: Record<string, unknown> = {}
  for (const key of UPDATABLE_FIELDS) if (key in body) input[key] = body[key]
  try {
    const sup = await updateSupplier(params.id, input as any)
    return NextResponse.json(sup)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await deactivateSupplier(params.id)
  return NextResponse.json({ ok: true })
}
