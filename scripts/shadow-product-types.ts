// Shadow check before turning on standard product types (docs/superpowers/specs/2026-10-29-design-library-plan.md, 6.2):
// resolve every order line of the last N days twice — product_type as typed (today) and through the aliases of
// tools/library/listing_types.json — and list every line whose supplier product would change. Read-only.
//
//   DATABASE_URL=file:./db-backups/prod-YYYYMMDD.db npx tsx scripts/shadow-product-types.ts [--days 90]
import fs from 'fs'
import path from 'path'
import { prisma } from '@/lib/db'
import { buildTypeAliases, profileKey, resolveByProductBase } from '@/lib/product-mapping'
import { loadProductBasesForResolver, loadProductProfilesForResolver, loadVariantManualMappingsForResolver } from '@/lib/repos/mapping'
import { isNonProductLine } from '@/lib/order-lines'

function parseOptions(json: string | null): Record<string, string> {
  try { const v = JSON.parse(json || '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} }
}

async function main() {
  const days = Number(process.argv[process.argv.indexOf('--days') + 1]) || 90
  const listing = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tools/library/listing_types.json'), 'utf8'))
  const aliases = buildTypeAliases(listing.types)
  const [bases, manual, profiles] = await Promise.all([loadProductBasesForResolver(), loadVariantManualMappingsForResolver(), loadProductProfilesForResolver()])
  const since = new Date(Date.now() - days * 86400_000)
  const lines = await prisma.orderLine.findMany({
    where: { order: { placedAt: { gte: since } } },
    select: { sku: true, productTitle: true, shopifyProductType: true, shopifyVariantId: true, shopifyProductId: true, variantOptions: true,
      order: { select: { shopifyOrderNumber: true, storeId: true, shippingCountry: true } } },
  })
  const supplierSku = new Map((await prisma.supplierProduct.findMany({ select: { id: true, sku: true, supplier: { select: { code: true } } } })).map(p => [p.id, `${p.supplier.code}/${p.sku}`]))
  const out = { lines: lines.length, skippedNonProduct: 0, same: 0, newlyResolved: [] as string[], changed: [] as string[], lost: [] as string[], newlyAmbiguous: [] as string[] }
  for (const l of lines) {
    if (isNonProductLine({ sku: l.sku, productTitle: l.productTitle, shopifyProductType: l.shopifyProductType })) { out.skippedNonProduct++; continue }
    const opts = parseOptions(l.variantOptions)
    const profile = l.shopifyProductId ? profiles.get(profileKey(l.order.storeId, l.shopifyProductId)) ?? null : null
    const a = resolveByProductBase(l.shopifyVariantId, l.shopifyProductType, opts, bases, manual, profile, l.order.shippingCountry)
    const b = resolveByProductBase(l.shopifyVariantId, l.shopifyProductType, opts, bases, manual, profile, l.order.shippingCountry, aliases)
    const tag = `${l.order.shopifyOrderNumber} ${l.sku ?? ''} [${l.shopifyProductType ?? ''}] ${JSON.stringify(opts)}`
    if (a.supplierProductId === b.supplierProductId) {
      out.same++
      if (!a.ambiguousBaseIds && b.ambiguousBaseIds) out.newlyAmbiguous.push(`${tag} -> ${b.ambiguousBaseIds.length} bases`)
      continue
    }
    const name = (id: string | null) => (id ? supplierSku.get(id) ?? id : 'none')
    const msg = `${tag}: ${name(a.supplierProductId)} (${a.resolvedVia}) -> ${name(b.supplierProductId)} (${b.resolvedVia})`
    if (!a.supplierProductId) out.newlyResolved.push(msg)
    else if (!b.supplierProductId) out.lost.push(msg)
    else out.changed.push(msg)
  }
  console.log(JSON.stringify({ ...out, newlyResolved: out.newlyResolved.length, changed: out.changed.length, lost: out.lost.length, newlyAmbiguous: out.newlyAmbiguous.length }))
  for (const [k, list] of [['CHANGED', out.changed], ['LOST', out.lost], ['NEWLY RESOLVED', out.newlyResolved], ['NEWLY AMBIGUOUS', out.newlyAmbiguous]] as const) {
    if (!list.length) continue
    console.log(`\n## ${k} (${list.length})`)
    for (const m of list.slice(0, 60)) console.log(m)
  }
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
