import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateWorkerToken, revokeWorkerToken } from '@/lib/artwork-worker'
import { mintHashedToken, revokeHashedToken } from '@/lib/hashed-token'
import { DELIVERY_SWITCH_KEY } from '@/lib/delivery/guard'
import { setDeliveryDriveForTests } from '@/lib/delivery/drive'
import type { DeliveryFile } from '@/lib/delivery/types'

const hooks = vi.hoisted(() => ({ transitionThrows: null as string | null }))
vi.mock('@/lib/delivery/queue', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/delivery/queue')>()
  return { ...real, memoryPressure: () => null }
})
vi.mock('@/lib/design-tasks', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/design-tasks')>()
  return {
    ...real,
    transitionTask: async (...args: Parameters<typeof real.transitionTask>) => {
      if (hooks.transitionThrows) throw new Error(hooks.transitionThrows)
      return real.transitionTask(...args)
    },
  }
})
import { POST as COMMIT } from '@/app/api/design-studio/worker/delivery/tasks/[key]/commit/route'
import { POST as NOTE } from '@/app/api/design-studio/worker/delivery/tasks/[key]/note/route'
import { APPROVE_TOKEN_KEY, LOCAL_APPROVER_KEY, LOCAL_APPROVE_EVENT, verifyApproveToken } from '@/lib/delivery/approve'
import { agentFixture } from './helpers/design-agent-fixture'
import { fakeDrive } from './helpers/delivery-fake-drive'

const fx = agentFixture('LRQ')
const TPL_SKU = 'LRQ-FB'
const MISSING_WARNING = 'Không duyệt được: thiếu phần'
let n = 0
let workerToken = ''
let approveToken = ''
let ownerId = ''
let supportId = ''

function file(printArea: string, driveFileId: string): DeliveryFile {
  return { kind: 'PRINT', printArea, driveFileId, fileName: `${printArea.toLowerCase()}.png`, size: 100, mimeType: 'image/png', widthPx: 1000, heightPx: 1000, shortcutOf: null }
}

type Line = { orderId: string; taskKey: string; drive: ReturnType<typeof fakeDrive>; ids: Record<string, string> }

async function line(opts: { status?: string; arts?: string[] } = {}): Promise<Line> {
  const o = await fx.order(++n, { supplierSku: TPL_SKU, taskStatus: opts.status })
  const taskKey = o.taskKeys[0]
  const drive = fakeDrive()
  const ids: Record<string, string> = {}
  for (const area of opts.arts ?? []) {
    const driveFileId = `lrq-${n}-${area}-1`
    const row = await prisma.designArtwork.create({ data: {
      orderId: o.orderId, shopifyLineId: 'l1', kind: 'PRINT', printArea: area, version: 1, fileName: `${area.toLowerCase()}.png`,
      storage: 'DRIVE', driveFileId, drivePlace: 'TASK', size: 100, mimeType: 'image/png', widthPx: 1000, heightPx: 1000, source: 'AUTO',
    } })
    ids[area] = row.id
    drive.addFile({ id: driveFileId, parent: `task-${o.orderId}-l1`, size: 100, mimeType: 'image/png' })
  }
  if (opts.arts?.length) await prisma.designTask.updateMany({ where: { orderId: o.orderId }, data: { readiness: 'AUTO' } })
  const task = await prisma.designTask.findUniqueOrThrow({ where: { taskKey } })
  await prisma.designTaskEvent.deleteMany({ where: { taskId: task.id } })
  setDeliveryDriveForTests(drive)
  return { orderId: o.orderId, taskKey, drive, ids }
}

function upload(l: Line, files: DeliveryFile[]) {
  for (const f of files) l.drive.addFile({ id: f.driveFileId, parent: `incoming-${l.taskKey}`, size: f.size, mimeType: f.mimeType })
  return files
}

