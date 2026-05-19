import { NextRequest, NextResponse } from 'next/server'
import { createSupplier, listAllSuppliers } from '@/lib/repos/suppliers'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const includeInactive = searchParams.get('includeInactive') === '1'
  const suppliers = await listAllSuppliers({ includeInactive })
  return NextResponse.json({ suppliers })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body.name || !body.code) {
    return NextResponse.json({ error: 'name and code are required' }, { status: 400 })
  }
  try {
    const sup = await createSupplier(body)
    return NextResponse.json(sup, { status: 201 })
  } catch (e: any) {
    if (e.code === 'P2002') {
      return NextResponse.json({ error: `Supplier code "${body.code}" already exists` }, { status: 409 })
    }
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
