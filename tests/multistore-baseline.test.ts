import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createClient } from '@libsql/client'
import { spawnSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

const SCRIPT = path.resolve(__dirname, '../scripts/multistore-baseline.mjs')
const SHOP = 'litz.myshopify.com'
const NEW_SHOP = 'second.myshopify.com'

let dir = ''
let dbFile = ''
let baselineFile = ''

const urlOf = (file: string) => 'file:' + file.replace(/\\/g, '/')
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const minutesAfter = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString()

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

async function withDb<T>(fn: (sql: (query: string, args?: any[]) => Promise<void>) => Promise<T>): Promise<T> {
  const client = createClient({ url: urlOf(dbFile) })
  try {
    return await fn(async (query, args = []) => { await client.execute({ sql: query, args }) })
  } finally {
    client.close()
  }
}

async function seed(opts: { orderPrefixColumn?: boolean } = {}) {
  const prefixColumn = opts.orderPrefixColumn ?? true
  await withDb(async sql => {
    await sql(`CREATE TABLE ShopifyStore (id TEXT PRIMARY KEY, shop TEXT NOT NULL UNIQUE${prefixColumn ? ', orderPrefix TEXT' : ''})`)
    await sql(`CREATE TABLE "Order" (id TEXT PRIMARY KEY, storeId TEXT NOT NULL, shopifyOrderNumber TEXT NOT NULL, grossAmount REAL NOT NULL, placedAt TEXT NOT NULL)`)
    await sql(`CREATE TABLE Payout (id INTEGER PRIMARY KEY, storeId TEXT NOT NULL, status TEXT NOT NULL, date TEXT NOT NULL, amount REAL NOT NULL)`)
    await sql(`CREATE TABLE DesignTask (id TEXT PRIMARY KEY, orderId TEXT NOT NULL, status TEXT NOT NULL)`)
    await sql(`CREATE TABLE Shipment (id TEXT PRIMARY KEY, orderId TEXT NOT NULL)`)
    await sql(prefixColumn ? `INSERT INTO ShopifyStore (id, shop, orderPrefix) VALUES ('s1', ?, 'LIT')` : `INSERT INTO ShopifyStore (id, shop) VALUES ('s1', ?)`, [SHOP])
    await sql(`INSERT INTO "Order" VALUES ('o1', 's1', '#LIT1', 10.10, '2026-10-01T10:00:00.000+00:00')`)
    await sql(`INSERT INTO "Order" VALUES ('o2', 's1', '#LIT2', 20.20, '2026-10-02T11:30:00.000+00:00')`)
    await sql(`INSERT INTO Payout VALUES (1, 's1', 'paid', '2026-10-03', 30.30)`)
    await sql(`INSERT INTO Payout VALUES (2, 's1', 'paid', '2026-10-04', 40.40)`)
    await sql(`INSERT INTO Payout VALUES (3, 's1', 'in_transit', '2099-01-01', 50.50)`)
    await sql(`INSERT INTO DesignTask VALUES ('t1', 'o1', 'DONE')`)
    await sql(`INSERT INTO DesignTask VALUES ('t2', 'o1', 'NEW')`)
    await sql(`INSERT INTO DesignTask VALUES ('t3', 'o2', 'NEW')`)
    await sql(`INSERT INTO Shipment VALUES ('sh1', 'o2')`)
  })
}

function takeBaseline() {
  const r = run(dbFile)
  expect(r.code).toBe(0)
  fs.writeFileSync(baselineFile, r.out)
  return JSON.parse(r.out)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multistore-baseline-'))
  dbFile = path.join(dir, 'fixture.db')
  baselineFile = path.join(dir, 'baseline.json')
})

afterEach(() => {
  // libsql keeps the database file open until the process exits on Windows, so removal can fail there
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
})

