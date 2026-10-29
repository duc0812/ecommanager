// Rename the Shopify product_type of every product whose type is an old spelling of one standard type (ProductType),
// one standard type per run. Before each product changes, the type it had is written to ProductLegacyType, so its
// orders keep mapping exactly as before. A type held back by seed-product-types.ts (no aliases yet) is refused.
//
//   DATABASE_URL=… npx tsx scripts/rename-shopify-product-types.ts --type "Tumbler"            # dry run: list products
//   DATABASE_URL=… npx tsx scripts/rename-shopify-product-types.ts --type "Tumbler" --apply
import { prisma } from '@/lib/db'
import { getShopifyConnection } from '@/lib/token-store'
import { typeKey } from '@/lib/product-mapping'

const API = '2024-10'

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}

async function gql(shop: string, token: string, query: string, variables: Record<string, unknown>) {
  const res = await fetch(`https://${shop}/admin/api/${API}/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors).slice(0, 300)}`)
  return json.data
}

async function main() {
  const name = arg('type')
  const apply = process.argv.includes('--apply')
  if (!name) throw new Error('--type "<standard type>" is required')
  const type = await prisma.productType.findUnique({ where: { name } })
  if (!type) throw new Error(`No ProductType "${name}"`)
  const aliases: string[] = JSON.parse(type.aliases || '[]')
  if (aliases.length === 0) throw new Error(`"${name}" is held back (no aliases): its mapping groups must be cleaned up first`)
  const conn = await getShopifyConnection()
  if (!conn) throw new Error('Shopify not connected')
  const store = await prisma.shopifyStore.findUnique({ where: { shop: conn.shop }, select: { id: true } })
  if (!store) throw new Error(`No ShopifyStore ${conn.shop}`)

  const olds = aliases.filter(a => typeKey(a) !== typeKey(name))
  const products: Array<{ id: string; title: string; productType: string; status: string }> = []
  for (const old of olds) {
    let after: string | null = null
    do {
      const data = await gql(conn.shop, conn.token, `query($q: String!, $after: String) { products(first: 100, after: $after, query: $q) { nodes { id title productType status } pageInfo { hasNextPage endCursor } } }`,
        { q: `product_type:"${old.replace(/"/g, '\\"')}"`, after })
      // the search is fuzzy: keep exact spellings only (case and spaces aside)
      for (const p of data.products.nodes) if (typeKey(p.productType) === typeKey(old)) products.push(p)
      after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null
    } while (after)
  }
  console.log(`${name}: ${products.length} product(s) to rename from ${olds.map(o => `"${o}"`).join(', ') || '(no other spelling)'}`)
  for (const p of products) console.log(`  ${p.status.padEnd(8)} ${p.productType.padEnd(28)} ${p.title.slice(0, 80)}  ${p.id}`)
  if (!apply) { console.log('dry run — add --apply'); return }

  let done = 0
  for (const p of products) {
    await prisma.productLegacyType.upsert({
      where: { storeId_shopifyProductId: { storeId: store.id, shopifyProductId: p.id } },
      create: { storeId: store.id, shopifyProductId: p.id, productType: p.productType }, update: {},
    })
    const data = await gql(conn.shop, conn.token, `mutation($input: ProductInput!) { productUpdate(input: $input) { product { id productType } userErrors { field message } } }`,
      { input: { id: p.id, productType: name } })
    const errs = data.productUpdate.userErrors
    if (errs.length) { console.log(`  ! ${p.id}: ${JSON.stringify(errs)}`); continue }
    done++
    await new Promise(r => setTimeout(r, 400))
  }
  console.log(`renamed ${done} of ${products.length} to "${name}"`)
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
