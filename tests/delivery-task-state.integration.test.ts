import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateWorkerToken, revokeWorkerToken } from '@/lib/artwork-worker'
import { deliveryTaskState, DeliveryLineMissingError } from '@/lib/delivery/task-state'
import { setDeliveryDriveForTests } from '@/lib/delivery/drive'
import { GET } from '@/app/api/design-studio/worker/delivery/tasks/[key]/route'
import { agentFixture } from './helpers/design-agent-fixture'
import { fakeDrive } from './helpers/delivery-fake-drive'

const fx = agentFixture('DLS')
const TPL_SKU = 'DLS-FB'
let keys: string[] = []
let token = ''

const art = (orderId: string, over: Record<string, unknown>) => prisma.designArtwork.create({
  data: { orderId, shopifyLineId: 'l1', kind: 'PRINT', printArea: 'Front', version: 1, fileName: 'f.png', size: 1, mimeType: 'image/png', ...over } as any,
})

beforeAll(async () => {
  await fx.cleanup()
  await fx.seed()
  await prisma.printTemplate.deleteMany({ where: { supplierId: fx.supplierId } })
  await prisma.printTemplate.create({ data: {
    supplierId: fx.supplierId, supplierSku: TPL_SKU, name: 'DLS Front Back', widthPx: 2000, heightPx: 1000,
    areas: JSON.stringify([{ name: 'Front', x: 0, y: 0, w: 1000, h: 1000 }, { name: 'Back', x: 1000, y: 0, w: 1000, h: 1000 }]),
  } })
  const a = await fx.order(1, { supplierSku: TPL_SKU })
  const b = await fx.order(2, { supplierSku: TPL_SKU })
  const c = await fx.order(3, { supplierSku: TPL_SKU })
  keys = [a.taskKeys[0], b.taskKeys[0], c.taskKeys[0]]
  await art(b.orderId, { version: 1, removedAt: new Date(), storagePath: 'x/1' })
  await art(b.orderId, { version: 2, storagePath: 'x/2', source: 'AUTO', driveFileId: 'drv-shared' })
  await art(b.orderId, { kind: 'MOCKUP', printArea: 'Main', storagePath: 'x/3' })
  await art(c.orderId, { version: 1, driveFileId: 'drv-shared' })
  await prisma.appSetting.upsert({ where: { key: 'delivery.api.enabled' }, create: { key: 'delivery.api.enabled', value: 'true' }, update: { value: 'true' } })
  token = await generateWorkerToken()
})

afterAll(async () => {
  setDeliveryDriveForTests(null)
  await prisma.appSetting.deleteMany({ where: { key: 'delivery.api.enabled' } })
  await revokeWorkerToken()
  await prisma.printTemplate.deleteMany({ where: { supplierId: fx.supplierId } })
  await fx.cleanup()
})

describe('deliveryTaskState', () => {
  it('a task with no files lists the template parts and creates both folders once', async () => {
    const drive = fakeDrive()
    const s = await deliveryTaskState(keys[0], drive)
    expect(s).toMatchObject({
      taskKey: keys[0], status: 'NEW', orderOpen: true, sent: false,
      artworks: [], nextVersion: {}, required: ['Front', 'Back'],
      incomingFolder: { id: `incoming-${keys[0]}` },
    })
    expect(s!.folder.id).toContain('task-')
    expect(drive.calls.filter(c => c.startsWith('taskFolder:'))).toHaveLength(1)
    expect(drive.calls.filter(c => c.startsWith('incomingFolder:'))).toHaveLength(1)
  })

  it('counts removed rows in nextVersion and lists live rows only', async () => {
    const s = await deliveryTaskState(keys[1], fakeDrive())
    expect(s!.nextVersion['PRINT/Front']).toBe(3)
    expect(s!.nextVersion['MOCKUP/Main']).toBe(2)
    expect(s!.artworks.map(a => `${a.kind}/${a.printArea}/${a.version}`).sort()).toEqual(['MOCKUP/Main/1', 'PRINT/Front/2'])
    expect(s!.artworks.find(a => a.version === 2 && a.kind === 'PRINT')).toMatchObject({ source: 'AUTO', driveFileId: 'drv-shared', sharedWith: 1 })
  })

  it('reports a file shared with another line', async () => {
    const s = await deliveryTaskState(keys[2], fakeDrive())
    expect(s!.artworks[0].sharedWith).toBe(1)
  })

  it('returns null for an unknown key', async () => {
    expect(await deliveryTaskState('NOPE_9', fakeDrive())).toBeNull()
  })

  it('throws a typed error when the order line row is missing', async () => {
    const o = await fx.order(4, { supplierSku: TPL_SKU })
    await prisma.orderLine.deleteMany({ where: { orderId: o.orderId } })
    await expect(deliveryTaskState(o.taskKeys[0], fakeDrive())).rejects.toBeInstanceOf(DeliveryLineMissingError)
  })
})

describe('GET delivery/tasks/[key]', () => {
  const call = (key: string, auth = true) => GET(
    new NextRequest(`http://localhost/api/design-studio/worker/delivery/tasks/${key}`, { headers: auth ? { authorization: `Bearer ${token}` } : {} }),
    { params: { key } },
  )

  it('rejects a missing token', async () => {
    expect((await call(keys[0], false)).status).toBe(401)
  })

  it('answers 404 for an unknown key', async () => {
    setDeliveryDriveForTests(fakeDrive())
    const r = await call('NOPE_9')
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ error: 'Không tìm thấy task' })
  })

  it('answers 200 with the state', async () => {
    setDeliveryDriveForTests(fakeDrive())
    const r = await call(keys[1])
    expect(r.status).toBe(200)
    expect((await r.json()).nextVersion['PRINT/Front']).toBe(3)
  })

  it('answers 409 while the line is being re-synced', async () => {
    setDeliveryDriveForTests(fakeDrive())
    const o = await fx.order(5, { supplierSku: TPL_SKU })
    await prisma.orderLine.deleteMany({ where: { orderId: o.orderId } })
    const r = await call(o.taskKeys[0])
    expect(r.status).toBe(409)
    expect((await r.json()).error).toContain('đồng bộ lại')
  })
})
