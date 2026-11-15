import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { prisma } from '@/lib/db'

const hooks = vi.hoisted(() => ({ submitThrows: false }))
vi.mock('@/lib/design-tasks', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/design-tasks')>()
  return {
    ...real,
    submitAutoRenderForReview: async (orderId: string, shopifyLineId: string) => {
      if (hooks.submitThrows) throw new Error('db gone')
      return real.submitAutoRenderForReview(orderId, shopifyLineId)
    },
  }
})
import { AUTO_REVIEW_MESSAGE } from '@/lib/design-tasks'
import { commitDelivery } from '@/lib/delivery/commit'
import type { CommitInput, DeliveryFile } from '@/lib/delivery/types'
import { agentFixture } from './helpers/design-agent-fixture'
import { fakeDrive } from './helpers/delivery-fake-drive'

const fx = agentFixture('DLC')
const TPL_SKU = 'DLC-FB'
const OLD_SKU = 'DLC-OLD'
const PIECES_OLD_SKU = 'DLC-PCS'
const PIECES_SKU = 'DLC-PCS2'
let n = 0

async function line(opts: { sku?: string; taskStatus?: string; pipelineStatus?: string } = {}) {
  const o = await fx.order(++n, { supplierSku: opts.sku ?? TPL_SKU, taskStatus: opts.taskStatus, pipelineStatus: opts.pipelineStatus })
  return { orderId: o.orderId, taskKey: o.taskKeys[0], taskFolder: `task-${o.orderId}-l1` }
}

function file(over: Partial<DeliveryFile> & { printArea: string; driveFileId: string }): DeliveryFile {
  return { kind: 'PRINT', fileName: `${over.printArea.toLowerCase()}.png`, size: 100, mimeType: 'image/png', widthPx: 1000, heightPx: 1000, shortcutOf: null, ...over }
}

function input(files: DeliveryFile[], over: Partial<CommitInput> = {}): CommitInput {
  return { action: 'push', expected: { status: 'NEW', liveIds: [] }, files, retire: [], ...over }
}

function driveWith(taskKey: string, files: DeliveryFile[], parent = `incoming-${taskKey}`) {
  const drive = fakeDrive()
  for (const f of files) drive.addFile({ id: f.driveFileId, parent, size: f.size, mimeType: f.mimeType })
  return drive
}

const rowsOf = (orderId: string) => prisma.designArtwork.findMany({ where: { orderId }, orderBy: [{ kind: 'asc' }, { printArea: 'asc' }] })
const eventsOf = (taskKey: string) => prisma.designTaskEvent.findMany({ where: { task: { taskKey } }, orderBy: { createdAt: 'asc' } })
const taskOf = (taskKey: string) => prisma.designTask.findUniqueOrThrow({ where: { taskKey } })

async function expectNothingWritten(orderId: string, taskKey: string, status = 'NEW') {
  expect(await rowsOf(orderId)).toHaveLength(0)
  expect((await eventsOf(taskKey)).filter(e => e.type === 'ARTWORK')).toHaveLength(0)
  expect((await taskOf(taskKey)).status).toBe(status)
}

beforeAll(async () => {
  await fx.cleanup()
  await fx.seed()
  await prisma.printTemplate.deleteMany({ where: { supplierId: fx.supplierId } })
  const areas = JSON.stringify([{ name: 'Front', x: 0, y: 0, w: 1000, h: 1000 }, { name: 'Back', x: 1000, y: 0, w: 1000, h: 1000 }])
  await prisma.printTemplate.create({ data: { supplierId: fx.supplierId, supplierSku: TPL_SKU, name: 'DLC Front Back', widthPx: 2000, heightPx: 1000, areas } })
  await prisma.printTemplate.create({ data: {
    supplierId: fx.supplierId, supplierSku: OLD_SKU, name: 'DLC moved layout', widthPx: 2000, heightPx: 1000, areas,
    altAreas: JSON.stringify([{
      label: 'Layout cũ', widthPx: 1800, heightPx: 900, filesUntil: '2026-11-01',
      areas: [{ name: 'Front', x: 0, y: 0, w: 900, h: 900 }, { name: 'Back', x: 900, y: 0, w: 900, h: 900 }],
    }]),
  } })
  const pieces = (filesUntil?: string) => JSON.stringify([{
    label: 'Bộ mảnh', widthPx: 1600, heightPx: 800, ...(filesUntil ? { filesUntil } : {}),
    areas: [{ name: 'Back Left', x: 0, y: 0, w: 400, h: 800 }, { name: 'Back Right', x: 400, y: 0, w: 400, h: 800 }, { name: 'Front', x: 800, y: 0, w: 800, h: 800 }],
  }])
  await prisma.printTemplate.create({ data: {
    supplierId: fx.supplierId, supplierSku: PIECES_OLD_SKU, name: 'DLC expired pieces', widthPx: 2000, heightPx: 1000, areas, altAreas: pieces('2026-11-01'),
  } })
  await prisma.printTemplate.create({ data: {
    supplierId: fx.supplierId, supplierSku: PIECES_SKU, name: 'DLC pieces', widthPx: 2000, heightPx: 1000, areas, altAreas: pieces(),
  } })
})

