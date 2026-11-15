import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'

const hooks = vi.hoisted(() => ({ fileInfoNever: false, tidyResult: null as any, tidyNever: false }))
vi.mock('@/lib/delivery/queue', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/delivery/queue')>()), memoryPressure: () => null }))
vi.mock('@/lib/google-drive', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/google-drive')>()
  return { ...real, getFileInfo: (id: string) => (hooks.fileInfoNever ? new Promise(() => {}) : real.getFileInfo(id)) }
})
vi.mock('@/lib/task-folder', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/task-folder')>()
  return { ...real, tidyTaskFolder: async () => (hooks.tidyNever ? new Promise(() => {}) : hooks.tidyResult) }
})
import { generateWorkerToken, revokeWorkerToken } from '@/lib/artwork-worker'
import { DriveAuthError, DriveError } from '@/lib/google-drive'
import { commitDelivery } from '@/lib/delivery/commit'
import { DriveTimeoutError, realDeliveryDrive, setDeliveryDriveForTests, setDriveTimeoutForTests, withDriveTimeout, type DeliveryDrive } from '@/lib/delivery/drive'
import { DELIVERY_SWITCH_KEY } from '@/lib/delivery/guard'
import type { CommitInput, DeliveryFile } from '@/lib/delivery/types'
import { GET as getState } from '@/app/api/design-studio/worker/delivery/tasks/[key]/route'
import { POST as postCommit } from '@/app/api/design-studio/worker/delivery/tasks/[key]/commit/route'
import { agentFixture } from './helpers/design-agent-fixture'
import { fakeDrive } from './helpers/delivery-fake-drive'

const fx = agentFixture('DLF')
const TPL_SKU = 'DLF-FB'
const MS = 20
const never = () => new Promise<never>(() => {})
let token = ''
let n = 0

type Fake = ReturnType<typeof fakeDrive>

async function line(opts: { status?: string; arts?: { printArea: string; driveFileId?: string }[] } = {}) {
  const o = await fx.order(++n, { supplierSku: TPL_SKU, taskStatus: opts.status })
  const taskFolder = `task-${o.orderId}-l1`
  const drive = fakeDrive()
  const ids: Record<string, string> = {}
  for (const a of opts.arts ?? []) {
    const driveFileId = a.driveFileId ?? `dlf-${n}-${a.printArea}`
    const row = await prisma.designArtwork.create({ data: {
      orderId: o.orderId, shopifyLineId: 'l1', kind: 'PRINT', printArea: a.printArea, version: 1, fileName: `${a.printArea.toLowerCase()}.png`,
      storage: 'DRIVE', driveFileId, drivePlace: 'TASK', size: 100, mimeType: 'image/png', widthPx: 1000, heightPx: 1000, source: 'AUTO',
    } })
    ids[a.printArea] = row.id
    if (!drive.files.has(driveFileId)) drive.addFile({ id: driveFileId, parent: taskFolder, size: 100, mimeType: 'image/png' })
  }
  const task = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: o.taskKeys[0] } })
  return { orderId: o.orderId, taskKey: o.taskKeys[0], taskFolder, drive, ids, status: task.status, liveIds: Object.values(ids) }
}

function file(printArea: string, driveFileId: string, over: Partial<DeliveryFile> = {}): DeliveryFile {
  return { kind: 'PRINT', printArea, driveFileId, fileName: `${printArea.toLowerCase()}.png`, size: 100, mimeType: 'image/png', widthPx: 1000, heightPx: 1000, shortcutOf: null, ...over }
}

function upload(l: { taskKey: string; drive: Fake }, files: DeliveryFile[]) {
  for (const f of files) if (!f.shortcutOf) l.drive.addFile({ id: f.driveFileId, parent: `incoming-${l.taskKey}`, size: f.size, mimeType: f.mimeType })
  return files
}

const req = (l: { status: string; liveIds: string[] }, action: CommitInput['action'], over: Partial<CommitInput> = {}): CommitInput =>
  ({ action, expected: { status: l.status, liveIds: l.liveIds }, files: [], retire: [], ...over })

