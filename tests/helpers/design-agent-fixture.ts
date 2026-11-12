import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { syncDesignTasks, type Actor } from '@/lib/design-tasks'
import { lineKeysOf } from '@/lib/order-lines'

type OrderOpts = {
  skus?: string[]
  taskStatus?: string
  exported?: boolean
  pipelineStatus?: string
  fulfillmentStatus?: string | null
  placedAt?: Date | string
  supplierSku?: string | null
  withPrint?: boolean
  otherStore?: boolean
}

export function agentFixture(prefix: string) {
  const P = prefix.toUpperCase()
  const ids = {
    project: `proj_${prefix}`, project2: `proj2_${prefix}`, supplier: `sup_${prefix}`,
    shop: `${prefix}.myshopify.com`, shop2: `${prefix}-b.myshopify.com`, supplierCode: `${P}SUP`,
  }
  const emails: string[] = []
  let storeId = ''
  let otherStoreId = ''
  let supplierId = ''

  async function seed() {
    await prisma.project.upsert({ where: { id: ids.project }, create: { id: ids.project, name: P, startDate: new Date('2026-06-01') }, update: {} })
    await prisma.project.upsert({ where: { id: ids.project2 }, create: { id: ids.project2, name: `${P}2`, startDate: new Date('2026-06-01') }, update: {} })
    storeId = (await prisma.shopifyStore.upsert({ where: { shop: ids.shop }, create: { shop: ids.shop, projectId: ids.project }, update: {} })).id
    otherStoreId = (await prisma.shopifyStore.upsert({ where: { shop: ids.shop2 }, create: { shop: ids.shop2, projectId: ids.project2 }, update: {} })).id
    supplierId = (await prisma.supplier.upsert({ where: { code: ids.supplierCode }, create: { id: ids.supplier, name: `${P} Supplier`, code: ids.supplierCode }, update: {} })).id
    return { storeId, otherStoreId, supplierId }
  }

  async function order(n: number, opts: OrderOpts = {}) {
    const skus = opts.skus ?? ['DN1-Hoodie']
    const orderNumber = `#${P}${n}`
    const orderId = `gid://test/Order/${prefix}-${n}`
    await prisma.order.create({
      data: {
        id: orderId, projectId: opts.otherStore ? ids.project2 : ids.project, storeId: opts.otherStore ? otherStoreId : storeId,
        shopifyOrderNumber: orderNumber, financialStatus: 'PAID', currency: 'USD',
        grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0,
        placedAt: opts.placedAt ? new Date(opts.placedAt) : new Date('2026-11-01'),
        pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
        lines: { create: skus.map((sku, i) => ({
          shopifyLineId: `l${i + 1}`, sku, productTitle: 'Hoodie', shopifyProductType: 'Hoodie', qty: 1, linePosition: i + 1, unitPrice: 1,
          resolvedSupplierId: supplierId, resolvedSupplierSku: opts.supplierSku ?? null, customized: true,
          customAttributesJson: JSON.stringify([{ key: 'Name', value: 'X' }]),
        })) },
      },
    })
    await syncDesignTasks(orderId)
    const lines = (await prisma.orderLine.findMany({ where: { orderId } })).sort((a, b) => a.linePosition - b.linePosition)
    const keys = lineKeysOf(orderNumber, lines)
    const taskKeys = lines.map(l => keys.get(l.shopifyLineId)!)
    if (opts.taskStatus) await prisma.designTask.updateMany({ where: { orderId }, data: { status: opts.taskStatus } })
    if (opts.exported) await prisma.orderLine.updateMany({ where: { orderId }, data: { exportedAt: new Date('2026-11-02'), exportedToSupplierId: supplierId } })
    if (opts.pipelineStatus || opts.fulfillmentStatus !== undefined) {
      await prisma.order.update({ where: { id: orderId }, data: {
        ...(opts.pipelineStatus ? { pipelineStatus: opts.pipelineStatus } : {}),
        ...(opts.fulfillmentStatus !== undefined ? { fulfillmentStatus: opts.fulfillmentStatus } : {}),
      } })
    }
    if (opts.withPrint) {
      for (const l of lines) {
        await prisma.designArtwork.create({ data: { orderId, shopifyLineId: l.shopifyLineId, printArea: 'PRINT', version: 1, fileName: 'a.png', storagePath: `x/${prefix}-${n}.png`, size: 1, mimeType: 'image/png' } })
      }
    }
    return { orderId, orderNumber, taskKeys }
  }

  async function user(key: string, role: string, permissions: string[] = []): Promise<{ actor: Actor; cookie: string }> {
    process.env.AUTH_SECRET ||= 'test-secret-that-is-long-enough-32chars'
    const email = `${prefix}-${key}@dag.test`
    emails.push(email)
    const row = await prisma.appUser.upsert({
      where: { email }, create: { name: key, email, role, permissions: JSON.stringify(permissions) }, update: {},
    })
    const token = await signToken({ userId: row.id, email, name: key, role: role as any, permissions: permissions as any, tv: row.tokenVersion })
    return { actor: { id: row.id, name: key, role, permissions: permissions as any }, cookie: `${AUTH_COOKIE}=${token}` }
  }

  async function cleanup() {
    await prisma.order.deleteMany({ where: { id: { startsWith: `gid://test/Order/${prefix}-` } } })
    await prisma.supplier.deleteMany({ where: { code: ids.supplierCode } })
    await prisma.shopifyStore.deleteMany({ where: { shop: { in: [ids.shop, ids.shop2] } } })
    await prisma.project.deleteMany({ where: { id: { in: [ids.project, ids.project2] } } })
    if (emails.length) await prisma.appUser.deleteMany({ where: { email: { in: emails } } })
  }

  return {
    seed, order, user, cleanup,
    get storeId() { return storeId },
    get otherStoreId() { return otherStoreId },
    get supplierId() { return supplierId },
  }
}
