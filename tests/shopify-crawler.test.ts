import { describe, expect, it } from 'vitest'
import { buildShopifyProductCsv, mapCrawledVariants, productUrlToJsonEndpoint, type ShopifyCrawlerProduct } from '@/lib/shopify-crawler'
import type { SupplierProductCandidate } from '@/lib/auto-mapping'

const product: ShopifyCrawlerProduct = {
  id: 1,
  title: 'POMo Gift Hawaiian Shirt',
  handle: 'pomo-gift-hawaiian-shirt',
  vendor: 'POMo',
  product_type: 'Fit Hawaii Shirt',
  tags: ['3D', 'POD'],
  variants: [
    { id: 11, option1: 'S', price: '29.99' },
    { id: 12, option1: 'XL', price: '31.99' },
  ],
  options: [{ name: 'Size' }],
  images: [{ id: 1, src: 'https://cdn.example/image.jpg', variant_ids: [] }],
}

const candidates: SupplierProductCandidate[] = [
  {
    sku: 'PHS2VN000000AA01',
    supplierId: 'sup',
    supplierName: 'Merchize',
    supplierCode: 'merchize',
    supplierPreferenceRank: 1,
    baseCost: 18,
    firstItemShipFee: 0,
    additionalItemShipFee: 0,
    productType: 'Fit Hawaii Shirt',
    printingMethod: '3D AOP',
    sizeLabel: 'S',
  },
  {
    sku: 'PHS2VN000000AA04',
    supplierId: 'sup',
    supplierName: 'Merchize',
    supplierCode: 'merchize',
    supplierPreferenceRank: 1,
    baseCost: 18,
    firstItemShipFee: 0,
    additionalItemShipFee: 0,
    productType: 'Fit Hawaii Shirt',
    printingMethod: '3D AOP',
    sizeLabel: 'XL',
  },
]

describe('shopify crawler', () => {
  it('builds json endpoint from public product URL', () => {
    expect(productUrlToJsonEndpoint('https://store.test/products/abc?variant=1')).toBe('https://store.test/products/abc.json')
  })

  it('maps crawled variants to supplier SKUs and keeps generated design SKUs separate', () => {
    const mappings = mapCrawledVariants(product, candidates, 'DESIGN-POMO')
    expect(mappings[0].designSku).toBe('DESIGN-POMO-S')
    expect(mappings[0].supplierSku).toBe('PHS2VN000000AA01')
    expect(mappings[1].designSku).toBe('DESIGN-POMO-XL')
    expect(mappings[1].supplierSku).toBe('PHS2VN000000AA04')
  })

  it('exports Shopify CSV with design SKU as Variant SKU and mapped base cost', () => {
    const mappings = mapCrawledVariants(product, candidates, 'DESIGN-POMO')
    const csv = buildShopifyProductCsv(product, mappings, 'draft')
    expect(csv).toContain('DESIGN-POMO-S')
    expect(csv).toContain('DESIGN-POMO-XL')
    expect(csv).toContain(',18,')
    expect(csv).toContain('draft')
  })
})
