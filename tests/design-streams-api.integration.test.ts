import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/roles'
import { syncDesignTasks, transitionTask, type Actor } from '@/lib/design-tasks'
import { countOverdueHandoff, countPendingHandoff, handoffDueAt, listHandoffHub } from '@/lib/supplier-handoff'
import { GET as getTasks } from '@/app/api/design-studio/tasks/route'

const PROJECT = 'dsp2-proj'
const SHOP = 'dsp2-store.myshopify.com'
const SUP = 'dsp2-sup'
const EMAIL = 'dsp2@dt.test'
const ORDER = 'gid://test/Order/dsp2-1'
const PRINT = JSON.stringify([{ print_area: 'Main', url: 'https://cdn.example/dsp2.png' }])

describe('handoffDueAt', () => {
  it('ignores cancelled tasks and null dues', () => {
    expect(handoffDueAt([{ status: 'DONE', dueAt: new Date(5000) }, { status: 'CANCELLED', dueAt: new Date(1000) }, { status: 'DONE', dueAt: null }])).toEqual(new Date(5000))
    expect(handoffDueAt([{ status: 'DONE', dueAt: null }])).toBeNull()
    expect(handoffDueAt([])).toBeNull()
  })
})

describe('pending handoff orders carry the design due', () => {
  let token = ''
  let storeId = ''
  beforeAll(async () => {
    process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
    await prisma.order.deleteMany({ where: { projectId: PROJECT } })
    await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'DSP2', startDate: new Date('2026-06-01') }, update: {} })
    const store = await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })
    storeId = store.id
    await prisma.supplier.upsert({ where: { code: 'dsp2_sup' }, create: { id: SUP, name: 'Dsp2 Factory', code: 'dsp2_sup' }, update: {} })
    await prisma.supplierProduct.create({ data: { supplierId: SUP, sku: 'DSP2-TUMBLER', baseCost: 6 } })
    const perms = DEFAULT_ROLE_PERMISSIONS.ADMIN
    const userId = (await prisma.appUser.upsert({ where: { email: EMAIL }, create: { name: 'Dsp2', email: EMAIL, role: 'ADMIN', permissions: JSON.stringify(perms) }, update: {} })).id
    const actor: Actor = { id: userId, name: 'Dsp2', role: 'ADMIN', permissions: perms }
    await prisma.order.create({
      data: {
        id: ORDER, projectId: PROJECT, storeId: store.id, shopifyOrderNumber: '#DSP2', financialStatus: 'PAID', currency: 'USD',
        grossAmount: 30, expectedPayout: 28, totalFees: 2, refundedAmount: 0, placedAt: new Date('2026-10-05T10:00:00Z'),
        pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM', defaultSupplierId: SUP,
        customerEmail: 'mary@example.com', customerName: 'Mary Watson', shippingName: 'Mary Watson', shippingAddress1: '12 Main St',
        shippingCity: 'Denver', shippingZip: '80202', shippingPhone: '+1 303 555 0100', shippingCountry: 'US', shippingState: 'Colorado',
        lines: { create: [{
          shopifyLineId: 'dsp2-1-1', sku: 'DSP2-TUMBLER', productTitle: 'Custom Tumbler', variantTitle: '20oz', qty: 1, linePosition: 1, unitPrice: 15,
          resolvedSupplierId: SUP, resolvedSupplierSku: 'DSP2-TUMBLER', customized: true, previewCdnUrl: 'https://cdn.example.com/preview.png',
          customAttributesJson: JSON.stringify([{ key: 'Name', value: 'Ann' }, { key: '_print_files', value: PRINT }]),
        }] },
      },
    })
    await prisma.designArtwork.create({
      data: { orderId: ORDER, shopifyLineId: 'dsp2-1-1', printArea: 'Main', version: 1, fileName: 'main.png', storagePath: 'x/dsp2-1-1.png', size: 10, mimeType: 'image/png', widthPx: 100, heightPx: 100 },
    })
    await syncDesignTasks(ORDER)
    await prisma.designTask.updateMany({ where: { orderId: ORDER }, data: { status: 'REVIEW' } })
    await transitionTask('DSP2_1', actor, { to: 'DONE' })
    await prisma.designTask.updateMany({ where: { orderId: ORDER }, data: { dueAt: new Date('2026-11-02T00:00:00Z') } })
    token = await signToken({ userId, email: EMAIL, name: 'Dsp2', role: 'ADMIN', permissions: [], tv: 0 })
  })
  afterAll(async () => {
    await prisma.order.deleteMany({ where: { projectId: PROJECT } })
    await prisma.shopifyStore.deleteMany({ where: { shop: SHOP } })
    await prisma.supplierProduct.deleteMany({ where: { supplierId: SUP } })
    await prisma.supplier.deleteMany({ where: { id: SUP } })
    await prisma.appUser.deleteMany({ where: { email: EMAIL } })
    await prisma.project.deleteMany({ where: { id: PROJECT } })
  })

  it('the hub card shows the earliest non-cancelled due and the order counts as overdue', async () => {
    expect(await countPendingHandoff()).toBeGreaterThanOrEqual(1)
    expect(await countPendingHandoff({ storeIds: [storeId] })).toBe(1)
    const hub = await listHandoffHub({ q: 'DSP2' })
    const card = hub.pending.find(c => c.order.id === ORDER)!
    expect(card.dueAt).toBe('2026-11-02T00:00:00.000Z')
    expect(await countOverdueHandoff({ storeIds: [storeId], now: new Date('2026-10-15T00:00:00Z') })).toBe(0)
    expect(await countOverdueHandoff({ storeIds: [storeId], now: new Date('2026-11-03T00:00:00Z') })).toBe(1)
  })
  it('GET /api/design-studio/tasks returns handoffOverdue', async () => {
    const req = new NextRequest('http://x/api/design-studio/tasks')
    req.cookies.set(AUTH_COOKIE, token)
    const body = await (await getTasks(req)).json()
    expect(typeof body.handoffOverdue).toBe('number')
    expect(body.handoffOverdue).toBeGreaterThanOrEqual(1)
  })
})