describe('multistore-baseline', () => {
  it('prints takenAt and one entry per shop, and leaves the database file byte for byte untouched', async () => {
    await seed()
    const before = sha(dbFile)
    const r = run(dbFile)
    expect(r.code).toBe(0)
    const out = JSON.parse(r.out)
    expect(Number.isNaN(Date.parse(out.takenAt))).toBe(false)
    expect(Object.keys(out.stores)).toEqual([SHOP])
    expect(out.stores[SHOP]).toMatchObject({
      orderPrefix: 'LIT',
      orders: { count: 2, grossTotal: 30.3 },
      payouts: { count: 3, total: 121.2 },
      atTakenAt: { orders: { count: 2, grossTotal: 30.3 }, payouts: { count: 2, total: 70.7 } },
      designTasks: { total: 3, byStatus: { DONE: 1, NEW: 2 } },
      shipments: 1,
    })
    expect(sha(dbFile)).toBe(before)
    expect(fs.readdirSync(dir).sort()).toEqual(['fixture.db'])
  })

  it('works on the older schema that has no ShopifyStore.orderPrefix', async () => {
    await seed({ orderPrefixColumn: false })
    const out = takeBaseline()
    expect(out.stores[SHOP].orderPrefix).toBeNull()
    expect(out.stores[SHOP].orders.count).toBe(2)
  })

  it('exits 0 when nothing changed, even with a payout dated after the baseline', async () => {
    await seed()
    takeBaseline()
    const r = run(dbFile, '--compare', baselineFile)
    expect(r.code).toBe(0)
    expect(r.out).toContain(SHOP)
    expect(r.out).toMatch(/RESULT: OK/)
  })

  it('reads a baseline that PowerShell redirected as UTF-16 with a BOM', async () => {
    await seed()
    takeBaseline()
    fs.writeFileSync(baselineFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(fs.readFileSync(baselineFile, 'utf8'), 'utf16le')]))
    expect(run(dbFile, '--compare', baselineFile).code).toBe(0)
  })

  it('exits 0 when only a new store with orders is added and the old store only gains newer records', async () => {
    await seed()
    const baseline = takeBaseline()
    const later = minutesAfter(baseline.takenAt, 5)
    await withDb(async sql => {
      await sql(`INSERT INTO ShopifyStore (id, shop, orderPrefix) VALUES ('s2', ?, 'SEC')`, [NEW_SHOP])
      await sql(`INSERT INTO "Order" VALUES ('n1', 's2', '#SEC1', 99.99, '2026-09-01T00:00:00.000+00:00')`)
      await sql(`INSERT INTO "Order" VALUES ('n2', 's2', '#SEC2', 11.11, ?)`, [later])
      await sql(`INSERT INTO Payout VALUES (10, 's2', 'paid', '2026-09-02', 77.77)`)
      await sql(`INSERT INTO DesignTask VALUES ('t10', 'n1', 'NEW')`)
      await sql(`INSERT INTO Shipment VALUES ('sh10', 'n1')`)
      await sql(`INSERT INTO "Order" VALUES ('o3', 's1', '#LIT3', 5.05, ?)`, [later])
      await sql(`INSERT INTO Payout VALUES (4, 's1', 'paid', '2099-02-02', 6.06)`)
      await sql(`UPDATE DesignTask SET status = 'DONE' WHERE id = 't2'`)
      await sql(`INSERT INTO DesignTask VALUES ('t4', 'o3', 'NEW')`)
      await sql(`INSERT INTO Shipment VALUES ('sh2', 'o1')`)
    })
    const r = run(dbFile, '--compare', baselineFile)
    expect(r.code).toBe(0)
    expect(r.out).toContain(`${NEW_SHOP}: not in the baseline`)
    expect(r.out).toContain('dated after the baseline: 1 orders')
    expect(r.out).toMatch(/design tasks \(information\)/)
    expect(r.out).toMatch(/shipments \(information\): 1 -> 2/)
    expect(r.out).toMatch(/RESULT: OK/)
  })

  it('exits 1 when an old order of a baseline store disappears, even if a newer order arrived in the meantime', async () => {
    await seed()
    const baseline = takeBaseline()
    await withDb(async sql => {
      await sql(`DELETE FROM "Order" WHERE id = 'o1'`)
      await sql(`INSERT INTO "Order" VALUES ('o3', 's1', '#LIT3', 10.10, ?)`, [minutesAfter(baseline.takenAt, 5)])
    })
    const r = run(dbFile, '--compare', baselineFile)
    expect(r.code).toBe(1)
    expect(r.out).toContain(`FAIL ${SHOP}: orders dated at or before the baseline: 2 -> 1`)
    expect(r.out).toMatch(/RESULT: FAIL/)
  })

  it('exits 1 when the gross total of an old order moves but the count does not', async () => {
    await seed()
    takeBaseline()
    await withDb(async sql => { await sql(`UPDATE "Order" SET grossAmount = 11.10 WHERE id = 'o1'`) })
    const r = run(dbFile, '--compare', baselineFile)
    expect(r.code).toBe(1)
    expect(r.out).toContain(`FAIL ${SHOP}: orders gross total dated at or before the baseline: 30.30 -> 31.30`)
  })

  it('exits 1 when a payout of a baseline store is lost', async () => {
    await seed()
    takeBaseline()
    await withDb(async sql => { await sql(`DELETE FROM Payout WHERE id = 1`) })
    const r = run(dbFile, '--compare', baselineFile)
    expect(r.code).toBe(1)
    expect(r.out).toContain(`FAIL ${SHOP}: payouts lost: 1`)
  })

  it('exits 1 when a baseline store is gone', async () => {
    await seed()
    takeBaseline()
    await withDb(async sql => {
      await sql(`DELETE FROM ShopifyStore WHERE id = 's1'`)
      await sql(`DELETE FROM "Order"`)
    })
    const r = run(dbFile, '--compare', baselineFile)
    expect(r.code).toBe(1)
    expect(r.out).toContain(`FAIL ${SHOP}: store is not in the database any more`)
  })

  it('reads a WAL database another connection still has open, without writing to it', async () => {
    await seed()
    const app = createClient({ url: urlOf(dbFile) })
    try {
      await app.execute('PRAGMA journal_mode = WAL')
      const baseline = takeBaseline()
      await app.execute({ sql: `INSERT INTO "Order" VALUES ('o3', 's1', '#LIT3', 5.05, ?)`, args: [minutesAfter(baseline.takenAt, 5)] })
      const wal = dbFile + '-wal'
      const before = [sha(dbFile), sha(wal)]
      const r = run(dbFile, '--compare', baselineFile)
      expect(r.code).toBe(0)
      expect(r.out).toContain('dated after the baseline: 1 orders')
      expect([sha(dbFile), sha(wal)]).toEqual(before)
    } finally {
      app.close()
    }
  })

  it('exits 2 and creates nothing when the database does not exist', () => {
    const missing = path.join(dir, 'nope.db')
    const r = run(missing)
    expect(r.code).toBe(2)
    expect(r.err).toContain('not found')
    expect(fs.existsSync(missing)).toBe(false)
  })

  it('exits 2 when the baseline file is missing or is not a baseline', async () => {
    await seed()
    expect(run(dbFile, '--compare', path.join(dir, 'nope.json')).code).toBe(2)
    fs.writeFileSync(baselineFile, '{"hello":1}')
    const r = run(dbFile, '--compare', baselineFile)
    expect(r.code).toBe(2)
    expect(r.err).toContain('not a baseline')
  })
})