const bounded = (drive: Fake, over: Partial<DeliveryDrive>) => withDriveTimeout({ ...drive, ...over } as DeliveryDrive, MS)
const rowsOf = (orderId: string) => prisma.designArtwork.findMany({ where: { orderId } })

const post = (key: string, body: unknown) => postCommit(
  new NextRequest(`http://localhost/api/design-studio/worker/delivery/tasks/${key}/commit`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }),
  { params: { key } },
)
const get = (key: string) => getState(
  new NextRequest(`http://localhost/api/design-studio/worker/delivery/tasks/${key}`, { headers: { authorization: `Bearer ${token}` } }),
  { params: { key } },
)

beforeAll(async () => {
  await fx.cleanup()
  await fx.seed()
  await prisma.printTemplate.deleteMany({ where: { supplierId: fx.supplierId } })
  const areas = JSON.stringify([{ name: 'Front', x: 0, y: 0, w: 1000, h: 1000 }, { name: 'Back', x: 1000, y: 0, w: 1000, h: 1000 }])
  await prisma.printTemplate.create({ data: { supplierId: fx.supplierId, supplierSku: TPL_SKU, name: 'DLF Front Back', widthPx: 2000, heightPx: 1000, areas } })
  token = await generateWorkerToken()
  await prisma.appSetting.upsert({ where: { key: DELIVERY_SWITCH_KEY }, update: { value: 'true' }, create: { key: DELIVERY_SWITCH_KEY, value: 'true' } })
})

afterEach(() => {
  hooks.fileInfoNever = false
  hooks.tidyNever = false
  hooks.tidyResult = null
  setDriveTimeoutForTests(null)
  setDeliveryDriveForTests(null)
  vi.restoreAllMocks()
})

afterAll(async () => {
  await prisma.appSetting.deleteMany({ where: { key: DELIVERY_SWITCH_KEY } })
  await revokeWorkerToken()
  await prisma.printTemplate.deleteMany({ where: { supplierId: fx.supplierId } })
  await fx.cleanup()
})

describe('withDriveTimeout', () => {
  it('passes results through and rejects a call that never answers with DriveTimeoutError', async () => {
    const d = bounded(fakeDrive(), { fileInfo: never })
    expect(await d.incomingRoot()).toBe('incoming-root')
    await expect(d.fileInfo('x')).rejects.toBeInstanceOf(DriveTimeoutError)
  })

  it('a timed-out call keeps running in the background', async () => {
    let done = false
    const d = bounded(fakeDrive(), { shareAnyoneReader: () => new Promise<void>(r => setTimeout(() => { done = true; r() }, MS * 3)) })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(d.shareAnyoneReader('x')).rejects.toBeInstanceOf(DriveTimeoutError)
    expect(done).toBe(false)
    await new Promise(r => setTimeout(r, MS * 4))
    expect(done).toBe(true)
  })

  it('every realDeliveryDrive method is bounded (injected timeout)', async () => {
    setDriveTimeoutForTests(MS)
    hooks.fileInfoNever = true
    await expect(realDeliveryDrive.fileInfo('x')).rejects.toBeInstanceOf(DriveTimeoutError)
    hooks.tidyNever = true
    await expect(realDeliveryDrive.tidy('o', 'l')).rejects.toBeInstanceOf(DriveTimeoutError)
  })

  it('realDeliveryDrive.tidy returns the TidyResult', async () => {
    hooks.tidyResult = { moved: 1, stuck: 0, failed: 0, lastError: null, promoted: false, authError: false }
    expect(await realDeliveryDrive.tidy('o', 'l')).toEqual(hooks.tidyResult)
  })
})

