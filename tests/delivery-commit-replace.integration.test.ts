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
import { commitDelivery } from '@/lib/delivery/commit'
import type { CommitInput, DeliveryFile } from '@/lib/delivery/types'
import { agentFixture } from './helpers/design-agent-fixture'
import { fakeDrive } from './helpers/delivery-fake-drive'

const fx = agentFixture('DLR')
const TPL_SKU = 'DLR-FB'
const AUTO_REVIEW = 'Tự động gửi duyệt (file in tự động)'
let n = 0

type Seed = { kind?: 'PRINT' | 'MOCKUP'; printArea: string; version?: number; source?: string; driveFileId?: string; fileName?: string; drivePlace?: string | null }

async function line(opts: { status?: string; readiness?: string; arts?: Seed[]; drive?: ReturnType<typeof fakeDrive> } = {}) {
  const o = await fx.order(++n, { supplierSku: TPL_SKU, taskStatus: opts.status })
  if (opts.readiness) await prisma.designTask.updateMany({ where: { orderId: o.orderId }, data: { readiness: opts.readiness } })
  const taskFolder = `task-${o.orderId}-l1`
  const drive = opts.drive ?? fakeDrive()
  const ids: Record<string, string> = {}
  for (const a of opts.arts ?? []) {
    const kind = a.kind ?? 'PRINT'
    const driveFileId = a.driveFileId ?? `dlr-${n}-${kind}-${a.printArea}-${a.version ?? 1}`
    const row = await prisma.designArtwork.create({ data: {
      orderId: o.orderId, shopifyLineId: 'l1', kind, printArea: a.printArea, version: a.version ?? 1,
      fileName: a.fileName ?? `${a.printArea.toLowerCase()}.png`, storage: 'DRIVE', driveFileId, drivePlace: a.drivePlace === undefined ? 'TASK' : a.drivePlace,
      size: 100, mimeType: 'image/png', widthPx: 1000, heightPx: 1000, source: a.source ?? 'AUTO',
    } })
    ids[`${kind === 'MOCKUP' ? 'mockup ' : ''}${a.printArea} v${a.version ?? 1}`] = row.id
    if (!drive.files.has(driveFileId)) drive.addFile({ id: driveFileId, parent: taskFolder, size: 100, mimeType: 'image/png' })
  }
  const task = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: o.taskKeys[0] } })
  await prisma.designTaskEvent.deleteMany({ where: { taskId: task.id } })
  return { orderId: o.orderId, taskKey: o.taskKeys[0], taskFolder, drive, ids, status: task.status, liveIds: Object.values(ids) }
}

function file(over: Partial<DeliveryFile> & { printArea: string; driveFileId: string }): DeliveryFile {
  return { kind: 'PRINT', fileName: `${over.printArea.toLowerCase()}.png`, size: 100, mimeType: 'image/png', widthPx: 1000, heightPx: 1000, shortcutOf: null, ...over }
}

function upload(l: { taskKey: string; drive: ReturnType<typeof fakeDrive> }, files: DeliveryFile[]) {
  for (const f of files) l.drive.addFile({ id: f.driveFileId, parent: `incoming-${l.taskKey}`, size: f.size, mimeType: f.mimeType })
  return files
}

function req(l: { status: string; liveIds: string[] }, action: CommitInput['action'], over: Partial<CommitInput> = {}): CommitInput {
  return { action, expected: { status: l.status, liveIds: l.liveIds }, files: [], retire: [], ...over }
}

