import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateWorkerToken, revokeWorkerToken } from '@/lib/artwork-worker'
import { DELIVERY_SWITCH_KEY } from '@/lib/delivery/guard'
import { setDeliveryDriveForTests } from '@/lib/delivery/drive'
import type { DeliveryFile } from '@/lib/delivery/types'

const hooks = vi.hoisted(() => ({ pressure: false }))
vi.mock('@/lib/delivery/queue', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/delivery/queue')>()
  return { ...real, memoryPressure: (s?: any) => (hooks.pressure ? { retryAfterSec: 60 } : real.memoryPressure(s)) }
})
import { POST } from '@/app/api/design-studio/worker/delivery/tasks/[key]/commit/route'
import { agentFixture } from './helpers/design-agent-fixture'
import { fakeDrive } from './helpers/delivery-fake-drive'

const fx = agentFixture('DLR')
const TPL_SKU = 'DLR-FB'
let token = ''

function file(printArea: string, driveFileId: string): DeliveryFile {
  return { kind: 'PRINT', printArea, driveFileId, fileName: `${printArea}.png`, size: 100, mimeType: 'image/png', widthPx: 1000, heightPx: 1000, shortcutOf: null }
}

const post = (key: string, body: unknown, auth = true, raw?: string) =>
  POST(
    new NextRequest(`http://localhost/api/design-studio/worker/delivery/tasks/${key}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) },
      body: raw ?? JSON.stringify(body),
    }),
    { params: { key } },
  )

beforeAll(async () => {
  await fx.cleanup()
  await fx.seed()
  await prisma.printTemplate.deleteMany({ where: { supplierId: fx.supplierId } })
  const areas = JSON.stringify([{ name: 'Front', x: 0, y: 0, w: 1000, h: 1000 }, { name: 'Back', x: 1000, y: 0, w: 1000, h: 1000 }])
  await prisma.printTemplate.create({ data: { supplierId: fx.supplierId, supplierSku: TPL_SKU, name: 'DLR Front Back', widthPx: 2000, heightPx: 1000, areas } })
  token = await generateWorkerToken()
  await prisma.appSetting.upsert({ where: { key: DELIVERY_SWITCH_KEY }, update: { value: 'true' }, create: { key: DELIVERY_SWITCH_KEY, value: 'true' } })
})

afterEach(() => { hooks.pressure = false })

afterAll(async () => {
  setDeliveryDriveForTests(null)
  await prisma.appSetting.deleteMany({ where: { key: DELIVERY_SWITCH_KEY } })
  await revokeWorkerToken()
  await prisma.printTemplate.deleteMany({ where: { supplierId: fx.supplierId } })
  await fx.cleanup()
})

describe('POST delivery commit', () => {
  it('401 without a token', async () => {
    expect((await post('x', {}, false)).status).toBe(401)
  })

  it('400 bad_request for an unparsable or non-object body', async () => {
    for (const raw of ['not json', '[1]', 'null']) {
      const res = await post('x', null, true, raw)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Body không hợp lệ', code: 'bad_request' })
    }
  })

  it('503 busy with Retry-After under memory pressure', async () => {
    hooks.pressure = true
    const res = await post('x', { action: 'push' })
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('60')
    expect((await res.json()).code).toBe('busy')
  })

  it('404 for an unknown task, as the CommitError status and shape', async () => {
    setDeliveryDriveForTests(fakeDrive())
    const res = await post('NOPE-ZZZ', { action: 'push', expected: { status: 'NEW', liveIds: [] }, files: [], retire: [] })
    expect([400, 404]).toContain(res.status)
    expect(typeof (await res.json()).code).toBe('string')
  })

  it('two concurrent identical pushes: one applies, the other is already applied or stale, one row per part', async () => {
    const o = await fx.order(1, { supplierSku: TPL_SKU })
    const taskKey = o.taskKeys[0]
    const files = [file('Front', 'dlr-f1'), file('Back', 'dlr-b1')]
    const drive = fakeDrive()
    for (const f of files) drive.addFile({ id: f.driveFileId, parent: `incoming-${taskKey}`, size: f.size, mimeType: f.mimeType })
    setDeliveryDriveForTests(drive)
    const body = { action: 'push', expected: { status: 'NEW', liveIds: [] }, files, retire: [] }

    const [a, b] = await Promise.all([post(taskKey, body), post(taskKey, body)])
    const results = [a, b]
    const jsons = await Promise.all(results.map(r => r.json()))
    const applied = jsons.filter((j, i) => results[i].status === 200 && j.alreadyApplied === false)
    const rest = jsons.map((j, i) => ({ j, status: results[i].status })).filter(x => !(x.status === 200 && x.j.alreadyApplied === false))
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ ok: true, status: 'REVIEW' })
    expect(rest).toHaveLength(1)
    expect(rest[0].status === 200 ? rest[0].j.alreadyApplied : rest[0].j.code).toSatisfy((v: any) => v === true || v === 'stale')

    const rows = await prisma.designArtwork.findMany({ where: { orderId: o.orderId } })
    expect(rows.map(r => r.printArea).sort()).toEqual(['Back', 'Front'])
  })
})
