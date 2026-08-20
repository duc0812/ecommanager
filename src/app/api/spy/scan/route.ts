import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { runStoreProductScan } from '@/lib/spy/scan-runner'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const stores = body.storeId
    ? await prisma.spyStore.findMany({ where: { id: body.storeId } })
    : await prisma.spyStore.findMany({ where: { status: 'active' } })
  if (stores.length === 0) return NextResponse.json({ error: 'No stores to scan' }, { status: 404 })
  const results = []
  for (const s of stores) results.push({ store: s.domain, ...(await runStoreProductScan(s)) })
  return NextResponse.json({ results })
}
