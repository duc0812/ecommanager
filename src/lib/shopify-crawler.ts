import { resolveSupplierForOrderLine, type MappingResult, type SupplierProductCandidate } from '@/lib/auto-mapping'

export const SHOPIFY_PRODUCT_CSV_COLUMNS = [
  'Handle', 'Title', 'Body (HTML)', 'Vendor', 'Product Category', 'Type', 'Tags',
  'Published',
  'Option1 Name', 'Option1 Value',
  'Option2 Name', 'Option2 Value',
  'Option3 Name', 'Option3 Value',
  'Variant SKU', 'Variant Grams', 'Variant Inventory Tracker',
  'Variant Inventory Qty', 'Variant Inventory Policy',
  'Variant Fulfillment Service', 'Variant Price', 'Variant Compare At Price',
  'Variant Requires Shipping', 'Variant Taxable', 'Variant Barcode',
  'Image Src', 'Image Position', 'Image Alt Text', 'Gift Card',
  'SEO Title', 'SEO Description',
  'Google Shopping / Google Product Category', 'Google Shopping / Gender',
  'Google Shopping / Age Group', 'Google Shopping / MPN',
  'Google Shopping / Condition', 'Google Shopping / Custom Product',
  'Variant Image', 'Variant Weight Unit', 'Variant Tax Code', 'Cost per item',
  'Included / United States', 'Price / United States',
  'Compare At Price / United States',
  'Included / International', 'Price / International',
  'Compare At Price / International',
  'Status',
]

export type ShopifyCrawlerProduct = {
  id: number
  title: string
  handle: string
  body_html?: string
  vendor?: string
  product_type?: string
  tags?: string[] | string
  published_at?: string | null
  options?: Array<{ name: string }>
  variants?: ShopifyCrawlerVariant[]
  images?: Array<{ id: number; src: string; alt?: string | null; variant_ids?: number[] }>
}

export type ShopifyCrawlerVariant = {
  id: number
  title?: string
  sku?: string
  price?: string
  compare_at_price?: string | null
  grams?: number
  barcode?: string | null
  taxable?: boolean
  requires_shipping?: boolean
  weight_unit?: string
  option1?: string | null
  option2?: string | null
  option3?: string | null
}

export type CrawledVariantMapping = {
  variantId: number
  optionValues: string[]
  variantTitle: string
  designSku: string
  supplierSku: string | null
  supplierId: string | null
  supplierName: string | null
  baseCost: number | null
  score: number
  reasons: string[]
}

export function productUrlToJsonEndpoint(url: string) {
  const parsed = new URL(url.trim().split('?')[0])
  const path = parsed.pathname.replace(/\/$/, '')
  parsed.pathname = path.endsWith('.json') ? path : `${path}.json`
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

export async function fetchPublicShopifyProduct(url: string): Promise<ShopifyCrawlerProduct> {
  const res = await fetch(productUrlToJsonEndpoint(url), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; EcomManagerShopifyCrawler/1.0)',
      'Accept': 'application/json',
    },
  })
  if (!res.ok) throw new Error(`Shopify product fetch failed ${res.status}: ${await res.text()}`)
  const payload = await res.json()
  if (!payload?.product) throw new Error('Response missing product key. Check that this is a public Shopify product URL.')
  return payload.product
}

