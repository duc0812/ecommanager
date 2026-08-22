import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { runStoreProductScan, runStoreBestSellerScan } from '@/lib/spy/scan-runner'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const stores = body.storeId
    ? await prisma.spyStore.findMany({ where: { id: body.storeId } })
    : await prisma.spyStore.findMany({ where: { status: 'active' } })
  if (stores.length === 0) return NextResponse.json({ error: 'No stores to scan' }, { status: 404 })
  const results = []
  for (const s of stores) {
    const r = await runStoreProductScan(s)
    await runStoreBestSellerScan(s)
    results.push({ store: s.domain, ...r })
  }
  return NextResponse.json({ results })
}
