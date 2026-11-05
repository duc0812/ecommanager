import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

// What production admins run: one store, no filter, one time zone. The golden file is the output of the single-store
// routes before the store scope existed (store-scope-finance.integration.test.ts compares the seller side to the same file).
// The overview adds up every row of a few tables, so the comparison needs a database that holds nothing but this fixture;
// the shared test.db keeps stores and projects that other suites leave behind. This file migrates a private database
// and points the app at it before anything that opens a connection is loaded, which is why the app is imported in beforeAll.
// A fixed name: Windows keeps the file locked until the worker exits, so the next run removes what this one left.
const dbFile = path.join(os.tmpdir(), 'finance-single-store.test.db')
const removeDb = () => { for (const suffix of ['', '-journal', '-wal', '-shm']) { try { fs.unlinkSync(dbFile + suffix) } catch {} } }

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/finance-scope/single-store-before.json'), 'utf8'))
const json = async (res: Response) => ({ status: res.status, body: await res.json() })
const without = (value: any, ...keys: string[]) => {
  const copy = { ...value }
  for (const key of keys) delete copy[key]
  return copy
}

type Handler = (req: any) => Promise<Response>
let app: {
  prisma: typeof import('@/lib/db').prisma
  fixture: typeof import('./helpers/finance-scope-fixture')
  overview: Handler
  projects: Handler
  staff: Handler
  bills: Handler
  dbBilling: Handler
  accounts: Handler
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  removeDb()
  execSync('npx prisma migrate deploy', { stdio: 'ignore', env: { ...process.env, DATABASE_URL: `file:${dbFile}` } })
  process.env.DATABASE_URL = `file:${dbFile}`
  app = {
    prisma: (await import('@/lib/db')).prisma,
    fixture: await import('./helpers/finance-scope-fixture'),
    overview: (await import('@/app/api/overview/route')).GET,
    projects: (await import('@/app/api/projects/route')).GET,
    staff: (await import('@/app/api/staff/route')).GET,
    bills: (await import('@/app/api/finance/other-bills/route')).GET,
    dbBilling: (await import('@/app/api/meta/db-billing/route')).GET,
    accounts: (await import('@/app/api/meta/accounts/route')).GET as Handler,
  }
  expect(await app.prisma.shopifyStore.count()).toBe(0)
  await app.fixture.seedFinanceFixture()
}, 120_000)

afterAll(async () => {
  await app.fixture.cleanupFinanceFixture()
  await app.prisma.$disconnect()
  removeDb()
})

describe.each(['admin', 'super'])('%s on a single-store database equals the single-store output', who => {
  it.each([['overviewAll', 'period=all'], ['overviewCustom', 'period=custom&date=2026-10-05']])('%s', async (key, query) => {
    const { status, body } = await json(await app.overview(app.fixture.request(`/api/overview?${query}`, who)))
    expect(status).toBe(200)
    expect(without(body, 'chartData', 'stores', 'storeTotals', 'currencies')).toEqual(golden[key])
    expect(body.stores).toEqual(['FSF Alpha'])
    expect(body.currencies).toEqual(['USD'])
  })

  it('projects, staff, other bills, Meta billing and Meta accounts', async () => {
    const get = async (handler: Handler, url: string) => (await json(await handler(app.fixture.request(url, who)))).body
    expect(await get(app.projects, '/api/projects')).toEqual(golden.projects)
    expect(await get(app.staff, '/api/staff')).toEqual(golden.staff)
    expect(await get(app.bills, '/api/finance/other-bills')).toEqual(golden.otherBills)
    expect(await get(app.dbBilling, '/api/meta/db-billing')).toEqual(golden.dbBilling)
    expect(await get(app.accounts, '/api/meta/accounts')).toEqual(golden.metaAccounts)
  })
})