function slugify(value: string | null | undefined) {
  return (value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function tagsArray(product: ShopifyCrawlerProduct): string[] {
  const tags = product.tags
  if (Array.isArray(tags)) return tags
  if (typeof tags === 'string') return tags.split(',').map(t => t.trim()).filter(Boolean)
  return []
}

function optionNames(product: ShopifyCrawlerProduct): string[] {
  return (product.options ?? []).map(o => o.name).filter(Boolean)
}

function variantOptionValues(variant: ShopifyCrawlerVariant) {
  return [variant.option1, variant.option2, variant.option3].filter((v): v is string => !!v)
}

export function buildDesignSku(product: ShopifyCrawlerProduct, variant: ShopifyCrawlerVariant, index: number, prefix?: string) {
  const base = slugify(prefix || product.handle || product.title || 'DESIGN')
  const optionPart = variantOptionValues(variant).map(slugify).filter(Boolean).join('-')
  const suffix = optionPart || String(index + 1).padStart(3, '0')
  return `${base}-${suffix}`.replace(/-+/g, '-')
}

export function mapCrawledVariants(
  product: ShopifyCrawlerProduct,
  candidates: SupplierProductCandidate[],
  skuPrefix?: string,
): CrawledVariantMapping[] {
  const tags = tagsArray(product)
  const variants = product.variants ?? []
  return variants.map((variant, index) => {
    const optionValues = variantOptionValues(variant)
    const variantTitle = optionValues.join(' / ') || variant.title || ''
    const mapping: MappingResult = resolveSupplierForOrderLine({
      sku: null,
      title: product.title,
      variantTitle,
      productTags: tags,
      productType: product.product_type ?? null,
    }, candidates)
    return {
      variantId: variant.id,
      optionValues,
      variantTitle,
      designSku: buildDesignSku(product, variant, index, skuPrefix),
      supplierSku: mapping.supplier?.sku ?? null,
      supplierId: mapping.supplier?.supplierId ?? null,
      supplierName: mapping.supplier?.supplierName ?? null,
      baseCost: mapping.supplier?.baseCost ?? null,
      score: mapping.score,
      reasons: mapping.reasons,
    }
  })
}

function emptyCsvRow(): Record<string, string> {
  return Object.fromEntries(SHOPIFY_PRODUCT_CSV_COLUMNS.map(c => [c, '']))
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

export function buildShopifyProductCsv(
  product: ShopifyCrawlerProduct,
  mappings: CrawledVariantMapping[],
  status: 'draft' | 'active' | 'archived' = 'draft',
): string {
  const rows: Record<string, string>[] = []
  const names = optionNames(product)
  const variants = product.variants ?? []
  const images = product.images ?? []
  const variantImage = new Map<number, string>()
  for (const img of images) {
    for (const variantId of img.variant_ids ?? []) variantImage.set(variantId, img.src)
  }
  const mappingByVariant = new Map(mappings.map(m => [m.variantId, m]))
  const tags = tagsArray(product).join(', ')
  const firstImage = images[0]

  variants.forEach((variant, index) => {
    const row = emptyCsvRow()
    const mapping = mappingByVariant.get(variant.id)
    row.Handle = product.handle
    if (index === 0) {
      row.Title = product.title
      row['Body (HTML)'] = product.body_html ?? ''
      row.Vendor = product.vendor ?? ''
      row.Type = product.product_type ?? ''
      row.Tags = tags
      row.Published = product.published_at ? 'TRUE' : 'FALSE'
      row['SEO Title'] = product.title
      row['SEO Description'] = stripHtml(product.body_html ?? '').slice(0, 160)
      row['Image Src'] = firstImage?.src ?? ''
      row['Image Position'] = firstImage ? '1' : ''
      row['Image Alt Text'] = firstImage?.alt ?? product.title
      row['Gift Card'] = 'FALSE'
      row.Status = status
    }
    names.slice(0, 3).forEach((name, optIndex) => {
      row[`Option${optIndex + 1} Name`] = name
      row[`Option${optIndex + 1} Value`] = String((variant as any)[`option${optIndex + 1}`] ?? '')
    })
    row['Variant SKU'] = mapping?.designSku ?? variant.sku ?? ''
    row['Variant Grams'] = String(variant.grams ?? 0)
    row['Variant Inventory Tracker'] = 'shopify'
    row['Variant Inventory Qty'] = '0'
    row['Variant Inventory Policy'] = 'deny'
    row['Variant Fulfillment Service'] = 'manual'
    row['Variant Price'] = String(variant.price ?? '0.00')
    row['Variant Compare At Price'] = String(variant.compare_at_price ?? '')
    row['Variant Requires Shipping'] = variant.requires_shipping === false ? 'FALSE' : 'TRUE'
    row['Variant Taxable'] = variant.taxable === false ? 'FALSE' : 'TRUE'
    row['Variant Barcode'] = variant.barcode ?? ''
    row['Variant Image'] = variantImage.get(variant.id) ?? ''
    row['Variant Weight Unit'] = variant.weight_unit ?? 'kg'
    row['Cost per item'] = mapping?.baseCost == null ? '' : String(mapping.baseCost)
    rows.push(row)
  })

  images.slice(1).forEach((img, index) => {
    const row = emptyCsvRow()
    row.Handle = product.handle
    row['Image Src'] = img.src
    row['Image Position'] = String(index + 2)
    row['Image Alt Text'] = img.alt ?? `${product.title} - image ${index + 2}`
    rows.push(row)
  })

  return rowsToCsv(rows)
}

function csvEscape(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function rowsToCsv(rows: Record<string, string>[]) {
  const lines = [SHOPIFY_PRODUCT_CSV_COLUMNS.join(',')]
  for (const row of rows) {
    lines.push(SHOPIFY_PRODUCT_CSV_COLUMNS.map(col => csvEscape(row[col] ?? '')).join(','))
  }
  return lines.join('\n')
}
