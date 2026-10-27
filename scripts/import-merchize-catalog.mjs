// Imports one Merchize catalogue blank as supplier products (one row per colour × size, the Merchize variant SKU as
// both sku and apiSku) and optionally its print template. Dry run by default; --apply writes.
//
//   node scripts/import-merchize-catalog.mjs --sku 5000US --colors "Black,Light Blue" \
//     --template "Merchize Gildan 5000US (front)" --size 4200x4800 --dpi 300 --areas Front [--method DTF] [--apply]
//
// Reads MERCHIZE_API_URL / MERCHIZE_API_TOKEN and DATABASE_URL from the environment.
import { createClient } from '@libsql/client'
import path from 'path'
import { randomUUID } from 'crypto'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const has = name => process.argv.includes(`--${name}`)

const parentSku = arg('sku')
const apply = has('apply')
const method = (arg('method', 'DTF') || 'DTF').toUpperCase()
const colourFilter = (arg('colors') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
const templateName = arg('template')
const sizeArg = arg('size')
const dpi = Number(arg('dpi', '300'))
const areaNames = (arg('areas', 'Front') || 'Front').split(',').map(s => s.trim()).filter(Boolean)
if (!parentSku) { console.error('--sku is required'); process.exit(1) }
if (templateName && !/^\d+x\d+$/.test(sizeArg || '')) { console.error('--template needs --size WxH'); process.exit(1) }

const apiUrl = process.env.MERCHIZE_API_URL?.trim().replace(/\/+$/, '')
const token = process.env.MERCHIZE_API_TOKEN?.trim()
if (!apiUrl || !token) { console.error('MERCHIZE_API_URL / MERCHIZE_API_TOKEN not set'); process.exit(1) }

const res = await fetch(`${apiUrl}/product/catalog?limit=50&page=1&search=${encodeURIComponent(parentSku)}`, { headers: { Authorization: `Bearer ${token}` } })
const json = await res.json()
const product = (json?.data?.products ?? []).find(p => p.sku === parentSku)
if (!product) { console.error(`Merchize catalogue has no ${parentSku}`); process.exit(1) }

const tierName = `${method.toLowerCase()}_tier1`
function priceOf(v) {
  const tiers = v.tiers ?? []
  return tiers.find(t => t.name === tierName)?.price ?? tiers.find(t => t.name === 'tier1')?.price ?? null
}
function attr(v, type) {
  return (v.attributes ?? []).find(a => a.type === type || a.name === type)?.value_text ?? null
}
function shippingOf(v) {
  const out = {}
  for (const s of v.shipping_prices ?? []) {
    if (s.to_country !== 'all' || s.first_item_price == null) continue
    out[s.to_zone] = { first: s.first_item_price, additional: s.additional_item_price ?? 0 }
  }
  return out
}

const variants = product.variants.filter(v => {
  if (colourFilter.length === 0) return true
  return colourFilter.includes((attr(v, 'color') ?? '').toLowerCase())
})
const missingColours = colourFilter.filter(c => !product.variants.some(v => (attr(v, 'color') ?? '').toLowerCase() === c))
console.log(`${product.sku} — ${product.title} (${product.fulfillment_location?.code ?? '?'}), ${variants.length} variants, method ${method}`)
if (missingColours.length) console.log(`  colours Merchize does not sell: ${missingColours.join(', ')}`)

const url = process.env.DATABASE_URL?.trim() || `file:${path.resolve(process.cwd(), 'dev.db')}`
const db = createClient({ url })
const supplier = (await db.execute({ sql: `SELECT id, name FROM "Supplier" WHERE lower(code) = 'merchize' LIMIT 1`, args: [] })).rows[0]
if (!supplier) { console.error('No supplier with code "merchize" in this DB'); process.exit(1) }
const now = new Date().toISOString()

let templateId = null
if (templateName) {
  const [w, h] = sizeArg.split('x').map(Number)
  const areas = areaNames.map(name => ({ name, x: 0, y: 0, w, h }))
  const existing = (await db.execute({ sql: `SELECT id FROM "PrintTemplate" WHERE supplierId = ? AND supplierSku = ?`, args: [supplier.id, parentSku] })).rows[0]
  templateId = existing?.id ?? randomUUID()
  console.log(`  template ${existing ? 'update' : 'create'}: ${templateName} ${w}x${h} @${dpi}, areas ${areaNames.join(', ')}`)
  if (apply) {
    if (existing) {
      await db.execute({
        sql: `UPDATE "PrintTemplate" SET name = ?, widthPx = ?, heightPx = ?, dpi = ?, areas = ?, templateUrl = ?, updatedAt = ? WHERE id = ?`,
        args: [templateName, w, h, dpi, JSON.stringify(areas), product.mockup_and_templates_link, now, templateId],
      })
    } else {
      await db.execute({
        sql: `INSERT INTO "PrintTemplate" (id, supplierId, supplierSku, name, widthPx, heightPx, dpi, bleedIn, safeIn, mirror, areas, templateUrl, createdAt, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?)`,
        args: [templateId, supplier.id, parentSku, templateName, w, h, dpi, JSON.stringify(areas), product.mockup_and_templates_link, now, now],
      })
    }
  }
}

let created = 0
let updated = 0
for (const v of variants) {
  const price = priceOf(v)
  if (price == null) { console.log(`  skip ${v.sku}: no ${tierName} price`); continue }
  const size = attr(v, 'size')
  const colour = attr(v, 'color')
  const row = {
    sku: v.sku, apiSku: v.sku, baseSku: product.sku, productName: product.title, productType: 'Merchize blank',
    variant1Name: 'Size', variant1Value: size, variant2Name: colour ? 'Color' : null, variant2Value: colour,
    baseCost: price, shippingByRegion: JSON.stringify(shippingOf(v)), designTemplateUrl: product.mockup_and_templates_link,
    minProductionDays: product.production_time?.min ?? null, maxProductionDays: product.production_time?.max ?? null,
  }
  const existing = (await db.execute({ sql: `SELECT id FROM "SupplierProduct" WHERE supplierId = ? AND sku = ?`, args: [supplier.id, v.sku] })).rows[0]
  if (existing) updated++
  else created++
  if (!apply) continue
  if (existing) {
    await db.execute({
      sql: `UPDATE "SupplierProduct" SET apiSku = ?, baseSku = ?, productName = ?, productType = ?, variant1Name = ?, variant1Value = ?,
            variant2Name = ?, variant2Value = ?, baseCost = ?, shippingByRegion = ?, designTemplateUrl = ?, minProductionDays = ?,
            maxProductionDays = ?, printTemplateId = COALESCE(?, printTemplateId), updatedAt = ? WHERE id = ?`,
      args: [row.apiSku, row.baseSku, row.productName, row.productType, row.variant1Name, row.variant1Value, row.variant2Name, row.variant2Value,
        row.baseCost, row.shippingByRegion, row.designTemplateUrl, row.minProductionDays, row.maxProductionDays, templateId, now, existing.id],
    })
  } else {
    await db.execute({
      sql: `INSERT INTO "SupplierProduct" (id, supplierId, sku, apiSku, baseSku, productName, productType, variant1Name, variant1Value,
            variant2Name, variant2Value, baseCost, currency, requiresDesign, shippingByRegion, designTemplateUrl, minProductionDays,
            maxProductionDays, printTemplateId, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', 1, ?, ?, ?, ?, ?, ?, ?)`,
      args: [randomUUID().replace(/-/g, '').slice(0, 25), supplier.id, row.sku, row.apiSku, row.baseSku, row.productName, row.productType,
        row.variant1Name, row.variant1Value, row.variant2Name, row.variant2Value, row.baseCost, row.shippingByRegion, row.designTemplateUrl,
        row.minProductionDays, row.maxProductionDays, templateId, now, now],
    })
  }
}
const sample = variants.find(v => priceOf(v) != null)
if (sample) console.log(`  e.g. ${sample.sku} ${attr(sample, 'color')} / ${attr(sample, 'size')}: $${priceOf(sample)} + ship ${JSON.stringify(shippingOf(sample))}`)
console.log(`${apply ? 'Wrote' : 'Would write'}: ${created} new, ${updated} updated supplier products${apply ? '' : ' (dry run — add --apply)'}`)