const rowsOf = (orderId: string) => prisma.designArtwork.findMany({ where: { orderId }, orderBy: [{ kind: 'asc' }, { printArea: 'asc' }, { version: 'asc' }] })
const liveOf = async (orderId: string) => (await rowsOf(orderId)).filter(r => !r.removedAt).map(r => `${r.kind === 'MOCKUP' ? 'mockup ' : ''}${r.printArea} v${r.version}`)
const eventsOf = (taskKey: string) => prisma.designTaskEvent.findMany({ where: { task: { taskKey } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
const taskOf = (taskKey: string) => prisma.designTask.findUniqueOrThrow({ where: { taskKey } })
const moves = (calls: string[]) => calls.filter(c => c.startsWith('moveFile:') || c.startsWith('createShortcut:') || c.startsWith('tidy:'))

async function expectUntouched(l: { orderId: string; taskKey: string; status: string }, live: string[]) {
  const rows = await rowsOf(l.orderId)
  expect(rows.filter(r => r.removedAt)).toHaveLength(0)
  expect(await liveOf(l.orderId)).toEqual(live)
  expect(await eventsOf(l.taskKey)).toHaveLength(0)
  expect((await taskOf(l.taskKey)).status).toBe(l.status)
}

const FRONT_BACK: Seed[] = [{ printArea: 'Front' }, { printArea: 'Back' }]

beforeAll(async () => {
  await fx.cleanup()
  await fx.seed()
  await prisma.printTemplate.deleteMany({ where: { supplierId: fx.supplierId } })
  const areas = JSON.stringify([{ name: 'Front', x: 0, y: 0, w: 1000, h: 1000 }, { name: 'Back', x: 1000, y: 0, w: 1000, h: 1000 }])
  await prisma.printTemplate.create({ data: { supplierId: fx.supplierId, supplierSku: TPL_SKU, name: 'DLR Front Back', widthPx: 2000, heightPx: 1000, areas } })
})

afterEach(() => { hooks.submitThrows = false })

afterAll(async () => {
  await prisma.printTemplate.deleteMany({ where: { supplierId: fx.supplierId } })
  await fx.cleanup()
})

describe('commitDelivery replace', () => {
  it('replacing Front on a REVIEW line retires v1, adds v2, keeps REVIEW and writes one ARTWORK event', async () => {
    const l = await line({ status: 'REVIEW', readiness: 'AUTO', arts: FRONT_BACK })
    const files = upload(l, [file({ printArea: 'Front', driveFileId: 'dlr-f2' })])
    const r = await commitDelivery(l.taskKey, req(l, 'replace', { files, retire: [l.ids['Front v1']] }), l.drive)
    expect(r).toMatchObject({ ok: true, status: 'REVIEW', retired: [l.ids['Front v1']], missing: [], alreadyApplied: false })

    const rows = await rowsOf(l.orderId)
    const old = rows.find(x => x.id === l.ids['Front v1'])!
    expect(old.removedAt).not.toBeNull()
    expect(old).toMatchObject({ removedById: null, drivePlace: null })
    expect(rows.find(x => x.driveFileId === 'dlr-f2')).toMatchObject({ printArea: 'Front', version: 2, source: 'AUTO', removedAt: null, drivePlace: null })
    expect(await liveOf(l.orderId)).toEqual(['Back v1', 'Front v2'])
    expect(await taskOf(l.taskKey)).toMatchObject({ status: 'REVIEW', readiness: 'AUTO' })
    expect((await eventsOf(l.taskKey)).map(e => `${e.type}:${e.message}`))
      .toEqual(['ARTWORK:Render lại (máy local 26/10) · Front v2 · 1000×1000 px · thay Front v1'])
    expect(l.drive.calls).toContain(`tidy:${l.orderId}`)
    expect(l.drive.calls.filter(c => c.startsWith('deleteFile:'))).toEqual([])
  })

  it('eventMessage and a no-name file shape the replace event like the local script', async () => {
    const l = await line({ status: 'REVIEW', readiness: 'AUTO', arts: FRONT_BACK })
    const files = upload(l, [file({ printArea: 'Front', driveFileId: 'dlr-nn-f', fileName: 'front-noname.png' }), file({ printArea: 'Back', driveFileId: 'dlr-nn-b' })])
    await commitDelivery(l.taskKey, req(l, 'replace', { files, retire: [l.ids['Front v1'], l.ids['Back v1']] }), l.drive)
    expect((await eventsOf(l.taskKey)).map(e => e.message))
      .toEqual(['Render lại (máy local 26/10) · 2 mảnh: Front v2, Back v2 · thay Front v1, Back v1 · khách không đặt tên'])

    const m = await line({ status: 'REVIEW', readiness: 'AUTO', arts: FRONT_BACK })
    const mf = upload(m, [file({ printArea: 'Front', driveFileId: 'dlr-msg-f' })])
    await commitDelivery(m.taskKey, req(m, 'replace', { files: mf, retire: [m.ids['Front v1']], eventMessage: 'Sửa màu nền' }), m.drive)
    expect((await eventsOf(m.taskKey)).map(e => e.message)).toEqual(['Sửa màu nền · thay Front v1'])
  })

  it('a REJECTED line goes back to REVIEW with "Gửi duyệt lại"; a DOING line too', async () => {
    for (const status of ['REJECTED', 'DOING']) {
      const l = await line({ status, arts: FRONT_BACK })
      const files = upload(l, [file({ printArea: 'Back', driveFileId: `dlr-rj-${status}` })])
      const r = await commitDelivery(l.taskKey, req(l, 'replace', { files, retire: [l.ids['Back v1']] }), l.drive)
      expect(r).toMatchObject({ ok: true, status: 'REVIEW', missing: [] })
      expect(await taskOf(l.taskKey)).toMatchObject({ status: 'REVIEW', readiness: 'AUTO' })
      const events = (await eventsOf(l.taskKey)).map(e => `${e.type}:${e.message}`)
      expect(events[0]).toBe('ARTWORK:Render lại (máy local 26/10) · Back v2 · 1000×1000 px · thay Back v1')
      expect(events.slice(1).sort()).toEqual(['ARTWORK:Gửi duyệt lại', `SYSTEM:${AUTO_REVIEW}`])
    }
  })

  it('a REJECTED replace that leaves a part missing stays REJECTED and reports it', async () => {
    const l = await line({ status: 'REJECTED', arts: FRONT_BACK })
    const files = upload(l, [file({ printArea: 'Front', driveFileId: 'dlr-rj-miss' })])
    const r = await commitDelivery(l.taskKey, req(l, 'replace', { files, retire: [l.ids['Front v1'], l.ids['Back v1']] }), l.drive)
    expect(r).toMatchObject({ ok: true, status: 'REJECTED', missing: ['Back'] })
    expect((await eventsOf(l.taskKey)).map(e => e.message)).toEqual(['Render lại (máy local 26/10) · Front v2 · 1000×1000 px · thay Front v1, Back v1'])
  })

  it('a DONE line needs allowFinished, then is replaced and stays DONE', async () => {
    const l = await line({ status: 'DONE', arts: FRONT_BACK })
    const files = upload(l, [file({ printArea: 'Front', driveFileId: 'dlr-done-f' })])
    const refused = await commitDelivery(l.taskKey, req(l, 'replace', { files, retire: [l.ids['Front v1']] }), l.drive)
    expect(refused).toMatchObject({ ok: false, code: 'wrong_state', httpStatus: 409 })
    await expectUntouched(l, ['Back v1', 'Front v1'])
    expect(moves(l.drive.calls)).toEqual([])

    const r = await commitDelivery(l.taskKey, req(l, 'replace', { files, retire: [l.ids['Front v1']], allowFinished: true }), l.drive)
    expect(r).toMatchObject({ ok: true, status: 'DONE' })
    const oldFile = (await rowsOf(l.orderId)).find(x => x.id === l.ids['Front v1'])!.driveFileId
    const shared = l.drive.calls.indexOf(`shareAnyoneReader:${oldFile}`)
    expect(shared).toBeGreaterThan(-1)
    expect(shared).toBeLessThan(l.drive.calls.indexOf(`tidy:${l.orderId}`))
    expect(l.drive.calls).not.toContain('shareAnyoneReader:dlr-done-f')
    expect(await liveOf(l.orderId)).toEqual(['Back v1', 'Front v2'])
    expect((await taskOf(l.taskKey)).status).toBe('DONE')
    expect((await eventsOf(l.taskKey)).map(e => e.message)).toEqual(['Render lại (máy local 26/10) · Front v2 · 1000×1000 px · thay Front v1'])
  })

  it('replace on a NEW line is 409 wrong_state', async () => {
    const l = await line({ arts: [{ printArea: 'Front' }] })
    const files = upload(l, [file({ printArea: 'Front', driveFileId: 'dlr-new-f' })])
    expect(await commitDelivery(l.taskKey, req(l, 'replace', { files, retire: [l.ids['Front v1']] }), l.drive))
      .toMatchObject({ ok: false, code: 'wrong_state', httpStatus: 409 })
    await expectUntouched(l, ['Front v1'])
  })

  it('a MANUAL row is 409 not_retirable by default and retired with retireSources AUTO+MANUAL', async () => {
    const l = await line({ status: 'REVIEW', arts: [{ printArea: 'Front', source: 'MANUAL' }, { printArea: 'Back' }] })
    const files = upload(l, [file({ printArea: 'Front', driveFileId: 'dlr-man-f' })])
    const refused = await commitDelivery(l.taskKey, req(l, 'replace', { files, retire: [l.ids['Front v1']] }), l.drive)
    expect(refused).toMatchObject({ ok: false, code: 'not_retirable', httpStatus: 409 })
    expect(await commitDelivery(l.taskKey, req(l, 'retire', { retire: [l.ids['Front v1']] }), l.drive))
      .toMatchObject({ ok: false, code: 'not_retirable', httpStatus: 409 })
    await expectUntouched(l, ['Back v1', 'Front v1'])

    const r = await commitDelivery(l.taskKey, req(l, 'retire', { retire: [l.ids['Front v1']], retireSources: ['AUTO', 'MANUAL'] }), l.drive)
    expect(r).toMatchObject({ ok: true, status: 'REVIEW', retired: [l.ids['Front v1']] })
    expect(await liveOf(l.orderId)).toEqual(['Back v1'])
    expect((await rowsOf(l.orderId)).find(x => x.id === l.ids['Front v1'])).toMatchObject({ removedById: null, drivePlace: null })
    expect((await eventsOf(l.taskKey)).map(e => `${e.type}:${e.message}`)).toEqual(['ARTWORK:Gỡ file · gỡ Front v1'])
    expect(l.drive.calls).toContain(`tidy:${l.orderId}`)
  })

  it('retiring the only PRINT is 409 last_print; so is a replace that leaves no PRINT', async () => {
    const l = await line({ status: 'REVIEW', arts: [{ printArea: 'Front' }, { kind: 'MOCKUP', printArea: 'Main' }] })
    expect(await commitDelivery(l.taskKey, req(l, 'retire', { retire: [l.ids['Front v1']] }), l.drive))
      .toMatchObject({ ok: false, code: 'last_print', httpStatus: 409 })
    const mock = upload(l, [file({ kind: 'MOCKUP', printArea: 'Side', driveFileId: 'dlr-lp-m' })])
    expect(await commitDelivery(l.taskKey, req(l, 'replace', { files: mock, retire: [l.ids['Front v1']] }), l.drive))
      .toMatchObject({ ok: false, code: 'last_print', httpStatus: 409 })
    await expectUntouched(l, ['mockup Main v1', 'Front v1'])
  })

  it('retiring a row whose file is live on another line moves only the shortcut and marks the row OLD', async () => {
    const owner = await line({ status: 'REVIEW', arts: [{ printArea: 'Front', driveFileId: 'dlr-shared' }] })
    const l = await line({ status: 'REVIEW', arts: [{ printArea: 'Front', driveFileId: 'dlr-shared' }, { printArea: 'Back' }] })
    l.drive.addFile({ id: 'dlr-shared', parent: owner.taskFolder, size: 100 })
    const shortcutId = await l.drive.createShortcut('dlr-shared', l.taskFolder, 'Front.png')
    l.drive.calls.length = 0

    const r = await commitDelivery(l.taskKey, req(l, 'retire', { retire: [l.ids['Front v1']] }), l.drive)
    expect(r).toMatchObject({ ok: true, warnings: [] })
    expect(l.drive.calls).toContain(`findShortcut:${l.taskFolder}`)
    expect(l.drive.calls).toContain(`moveFile:${shortcutId}`)
    expect(l.drive.calls).not.toContain('moveFile:dlr-shared')
    expect(l.drive.calls.filter(c => c.startsWith('deleteFile:'))).toEqual([])
    expect(l.drive.files.get(shortcutId)).toMatchObject({ parents: [`old-${l.orderId}-l1`], name: 'v1_Front.png' })
    expect(l.drive.files.get('dlr-shared')!.parents).toEqual([owner.taskFolder])
    expect((await rowsOf(l.orderId)).find(x => x.id === l.ids['Front v1'])).toMatchObject({ drivePlace: 'OLD', removedById: null })
    expect((await rowsOf(owner.orderId))[0]).toMatchObject({ removedAt: null, drivePlace: 'TASK' })
  })

  it('retiring a shared row whose original sits in this folder moves nothing and warns', async () => {
    const l = await line({ status: 'REVIEW', arts: [{ printArea: 'Front', driveFileId: 'dlr-shared-own' }, { printArea: 'Back' }] })
    const other = await line({ status: 'REVIEW', arts: [{ printArea: 'Front', driveFileId: 'dlr-shared-own' }] })
    void other
    const r = await commitDelivery(l.taskKey, req(l, 'retire', { retire: [l.ids['Front v1']] }), l.drive)
    expect(r).toMatchObject({ ok: true })
    if (r.ok) expect(r.warnings).toContain('File dùng chung vẫn nằm trong thư mục task')
    expect(l.drive.calls.filter(c => c.startsWith('moveFile:'))).toEqual([])
    expect(l.drive.files.get('dlr-shared-own')!.parents).toEqual([l.taskFolder])
    expect(l.drive.calls).not.toContain('shareAnyoneReader:dlr-shared-own')
    expect((await rowsOf(l.orderId)).find(x => x.id === l.ids['Front v1'])).toMatchObject({ drivePlace: 'OLD' })
    expect((await eventsOf(l.taskKey)).filter(e => e.type === 'SYSTEM').map(e => e.message))
      .toEqual(['File dùng chung Front v1 vẫn nằm trong thư mục task — cần dọn tay khi các dòng khác xong'])
  })

  it('a failed shortcut move after the commit is a warning and the retire stands', async () => {
    const owner = await line({ status: 'REVIEW', arts: [{ printArea: 'Front', driveFileId: 'dlr-shared-fail' }] })
    const l = await line({ status: 'REVIEW', arts: [{ printArea: 'Front', driveFileId: 'dlr-shared-fail' }, { printArea: 'Back' }] })
    l.drive.addFile({ id: 'dlr-shared-fail', parent: owner.taskFolder, size: 100 })
    await l.drive.createShortcut('dlr-shared-fail', l.taskFolder, 'Front.png')
    l.drive.moveFile = async () => { throw new Error('drive 500') }
    const r = await commitDelivery(l.taskKey, req(l, 'retire', { retire: [l.ids['Front v1']] }), l.drive)
    expect(r).toMatchObject({ ok: true })
    if (r.ok) expect(r.warnings.join('\n')).toContain('drive 500')
    expect(await liveOf(l.orderId)).toEqual(['Back v1'])
    expect((await rowsOf(l.orderId)).find(x => x.id === l.ids['Front v1'])).toMatchObject({ drivePlace: 'OLD' })
    expect((await eventsOf(l.taskKey)).filter(e => e.type === 'SYSTEM').map(e => e.message))
      .toEqual(['Không dời được lối tắt file cũ Front v1 — cần dọn tay'])
  })

  it('owner retired first, then the shortcut line retires: the original never moves, the shortcut does', async () => {
    const drive = fakeDrive()
    const owner = await line({ status: 'REVIEW', drive, arts: [{ printArea: 'Front', driveFileId: 'dlr-chain' }, { printArea: 'Back' }] })
    const sc = await line({ status: 'REVIEW', drive, arts: [{ printArea: 'Front', driveFileId: 'dlr-chain' }, { printArea: 'Back' }] })
    const shortcutId = await drive.createShortcut('dlr-chain', sc.taskFolder, 'Front.png')
    expect(drive.files.get('dlr-chain')!.parents).toEqual([owner.taskFolder])

    const first = await commitDelivery(owner.taskKey, req(owner, 'retire', { retire: [owner.ids['Front v1']] }), drive)
    expect(first).toMatchObject({ ok: true })
    if (first.ok) expect(first.warnings).toContain('File dùng chung vẫn nằm trong thư mục task')
    expect((await rowsOf(owner.orderId)).find(x => x.id === owner.ids['Front v1'])).toMatchObject({ drivePlace: 'OLD' })

    drive.calls.length = 0
    const second = await commitDelivery(sc.taskKey, req(sc, 'retire', { retire: [sc.ids['Front v1']] }), drive)
    expect(second).toMatchObject({ ok: true, warnings: [] })
    expect((await rowsOf(sc.orderId)).find(x => x.id === sc.ids['Front v1'])).toMatchObject({ drivePlace: 'OLD' })
    expect(drive.calls).toContain(`moveFile:${shortcutId}`)
    expect(drive.calls).not.toContain('moveFile:dlr-chain')
    expect(drive.calls).not.toContain('shareAnyoneReader:dlr-chain')
    expect(drive.files.get('dlr-chain')!.parents).toEqual([owner.taskFolder])
    expect(drive.files.get(shortcutId)!.parents).toEqual([`old-${sc.orderId}-l1`])
  })

  it('a shortcut lookup that fails keeps the row OLD, moves nothing and leaves a task event', async () => {
    const drive = fakeDrive()
    await line({ status: 'REVIEW', drive, arts: [{ printArea: 'Front', driveFileId: 'dlr-look' }] })
    const l = await line({ status: 'REVIEW', drive, arts: [{ printArea: 'Front', driveFileId: 'dlr-look' }, { printArea: 'Back' }] })
    drive.findShortcut = async () => { throw new Error('drive 503') }
    const r = await commitDelivery(l.taskKey, req(l, 'retire', { retire: [l.ids['Front v1']] }), drive)
    expect(r).toMatchObject({ ok: true })
    if (r.ok) expect(r.warnings.join('\n')).toContain('drive 503')
    expect((await rowsOf(l.orderId)).find(x => x.id === l.ids['Front v1'])).toMatchObject({ drivePlace: 'OLD' })
    expect(drive.calls.filter(c => c.startsWith('moveFile:') || c.startsWith('shareAnyoneReader:'))).toEqual([])
    expect((await eventsOf(l.taskKey)).filter(e => e.type === 'SYSTEM').map(e => e.message))
      .toEqual(['Không dời được lối tắt file cũ Front v1 — cần dọn tay'])
  })

  it('a file once used by another line that nobody prints from any more is left to tidy (drivePlace NULL) and shared first', async () => {
    const drive = fakeDrive()
    const gone = await line({ status: 'REVIEW', drive, arts: [{ printArea: 'Front', driveFileId: 'dlr-ever' }] })
    await prisma.designArtwork.updateMany({ where: { orderId: gone.orderId }, data: { removedAt: new Date('2026-11-10') } })
    const l = await line({ status: 'REVIEW', drive, arts: [{ printArea: 'Front', driveFileId: 'dlr-ever' }, { printArea: 'Back' }] })
    drive.calls.length = 0
    const r = await commitDelivery(l.taskKey, req(l, 'retire', { retire: [l.ids['Front v1']] }), drive)
    expect(r).toMatchObject({ ok: true, warnings: [] })
    expect((await rowsOf(l.orderId)).find(x => x.id === l.ids['Front v1'])).toMatchObject({ drivePlace: null })
    expect(drive.calls.indexOf('shareAnyoneReader:dlr-ever')).toBeGreaterThan(-1)
    expect(drive.calls.indexOf('shareAnyoneReader:dlr-ever')).toBeLessThan(drive.calls.indexOf(`tidy:${l.orderId}`))
  })

  it('replacing the file the factory holds as designDriveLink never deletes it', async () => {
    const l = await line({ status: 'REVIEW', arts: [{ printArea: 'Front', driveFileId: 'dlr-link-f' }, { printArea: 'Back' }] })
    await prisma.orderLine.updateMany({ where: { orderId: l.orderId }, data: { designDriveLink: 'https://drive.google.com/file/d/dlr-link-f/view?usp=drivesdk' } })
    const files = upload(l, [file({ printArea: 'Front', driveFileId: 'dlr-link-f2' })])
    const r = await commitDelivery(l.taskKey, req(l, 'replace', { files, retire: [l.ids['Front v1']] }), l.drive)
    expect(r).toMatchObject({ ok: true })
    expect(l.drive.calls.filter(c => c.startsWith('deleteFile:'))).toEqual([])
    expect(l.drive.files.has('dlr-link-f')).toBe(true)
    expect(l.drive.files.get('dlr-link-f')!.trashed).toBe(false)
  })

  it('a file for a part whose live row is not retired is 400 bad_request', async () => {
    const l = await line({ status: 'REVIEW', arts: FRONT_BACK })
    const files = upload(l, [file({ printArea: 'front', driveFileId: 'dlr-keep-f' })])
    expect(await commitDelivery(l.taskKey, req(l, 'replace', { files, retire: [l.ids['Back v1']] }), l.drive))
      .toMatchObject({ ok: false, code: 'bad_request', httpStatus: 400 })
    expect(await commitDelivery(l.taskKey, req(l, 'retire', { retire: ['not-a-row'] }), l.drive))
      .toMatchObject({ ok: false, code: 'bad_request', httpStatus: 400 })
    await expectUntouched(l, ['Back v1', 'Front v1'])
  })

  it('malformed replace, retire and revert requests are 400 bad_request', async () => {
    const l = await line({ status: 'REVIEW', readiness: 'AUTO', arts: FRONT_BACK })
    const f = file({ printArea: 'Front', driveFileId: 'dlr-bad-f' })
    const cases: CommitInput[] = [
      req(l, 'replace', { files: [f] }),
      req(l, 'replace', { retire: [l.ids['Front v1']] }),
      req(l, 'retire', { files: [f], retire: [l.ids['Front v1']] }),
      req(l, 'retire'),
      req(l, 'revert', { files: [f] }),
      req(l, 'revert', { retire: [l.ids['Front v1']] }),
      req(l, 'retire', { retire: [l.ids['Front v1']], retireSources: ['AGENT' as any] }),
      req(l, 'retire', { retire: [l.ids['Front v1']], allowFinished: 'yes' as any }),
      req(l, 'retire', { retire: [l.ids['Front v1'], l.ids['Front v1']] }),
      req(l, 'revert', { revertReadiness: 'AUTO' as any }),
    ]
    for (const c of cases) expect(await commitDelivery(l.taskKey, c, l.drive)).toMatchObject({ ok: false, code: 'bad_request', httpStatus: 400 })
    await expectUntouched(l, ['Back v1', 'Front v1'])
  })

  it('dryRun replace reports what would be live and writes nothing', async () => {
    const l = await line({ status: 'REVIEW', arts: FRONT_BACK })
    const files = upload(l, [file({ printArea: 'Front', driveFileId: 'dlr-dry-f' })])
    const r = await commitDelivery(l.taskKey, req(l, 'replace', { files, retire: [l.ids['Front v1']], dryRun: true }), l.drive)
    expect(r).toMatchObject({ ok: true, status: 'REVIEW', retired: [l.ids['Front v1']], missing: [], alreadyApplied: false })
    if (r.ok) expect(r.artworks.map(a => `${a.printArea} v${a.version}`).sort()).toEqual(['Back v1', 'Front v2'])
    await expectUntouched(l, ['Back v1', 'Front v1'])
    expect(moves(l.drive.calls)).toEqual([])
  })

  it('a replace sent again with the old expected is already applied: no writes, no status change', async () => {
    const l = await line({ status: 'REJECTED', arts: FRONT_BACK })
    const files = upload(l, [file({ printArea: 'Front', driveFileId: 'dlr-rs-f' })])
    const body = req(l, 'replace', { files, retire: [l.ids['Front v1']] })
    expect(await commitDelivery(l.taskKey, body, l.drive)).toMatchObject({ ok: true, status: 'REVIEW' })
    await prisma.designTask.update({ where: { taskKey: l.taskKey }, data: { status: 'REJECTED' } })
    const before = (await eventsOf(l.taskKey)).length
    const again = await commitDelivery(l.taskKey, body, l.drive)
    expect(again).toMatchObject({ ok: true, alreadyApplied: true, status: 'REJECTED', retired: [l.ids['Front v1']] })
    expect((await eventsOf(l.taskKey)).length).toBe(before)
    expect((await rowsOf(l.orderId))).toHaveLength(3)
  })

  it('a retire sent again is already applied', async () => {
    const l = await line({ status: 'REVIEW', arts: FRONT_BACK })
    const body = req(l, 'retire', { retire: [l.ids['Back v1']] })
    expect(await commitDelivery(l.taskKey, body, l.drive)).toMatchObject({ ok: true, alreadyApplied: false })
    const before = (await eventsOf(l.taskKey)).length
    expect(await commitDelivery(l.taskKey, body, l.drive)).toMatchObject({ ok: true, alreadyApplied: true, retired: [l.ids['Back v1']] })
    expect((await eventsOf(l.taskKey)).length).toBe(before)
  })

  it('a writer that changes the task after the checks makes replace 409 stale and nothing is retired', async () => {
    const l = await line({ status: 'REVIEW', arts: FRONT_BACK })
    const files = upload(l, [file({ printArea: 'Front', driveFileId: 'dlr-race-f' })])
    const fileInfo = l.drive.fileInfo
    l.drive.fileInfo = async id => {
      await prisma.designTask.update({ where: { taskKey: l.taskKey }, data: { status: 'DOING' } })
      return fileInfo(id)
    }
    const r = await commitDelivery(l.taskKey, req(l, 'replace', { files, retire: [l.ids['Front v1']] }), l.drive)
    expect(r).toMatchObject({ ok: false, code: 'stale', httpStatus: 409 })
    await expectUntouched({ ...l, status: 'DOING' }, ['Back v1', 'Front v1'])
    expect(moves(l.drive.calls)).toEqual([])
  })

  it('a row retired by another writer after the checks makes retire 409 stale', async () => {
    const l = await line({ status: 'REVIEW', arts: FRONT_BACK })
    const incoming = l.drive.incomingFolder
    l.drive.incomingFolder = async key => {
      await prisma.designArtwork.update({ where: { id: l.ids['Back v1'] }, data: { removedAt: new Date() } })
      return incoming(key)
    }
    const r = await commitDelivery(l.taskKey, req(l, 'retire', { retire: [l.ids['Front v1']] }), l.drive)
    expect(r).toMatchObject({ ok: false, code: 'stale', httpStatus: 409 })
    expect(await liveOf(l.orderId)).toEqual(['Front v1'])
    expect(await eventsOf(l.taskKey)).toHaveLength(0)
  })
})

describe('commitDelivery revert', () => {
  it('a REVIEW/AUTO line loses every AUTO file, keeps MANUAL mockups and goes back to NEW', async () => {
    const l = await line({ status: 'REVIEW', readiness: 'AUTO', arts: [
      { printArea: 'Front' }, { printArea: 'Back' }, { kind: 'MOCKUP', printArea: 'Main' }, { kind: 'MOCKUP', printArea: 'Side', source: 'MANUAL' },
    ] })
    await prisma.designTask.updateMany({ where: { orderId: l.orderId }, data: { prevStatus: 'NEW' } })
    const r = await commitDelivery(l.taskKey, req(l, 'revert'), l.drive)
    expect(r).toMatchObject({ ok: true, status: 'NEW', alreadyApplied: false })
    if (r.ok) expect([...r.retired].sort()).toEqual([l.ids['Front v1'], l.ids['Back v1'], l.ids['mockup Main v1']].sort())
    expect(await liveOf(l.orderId)).toEqual(['mockup Side v1'])
    for (const row of (await rowsOf(l.orderId)).filter(x => x.removedAt)) expect(row).toMatchObject({ removedById: null, drivePlace: null })
    expect(await taskOf(l.taskKey)).toMatchObject({ status: 'NEW', readiness: 'MANUAL', prevStatus: null })
    expect((await eventsOf(l.taskKey)).map(e => `${e.type}:${e.message}:${e.actorId}`))
      .toEqual(['SYSTEM:Gỡ file in tự động (máy local 26/10): gỡ Back v1, Front v1, mockup Main v1 — rút qua API:null'])
    expect(l.drive.calls).toContain(`tidy:${l.orderId}`)
  })

  it('revertReadiness and eventMessage are used when given', async () => {
    const l = await line({ status: 'REVIEW', readiness: 'AUTO', arts: [{ printArea: 'Front' }] })
    await commitDelivery(l.taskKey, req(l, 'revert', { revertReadiness: 'LOW', eventMessage: 'designer làm tay' }), l.drive)
    expect(await taskOf(l.taskKey)).toMatchObject({ status: 'NEW', readiness: 'LOW' })
    expect((await eventsOf(l.taskKey)).map(e => e.message)).toEqual(['Gỡ file in tự động (máy local 26/10): gỡ Front v1 — designer làm tay'])
  })

  it('a MANUAL print, readiness not AUTO, a status other than REVIEW or no print at all is 409 wrong_state', async () => {
    const manual = await line({ status: 'REVIEW', readiness: 'AUTO', arts: [{ printArea: 'Front' }, { printArea: 'Back', source: 'MANUAL' }] })
    expect(await commitDelivery(manual.taskKey, req(manual, 'revert'), manual.drive)).toMatchObject({ ok: false, code: 'wrong_state', httpStatus: 409 })
    await expectUntouched(manual, ['Back v1', 'Front v1'])

    const notAuto = await line({ status: 'REVIEW', readiness: 'MANUAL', arts: [{ printArea: 'Front' }] })
    expect(await commitDelivery(notAuto.taskKey, req(notAuto, 'revert'), notAuto.drive)).toMatchObject({ ok: false, code: 'wrong_state' })
    const rejected = await line({ status: 'REJECTED', readiness: 'AUTO', arts: [{ printArea: 'Front' }] })
    expect(await commitDelivery(rejected.taskKey, req(rejected, 'revert'), rejected.drive)).toMatchObject({ ok: false, code: 'wrong_state' })
    const empty = await line({ status: 'REVIEW', readiness: 'AUTO' })
    expect(await commitDelivery(empty.taskKey, req(empty, 'revert'), empty.drive)).toMatchObject({ ok: false, code: 'wrong_state' })
    await expectUntouched(empty, [])
  })

  it('a revert sent again is already applied and writes nothing', async () => {
    const l = await line({ status: 'REVIEW', readiness: 'AUTO', arts: [{ printArea: 'Front' }] })
    const body = req(l, 'revert')
    expect(await commitDelivery(l.taskKey, body, l.drive)).toMatchObject({ ok: true, status: 'NEW' })
    const again = await commitDelivery(l.taskKey, body, l.drive)
    expect(again).toMatchObject({ ok: true, alreadyApplied: true, status: 'NEW', retired: [l.ids['Front v1']] })
    expect(await eventsOf(l.taskKey)).toHaveLength(1)
  })

  it('a revert dryRun reports status NEW and writes nothing', async () => {
    const l = await line({ status: 'REVIEW', readiness: 'AUTO', arts: [{ printArea: 'Front' }] })
    const r = await commitDelivery(l.taskKey, req(l, 'revert', { dryRun: true }), l.drive)
    expect(r).toMatchObject({ ok: true, status: 'NEW', retired: [l.ids['Front v1']], artworks: [], alreadyApplied: false })
    await expectUntouched(l, ['Front v1'])
  })

  it('a revert resend after a person moved the task on is not already applied', async () => {
    const l = await line({ status: 'REVIEW', readiness: 'AUTO', arts: [{ printArea: 'Front' }] })
    const body = req(l, 'revert')
    await commitDelivery(l.taskKey, body, l.drive)
    await prisma.designTask.update({ where: { taskKey: l.taskKey }, data: { status: 'DOING' } })
    expect(await commitDelivery(l.taskKey, body, l.drive)).toMatchObject({ ok: false, code: 'stale', httpStatus: 409 })
  })

  it('readiness changed by a person after the checks makes revert 409 stale', async () => {
    const l = await line({ status: 'REVIEW', readiness: 'AUTO', arts: [{ printArea: 'Front' }] })
    const incoming = l.drive.incomingFolder
    l.drive.incomingFolder = async key => {
      await prisma.designTask.update({ where: { taskKey: l.taskKey }, data: { readiness: 'MANUAL' } })
      return incoming(key)
    }
    const r = await commitDelivery(l.taskKey, req(l, 'revert'), l.drive)
    expect(r).toMatchObject({ ok: false, code: 'stale', httpStatus: 409 })
    await expectUntouched(l, ['Front v1'])
    expect(await taskOf(l.taskKey)).toMatchObject({ status: 'REVIEW', readiness: 'MANUAL' })
  })
})

// Expected values copied from lineStatements in the local push script (scripts/lib/push-local-renders.mjs, peaceful-villani
// worktree): push from NEW inserts AUTO DRIVE rows, moves NEW -> REVIEW/AUTO with prevStatus NULL and writes ARTWORK then
// SYSTEM; replace in REVIEW retires with removedAt=now/removedById NULL, inserts the next version and writes one ARTWORK event.
// Not compared: id, createdAt, previewPath, drivePlace (script 'TASK'/'OLD', server NULL then tidy), driveWebViewLink.
describe('parity with the local push script', () => {
  const scriptRow = (orderId: string, over: Record<string, unknown>) => ({
    orderId, shopifyLineId: 'l1', kind: 'PRINT', storagePath: null, storage: 'DRIVE', size: 100, mimeType: 'image/png',
    widthPx: 1000, heightPx: 1000, uploadedById: null, source: 'AUTO', removedAt: null, removedById: null, publicToken: null, ...over,
  })
  const pick = (row: any) => {
    const out: Record<string, unknown> = {}
    for (const k of ['orderId', 'shopifyLineId', 'kind', 'printArea', 'version', 'fileName', 'storagePath', 'storage', 'driveFileId',
      'size', 'mimeType', 'widthPx', 'heightPx', 'uploadedById', 'source', 'removedAt', 'removedById', 'publicToken']) out[k] = row[k]
    if (out.removedAt) out.removedAt = 'set'
    return out
  }

  it('push from NEW with every part', async () => {
    const l = await line()
    const files = upload(l, [file({ printArea: 'Back', driveFileId: 'dlr-par-b' }), file({ printArea: 'Front', driveFileId: 'dlr-par-f' })])
    await commitDelivery(l.taskKey, req(l, 'push', { files }), l.drive)

    expect((await rowsOf(l.orderId)).map(pick)).toEqual([
      scriptRow(l.orderId, { printArea: 'Back', version: 1, fileName: 'back.png', driveFileId: 'dlr-par-b' }),
      scriptRow(l.orderId, { printArea: 'Front', version: 1, fileName: 'front.png', driveFileId: 'dlr-par-f' }),
    ])
    expect(await taskOf(l.taskKey)).toMatchObject({ status: 'REVIEW', readiness: 'AUTO', prevStatus: null })
    const events = (await eventsOf(l.taskKey)).sort((a, b) => a.type.localeCompare(b.type))
    expect(events.map(e => ({ type: e.type, message: e.message, actorId: e.actorId }))).toEqual([
      { type: 'ARTWORK', message: 'Render tự động (máy local 25/10) · 2 mảnh: Back v1, Front v1', actorId: null },
      { type: 'SYSTEM', message: 'Tự động gửi duyệt (file in tự động)', actorId: null },
    ])
  })

  it('replace in REVIEW', async () => {
    const l = await line({ status: 'REVIEW', readiness: 'AUTO', arts: [
      { printArea: 'Back', fileName: 'back.png', driveFileId: 'dlr-par2-b1' }, { printArea: 'Front', fileName: 'front.png', driveFileId: 'dlr-par2-f1' },
    ] })
    await prisma.designArtwork.create({ data: {
      orderId: l.orderId, shopifyLineId: 'l1', kind: 'PRINT', printArea: 'Front', version: 2, fileName: 'front.png', storage: 'DRIVE', driveFileId: 'dlr-par2-f2',
      size: 100, mimeType: 'image/png', widthPx: 1000, heightPx: 1000, source: 'AUTO', removedAt: new Date('2026-11-10'),
    } })
    const files = upload(l, [file({ printArea: 'Front', driveFileId: 'dlr-par2-f3' })])
    await commitDelivery(l.taskKey, req(l, 'replace', { files, retire: [l.ids['Front v1']] }), l.drive)

    expect((await rowsOf(l.orderId)).map(pick)).toEqual([
      scriptRow(l.orderId, { printArea: 'Back', version: 1, fileName: 'back.png', driveFileId: 'dlr-par2-b1' }),
      scriptRow(l.orderId, { printArea: 'Front', version: 1, fileName: 'front.png', driveFileId: 'dlr-par2-f1', removedAt: 'set' }),
      scriptRow(l.orderId, { printArea: 'Front', version: 2, fileName: 'front.png', driveFileId: 'dlr-par2-f2', removedAt: 'set' }),
      scriptRow(l.orderId, { printArea: 'Front', version: 3, fileName: 'front.png', driveFileId: 'dlr-par2-f3' }),
    ])
    expect(await taskOf(l.taskKey)).toMatchObject({ status: 'REVIEW', readiness: 'AUTO', prevStatus: null })
    expect((await eventsOf(l.taskKey)).map(e => ({ type: e.type, message: e.message, actorId: e.actorId }))).toEqual([
      { type: 'ARTWORK', message: 'Render lại (máy local 26/10) · Front v3 · 1000×1000 px · thay Front v1', actorId: null },
    ])
  })
})
