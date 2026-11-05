import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { saveStoreCredential } from '@/lib/store-connections'
import { DEFAULT_ROLE_PERMISSIONS, type FeaturePermission, type UserRole } from '@/lib/roles'

export const P = 'fsf'
export const SHOP_A = `${P}-a.myshopify.com`
export const SHOP_B = `${P}-b.myshopify.com`
export const SHOP_C = `${P}-c.myshopify.com`
export const PROJECT_A = `${P}-project-a`
export const PROJECT_B = `${P}-project-b`
export const PROJECT_C = `${P}-project-c`
export const NAME_A = 'FSF Alpha'
export const NAME_B = 'FSF Beta'
export const NAME_C = 'FSF Gamma'
export const ACC_A = `${P}-acc-a`
export const ACC_B = `${P}-acc-b`
export const ACC_C = `${P}-acc-c`
export const ACC_U = `${P}-acc-u`
export const EMAILS = ['super', 'admin', 'seller-a', 'seller-b', 'seller-ab', 'seller-bc', 'seller-none', 'seller-writer'].map(k => `${P}-${k}@test.local`)

export const SELLER_FEATURES: FeaturePermission[] = [
  'projects', 'overview', 'meta_billing', 'other_bills', 'marketing_niche', 'shopify', 'fulfillment_orders',
]

export type Fixture = { storeA: string; storeB: string; storeC: string }

const tokens: Record<string, string> = {}

export function request(path: string, who: string | null, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = who ? { cookie: `${AUTH_COOKIE}=${tokens[who]}` } : {}
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
}

async function makeUser(key: string, role: UserRole, permissions: FeaturePermission[], storeIds: string[] = []) {
  const email = `${P}-${key}@test.local`
  const row = await prisma.appUser.create({
    data: { name: key, email, role, permissions: JSON.stringify(permissions), storeAccess: { create: storeIds.map(storeId => ({ storeId })) } },
  })
  tokens[key] = await signToken({ userId: row.id, email, name: key, role, permissions, tv: row.tokenVersion })
}

