import { NextRequest, NextResponse } from 'next/server'
import {
  bulkUpsertProducts, countProducts, listProducts, upsertProductMapping,
} from '@/lib/repos/suppliers'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const supplierId = searchParams.get('supplierId') ?? undefined
  const search = searchParams.get('search') ?? undefined
  const limit = parseInt(searchParams.get('limit') ?? '200', 10)
  const offset = parseInt(searchParams.get('offset') ?? '0', 10)
  const [products, total] = await Promise.all([
    listProducts({ supplierId, search, limit, offset }),
    countProducts({ supplierId, search }),
  ])
  return NextResponse.json({ products, total })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body.supplierId || !body.sku || !Number.isFinite(body.baseCost)) {
    return NextResponse.json({ error: 'supplierId, sku, baseCost required' }, { status: 400 })
  }
  const p = await upsertProductMapping(body)
  return NextResponse.json(p, { status: 201 })
}

export async function PUT(req: NextRequest) {
  const body = await req.json()
  if (!body.supplierId || !Array.isArray(body.rows)) {
    return NextResponse.json({ error: 'supplierId + rows array required' }, { status: 400 })
  }
  const result = await bulkUpsertProducts(body.supplierId, body.rows)
  return NextResponse.json(result)
}