describe('Drive timeouts in a commit', () => {
  it('before the transaction: fileInfo, the task folder or a shortcut that never answers is 503 busy and nothing is written', async () => {
    const a = await line()
    const files = upload(a, [file('Front', 'dlf-a-f'), file('Back', 'dlf-a-b')])
    for (const over of [{ fileInfo: never }, { taskFolder: never }, { incomingFolder: never }] as Partial<DeliveryDrive>[]) {
      expect(await commitDelivery(a.taskKey, req(a, 'push', { files }), bounded(a.drive, over))).toMatchObject({ ok: false, code: 'busy', httpStatus: 503 })
    }
    expect(await rowsOf(a.orderId)).toHaveLength(0)

    const owner = await line({ arts: [{ printArea: 'Front', driveFileId: 'dlf-shared' }] })
    const b = await line()
    b.drive.addFile({ id: 'dlf-shared', parent: owner.taskFolder, size: 100 })
    const withShortcut = upload(b, [file('Front', 'dlf-shared', { shortcutOf: 'dlf-shared' }), file('Back', 'dlf-b-b')])
    expect(await commitDelivery(b.taskKey, req(b, 'push', { files: withShortcut }), bounded(b.drive, { createShortcut: never })))
      .toMatchObject({ ok: false, code: 'busy', httpStatus: 503 })
    expect(await rowsOf(b.orderId)).toHaveLength(0)
    expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: b.taskKey } })).status).toBe('NEW')
  })

  it('a shortcut lookup that times out before the transaction is busy, not a stuck row', async () => {
    const owner = await line({ status: 'REVIEW', arts: [{ printArea: 'Front', driveFileId: 'dlf-look' }] })
    void owner
    const l = await line({ status: 'REVIEW', arts: [{ printArea: 'Front', driveFileId: 'dlf-look' }, { printArea: 'Back' }] })
    const r = await commitDelivery(l.taskKey, req(l, 'retire', { retire: [l.ids.Front] }), bounded(l.drive, { findShortcut: never }))
    expect(r).toMatchObject({ ok: false, code: 'busy', httpStatus: 503 })
    expect((await rowsOf(l.orderId)).every(x => !x.removedAt)).toBe(true)
  })

  it('after the commit: a share, a shortcut move or tidy that never answers is a warning and the commit stands', async () => {
    const l = await line({ status: 'REVIEW', arts: [{ printArea: 'Front' }, { printArea: 'Back' }] })
    const files = upload(l, [file('Front', 'dlf-post-f')])
    const r = await commitDelivery(l.taskKey, req(l, 'replace', { files, retire: [l.ids.Front] }), bounded(l.drive, { shareAnyoneReader: never, tidy: never }))
    expect(r).toMatchObject({ ok: true, status: 'REVIEW' })
    if (r.ok) {
      expect(r.warnings.some(w => w.includes('chưa chia sẻ được file cũ') && w.includes('quá'))).toBe(true)
      expect(r.warnings.some(w => w.includes('Chưa xếp được file vào thư mục task') && w.includes('quá'))).toBe(true)
    }
    expect((await rowsOf(l.orderId)).find(x => x.id === l.ids.Front)!.removedAt).not.toBeNull()

    const owner = await line({ status: 'REVIEW', arts: [{ printArea: 'Front', driveFileId: 'dlf-sc-move' }] })
    const s = await line({ status: 'REVIEW', arts: [{ printArea: 'Front', driveFileId: 'dlf-sc-move' }, { printArea: 'Back' }] })
    s.drive.addFile({ id: 'dlf-sc-move', parent: owner.taskFolder, size: 100 })
    await s.drive.createShortcut('dlf-sc-move', s.taskFolder, 'Front.png')
    const moved = await commitDelivery(s.taskKey, req(s, 'retire', { retire: [s.ids.Front] }), bounded(s.drive, { moveFile: never }))
    expect(moved).toMatchObject({ ok: true })
    if (moved.ok) expect(moved.warnings.some(w => w.includes('chưa dời được lối tắt') && w.includes('quá'))).toBe(true)
    expect((await rowsOf(s.orderId)).find(x => x.id === s.ids.Front)).toMatchObject({ drivePlace: 'OLD' })
  })

  it('tidy failed and stuck counts become warnings', async () => {
    const l = await line()
    const files = upload(l, [file('Front', 'dlf-td-f'), file('Back', 'dlf-td-b')])
    const drive = { ...l.drive, tidy: async () => ({ moved: 0, stuck: 1, failed: 2, lastError: 'Drive 500', promoted: false, authError: false }) } as DeliveryDrive
    const r = await commitDelivery(l.taskKey, req(l, 'push', { files }), drive)
    expect(r).toMatchObject({ ok: true })
    if (r.ok) {
      expect(r.warnings).toContain('Chưa xếp được 2 file vào thư mục task: Drive 500 — lượt dọn định kỳ làm lại')
      expect(r.warnings).toContain('1 file Drive không cho chuyển (403/404) — giữ nguyên chỗ cũ, cần xem tay')
    }
  })
})