afterEach(() => { hooks.submitThrows = false })

afterAll(async () => {
  await prisma.printTemplate.deleteMany({ where: { supplierId: fx.supplierId } })
  await fx.cleanup()
})

describe('commitDelivery push', () => {
  it('Front + Back on a NEW task writes two AUTO rows, moves to REVIEW and tidies', async () => {
    const l = await line()
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-f1' }), file({ printArea: 'Back', driveFileId: 'dlc-b1' })]
    const drive = driveWith(l.taskKey, files)
    const r = await commitDelivery(l.taskKey, input(files), drive)
    expect(r).toMatchObject({ ok: true, status: 'REVIEW', missing: [], retired: [], alreadyApplied: false })

    const rows = await rowsOf(l.orderId)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row).toMatchObject({
        source: 'AUTO', storage: 'DRIVE', storagePath: null, version: 1, uploadedById: null, drivePlace: null, previewPath: null,
        size: 100, mimeType: 'image/png', widthPx: 1000, heightPx: 1000,
      })
      expect(row.driveWebViewLink).toBe(`https://drive.google.com/file/d/${row.driveFileId}/view?usp=drivesdk`)
    }
    expect(rows.map(x => `${x.printArea}:${x.driveFileId}`).sort()).toEqual(['Back:dlc-b1', 'Front:dlc-f1'])

    const task = await taskOf(l.taskKey)
    expect(task).toMatchObject({ status: 'REVIEW', readiness: 'AUTO' })
    const events = await eventsOf(l.taskKey)
    const artwork = events.filter(e => e.type === 'ARTWORK')
    const system = events.filter(e => e.type === 'SYSTEM' && e.message === AUTO_REVIEW_MESSAGE)
    expect(artwork.map(e => e.message)).toEqual(['Render tự động (máy local 25/10) · 2 mảnh: Front v1, Back v1'])
    expect(artwork[0].actorId).toBeNull()
    expect(system).toHaveLength(1)
    expect(artwork[0].createdAt.getTime()).toBeLessThanOrEqual(system[0].createdAt.getTime())
    expect(drive.calls).toContain(`tidy:${l.orderId}`)
    if (r.ok) expect(r.artworks.map(a => `${a.printArea} v${a.version}`).sort()).toEqual(['Back v1', 'Front v1'])
  })

  it('Front only writes one row, keeps the task NEW and reports Back missing', async () => {
    const l = await line()
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-f2', fileName: 'front-noname.png', widthPx: 1000, heightPx: 1000 })]
    const r = await commitDelivery(l.taskKey, input(files), driveWith(l.taskKey, files))
    expect(r).toMatchObject({ ok: true, status: 'NEW', missing: ['Back'] })
    expect(await rowsOf(l.orderId)).toHaveLength(1)
    expect((await taskOf(l.taskKey)).status).toBe('NEW')
    expect((await eventsOf(l.taskKey)).filter(e => e.type === 'ARTWORK').map(e => e.message))
      .toEqual(['Render tự động (máy local 25/10) · Front v1 · 1000×1000 px · khách không đặt tên'])
  })

  it('the same request sent again with the old expected is already applied and writes nothing more', async () => {
    const l = await line()
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-f3' }), file({ printArea: 'Back', driveFileId: 'dlc-b3' })]
    const drive = driveWith(l.taskKey, files)
    const first = await commitDelivery(l.taskKey, input(files), drive)
    expect(first).toMatchObject({ ok: true, alreadyApplied: false })
    const eventsBefore = (await eventsOf(l.taskKey)).length

    const again = await commitDelivery(l.taskKey, input(files, { expected: { status: 'NEW', liveIds: [] } }), drive)
    expect(again).toMatchObject({ ok: true, alreadyApplied: true, status: 'REVIEW' })
    if (again.ok) expect(again.artworks.map(a => a.printArea).sort()).toEqual(['Back', 'Front'])
    expect(await rowsOf(l.orderId)).toHaveLength(2)
    expect((await eventsOf(l.taskKey)).length).toBe(eventsBefore)
  })

  async function landedWithoutSubmit(taskStatus?: string) {
    const l = await line({ taskStatus })
    const files = [file({ printArea: 'Front', driveFileId: `dlc-r${n}f` }), file({ printArea: 'Back', driveFileId: `dlc-r${n}b` })]
    for (const f of files) {
      await prisma.designArtwork.create({ data: {
        orderId: l.orderId, shopifyLineId: 'l1', kind: f.kind, printArea: f.printArea, version: 1, fileName: f.fileName, storage: 'DRIVE',
        driveFileId: f.driveFileId, size: f.size, mimeType: f.mimeType, widthPx: 1000, heightPx: 1000, source: 'AUTO',
      } })
    }
    return { l, files, drive: driveWith(l.taskKey, files) }
  }

  it('a resend after rows landed but the task was never submitted moves a NEW task to REVIEW', async () => {
    const { l, files, drive } = await landedWithoutSubmit()
    const r = await commitDelivery(l.taskKey, input(files), drive)
    expect(r).toMatchObject({ ok: true, alreadyApplied: true, status: 'REVIEW', missing: [] })
    expect(await taskOf(l.taskKey)).toMatchObject({ status: 'REVIEW', readiness: 'AUTO' })
    expect((await eventsOf(l.taskKey)).filter(e => e.message === AUTO_REVIEW_MESSAGE)).toHaveLength(1)
    expect(await rowsOf(l.orderId)).toHaveLength(2)
  })

  it('a resend leaves a task a person moved since (REJECTED) where it is', async () => {
    const { l, files, drive } = await landedWithoutSubmit('REJECTED')
    const r = await commitDelivery(l.taskKey, input(files), drive)
    expect(r).toMatchObject({ ok: true, alreadyApplied: true, status: 'REJECTED' })
    expect((await taskOf(l.taskKey)).status).toBe('REJECTED')
    expect((await eventsOf(l.taskKey)).filter(e => e.message === AUTO_REVIEW_MESSAGE)).toHaveLength(0)
  })

  it('a dryRun resend never moves the task', async () => {
    const { l, files, drive } = await landedWithoutSubmit()
    const r = await commitDelivery(l.taskKey, input(files, { dryRun: true }), drive)
    expect(r).toMatchObject({ ok: true, alreadyApplied: true, status: 'NEW' })
    expect((await taskOf(l.taskKey)).status).toBe('NEW')
  })

  it('a status that moved since the read is 409 stale with the current state', async () => {
    const l = await line({ taskStatus: 'DOING' })
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-f4' })]
    const r = await commitDelivery(l.taskKey, input(files), driveWith(l.taskKey, files))
    expect(r).toMatchObject({ ok: false, code: 'stale', httpStatus: 409 })
    if (!r.ok) expect(r.current?.status).toBe('DOING')
    await expectNothingWritten(l.orderId, l.taskKey, 'DOING')
  })

  it('live ids that differ from expected are 409 stale', async () => {
    const l = await line()
    await prisma.designArtwork.create({ data: {
      orderId: l.orderId, shopifyLineId: 'l1', kind: 'MOCKUP', printArea: 'Main', version: 1, fileName: 'm.jpg', size: 1, mimeType: 'image/jpeg', storagePath: 'x/m',
    } })
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-f4b' })]
    const r = await commitDelivery(l.taskKey, input(files), driveWith(l.taskKey, files))
    expect(r).toMatchObject({ ok: false, code: 'stale', httpStatus: 409 })
    expect(await rowsOf(l.orderId)).toHaveLength(1)
  })

  it('a file outside the incoming and task folders is 400 wrong_folder', async () => {
    const l = await line()
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-f5' })]
    const r = await commitDelivery(l.taskKey, input(files), driveWith(l.taskKey, files, 'somewhere-else'))
    expect(r).toMatchObject({ ok: false, code: 'wrong_folder', httpStatus: 400 })
    await expectNothingWritten(l.orderId, l.taskKey)
  })

  it('a file already in the task folder passes the folder check', async () => {
    const l = await line()
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-f5b' })]
    const r = await commitDelivery(l.taskKey, input(files), driveWith(l.taskKey, files, l.taskFolder))
    expect(r).toMatchObject({ ok: true })
  })

  it('a trashed or missing file is 400 drive_missing', async () => {
    const l = await line()
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-f6' })]
    const drive = driveWith(l.taskKey, files)
    drive.files.get('dlc-f6')!.trashed = true
    const r = await commitDelivery(l.taskKey, input(files), drive)
    expect(r).toMatchObject({ ok: false, code: 'drive_missing', httpStatus: 400 })
    const gone = await commitDelivery(l.taskKey, input(files), fakeDrive())
    expect(gone).toMatchObject({ ok: false, code: 'drive_missing' })
    await expectNothingWritten(l.orderId, l.taskKey)
  })

  it('a size one byte off is 400 size_mismatch', async () => {
    const l = await line()
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-f7' })]
    const drive = driveWith(l.taskKey, files)
    drive.files.get('dlc-f7')!.size = 101
    const r = await commitDelivery(l.taskKey, input(files), drive)
    expect(r).toMatchObject({ ok: false, code: 'size_mismatch', httpStatus: 400 })
    await expectNothingWritten(l.orderId, l.taskKey)
  })

  it('a closed order or a cancelled task is 409 closed and touches nothing', async () => {
    const closed = await line({ pipelineStatus: 'FULFILLED' })
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-f8' })]
    const drive = driveWith(closed.taskKey, files)
    expect(await commitDelivery(closed.taskKey, input(files), drive)).toMatchObject({ ok: false, code: 'closed', httpStatus: 409 })
    await expectNothingWritten(closed.orderId, closed.taskKey)

    const cancelled = await line({ taskStatus: 'CANCELLED' })
    const r = await commitDelivery(cancelled.taskKey, input(files, { expected: { status: 'CANCELLED', liveIds: [] } }), drive)
    expect(r).toMatchObject({ ok: false, code: 'closed', httpStatus: 409 })
    await expectNothingWritten(cancelled.orderId, cancelled.taskKey, 'CANCELLED')
    expect(drive.calls).toEqual([])
  })

  it('an unknown task is 404 not_found', async () => {
    expect(await commitDelivery('DLC_NOPE_1', input([file({ printArea: 'Front', driveFileId: 'x' })]), fakeDrive()))
      .toMatchObject({ ok: false, code: 'not_found', httpStatus: 404 })
  })

  it('a missing order line row is 409 line_syncing', async () => {
    const l = await line()
    await prisma.orderLine.deleteMany({ where: { orderId: l.orderId } })
    const r = await commitDelivery(l.taskKey, input([file({ printArea: 'Front', driveFileId: 'x' })]), fakeDrive())
    expect(r).toMatchObject({ ok: false, code: 'line_syncing', httpStatus: 409 })
    if (!r.ok) expect(r.error).toContain('đồng bộ lại')
  })

  it('a file sized to the expired alternative layout is 400 old_layout', async () => {
    const l = await line({ sku: OLD_SKU })
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-f9', widthPx: 900, heightPx: 900 })]
    const drive = driveWith(l.taskKey, files)
    const r = await commitDelivery(l.taskKey, input(files), drive)
    expect(r).toMatchObject({ ok: false, code: 'old_layout', httpStatus: 400 })
    await expectNothingWritten(l.orderId, l.taskKey)
    expect(drive.calls.some(c => c.startsWith('moveFile:') || c.startsWith('createShortcut:') || c.startsWith('tidy:'))).toBe(false)
  })

  it('any other size mismatch only warns and the push goes through', async () => {
    const l = await line()
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-f10', widthPx: 950, heightPx: 950 })]
    const r = await commitDelivery(l.taskKey, input(files), driveWith(l.taskKey, files))
    expect(r).toMatchObject({ ok: true })
    if (r.ok) expect(r.warnings.join('\n')).toContain('950×950')
    expect(await rowsOf(l.orderId)).toHaveLength(1)
  })

  it('dryRun reports the versions it would write and writes nothing', async () => {
    const l = await line()
    await prisma.designArtwork.create({ data: {
      orderId: l.orderId, shopifyLineId: 'l1', kind: 'PRINT', printArea: 'Front', version: 2, fileName: 'f.png', size: 1, mimeType: 'image/png',
      storagePath: 'x/old', removedAt: new Date('2026-11-02'),
    } })
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-f11' }), file({ printArea: 'Back', driveFileId: 'dlc-b11' })]
    const drive = driveWith(l.taskKey, files)
    const r = await commitDelivery(l.taskKey, input(files, { dryRun: true }), drive)
    expect(r).toMatchObject({ ok: true, alreadyApplied: false, status: 'NEW', missing: [] })
    if (r.ok) {
      expect(r.artworks.map(a => `${a.printArea} v${a.version}`).sort()).toEqual(['Back v1', 'Front v3'])
      expect(r.artworks.filter(a => a.id === null)).toHaveLength(2)
    }
    expect(await rowsOf(l.orderId)).toHaveLength(1)
    expect((await eventsOf(l.taskKey)).filter(e => e.type === 'ARTWORK')).toHaveLength(0)
    expect((await taskOf(l.taskKey)).status).toBe('NEW')
    expect(drive.calls.some(c => c.startsWith('moveFile:') || c.startsWith('createShortcut:') || c.startsWith('tidy:'))).toBe(false)
  })

  it('shortcutOf another line\'s live print writes the target id with drivePlace TASK and never moves the target', async () => {
    const owner = await line()
    await prisma.designArtwork.create({ data: {
      orderId: owner.orderId, shopifyLineId: 'l1', kind: 'PRINT', printArea: 'Front', version: 1, fileName: 'front.png', size: 100, mimeType: 'image/png',
      storage: 'DRIVE', driveFileId: 'dlc-shared', drivePlace: 'TASK', source: 'AUTO',
    } })
    const l = await line()
    const front = file({ printArea: 'Front', driveFileId: 'dlc-shared', shortcutOf: 'dlc-shared' })
    const back = file({ printArea: 'Back', driveFileId: 'dlc-b12' })
    const drive = driveWith(l.taskKey, [back])
    drive.addFile({ id: 'dlc-shared', parent: owner.taskFolder, size: 100 })
    const r = await commitDelivery(l.taskKey, input([front, back]), drive)
    expect(r).toMatchObject({ ok: true, status: 'REVIEW' })

    const rows = await rowsOf(l.orderId)
    expect(rows.find(x => x.printArea === 'Front')).toMatchObject({ driveFileId: 'dlc-shared', drivePlace: 'TASK' })
    expect(rows.find(x => x.printArea === 'Back')).toMatchObject({ driveFileId: 'dlc-b12', drivePlace: null })
    expect(drive.calls.filter(c => c.startsWith('createShortcut:'))).toEqual(['createShortcut:dlc-shared'])
    const shortcut = Array.from(drive.files.values()).find(f => f.target === 'dlc-shared')!
    expect(shortcut).toMatchObject({ parents: [l.taskFolder], name: 'Front.png' })
    expect(drive.calls).not.toContain('moveFile:dlc-shared')
    expect(drive.files.get('dlc-shared')!.parents).toEqual([owner.taskFolder])
  })

  it('shortcutOf a file that is no other line\'s live print is 400 bad_shortcut', async () => {
    const l = await line()
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-nobody', shortcutOf: 'dlc-nobody' })]
    const drive = fakeDrive()
    drive.addFile({ id: 'dlc-nobody', parent: 'elsewhere', size: 100 })
    expect(await commitDelivery(l.taskKey, input(files), drive)).toMatchObject({ ok: false, code: 'bad_shortcut', httpStatus: 400 })
    const mismatch = [file({ printArea: 'Front', driveFileId: 'dlc-other', shortcutOf: 'dlc-nobody' })]
    expect(await commitDelivery(l.taskKey, input(mismatch), drive)).toMatchObject({ ok: false, code: 'bad_shortcut' })
    await expectNothingWritten(l.orderId, l.taskKey)
    expect(drive.calls.filter(c => c.startsWith('createShortcut:'))).toEqual([])
  })

  it('push is additive: Front then Back completes the line, re-sending Front is 409 wrong_state', async () => {
    const l = await line()
    const front = [file({ printArea: 'Front', driveFileId: 'dlc-add-f' })]
    const drive = driveWith(l.taskKey, front)
    expect(await commitDelivery(l.taskKey, input(front), drive)).toMatchObject({ ok: true, status: 'NEW', missing: ['Back'] })
    const frontId = (await rowsOf(l.orderId))[0].id

    const back = [file({ printArea: 'Back', driveFileId: 'dlc-add-b' })]
    drive.addFile({ id: 'dlc-add-b', parent: `incoming-${l.taskKey}`, size: 100 })
    const r = await commitDelivery(l.taskKey, input(back, { expected: { status: 'NEW', liveIds: [frontId] } }), drive)
    expect(r).toMatchObject({ ok: true, status: 'REVIEW', missing: [] })
    expect((await eventsOf(l.taskKey)).filter(e => e.type === 'ARTWORK').map(e => e.message)).toEqual([
      'Render tự động (máy local 25/10) · Front v1 · 1000×1000 px',
      'Render tự động (máy local 25/10) · Back v1 · 1000×1000 px',
    ])
    expect((await eventsOf(l.taskKey)).filter(e => e.message === AUTO_REVIEW_MESSAGE)).toHaveLength(1)

    const l2 = await line()
    const first = [file({ printArea: 'Front', driveFileId: 'dlc-add-f2' })]
    const drive2 = driveWith(l2.taskKey, first)
    await commitDelivery(l2.taskKey, input(first), drive2)
    const liveIds = (await rowsOf(l2.orderId)).map(x => x.id)
    const again = [file({ printArea: 'front', driveFileId: 'dlc-add-f3' })]
    drive2.addFile({ id: 'dlc-add-f3', parent: `incoming-${l2.taskKey}`, size: 100 })
    const refused = await commitDelivery(l2.taskKey, input(again, { expected: { status: 'NEW', liveIds } }), drive2)
    expect(refused).toMatchObject({ ok: false, code: 'wrong_state', httpStatus: 409 })
    if (!refused.ok) expect(refused.error).toContain('replace')
    expect(await rowsOf(l2.orderId)).toHaveLength(1)
  })

  it('push on a task in REVIEW is 409 wrong_state', async () => {
    const l = await line({ taskStatus: 'REVIEW' })
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-f14' })]
    const r = await commitDelivery(l.taskKey, input(files, { expected: { status: 'REVIEW', liveIds: [] } }), driveWith(l.taskKey, files))
    expect(r).toMatchObject({ ok: false, code: 'wrong_state', httpStatus: 409 })
    await expectNothingWritten(l.orderId, l.taskKey, 'REVIEW')
  })

  it('a writer that changes the task after the checks gets 409 stale and nothing is inserted', async () => {
    const l = await line()
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-f15' })]
    const drive = driveWith(l.taskKey, files)
    const fileInfo = drive.fileInfo
    drive.fileInfo = async id => {
      await prisma.designTask.update({ where: { taskKey: l.taskKey }, data: { status: 'DOING' } })
      return fileInfo(id)
    }
    const r = await commitDelivery(l.taskKey, input(files), drive)
    expect(r).toMatchObject({ ok: false, code: 'stale', httpStatus: 409 })
    if (!r.ok) expect(r.current?.status).toBe('DOING')
    await expectNothingWritten(l.orderId, l.taskKey, 'DOING')
    expect(drive.calls.some(c => c.startsWith('tidy:'))).toBe(false)
  })

  it('a row added by another writer after the checks makes the commit 409 stale', async () => {
    const l = await line()
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-f16' })]
    const drive = driveWith(l.taskKey, files)
    const fileInfo = drive.fileInfo
    drive.fileInfo = async id => {
      await prisma.designArtwork.create({ data: {
        orderId: l.orderId, shopifyLineId: 'l1', kind: 'MOCKUP', printArea: 'Main', version: 1, fileName: 'm.jpg', size: 1, mimeType: 'image/jpeg', storagePath: 'x/race',
      } })
      return fileInfo(id)
    }
    const r = await commitDelivery(l.taskKey, input(files), drive)
    expect(r).toMatchObject({ ok: false, code: 'stale', httpStatus: 409 })
    expect((await rowsOf(l.orderId)).map(x => x.storagePath)).toEqual(['x/race'])
    expect((await eventsOf(l.taskKey)).filter(e => e.type === 'ARTWORK')).toHaveLength(0)
  })

  it('a concurrent shortcut push that loses the race removes the shortcut it created', async () => {
    const owner = await line()
    await prisma.designArtwork.create({ data: {
      orderId: owner.orderId, shopifyLineId: 'l1', kind: 'PRINT', printArea: 'Front', version: 1, fileName: 'front.png', size: 100, mimeType: 'image/png',
      storage: 'DRIVE', driveFileId: 'dlc-shared2', drivePlace: 'TASK', source: 'AUTO',
    } })
    const l = await line()
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-shared2', shortcutOf: 'dlc-shared2' })]
    const drive = fakeDrive()
    drive.addFile({ id: 'dlc-shared2', parent: owner.taskFolder, size: 100 })
    const createShortcut = drive.createShortcut
    drive.createShortcut = async (t, p, name) => {
      await prisma.designTask.update({ where: { taskKey: l.taskKey }, data: { status: 'DOING' } })
      return createShortcut(t, p, name)
    }
    const r = await commitDelivery(l.taskKey, input(files), drive)
    expect(r).toMatchObject({ ok: false, code: 'stale' })
    expect(Array.from(drive.files.values()).filter(f => f.target === 'dlc-shared2')).toHaveLength(0)
    expect(drive.files.has('dlc-shared2')).toBe(true)
    await expectNothingWritten(l.orderId, l.taskKey, 'DOING')
  })

  it('a print set leaning to an expired piece layout is 400 old_layout', async () => {
    const l = await line({ sku: PIECES_OLD_SKU })
    const files = [
      file({ printArea: 'Back Left', driveFileId: 'dlc-pc-l', widthPx: 400, heightPx: 800 }),
      file({ printArea: 'Back Right', driveFileId: 'dlc-pc-r', widthPx: 400, heightPx: 800 }),
    ]
    const r = await commitDelivery(l.taskKey, input(files), driveWith(l.taskKey, files))
    expect(r).toMatchObject({ ok: false, code: 'old_layout', httpStatus: 400 })
    await expectNothingWritten(l.orderId, l.taskKey)
  })

  it('the same piece set without filesUntil is accepted', async () => {
    const l = await line({ sku: PIECES_SKU })
    const files = [
      file({ printArea: 'Back Left', driveFileId: 'dlc-pc2-l', widthPx: 400, heightPx: 800 }),
      file({ printArea: 'Back Right', driveFileId: 'dlc-pc2-r', widthPx: 400, heightPx: 800 }),
    ]
    const r = await commitDelivery(l.taskKey, input(files), driveWith(l.taskKey, files))
    expect(r).toMatchObject({ ok: true, warnings: [] })
  })

  it('a driveFileId already live on this line is 400 duplicate_file', async () => {
    const l = await line()
    const mock = await prisma.designArtwork.create({ data: {
      orderId: l.orderId, shopifyLineId: 'l1', kind: 'MOCKUP', printArea: 'Main', version: 1, fileName: 'm.jpg', size: 100, mimeType: 'image/jpeg',
      storage: 'DRIVE', driveFileId: 'dlc-dup',
    } })
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-dup' })]
    const r = await commitDelivery(l.taskKey, input(files, { expected: { status: 'NEW', liveIds: [mock.id] } }), driveWith(l.taskKey, files))
    expect(r).toMatchObject({ ok: false, code: 'duplicate_file', httpStatus: 400 })
    const twice = [file({ printArea: 'Front', driveFileId: 'dlc-dup2' }), file({ printArea: 'Back', driveFileId: 'dlc-dup2' })]
    expect(await commitDelivery(l.taskKey, input(twice, { expected: { status: 'NEW', liveIds: [mock.id] } }), fakeDrive()))
      .toMatchObject({ ok: false, code: 'duplicate_file', httpStatus: 400 })
    expect(await rowsOf(l.orderId)).toHaveLength(1)
  })

  it('part names match case-insensitively and are stored with the template label', async () => {
    const l = await line()
    await prisma.designArtwork.create({ data: {
      orderId: l.orderId, shopifyLineId: 'l1', kind: 'PRINT', printArea: 'FRONT', version: 2, fileName: 'f.png', size: 1, mimeType: 'image/png',
      storagePath: 'x/old2', removedAt: new Date('2026-11-02'),
    } })
    const files = [file({ printArea: 'front', driveFileId: 'dlc-ci-f' }), file({ printArea: 'BACK', driveFileId: 'dlc-ci-b' })]
    const drive = driveWith(l.taskKey, files)
    const r = await commitDelivery(l.taskKey, input(files), drive)
    expect(r).toMatchObject({ ok: true, status: 'REVIEW' })
    const live = (await rowsOf(l.orderId)).filter(x => !x.removedAt).map(x => `${x.printArea} v${x.version}`).sort()
    expect(live).toEqual(['Back v1', 'Front v3'])
    const again = await commitDelivery(l.taskKey, input([file({ printArea: 'FRONT', driveFileId: 'dlc-ci-f' })]), drive)
    expect(again).toMatchObject({ ok: true, alreadyApplied: true })

    const dup = [file({ printArea: 'Front', driveFileId: 'a1' }), file({ printArea: 'front', driveFileId: 'a2' })]
    expect(await commitDelivery(l.taskKey, input(dup), fakeDrive())).toMatchObject({ ok: false, code: 'bad_request' })
  })

  it('wrongly typed fields are 400 bad_request', async () => {
    const l = await line()
    const cases: any[] = [
      input([{ ...file({ printArea: 'Front', driveFileId: 't1' }), widthPx: '1000' } as any]),
      input([{ ...file({ printArea: 'Front', driveFileId: 't2' }), heightPx: -1 } as any]),
      input([{ ...file({ printArea: 'Front', driveFileId: 't3' }), shortcutOf: 5 } as any]),
      { ...input([file({ printArea: 'Front', driveFileId: 't4' })]), eventMessage: 5 },
    ]
    for (const c of cases) expect(await commitDelivery(l.taskKey, c, fakeDrive())).toMatchObject({ ok: false, code: 'bad_request', httpStatus: 400 })
    await expectNothingWritten(l.orderId, l.taskKey)
  })

  it('shortcutOf on a mockup is 400 bad_shortcut', async () => {
    const l = await line()
    const files = [file({ kind: 'MOCKUP', printArea: 'Main', driveFileId: 'dlc-sm', shortcutOf: 'dlc-sm' })]
    expect(await commitDelivery(l.taskKey, input(files), fakeDrive())).toMatchObject({ ok: false, code: 'bad_shortcut', httpStatus: 400 })
  })

  it('a throw from the review move after the commit is a warning and the rows stay', async () => {
    const l = await line()
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-th-f' }), file({ printArea: 'Back', driveFileId: 'dlc-th-b' })]
    hooks.submitThrows = true
    const r = await commitDelivery(l.taskKey, input(files), driveWith(l.taskKey, files))
    expect(r).toMatchObject({ ok: true, status: 'NEW', missing: [] })
    if (r.ok) expect(r.warnings.join('\n')).toContain('Chưa gửi duyệt: db gone')
    expect(await rowsOf(l.orderId)).toHaveLength(2)
  })

  it('a tidy failure is a warning and the commit stands', async () => {
    const l = await line()
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-td-f' })]
    const drive = driveWith(l.taskKey, files)
    drive.tidy = async () => { throw new Error('drive down') }
    const r = await commitDelivery(l.taskKey, input(files), drive)
    expect(r).toMatchObject({ ok: true })
    if (r.ok) expect(r.warnings.join('\n')).toContain('Chưa xếp được file vào thư mục task: drive down')
    expect(await rowsOf(l.orderId)).toHaveLength(1)
  })

  it('a push with no files or two files for one part is 400 bad_request', async () => {
    const l = await line()
    expect(await commitDelivery(l.taskKey, input([]), fakeDrive())).toMatchObject({ ok: false, code: 'bad_request', httpStatus: 400 })
    const twice = [file({ printArea: 'Front', driveFileId: 'a' }), file({ printArea: 'Front', driveFileId: 'b' })]
    expect(await commitDelivery(l.taskKey, input(twice), fakeDrive())).toMatchObject({ ok: false, code: 'bad_request' })
    await expectNothingWritten(l.orderId, l.taskKey)
  })
})