export async function ensureAdmin() {
  if (!tokens.admin) await makeUser('admin', 'ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN)
}

export async function cleanupFinanceFixture() {
  for (const key of Object.keys(tokens)) delete tokens[key]
  const stores = await prisma.shopifyStore.findMany({ where: { shop: { in: [SHOP_A, SHOP_B, SHOP_C] } }, select: { id: true } })
  const storeIds = stores.map(s => s.id)
  const accounts = await prisma.metaAdAccount.findMany({ where: { accountId: { in: [ACC_A, ACC_B, ACC_C, ACC_U] } }, select: { id: true } })
  const accountIds = accounts.map(a => a.id)
  await prisma.dailyAdSpend.deleteMany({ where: { adAccountId: { in: accountIds } } })
  await prisma.metaCampaignDailySpend.deleteMany({ where: { adAccountId: { in: accountIds } } })
  await prisma.metaBilling.deleteMany({ where: { adAccountId: { in: accountIds } } })
  await prisma.metaAdAccount.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.order.deleteMany({ where: { id: { startsWith: `${P}-order-` } } })
  await prisma.payout.deleteMany({ where: { storeId: { in: storeIds } } })
  await prisma.otherBill.deleteMany({ where: { vendor: { startsWith: `${P}-` } } })
  await prisma.staffAssignment.deleteMany({ where: { staff: { name: { startsWith: `${P}-` } } } })
  await prisma.staff.deleteMany({ where: { name: { startsWith: `${P}-` } } })
  await prisma.cashflowSnapshot.deleteMany({ where: { projectId: { in: [PROJECT_A, PROJECT_B, PROJECT_C] } } })
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  await prisma.shopifyStore.deleteMany({ where: { id: { in: storeIds } } })
  await prisma.project.deleteMany({ where: { id: { in: [PROJECT_A, PROJECT_B, PROJECT_C] } } })
}

const order = (n: string, storeId: string, projectId: string, placedAt: string, gross: number, payout: number) => prisma.order.create({ data: {
  id: `${P}-order-${n}`, storeId, projectId, shopifyOrderNumber: `#FSF${n}`, financialStatus: 'PAID', currency: 'USD',
  grossAmount: gross, expectedPayout: payout, totalFees: 0, refundedAmount: 0, placedAt: new Date(placedAt), fetchedAt: new Date('2026-10-06T00:00:00Z'),
} })

const payout = (id: number, storeId: string, date: string, amount: number) => prisma.payout.create({ data: {
  id, storeId, status: 'paid', date, currency: 'USD', amount, chargesFeeAmount: 0, chargesGrossAmount: amount, refundsFeeAmount: 0,
  refundsGrossAmount: 0, adjustmentsFeeAmount: 0, adjustmentsGrossAmount: 0, fetchedAt: new Date('2026-10-06T00:00:00Z'),
} })

const account = (key: string, accountId: string, projectId: string | null) => prisma.metaAdAccount.create({ data: {
  id: `${P}-accdb-${key}`, accountId, accountName: `${accountId} name`, accessToken: 'fsf-token', currency: 'USD', projectId, createdAt: new Date('2026-10-01T00:00:00Z'),
} })

const billing = (id: string, adAccountId: string, amount: number, date: string, last4: string) => prisma.metaBilling.create({ data: {
  id, adAccountId, amount, currency: 'USD', billingDate: date, status: 'PAID', paymentMethodLast4: last4, createdAt: new Date('2026-10-06T00:00:00Z'),
} })

const spend = (adAccountId: string, date: string, amount: number) => prisma.dailyAdSpend.create({ data: {
  adAccountId, date, spend: amount, currency: 'USD', fetchedAt: new Date('2026-10-06T00:00:00Z'),
} })

const bill = (key: string, projectId: string | null, amountUsd: number, second: number) => prisma.otherBill.create({ data: {
  id: `${P}-obill-${key}`, vendor: `${P}-${key}`, category: 'OTHER', amount: amountUsd, currency: 'USD', amountUsd, paidAt: '2026-10-05', paymentMethod: 'OTHER', projectId,
  createdAt: new Date(Date.UTC(2026, 9, 6, 0, 0, second)),
} })

const staff = (key: string, monthlyCost: number) => prisma.staff.create({ data: {
  id: `${P}-staff-${key}`, name: `${P}-staff-${key}`, monthlyCost, createdAt: new Date('2026-01-01T00:00:00Z'),
} })

const assign = (staffId: string, projectId: string) => prisma.staffAssignment.create({ data: {
  id: `${staffId}-in-${projectId}`, staffId, projectId, startDate: new Date('2026-01-01'), createdAt: new Date('2026-01-01T00:00:00Z'),
} })

// Alpha is the store the single-store figures are checked on. Beta is the second store. Gamma lives in another time zone
// and only the time zone test uses it (with Beta's second order). The account with no project is the "no store" row.
export async function seedFinanceFixture(opts: { second?: boolean; third?: boolean } = {}): Promise<Fixture> {
  await prisma.project.create({ data: { id: PROJECT_A, name: NAME_A, startDate: new Date('2026-01-01'), createdAt: new Date('2026-01-01') } })
  const storeA = (await prisma.shopifyStore.create({ data: {
    id: `${P}-store-a`, shop: SHOP_A, orderPrefix: 'FSA', projectId: PROJECT_A, ianaTimezone: 'America/Denver', connectedAt: new Date('2001-01-01'),
  } })).id
  await saveStoreCredential(storeA, { authMode: 'TOKEN', accessToken: 'token-fsf-a' })
  await payout(9_500_001, storeA, '2026-10-10', 1000.25)
  await payout(9_500_002, storeA, '2026-10-11', 40.5)
  const accA = await account('a', ACC_A, PROJECT_A)
  const accU = await account('u', ACC_U, null)
  await billing(`${P}-bill-a1`, accA.id, 300.1, '2026-10-05', '1111')
  await billing(`${P}-bill-a2`, accA.id, 25.2, '2026-10-06', '1111')
  await billing(`${P}-bill-u1`, accU.id, 9.7, '2026-10-05', '2222')
  await spend(accA.id, '2026-10-05', 50)
  await spend(accU.id, '2026-10-05', 7)
  await bill('a', PROJECT_A, 11.5, 0)
  await bill('u', null, 3.25, 2)
  await order('a1', storeA, PROJECT_A, '2026-10-05T18:00:00Z', 100, 90)
  const staffA = await staff('a', 300)
  const staffAB = await staff('ab', 700)
  await assign(staffA.id, PROJECT_A)
  await assign(staffAB.id, PROJECT_A)

  let storeB = ''
  if (opts.second) {
    await prisma.project.create({ data: { id: PROJECT_B, name: NAME_B, startDate: new Date('2026-01-01'), createdAt: new Date('2026-01-02') } })
    storeB = (await prisma.shopifyStore.create({ data: {
      id: `${P}-store-b`, shop: SHOP_B, orderPrefix: 'FSB', projectId: PROJECT_B, ianaTimezone: 'America/Denver', connectedAt: new Date('2001-01-02'), payoutStartDate: '2026-10-06',
    } })).id
    await saveStoreCredential(storeB, { authMode: 'TOKEN', accessToken: 'token-fsf-b' })
    await payout(9_500_011, storeB, '2026-10-12', 2000.5)
    await payout(9_500_012, storeB, '2026-09-01', 999)
    const accB = await account('b', ACC_B, PROJECT_B)
    await billing(`${P}-bill-b1`, accB.id, 410.3, '2026-10-05', '3333')
    await spend(accB.id, '2026-10-05', 80)
    await bill('b', PROJECT_B, 22.5, 1)
    await order('b1', storeB, PROJECT_B, '2026-10-05T18:00:00Z', 200, 190)
    const staffB = await staff('b', 500)
    await assign(staffB.id, PROJECT_B)
    await assign(staffAB.id, PROJECT_B)
  }

  let storeC = ''
  if (opts.third) {
    await prisma.project.create({ data: { id: PROJECT_C, name: NAME_C, startDate: new Date('2026-01-01'), createdAt: new Date('2026-01-03') } })
    storeC = (await prisma.shopifyStore.create({ data: {
      id: `${P}-store-c`, shop: SHOP_C, orderPrefix: 'FSC', projectId: PROJECT_C, ianaTimezone: 'Asia/Ho_Chi_Minh', connectedAt: new Date('2001-01-03'),
    } })).id
    const accC = await account('c', ACC_C, PROJECT_C)
    await spend(accC.id, '2026-10-05', 13)
    await order('b2', storeB, PROJECT_B, '2026-10-05T20:00:00Z', 10, 9)
    await order('c1', storeC, PROJECT_C, '2026-10-04T20:00:00Z', 1000, 900)
    await order('c2', storeC, PROJECT_C, '2026-10-05T20:00:00Z', 5000, 4500)
  }

  await makeUser('super', 'SUPERADMIN', DEFAULT_ROLE_PERMISSIONS.SUPERADMIN)
  await ensureAdmin()
  await makeUser('seller-a', 'SELLER', SELLER_FEATURES, [storeA])
  await makeUser('seller-none', 'SELLER', SELLER_FEATURES)
  if (storeB) await makeUser('seller-b', 'SELLER', SELLER_FEATURES, [storeB])
  if (storeB) await makeUser('seller-ab', 'SELLER', SELLER_FEATURES, [storeA, storeB])
  if (storeC) await makeUser('seller-bc', 'SELLER', SELLER_FEATURES, [storeB, storeC])
  await makeUser('seller-writer', 'SELLER', [...SELLER_FEATURES, 'setup_projects', 'setup_hr', 'setup_meta'], [storeA])
  return { storeA, storeB, storeC }
}
