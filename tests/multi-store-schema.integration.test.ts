import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { prisma } from '@/lib/db'

const LITZZY = 'caramiaus-store.myshopify.com'
const CONNECTED = 'ms-connected.myshopify.com'
const BARE = 'ms-bare.myshopify.com'
const SETTINGS: Record<string, string> = {
  'shopify.connection.shop': CONNECTED,
  'shopify.connection.token': 'shpat_test_token',
  'shopify.app.apiKey': 'test-client-id',
  'shopify.app.apiSecret': 'test-client-secret',
}
const SELLER = 'ms-seller@example.com'
const ADMIN = 'ms-admin@example.com'

function backfillStatements(): string[] {
  const dir = fs.readdirSync(path.resolve(process.cwd(), 'prisma/migrations')).find(d => d.endsWith('_multi_store'))!
  const sql = fs.readFileSync(path.resolve(process.cwd(), 'prisma/migrations', dir, 'migration.sql'), 'utf8')
  const marker = '-- BACKFILL'
  expect(sql).toContain(marker)
  return sql.slice(sql.indexOf(marker)).split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean)
}

async function runBackfill() {
  for (const statement of backfillStatements()) await prisma.$executeRawUnsafe(statement)
}

const MINE = [CONNECTED, BARE, LITZZY]

type Snapshot = {
  stores: { id: string; enabled: boolean; orderPrefix: string | null; trackingPageUrl: string | null }[]
  settings: { key: string; value: string }[]
}
let before: Snapshot

// The backfill statements are global (disable every credential-less store, grant every seller),
// so what they change on rows this file does not own is put back after each test.
async function snapshot(): Promise<Snapshot> {
  const stores = await prisma.shopifyStore.findMany({
    where: { shop: { notIn: MINE } },
    select: { id: true, enabled: true, orderPrefix: true, trackingPageUrl: true },
  })
  const settings = await prisma.appSetting.findMany({ where: { key: { in: Object.keys(SETTINGS) } }, select: { key: true, value: true } })
  return { stores, settings }
}

async function cleanup() {
  await prisma.appUser.deleteMany({ where: { email: { in: [SELLER, ADMIN] } } })
  await prisma.shopifyStore.deleteMany({ where: { shop: { in: MINE } } })
  await prisma.appSetting.deleteMany({ where: { key: { in: Object.keys(SETTINGS) } } })
}

async function restore() {
  await cleanup()
  for (const { id, ...fields } of before.stores) await prisma.shopifyStore.update({ where: { id }, data: fields })
  for (const setting of before.settings) await prisma.appSetting.create({ data: setting })
}

describe('multi-store migration backfill', () => {
  beforeEach(async () => {
    before = await snapshot()
    await cleanup()
    for (const [key, value] of Object.entries(SETTINGS)) await prisma.appSetting.create({ data: { key, value } })
    await prisma.shopifyStore.create({ data: { shop: CONNECTED } })
    await prisma.shopifyStore.create({ data: { shop: BARE } })
    await prisma.shopifyStore.create({ data: { shop: LITZZY } })
    await prisma.appUser.create({ data: { name: 'Seller', email: SELLER, role: 'SELLER' } })
    await prisma.appUser.create({ data: { name: 'Admin', email: ADMIN, role: 'SUPERADMIN' } })
  })
  afterEach(restore)

  it('leaves stores it does not own as it found them', async () => {
    const other = await prisma.shopifyStore.create({ data: { shop: 'ms-other.myshopify.com' } })
    before = await snapshot()
    try {
      await runBackfill()
      expect((await prisma.shopifyStore.findUnique({ where: { id: other.id } }))!.enabled).toBe(false)
      await restore()
      expect((await prisma.shopifyStore.findUnique({ where: { id: other.id } }))!.enabled).toBe(true)
    } finally {
      await prisma.shopifyStore.deleteMany({ where: { id: other.id } })
      before = await snapshot()
    }
  })

  it('copies the connection into the credential table', async () => {
    await runBackfill()
    const store = await prisma.shopifyStore.findUnique({ where: { shop: CONNECTED } })
    const credential = await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store!.id } })
    expect(credential).toMatchObject({
      authMode: 'OAUTH',
      accessToken: 'shpat_test_token',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
    })
    expect(await prisma.shopifyStoreCredential.count({ where: { store: { shop: BARE } } })).toBe(0)
  })

  it('keeps the old settings so the migration can be rolled back', async () => {
    await runBackfill()
    expect(await prisma.appSetting.count({ where: { key: { in: Object.keys(SETTINGS) } } })).toBe(4)
  })

  it('gives Litzzy its order prefix and tracking page', async () => {
    await runBackfill()
    const litzzy = await prisma.shopifyStore.findUnique({ where: { shop: LITZZY } })
    expect(litzzy).toMatchObject({ orderPrefix: 'LIT', trackingPageUrl: 'https://litzzy.com/apps/trackingorder?nums=' })
    const other = await prisma.shopifyStore.findUnique({ where: { shop: CONNECTED } })
    expect(other!.orderPrefix).toBeNull()
  })

  it('disables only the stores that have no credential', async () => {
    await runBackfill()
    const byShop = Object.fromEntries((await prisma.shopifyStore.findMany({ where: { shop: { in: [CONNECTED, BARE] } } })).map(s => [s.shop, s.enabled]))
    expect(byShop).toEqual({ [CONNECTED]: true, [BARE]: false })
  })

  it('gives every seller access to Litzzy and nobody else', async () => {
    await runBackfill()
    const litzzy = await prisma.shopifyStore.findUnique({ where: { shop: LITZZY } })
    const seller = await prisma.appUser.findUnique({ where: { email: SELLER } })
    const admin = await prisma.appUser.findUnique({ where: { email: ADMIN } })
    expect(await prisma.userStoreAccess.count({ where: { userId: seller!.id, storeId: litzzy!.id } })).toBe(1)
    expect(await prisma.userStoreAccess.count({ where: { userId: admin!.id } })).toBe(0)
    expect(await prisma.userStoreAccess.count({ where: { userId: seller!.id } })).toBe(1)
  })

  it('is safe to run twice', async () => {
    await runBackfill()
    await runBackfill()
    const seller = await prisma.appUser.findUnique({ where: { email: SELLER } })
    expect(await prisma.shopifyStoreCredential.count({ where: { store: { shop: CONNECTED } } })).toBe(1)
    expect(await prisma.userStoreAccess.count({ where: { userId: seller!.id } })).toBe(1)
  })

  it('drops the credential and the access rows with their parent', async () => {
    await runBackfill()
    const seller = await prisma.appUser.findUnique({ where: { email: SELLER } })
    const connected = await prisma.shopifyStore.findUnique({ where: { shop: CONNECTED } })
    await prisma.shopifyStore.delete({ where: { shop: CONNECTED } })
    expect(await prisma.shopifyStoreCredential.count({ where: { storeId: connected!.id } })).toBe(0)
    await prisma.appUser.delete({ where: { email: SELLER } })
    expect(await prisma.userStoreAccess.count({ where: { userId: seller!.id } })).toBe(0)
  })
})
