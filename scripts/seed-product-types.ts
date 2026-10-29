// Load the standard listing types (tools/library/listing_types.json) into ProductType. A type's aliases are switched on
// only when merging its old product_type spellings changes no order line of the last 120 days (same supplier product,
// no new ambiguity) — checked here, line by line, before anything is written. Types that would change something keep an
// empty alias list and are listed: their bases have to be cleaned up first (plan 6.2, step 2). Re-run after each cleanup.
//
//   DATABASE_URL=… npx tsx scripts/seed-product-types.ts            # dry run
//   DATABASE_URL=… npx tsx scripts/seed-product-types.ts --apply
import fs from 'fs'
import path from 'path'
import { prisma } from '@/lib/db'
import { buildTypeAliases, profileKey, resolveByProductBase, typeKey } from '@/lib/product-mapping'
import { loadProductBasesForResolver, loadProductProfilesForResolver, loadVariantManualMappingsForResolver } from '@/lib/repos/mapping'
import { isNonProductLine } from '@/lib/order-lines'

type ListingType = { name: string; code: string; category: string; kind: string; aliases: string[] }

async function main() {
  const apply = process.argv.includes('--apply')
  const listing: { types: ListingType[] } = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tools/library/listing_types.json'), 'utf8'))
  const [bases, manual, profiles] = await Promise.all([loadProductBasesForResolver(), loadVariantManualMappingsForResolver(), loadProductProfilesForResolver()])
  const lines = (await prisma.orderLine.findMany({
    where: { order: { placedAt: { gte: new Date(Date.now() - 120 * 86400_000) } } },
    select: { sku: true, productTitle: true, shopifyProductType: true, shopifyVariantId: true, shopifyProductId: true, variantOptions: true, order: { select: { storeId: true, shippingCountry: true } } },
  })).filter(l => !isNonProductLine({ sku: l.sku, productTitle: l.productTitle, shopifyProductType: l.shopifyProductType }))

  const held: string[] = []
  for (const t of listing.types) {
    const aliases = buildTypeAliases([t])
    const members = new Set([typeKey(t.name), ...t.aliases.map(a => typeKey(a))])
    let changed = 0, ambiguous = 0, checked = 0
    for (const l of lines) {
      if (!l.shopifyProductType || !members.has(typeKey(l.shopifyProductType))) continue
      checked++
      let opts: Record<string, string> = {}
      try { opts = JSON.parse(l.variantOptions || '{}') } catch {}
      const prof = l.shopifyProductId ? profiles.get(profileKey(l.order.storeId, l.shopifyProductId)) ?? null : null
      const a = resolveByProductBase(l.shopifyVariantId, l.shopifyProductType, opts, bases, manual, prof, l.order.shippingCountry)
      const b = resolveByProductBase(l.shopifyVariantId, l.shopifyProductType, opts, bases, manual, prof, l.order.shippingCountry, aliases)
      if (a.supplierProductId !== b.supplierProductId && a.supplierProductId) changed++
      else if (!a.ambiguousBaseIds && b.ambiguousBaseIds) ambiguous++
    }
    const safe = changed === 0 && ambiguous === 0
    if (!safe) held.push(`${t.name}: ${changed} line(s) would change supplier, ${ambiguous} would become ambiguous (of ${checked})`)
    const data = { code: t.code, category: t.category, kind: t.kind, aliases: JSON.stringify(safe ? t.aliases : []) }
    console.log(`${safe ? 'ON  ' : 'HOLD'} ${t.name} (${t.code}) — ${checked} line(s)${safe ? `, ${t.aliases.length} alias(es)` : ''}`)
    if (apply) await prisma.productType.upsert({ where: { name: t.name }, create: { name: t.name, ...data }, update: data })
  }
  console.log(`\n${listing.types.length - held.length} type(s) with aliases on; held back ${held.length}:`)
  for (const h of held) console.log(`  - ${h}`)
  if (!apply) console.log('\ndry run — add --apply')
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
