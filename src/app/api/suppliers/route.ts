import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { createSupplier, listAllSuppliers } from '@/lib/repos/suppliers'

// A seller reads the list only to filter orders by supplier (id, name; code on the CSV Export page), and the owner keeps
// supplier set-up away from staff, so a seller gets those three fields and nothing else.
export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const { searchParams } = new URL(req.url)
  const includeInactive = searchParams.get('includeInactive') === '1'
  const suppliers = await listAllSuppliers({ includeInactive })
  if (auth.user.role === 'SELLER') return NextResponse.json({ suppliers: suppliers.map(({ id, name, code }) => ({ id, name, code })) })
  return NextResponse.json({ suppliers })
}

export async function POST(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
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