function push(l: Line, files: DeliveryFile[], over: Record<string, unknown> = {}) {
  return { action: 'push', expected: { status: 'NEW', liveIds: [] }, files: upload(l, files), retire: [], ...over }
}

const commit = (key: string, body: unknown, headers: Record<string, string> = { 'x-delivery-approve': approveToken }) =>
  COMMIT(
    new NextRequest(`http://localhost/api/design-studio/worker/delivery/tasks/${key}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workerToken}`, ...headers },
      body: JSON.stringify(body),
    }),
    { params: { key } },
  )

const note = (key: string, body: unknown, auth = true) =>
  NOTE(
    new NextRequest(`http://localhost/api/design-studio/worker/delivery/tasks/${key}/note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${workerToken}` } : {}) },
      body: JSON.stringify(body),
    }),
    { params: { key } },
  )

const eventsOf = (taskKey: string) => prisma.designTaskEvent.findMany({ where: { task: { taskKey } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
const taskOf = (taskKey: string) => prisma.designTask.findUniqueOrThrow({ where: { taskKey } })
const liveOf = (orderId: string) => prisma.designArtwork.findMany({ where: { orderId, removedAt: null } })
const setApprover = (value: string | null) => value === null
  ? prisma.appSetting.deleteMany({ where: { key: LOCAL_APPROVER_KEY } })
  : prisma.appSetting.upsert({ where: { key: LOCAL_APPROVER_KEY }, update: { value }, create: { key: LOCAL_APPROVER_KEY, value } })

async function expectNothingWritten(l: Line, status = 'NEW', artworks = 0) {
  expect(await liveOf(l.orderId)).toHaveLength(artworks)
  expect(await eventsOf(l.taskKey)).toHaveLength(0)
  expect((await taskOf(l.taskKey)).status).toBe(status)
}

beforeAll(async () => {
  await fx.cleanup()
  await fx.seed()
  await prisma.printTemplate.deleteMany({ where: { supplierId: fx.supplierId } })
  const areas = JSON.stringify([{ name: 'Front', x: 0, y: 0, w: 1000, h: 1000 }, { name: 'Back', x: 1000, y: 0, w: 1000, h: 1000 }])
  await prisma.printTemplate.create({ data: { supplierId: fx.supplierId, supplierSku: TPL_SKU, name: 'LRQ Front Back', widthPx: 2000, heightPx: 1000, areas } })
  workerToken = await generateWorkerToken()
  approveToken = await mintHashedToken('dap_', APPROVE_TOKEN_KEY)
  ownerId = (await fx.user('owner', 'ADMIN')).actor.id
  supportId = (await fx.user('support', 'SUPPORT')).actor.id
  await prisma.appSetting.upsert({ where: { key: DELIVERY_SWITCH_KEY }, update: { value: 'true' }, create: { key: DELIVERY_SWITCH_KEY, value: 'true' } })
})

afterEach(async () => {
  hooks.transitionThrows = null
  await setApprover(ownerId)
  await prisma.appSetting.upsert({ where: { key: DELIVERY_SWITCH_KEY }, update: { value: 'true' }, create: { key: DELIVERY_SWITCH_KEY, value: 'true' } })
})

afterAll(async () => {
  setDeliveryDriveForTests(null)
  await prisma.appSetting.deleteMany({ where: { key: { in: [DELIVERY_SWITCH_KEY, LOCAL_APPROVER_KEY] } } })
  await revokeHashedToken(APPROVE_TOKEN_KEY)
  await revokeWorkerToken()
  await prisma.printTemplate.deleteMany({ where: { supplierId: fx.supplierId } })
  await fx.cleanup()
})

describe('verifyApproveToken', () => {
  it('takes the token raw or as Bearer, and never the worker token', async () => {
    expect(await verifyApproveToken(approveToken)).toBe(true)
    expect(await verifyApproveToken(`Bearer ${approveToken}`)).toBe(true)
    expect(await verifyApproveToken(workerToken)).toBe(false)
    expect(await verifyApproveToken('dap_wrong')).toBe(false)
    expect(await verifyApproveToken(null)).toBe(false)
    expect(await verifyApproveToken('')).toBe(false)
  })
})

describe('commit with approve', () => {
  it('a full push with approve lands in DONE through the app approval, signed by the local approver', async () => {
    await setApprover(ownerId)
    const l = await line()
    const res = await commit(l.taskKey, push(l, [file('Front', 'lrq-a1-f'), file('Back', 'lrq-a1-b')], { approve: true }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, status: 'DONE', missing: [], alreadyApplied: false })
    expect(body.warnings).toEqual([])
    expect(body).not.toHaveProperty('wouldApprove')
    expect((await taskOf(l.taskKey)).status).toBe('DONE')
    expect(await liveOf(l.orderId)).toHaveLength(2)
    const events = await eventsOf(l.taskKey)
    expect(events.find(e => e.type === 'STATUS' && e.message === 'Duyệt design')?.actorId).toBe(ownerId)
    const local = events.filter(e => e.message === LOCAL_APPROVE_EVENT)
    expect(local).toHaveLength(1)
    expect(local[0]).toMatchObject({ type: 'SYSTEM', actorId: ownerId })
    expect((await prisma.orderLine.findFirstOrThrow({ where: { orderId: l.orderId } })).designDriveLink).toBeTruthy()
  })

  it('a replace on a REJECTED line with approve goes REVIEW then DONE', async () => {
    const l = await line({ status: 'REJECTED', arts: ['Front', 'Back'] })
    const files = upload(l, [file('Back', 'lrq-rj-b2')])
    const res = await commit(l.taskKey, { action: 'replace', expected: { status: 'REJECTED', liveIds: Object.values(l.ids) }, files, retire: [l.ids.Back], approve: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, status: 'DONE', missing: [] })
    expect((await eventsOf(l.taskKey)).filter(e => e.message === LOCAL_APPROVE_EVENT)).toHaveLength(1)
  })

  it('approve without a valid X-Delivery-Approve is 403 approve_token and writes nothing', async () => {
    for (const headers of [{}, { 'x-delivery-approve': 'dap_wrong' }, { 'x-delivery-approve': workerToken }] as Record<string, string>[]) {
      const l = await line()
      const res = await commit(l.taskKey, push(l, [file('Front', `lrq-t${n}-f`), file('Back', `lrq-t${n}-b`)], { approve: true }), headers)
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('approve_token')
      await expectNothingWritten(l)
    }
  })

  it('no approver, an unknown or inactive approver, or one without the approve right is 409 approve_not_allowed and writes nothing', async () => {
    const inactive = (await fx.user('gone', 'ADMIN')).actor.id
    await prisma.appUser.update({ where: { id: inactive }, data: { status: 'INACTIVE' } })
    for (const approver of [null, '', 'no-such-user', inactive, supportId]) {
      await setApprover(approver)
      const l = await line()
      const res = await commit(l.taskKey, push(l, [file('Front', `lrq-na${n}-f`), file('Back', `lrq-na${n}-b`)], { approve: true }))
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe('approve_not_allowed')
      await expectNothingWritten(l)
      const dry = await commit(l.taskKey, push(l, [], { files: [file('Front', `lrq-na${n}-f`)], approve: true, dryRun: true }))
      expect(dry.status).toBe(409)
    }
  })

  it('a push that leaves a part missing writes the file, stays NEW and warns', async () => {
    const l = await line()
    const res = await commit(l.taskKey, push(l, [file('Front', 'lrq-m1-f')], { approve: true }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, status: 'NEW', missing: ['Back'] })
    expect(body.warnings).toContain(MISSING_WARNING)
    expect((await taskOf(l.taskKey)).status).toBe('NEW')
    expect(await liveOf(l.orderId)).toHaveLength(1)
    expect((await eventsOf(l.taskKey)).some(e => e.message === LOCAL_APPROVE_EVENT)).toBe(false)
  })

  it('an approval the app refuses keeps the files, leaves REVIEW and warns with the reason', async () => {
    hooks.transitionThrows = 'File in/cắt lệch khổ'
    const l = await line()
    const res = await commit(l.taskKey, push(l, [file('Front', 'lrq-x1-f'), file('Back', 'lrq-x1-b')], { approve: true }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, status: 'REVIEW' })
    expect(body.warnings).toContain('Không duyệt được: File in/cắt lệch khổ')
    expect((await taskOf(l.taskKey)).status).toBe('REVIEW')
    expect(await liveOf(l.orderId)).toHaveLength(2)
    expect((await eventsOf(l.taskKey)).some(e => e.message === LOCAL_APPROVE_EVENT)).toBe(false)
  })

  it('an already applied resend with approve approves a REVIEW task', async () => {
    const l = await line()
    const body = push(l, [file('Front', 'lrq-r1-f'), file('Back', 'lrq-r1-b')])
    expect(await (await commit(l.taskKey, body, {})).json()).toMatchObject({ ok: true, status: 'REVIEW' })
    const res = await commit(l.taskKey, { ...body, approve: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, status: 'DONE', alreadyApplied: true })
    expect((await taskOf(l.taskKey)).status).toBe('DONE')
    expect((await eventsOf(l.taskKey)).filter(e => e.message === LOCAL_APPROVE_EVENT)).toHaveLength(1)
  })

  it('an already applied resend with approve and without a token is still 403', async () => {
    const l = await line()
    const body = push(l, [file('Front', 'lrq-r2-f'), file('Back', 'lrq-r2-b')])
    await commit(l.taskKey, body, {})
    const res = await commit(l.taskKey, { ...body, approve: true }, {})
    expect(res.status).toBe(403)
    expect((await taskOf(l.taskKey)).status).toBe('REVIEW')
  })

  it('a replace on a DONE line ignores approve and stays DONE', async () => {
    const l = await line({ status: 'DONE', arts: ['Front', 'Back'] })
    const files = upload(l, [file('Front', 'lrq-d1-f2')])
    const res = await commit(l.taskKey, {
      action: 'replace', expected: { status: 'DONE', liveIds: Object.values(l.ids) }, files, retire: [l.ids.Front], allowFinished: true, approve: true,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, status: 'DONE' })
    expect(body.warnings.filter((w: string) => w.startsWith('Không duyệt được'))).toEqual([])
    expect((await eventsOf(l.taskKey)).some(e => e.message === LOCAL_APPROVE_EVENT)).toBe(false)
  })

  it('approve is refused with retire and revert, and must be true/false', async () => {
    const l = await line({ status: 'REVIEW', arts: ['Front', 'Back'] })
    const retire = await commit(l.taskKey, { action: 'retire', expected: { status: 'REVIEW', liveIds: Object.values(l.ids) }, files: [], retire: [l.ids.Front], approve: true })
    expect(retire.status).toBe(400)
    const revert = await commit(l.taskKey, { action: 'revert', expected: { status: 'REVIEW', liveIds: Object.values(l.ids) }, files: [], retire: [], approve: true })
    expect(revert.status).toBe(400)
    const odd = await commit(l.taskKey, { action: 'push', expected: { status: 'REVIEW', liveIds: Object.values(l.ids) }, files: [file('Front', 'lrq-o1')], retire: [], approve: 'yes' })
    expect(odd.status).toBe(400)
    await expectNothingWritten(l, 'REVIEW', 2)
  })

  it('dryRun with approve reports wouldApprove and writes nothing', async () => {
    const full = await line()
    const yes = await commit(full.taskKey, push(full, [file('Front', 'lrq-dr1-f'), file('Back', 'lrq-dr1-b')], { approve: true, dryRun: true }))
    expect(yes.status).toBe(200)
    expect(await yes.json()).toMatchObject({ ok: true, wouldApprove: true, missing: [] })
    await expectNothingWritten(full)

    const part = await line()
    const no = await commit(part.taskKey, push(part, [file('Front', 'lrq-dr2-f')], { approve: true, dryRun: true }))
    expect(await no.json()).toMatchObject({ ok: true, wouldApprove: false, missing: ['Back'] })
    await expectNothingWritten(part)

    const done = await line({ status: 'DONE', arts: ['Front', 'Back'] })
    const files = upload(done, [file('Front', 'lrq-dr3-f2')])
    const ignored = await commit(done.taskKey, {
      action: 'replace', expected: { status: 'DONE', liveIds: Object.values(done.ids) }, files, retire: [done.ids.Front], allowFinished: true, approve: true, dryRun: true,
    })
    expect(await ignored.json()).toMatchObject({ ok: true, wouldApprove: false })

    const plain = await line()
    const noFlag = await commit(plain.taskKey, push(plain, [file('Front', 'lrq-dr4-f'), file('Back', 'lrq-dr4-b')], { dryRun: true }), {})
    expect(await noFlag.json()).not.toHaveProperty('wouldApprove')
  })

  it('a dryRun resend with approve on a REVIEW task would approve and writes nothing', async () => {
    const l = await line()
    const body = push(l, [file('Front', 'lrq-dr5-f'), file('Back', 'lrq-dr5-b')])
    await commit(l.taskKey, body, {})
    const before = (await eventsOf(l.taskKey)).length
    const res = await commit(l.taskKey, { ...body, approve: true, dryRun: true })
    expect(await res.json()).toMatchObject({ ok: true, status: 'REVIEW', alreadyApplied: true, wouldApprove: true })
    expect((await taskOf(l.taskKey)).status).toBe('REVIEW')
    expect(await eventsOf(l.taskKey)).toHaveLength(before)
  })

  it('without approve the token is not needed and the task stops at REVIEW', async () => {
    const l = await line()
    const res = await commit(l.taskKey, push(l, [file('Front', 'lrq-p1-f'), file('Back', 'lrq-p1-b')]), {})
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, status: 'REVIEW' })
  })
})

describe('POST delivery note', () => {
  it('writes one SYSTEM event with no actor and leaves the task as it is', async () => {
    const l = await line()
    const res = await note(l.taskKey, { message: 'Đang chờ chủ shop duyệt ở máy local (tối đa 3 giờ)' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const events = await eventsOf(l.taskKey)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'SYSTEM', message: 'Đang chờ chủ shop duyệt ở máy local (tối đa 3 giờ)', actorId: null })
    expect((await taskOf(l.taskKey)).status).toBe('NEW')
  })

  it('needs the worker token and the delivery switch', async () => {
    const l = await line()
    expect((await note(l.taskKey, { message: 'x' }, false)).status).toBe(401)
    await prisma.appSetting.update({ where: { key: DELIVERY_SWITCH_KEY }, data: { value: 'false' } })
    const off = await note(l.taskKey, { message: 'x' })
    expect(off.status).toBe(503)
    expect((await off.json()).code).toBe('disabled')
    expect(await eventsOf(l.taskKey)).toHaveLength(0)
  })

  it('404 for an unknown task, 400 for an empty, non-text or over-500-character message', async () => {
    const unknown = await note('NOPE-LRQ', { message: 'x' })
    expect(unknown.status).toBe(404)
    const l = await line()
    for (const body of [{}, { message: '' }, { message: '   ' }, { message: 5 }, { message: 'a'.repeat(501) }]) {
      const res = await note(l.taskKey, body)
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('bad_request')
    }
    expect((await note(l.taskKey, { message: 'a'.repeat(500) })).status).toBe(200)
    expect(await eventsOf(l.taskKey)).toHaveLength(1)
  })
})
