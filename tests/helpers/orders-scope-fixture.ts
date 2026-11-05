import fs from 'fs'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { saveStoreCredential } from '@/lib/store-connections'
import { DEFAULT_ROLE_PERMISSIONS, type FeaturePermission, type UserRole } from '@/lib/roles'

// What the seller account on production has (Nghia): the features the page-by-page check is run with.
export const SELLER_FEATURES: FeaturePermission[] = [
  'projects', 'overview', 'meta_billing', 'other_bills', 'fulfillment_orders', 'tools_spy_idea',
  'fulfillment_crawler', 'need_to_fix', 'marketing_niche', 'tools_creative',
]

export type Side = 'a' | 'b'
export type Who = 'super' | 'admin' | 'support' | 'sellerA' | 'sellerB' | 'sellerAB' | 'sellerNone' | 'designerA' | 'exporterA'

// Two stores with the same shape of data. The order number, customer, project and shop of store B carry markers
// that must never show up in an answer given to a seller of store A.
export function ordersScopeFixture(P: string) {
  const U = P.toUpperCase()
  const tokens: Record<string, string> = {}
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${P}-storage-`))

  const f = {
    P,
    root,
    emails: ['super', 'admin', 'support', 'seller-a', 'seller-b', 'seller-ab', 'seller-none', 'designer-a', 'exporter-a'].map(k => `${P}-${k}@test.local`),
    shop: (s: Side) => `${P}-${s}.myshopify.com`,
    storeId: (s: Side) => `${P}-store-${s}`,
    projectId: (s: Side) => `${P}-project-${s}`,
    projectName: (s: Side) => `${U} ${s === 'a' ? 'Alpha' : 'Beta'}`,
    prefix: (s: Side) => `${U}${s === 'a' ? 'A' : 'B'}`,
    orderId: (s: Side, n: number) => `${P}-order-${s}${n}`,
    orderNumber: (s: Side, n: number) => `#${U}${s === 'a' ? 'A' : 'B'}${n}`,
    lineId: (s: Side, n: number) => `${P}-line-${s}${n}`,
    shopifyLineId: (s: Side, n: number) => `${P}-sl-${s}${n}`,
    taskKey: (s: Side, n: number) => `${U}${s === 'a' ? 'A' : 'B'}${n}_1`,
    artworkId: (s: Side) => `${P}-art-${s}`,
    artworkBytes: (s: Side) => `bytes-of-${P}-${s}`,
    supplierId: `${P}-sup`,
    customer: (s: Side) => `${U} Customer ${s === 'a' ? 'Alpha' : 'Beta'}`,
    payout: (s: Side, n: number) => (s === 'a' ? 100 : 1000) * n,
    // Strings that only the data of this side carries: finding one in an answer given to the other side is a leak.
    markers: (s: Side) => [
      `${P}-store-${s}`, `${P}-project-${s}`, `${P}-${s}.myshopify.com`, `${U} ${s === 'a' ? 'Alpha' : 'Beta'}`, `${U}${s === 'a' ? 'A' : 'B'}`, `${P}-order-${s}`, `${P}-art-${s}`,
    ],
    // 1: waiting for design, a line with no SKU. 2: ready, non-custom, a supplier and no cost. 3: exported, with a cost.
    // 4: ready, its design approved (waits to be handed to the supplier).
    orders: [1, 2, 3, 4],
    status: (n: number) => (['PENDING_DESIGN', 'READY_TO_PRODUCTION', 'EXPORTED', 'READY_TO_PRODUCTION'] as const)[n - 1],
  }

  const sides: Side[] = ['a', 'b']

  async function makeUser(key: string, role: UserRole | string, permissions: FeaturePermission[], storeIds: string[] = []) {
    const email = `${P}-${key}@test.local`
    const row = await prisma.appUser.create({
      data: { name: key, email, role, permissions: JSON.stringify(permissions), storeAccess: { create: storeIds.map(storeId => ({ storeId })) } },
    })
    tokens[key] = await signToken({ userId: row.id, email, name: key, role: role as UserRole, permissions, tv: row.tokenVersion })
  }

  async function cleanup() {
    for (const key of Object.keys(tokens)) delete tokens[key]
    await prisma.orderTaskState.deleteMany({ where: { orderId: { startsWith: `${P}-` } } })
    await prisma.order.deleteMany({ where: { id: { startsWith: `${P}-` } } })
    await prisma.appUser.deleteMany({ where: { email: { in: f.emails } } })
    await prisma.shopifyStore.deleteMany({ where: { id: { in: sides.map(f.storeId) } } })
    await prisma.project.deleteMany({ where: { id: { in: sides.map(f.projectId) } } })
    await prisma.supplier.deleteMany({ where: { id: f.supplierId } })
  }

  async function seed() {
    await cleanup()
    await prisma.supplier.create({ data: { id: f.supplierId, name: `${U} Supplier`, code: `${U}SUP` } })
    for (const s of sides) {
      await prisma.project.create({ data: { id: f.projectId(s), name: f.projectName(s), startDate: new Date('2026-01-01') } })
      await prisma.shopifyStore.create({ data: {
        id: f.storeId(s), shop: f.shop(s), orderPrefix: f.prefix(s), projectId: f.projectId(s), ianaTimezone: 'America/Denver',
        connectedAt: new Date(s === 'a' ? '2001-01-01' : '2001-01-02'),
      } })
      await saveStoreCredential(f.storeId(s), { authMode: 'TOKEN', accessToken: `token-${P}-${s}` })
      for (const n of f.orders) {
        const noSku = n === 1
        await prisma.order.create({ data: {
          id: f.orderId(s, n), storeId: f.storeId(s), projectId: f.projectId(s), shopifyOrderNumber: f.orderNumber(s, n),
          customerName: f.customer(s), customerEmail: `${f.customer(s).replace(/ /g, '.').toLowerCase()}@example.test`,
          financialStatus: 'PAID', currency: 'USD', grossAmount: f.payout(s, n), expectedPayout: f.payout(s, n), totalFees: 0, refundedAmount: 0,
          placedAt: new Date(`2026-10-0${n}T12:00:00Z`), pipelineStatus: f.status(n), orderType: n === 2 ? 'NON_CUSTOM' : 'CUSTOM',
          designReady: false, fetchedAt: new Date('2026-10-10T00:00:00Z'),
          lines: { create: [{
            id: f.lineId(s, n), shopifyLineId: f.shopifyLineId(s, n), sku: noSku ? null : `${U}-SKU-${s}${n}`, productTitle: `${f.projectName(s)} product ${n}`,
            qty: 1, linePosition: 1, unitPrice: f.payout(s, n), customized: n === 1,
            resolvedSupplierId: n === 1 ? null : f.supplierId, resolvedBaseCost: n === 3 ? 5 : null,
            designDriveLink: n === 4 ? 'https://drive.google.com/file/d/fixture/view' : null,
          }] },
        } })
      }
      await prisma.designTask.create({ data: { orderId: f.orderId(s, 1), shopifyLineId: f.shopifyLineId(s, 1), taskKey: f.taskKey(s, 1), status: 'NEW' } })
      await prisma.designTask.create({ data: { orderId: f.orderId(s, 2), shopifyLineId: f.shopifyLineId(s, 2), taskKey: f.taskKey(s, 2), status: 'REVIEW' } })
      await prisma.designTask.create({ data: { orderId: f.orderId(s, 4), shopifyLineId: f.shopifyLineId(s, 4), taskKey: f.taskKey(s, 4), status: 'DONE' } })
      await prisma.orderTaskState.create({ data: {
        orderId: f.orderId(s, 1), shopifyOrderNumber: f.orderNumber(s, 1), taskType: 'UNMAPPED', dept: 'MAPPING', resolvedAt: new Date('2026-10-20T00:00:00Z'),
      } })
      const rel = `${P}/${s}.png`
      fs.mkdirSync(path.join(root, P), { recursive: true })
      fs.writeFileSync(path.join(root, rel), f.artworkBytes(s))
      await prisma.designArtwork.create({ data: {
        id: f.artworkId(s), orderId: f.orderId(s, 1), shopifyLineId: f.shopifyLineId(s, 1), printArea: 'Front', version: 1,
        fileName: `${s}.png`, storagePath: rel, size: f.artworkBytes(s).length, mimeType: 'image/png',
      } })
    }
    const all = DEFAULT_ROLE_PERMISSIONS
    await makeUser('super', 'SUPERADMIN', all.SUPERADMIN)
    await makeUser('admin', 'ADMIN', all.ADMIN)
    await makeUser('support', 'SUPPORT', all.SUPPORT)
    await makeUser('sellerA', 'SELLER', SELLER_FEATURES, [f.storeId('a')])
    await makeUser('sellerB', 'SELLER', SELLER_FEATURES, [f.storeId('b')])
    await makeUser('sellerAB', 'SELLER', SELLER_FEATURES, [f.storeId('a'), f.storeId('b')])
    await makeUser('sellerNone', 'SELLER', SELLER_FEATURES)
    await makeUser('designerA', 'SELLER', [...SELLER_FEATURES, 'design_tasks'], [f.storeId('a')])
    await makeUser('exporterA', 'SELLER', [...SELLER_FEATURES, 'fulfillment_export'], [f.storeId('a')])
  }

  // `who` null = no session.
  function request(url: string, who: Who | null, init: { method?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(init.headers ?? {}) }
    if (who) headers.cookie = `${AUTH_COOKIE}=${tokens[who]}`
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    return new NextRequest(`http://localhost${url}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : init.raw !== undefined ? { body: init.raw } : {}),
    })
  }

  return { ...f, sides, seed, cleanup, request, tokens }
}

export type OrdersScopeFixture = ReturnType<typeof ordersScopeFixture>

export const call = async (res: Response) => ({ status: res.status, body: await res.json().catch(() => null) as any })