describe('Drive failures in the routes', () => {
  it('commit: a timeout before the transaction is 503 busy with Retry-After 30', async () => {
    const l = await line()
    const files = upload(l, [file('Front', 'dlf-rt-f'), file('Back', 'dlf-rt-b')])
    setDeliveryDriveForTests(bounded(l.drive, { fileInfo: never }))
    const res = await post(l.taskKey, req(l, 'push', { files }))
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('30')
    expect((await res.json()).code).toBe('busy')
  })

  it('commit: DriveAuthError is drive_not_connected, Drive 5xx/429 is busy with Retry-After 30, a 404 still throws', async () => {
    const l = await line()
    const files = upload(l, [file('Front', 'dlf-re-f'), file('Back', 'dlf-re-b')])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failWith = (err: Error) => setDeliveryDriveForTests({ ...l.drive, fileInfo: async () => { throw err } } as DeliveryDrive)

    failWith(new DriveAuthError('Google Drive cần kết nối lại'))
    const auth = await post(l.taskKey, req(l, 'push', { files }))
    expect(auth.status).toBe(503)
    expect((await auth.json()).code).toBe('drive_not_connected')

    for (const status of [500, 502, 429]) {
      failWith(new DriveError(`Google Drive: Backend Error (HTTP ${status})`, status))
      const res = await post(l.taskKey, req(l, 'push', { files }))
      expect(res.status).toBe(503)
      expect(res.headers.get('Retry-After')).toBe('30')
      expect((await res.json()).code).toBe('busy')
    }

    failWith(new DriveError('Google Drive: File not found (HTTP 404)', 404))
    await expect(post(l.taskKey, req(l, 'push', { files }))).rejects.toThrow('HTTP 404')
    expect(await rowsOf(l.orderId)).toHaveLength(0)
  })

  it('GET task state maps Drive failures the same way', async () => {
    const l = await line()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failWith = (err: Error) => setDeliveryDriveForTests({ ...l.drive, taskFolder: async () => { throw err } } as DeliveryDrive)

    failWith(new DriveAuthError('Google Drive chưa được kết nối.'))
    const auth = await get(l.taskKey)
    expect(auth.status).toBe(503)
    expect((await auth.json()).code).toBe('drive_not_connected')

    for (const err of [new DriveError('x (HTTP 503)', 503), new DriveError('x (HTTP 429)', 429), new DriveTimeoutError('taskFolder', 60000)]) {
      failWith(err)
      const res = await get(l.taskKey)
      expect(res.status).toBe(503)
      expect(res.headers.get('Retry-After')).toBe('30')
      expect((await res.json()).code).toBe('busy')
    }

    failWith(new DriveError('x (HTTP 403)', 403))
    await expect(get(l.taskKey)).rejects.toThrow('HTTP 403')

    setDeliveryDriveForTests(bounded(l.drive, { incomingFolder: never }))
    const slow = await get(l.taskKey)
    expect(slow.status).toBe(503)
    expect(slow.headers.get('Retry-After')).toBe('30')
  })
})
