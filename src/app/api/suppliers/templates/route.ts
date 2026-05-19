import { NextRequest, NextResponse } from 'next/server'
import { createTemplate, ensureStandardSupplierTemplate, listTemplates } from '@/lib/repos/templates'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const supplierId = searchParams.get('supplierId') ?? undefined
  const ensureDefault = searchParams.get('ensureDefault') === '1'
  if (supplierId && ensureDefault) {
    await ensureStandardSupplierTemplate(supplierId)
  }
  const templates = await listTemplates(supplierId)
  return NextResponse.json({ templates })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body.supplierId || !body.name || !Array.isArray(body.columns) || !body.rowMode) {
    return NextResponse.json({ error: 'supplierId, name, columns[], rowMode required' }, { status: 400 })
  }
  if (body.rowMode !== 'PER_LINE' && body.rowMode !== 'PER_ORDER') {
    return NextResponse.json({ error: 'rowMode must be PER_LINE or PER_ORDER' }, { status: 400 })
  }
  const t = await createTemplate(body)
  return NextResponse.json(t, { status: 201 })
}
