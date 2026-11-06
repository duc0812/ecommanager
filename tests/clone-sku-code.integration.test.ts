import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { SKU_CODE_RE, isCodeTaken, issueSkuCode, makeShopifySkuExists, parseSkuPrefix, skuBelongsTo, skuCodeFor } from '@/lib/clone/sku-code'

const P = 'csk'
const SHOP = `${P}-shop.myshopify.com`
const PROJECT = `${P}-project`
const SUPPLIER = `${P}-supplier`
const TEMPLATE = `${P}-template`
const ORDER = `${P}-order`
const TOKEN = `${P}-secret-token-value`
const NOW = new Date('2026-11-05T03:00:00Z')
const code = (k: number) => `DC261105000${k}`

let storeId = ''

const noShopify = async () => false
const sequence = (...values: number[]) => {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

beforeAll(async () => {
  await prisma.project.create({ data: { id: PROJECT, name: 'Csk', startDate: new Date('2026-06-01') } })
  storeId = (await prisma.shopifyStore.create({
    data: { shop: SHOP, projectId: PROJECT, credential: { create: { authMode: 'TOKEN', accessToken: TOKEN } } },
  })).id
  await prisma.supplier.create({ data: { id: SUPPLIER, name: 'Csk Sup', code: 'CSKSUP' } })
  await prisma.printTemplate.create({
    data: { id: TEMPLATE, supplierId: SUPPLIER, name: 'Csk tpl', widthPx: 100, heightPx: 100, areas: '[]' },
  })
  await prisma.cloneJob.create({
    data: { storeId, sourceUrl: 'https://example.com/p', sourceKey: 'example.com/p', skuCode: code(1), requestedById: 'u1', requestedByName: 'U1' },
  })
  await prisma.order.create({
    data: {
      id: ORDER, projectId: PROJECT, storeId, shopifyOrderNumber: '#CSK1', financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, placedAt: NOW,
      lines: { create: [{ shopifyLineId: `${P}-l1`, sku: `${code(2)}-BLACK-XL`, productTitle: 'Tee', qty: 1, linePosition: 1, unitPrice: 1 }] },
    },
  })
  await prisma.skuSupplierDesign.create({ data: { sku: code(3), supplierId: SUPPLIER } })
  await prisma.skuDesign.create({ data: { sku: `${code(4)}-PARENT` } })
  await prisma.artworkEntry.create({
    data: { storeId, shopifyProductId: `${P}-p1`, printTemplateId: TEMPLATE, supplierId: SUPPLIER, title: `Mug ${code(5)} Gift` },
  })
  await prisma.productProfile.create({ data: { storeId, shopifyProductId: `${P}-p2`, title: `Mug ${code(6)} Personalized` } })
})

afterAll(async () => {
  await prisma.productProfile.deleteMany({ where: { storeId } })
  await prisma.artworkEntry.deleteMany({ where: { storeId } })
  await prisma.skuDesign.deleteMany({ where: { sku: { startsWith: code(4) } } })
  await prisma.skuSupplierDesign.deleteMany({ where: { supplierId: SUPPLIER } })
  await prisma.order.deleteMany({ where: { id: ORDER } })
  await prisma.cloneJob.deleteMany({ where: { storeId } })
  await prisma.printTemplate.deleteMany({ where: { id: TEMPLATE } })
  await prisma.supplier.deleteMany({ where: { id: SUPPLIER } })
  await prisma.shopifyStore.deleteMany({ where: { id: storeId } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
})

describe('skuCodeFor', () => {
  it('uses the Vietnam calendar date', () => {
    expect(skuCodeFor('DC', new Date('2026-11-05T18:30:00Z'), 7392)).toBe('DC2611067392')
    expect(skuCodeFor('DC', new Date('2026-11-05T03:00:00Z'), 5)).toBe('DC2611050005')
  })

  it('keeps the shape of SKU_CODE_RE', () => {
    expect(SKU_CODE_RE.test(skuCodeFor('AB', new Date('2027-01-01T00:00:00Z'), 0))).toBe(true)
    expect(SKU_CODE_RE.test('DC261105000')).toBe(false)
    expect(SKU_CODE_RE.test('dc2611050001')).toBe(false)
  })
})

describe('parseSkuPrefix', () => {
  it('accepts exactly two letters, trimmed and upper-cased', () => {
    expect(parseSkuPrefix(' dc ')).toBe('DC')
    expect(parseSkuPrefix('D1')).toBeNull()
    expect(parseSkuPrefix('DCA')).toBeNull()
    expect(parseSkuPrefix('D')).toBeNull()
    expect(parseSkuPrefix('')).toBeNull()
    expect(parseSkuPrefix('ßß')).toBeNull()
    expect(parseSkuPrefix(12)).toBeNull()
    expect(parseSkuPrefix(null)).toBeNull()
  })
})

describe('skuBelongsTo', () => {
  it('matches the code itself and its variant SKUs only', () => {
    expect(skuBelongsTo('DC2611057392', 'DC2611057392')).toBe(true)
    expect(skuBelongsTo('DC2611057392', 'DC2611057392-BLACK-XL')).toBe(true)
    expect(skuBelongsTo('DC2611057392', 'DC26110573920-BLACK')).toBe(false)
    expect(skuBelongsTo('DC2611057392', null)).toBe(false)
  })
})

describe('isCodeTaken', () => {
  const deps = { random: () => 0, shopifySkuExists: noShopify, storeIds: async () => [storeId] }

  it('finds a code in each table that can hold one', async () => {
    for (let k = 1; k <= 6; k++) expect(await isCodeTaken(code(k), deps), `place ${k}`).toBe(true)
  })

  it('finds a code that a connected store already has on a variant', async () => {
    const asked: [string, string][] = []
    const taken = await isCodeTaken(code(7), {
      ...deps,
      shopifySkuExists: async (id, c) => { asked.push([id, c]); return true },
    })
    expect(taken).toBe(true)
    expect(asked).toEqual([[storeId, code(7)]])
  })

  it('does not take a free code', async () => {
    expect(await isCodeTaken(code(8), deps)).toBe(false)
  })

  it('skips a store Shopify cannot be asked about and logs it', async () => {
    const logs: string[] = []
    const taken = await isCodeTaken(code(8), {
      ...deps,
      shopifySkuExists: async () => { throw new Error('boom') },
      log: m => logs.push(m),
    })
    expect(taken).toBe(false)
    expect(logs).toHaveLength(1)
  })
})

describe('issueSkuCode', () => {
  it('skips codes already used in the database tables and on Shopify', async () => {
    const asked: string[] = []
    const issued = await issueSkuCode('DC', NOW, {
      random: sequence(1, 2, 3, 4, 5, 6, 7, 8),
      storeIds: async () => [storeId],
      shopifySkuExists: async (_id, c) => { asked.push(c); return c === code(7) },
    })
    expect(issued).toBe(code(8))
    expect(asked).toEqual([code(7), code(8)])
  })

  it('still issues a code when a store cannot be asked, and logs once', async () => {
    const logs: string[] = []
    const issued = await issueSkuCode('DC', NOW, {
      random: () => 8,
      storeIds: async () => [storeId],
      shopifySkuExists: async () => { throw new Error('Shopify 500') },
      log: m => logs.push(m),
    })
    expect(issued).toBe(code(8))
    expect(logs).toHaveLength(1)
  })

  it('asks every connected store by default', async () => {
    const asked: string[] = []
    await issueSkuCode('DC', NOW, {
      random: () => 8,
      shopifySkuExists: async (id) => { asked.push(id); return false },
    })
    expect(asked).toContain(storeId)
  })

  it('gives up after 20 attempts', async () => {
    let calls = 0
    await expect(issueSkuCode('DC', NOW, {
      random: () => { calls++; return 1 },
      storeIds: async () => [storeId],
      shopifySkuExists: noShopify,
    })).rejects.toThrow('Không cấp được mã SKU, thử lại sau.')
    expect(calls).toBe(20)
  })

  it('draws numbers from crypto.randomInt by default', async () => {
    const issued = await issueSkuCode('DC', NOW, { storeIds: async () => [], shopifySkuExists: noShopify })
    expect(issued).toMatch(SKU_CODE_RE)
    expect(issued.startsWith('DC261105')).toBe(true)
  })
})

describe('makeShopifySkuExists', () => {
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const edges = (n: number) => ({ data: { productVariants: { edges: Array.from({ length: n }, (_, i) => ({ node: { id: `gid://shopify/ProductVariant/${i}` } })) } } })

  it('asks the store for variants whose SKU starts with the code', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const exists = makeShopifySkuExists({
      fetchImpl: async (url, init) => { seen.push({ url: String(url), init: init ?? {} }); return answer(edges(1)) },
    })
    expect(await exists(storeId, 'DC2611057392')).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe(`https://${SHOP}/admin/api/2024-10/graphql.json`)
    expect((seen[0].init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(TOKEN)
    const body = JSON.parse(String(seen[0].init.body))
    expect(body.query).toContain('productVariants(first: 1')
    expect(body.variables).toEqual({ q: 'sku:DC2611057392*' })
  })

  it('answers false when no variant matches', async () => {
    const exists = makeShopifySkuExists({ fetchImpl: async () => answer(edges(0)) })
    expect(await exists(storeId, 'DC2611057392')).toBe(false)
  })

  it('answers false and logs, without the token, when Shopify or the connection fails', async () => {
    const logs: string[] = []
    const log = (m: string) => logs.push(m)
    expect(await makeShopifySkuExists({ log, fetchImpl: async () => answer({ errors: 'no' }, 500) })(storeId, 'DC2611057392')).toBe(false)
    expect(await makeShopifySkuExists({ log, fetchImpl: async () => answer({ errors: [{ message: 'Throttled' }] }) })(storeId, 'DC2611057392')).toBe(false)
    expect(await makeShopifySkuExists({ log, fetchImpl: async () => { throw new Error('network down') } })(storeId, 'DC2611057392')).toBe(false)
    expect(await makeShopifySkuExists({ log, fetchImpl: async () => answer(edges(1)) })('csk-no-such-store', 'DC2611057392')).toBe(false)
    expect(logs).toHaveLength(4)
    for (const line of logs) expect(line).not.toContain(TOKEN)
  })
})
