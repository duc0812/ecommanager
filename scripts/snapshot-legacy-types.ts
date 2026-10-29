// Record, for every Shopify product that has orders, the product_type its mapping uses today (ProductLegacyType), before
// the shop renames product_types to the standard list. Only adds rows that do not exist yet; never overwrites.
//
//   DATABASE_URL=… npx tsx scripts/snapshot-legacy-types.ts            # dry run
//   DATABASE_URL=… npx tsx scripts/snapshot-legacy-types.ts --apply
import { prisma } from '@/lib/db'

async function main() {
  const apply = process.argv.includes('--apply')
  const lines = await prisma.orderLine.findMany({
    where: { shopifyProductId: { not: null }, shopifyProductType: { not: null } },
    select: { shopifyProductId: true, shopifyProductType: true, order: { select: { storeId: true, placedAt: true } } },
  })
  // the product_type of the product's latest order is the one its mapping uses now
  const latest = new Map<string, { storeId: string; shopifyProductId: string; productType: string; at: Date }>()
  for (const l of lines) {
    const type = l.shopifyProductType!.trim()
    if (!type) continue
    const key = `${l.order.storeId}|${l.shopifyProductId}`
    const cur = latest.get(key)
    if (!cur || l.order.placedAt > cur.at) latest.set(key, { storeId: l.order.storeId, shopifyProductId: l.shopifyProductId!, productType: type, at: l.order.placedAt })
  }
  const existing = new Set((await prisma.productLegacyType.findMany({ select: { storeId: true, shopifyProductId: true } })).map(r => `${r.storeId}|${r.shopifyProductId}`))
  const todo = Array.from(latest.entries()).filter(([k]) => !existing.has(k)).map(([, v]) => v)
  const byType = new Map<string, number>()
  for (const t of todo) byType.set(t.productType, (byType.get(t.productType) ?? 0) + 1)
  console.log(`${latest.size} product(s) with orders; ${existing.size} already recorded; ${todo.length} to add`)
  for (const [t, n] of Array.from(byType.entries()).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${n}\t${t}`)
  if (!apply) { console.log('dry run — add --apply'); return }
  for (let i = 0; i < todo.length; i += 200) {
    await prisma.productLegacyType.createMany({ data: todo.slice(i, i + 200).map(({ storeId, shopifyProductId, productType }) => ({ storeId, shopifyProductId, productType })) })
  }
  console.log(`added ${todo.length}`)
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
