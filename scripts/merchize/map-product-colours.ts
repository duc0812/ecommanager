// One-off: maps a Shopify product's T-shirt style to a Merchize parent blank, one override row per colour Merchize sells,
// so colours it lacks keep falling through to the existing product-base mapping. Usage (from the repo root):
//   DATABASE_URL=file:./dev.db node scripts/merchize/run.cjs map-product-colours <storeId> <shopifyProductGid> <parentSku> <Option=Value> [--apply]
import { prisma } from '@/lib/db'
import { saveProfile } from '@/lib/repos/product-profiles'
import { toRouteKey } from '@/lib/product-profiles'

export async function main(args: string[]) {
  const [storeId, shopifyProductId, parentSku, styleArg] = args
  const apply = args.includes('--apply')
  const [styleKey, styleValue] = (styleArg ?? '').split('=')
  if (!storeId || !shopifyProductId || !parentSku || !styleKey || !styleValue) throw new Error('usage: <storeId> <productGid> <parentSku> <Option=Value> [--apply]')
  const supplier = await prisma.supplier.findFirstOrThrow({ where: { code: 'merchize' } })
  const blanks = await prisma.supplierProduct.findMany({ where: { supplierId: supplier.id, baseSku: parentSku }, select: { id: true, variant2Value: true } })
  const byColour = new Map<string, string>()
  for (const b of blanks) if (b.variant2Value && !byColour.has(b.variant2Value.toLowerCase())) byColour.set(b.variant2Value.toLowerCase(), b.id)
  const lines = await prisma.orderLine.findMany({ where: { shopifyProductId, order: { storeId } }, select: { variantOptions: true } })
  const colours = new Set<string>()
  for (const l of lines) {
    try { const o = JSON.parse(l.variantOptions ?? '{}'); if (o[styleKey] === styleValue && o.Color) colours.add(o.Color) } catch {}
  }
  const profile = await prisma.productProfile.findUnique({ where: { storeId_shopifyProductId: { storeId, shopifyProductId } } })
  const kept = profile ? JSON.parse(profile.overrides).filter((o: any) => o.combo?.[styleKey] !== styleValue) : []
  const extra = (args.find(a => a.startsWith('--colors=')) ?? '').slice('--colors='.length).split(',').map(s => s.trim()).filter(Boolean)
  for (const c of extra) colours.add(c)
  const rows: { combo: Record<string, string>; supplierProductId: string }[] = []
  const unmapped: string[] = []
  for (const c of Array.from(colours).sort()) {
    const id = byColour.get(c.toLowerCase())
    if (id) rows.push({ combo: { [styleKey]: styleValue, Color: c }, supplierProductId: id })
    else unmapped.push(c)
  }
  console.log(`override rows: ${rows.map(r => r.combo.Color).join(', ') || 'none'}`)
  if (unmapped.length) console.log(`no ${parentSku} colour for: ${unmapped.join(', ')} — these keep the current mapping`)
  if (!apply) { console.log('dry run — add --apply'); return }
  const res = await saveProfile(toRouteKey(storeId, shopifyProductId), { overrides: [...kept, ...rows] } as any)
  console.log('saved; reevaluation', JSON.stringify(res.reevaluation))
}