describe('final review fixes', () => {
  const libLink = (id: string) => `https://drive.google.com/file/d/${id}/view?usp=drivesdk`

  it('shortcutOf a file only the design library links to is accepted and leaves the original where it is', async () => {
    await prisma.skuSupplierDesign.create({ data: { sku: `DLC-LIB-${++n}`, supplierId: fx.supplierId, designLink: `https://x.test/a | ${libLink('dlc-lib1')}`, ready: true } })
    const l = await line()
    const front = file({ printArea: 'Front', driveFileId: 'dlc-lib1', shortcutOf: 'dlc-lib1' })
    const back = file({ printArea: 'Back', driveFileId: 'dlc-lib1-b' })
    const drive = driveWith(l.taskKey, [back])
    drive.addFile({ id: 'dlc-lib1', parent: 'library-folder', size: 100 })
    const r = await commitDelivery(l.taskKey, input([front, back]), drive)
    expect(r).toMatchObject({ ok: true, status: 'REVIEW' })
    expect((await rowsOf(l.orderId)).find(x => x.printArea === 'Front')).toMatchObject({ driveFileId: 'dlc-lib1', drivePlace: 'TASK' })
    expect(drive.calls.filter(c => c.startsWith('createShortcut:'))).toEqual(['createShortcut:dlc-lib1'])
    expect(drive.files.get('dlc-lib1')!.parents).toEqual(['library-folder'])
  })

  it('a library shortcut target must be on Drive, not trashed, and the size sent', async () => {
    await prisma.skuSupplierDesign.create({ data: { sku: `DLC-LIB-${++n}`, supplierId: fx.supplierId, designLink: libLink('dlc-lib2'), ready: true } })
    const l = await line()
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-lib2', shortcutOf: 'dlc-lib2' })]
    expect(await commitDelivery(l.taskKey, input(files), fakeDrive())).toMatchObject({ ok: false, code: 'drive_missing' })
    const trashed = fakeDrive()
    trashed.addFile({ id: 'dlc-lib2', parent: 'library-folder', size: 100, trashed: true })
    expect(await commitDelivery(l.taskKey, input(files), trashed)).toMatchObject({ ok: false, code: 'drive_missing' })
    const other = fakeDrive()
    other.addFile({ id: 'dlc-lib2', parent: 'library-folder', size: 99 })
    expect(await commitDelivery(l.taskKey, input(files), other)).toMatchObject({ ok: false, code: 'size_mismatch' })
    await expectNothingWritten(l.orderId, l.taskKey)
  })

  it('an id that is only part of a longer id in a library link is not a library file', async () => {
    await prisma.skuSupplierDesign.create({ data: { sku: `DLC-LIB-${++n}`, supplierId: fx.supplierId, designLink: libLink('dlc-lib3-longer'), ready: true } })
    const l = await line()
    const drive = fakeDrive()
    drive.addFile({ id: 'dlc-lib3', parent: 'library-folder', size: 100 })
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-lib3', shortcutOf: 'dlc-lib3' })]
    expect(await commitDelivery(l.taskKey, input(files), drive)).toMatchObject({ ok: false, code: 'bad_shortcut', httpStatus: 400 })
  })

  it('a resend after the order closed is already applied, not 409 closed, and does not move the task', async () => {
    const l = await line()
    const files = [file({ printArea: 'Front', driveFileId: 'dlc-cl-f' }), file({ printArea: 'Back', driveFileId: 'dlc-cl-b' })]
    const drive = driveWith(l.taskKey, files)
    expect(await commitDelivery(l.taskKey, input(files), drive)).toMatchObject({ ok: true, status: 'REVIEW' })
    await prisma.order.update({ where: { id: l.orderId }, data: { pipelineStatus: 'FULFILLED' } })
    expect(await commitDelivery(l.taskKey, input(files), drive)).toMatchObject({ ok: true, alreadyApplied: true, status: 'REVIEW' })

    const landed = await line()
    for (const f of files) {
      await prisma.designArtwork.create({ data: {
        orderId: landed.orderId, shopifyLineId: 'l1', kind: 'PRINT', printArea: f.printArea, version: 1, fileName: f.fileName, storage: 'DRIVE',
        driveFileId: `${f.driveFileId}-2`, size: 100, mimeType: 'image/png', source: 'AUTO',
      } })
    }
    await prisma.order.update({ where: { id: landed.orderId }, data: { pipelineStatus: 'FULFILLED' } })
    const resend = files.map(f => ({ ...f, driveFileId: `${f.driveFileId}-2` }))
    expect(await commitDelivery(landed.taskKey, input(resend), fakeDrive())).toMatchObject({ ok: true, alreadyApplied: true, status: 'NEW' })
    expect((await taskOf(landed.taskKey)).status).toBe('NEW')
  })

  it('a print whose part is no slot of the template warns and is written; a mockup does not warn', async () => {
    const l = await line()
    const files = [
      file({ printArea: 'Front', driveFileId: 'dlc-sl-f' }), file({ printArea: 'Back', driveFileId: 'dlc-sl-b' }),
      file({ printArea: 'Sleeve', driveFileId: 'dlc-sl-s' }), file({ kind: 'MOCKUP', printArea: 'Main', driveFileId: 'dlc-sl-m' }),
    ]
    const r = await commitDelivery(l.taskKey, input(files), driveWith(l.taskKey, files))
    expect(r).toMatchObject({ ok: true })
    if (r.ok) expect(r.warnings.filter(w => w.includes('không có trong template'))).toEqual(['Phần Sleeve không có trong template'])
    expect((await rowsOf(l.orderId)).map(x => x.printArea).sort()).toEqual(['Back', 'Front', 'Main', 'Sleeve'])
  })

  it('a line without a template gets no slot warning', async () => {
    const l = await line({ sku: 'DLC-NO-TEMPLATE' })
    const files = [file({ printArea: 'Anything', driveFileId: 'dlc-nt-a' })]
    const r = await commitDelivery(l.taskKey, input(files, { dryRun: true }), driveWith(l.taskKey, files))
    expect(r).toMatchObject({ ok: true })
    if (r.ok) expect(r.warnings.filter(w => w.includes('không có trong template'))).toEqual([])
  })
})
