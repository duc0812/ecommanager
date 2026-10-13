import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { GOOGLE_KEYS } from '@/lib/google-oauth'
import { primeAccessToken, resetDriveCache } from '@/lib/google-drive'
import { saveArtwork } from '@/lib/design-storage'
import { artworkUrl } from '@/lib/design-studio'
import { loadTask, transitionTask } from '@/lib/design-tasks'
import { pushArtworkToDrive } from '@/lib/design-drive-push'
import { drainDrivePushes, enqueueDrivePush, pushPendingArtworksToDrive, resetDrivePushQueue } from '@/lib/drive-push-queue'
import { resetTaskFolderState, tidyTaskFolder } from '@/lib/task-folder'
import { DELETE as deleteArtwork } from '@/app/api/design-studio/artwork/[artworkId]/route'
import { PATCH as renamePart } from '@/app/api/design-studio/tasks/[key]/parts/route'

type Call = { url: string; method: string; body: any }
type DriveFile = { id: string; name: string; parents: string[]; folder: boolean }

const KEYS = Object.values(GOOGLE_KEYS)
const SHOP = 'tf-store.myshopify.com'
const PROJECT = 'proj_tf'
const SUP = 'sup_tf'
const BASE = 'https://app.shop-tool.com'
const SESSION = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=tf-'
const FILES = 'https://www.googleapis.com/drive/v3/files'
const leader = { id: 'tf-leader', name: 'Lead', role: 'ADMIN' }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-storage-'))
const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL
const fileLink = (id: string) => `https://drive.google.com/file/d/${id}/view?usp=drivesdk`
const folderLink = (id: string) => `https://drive.google.com/drive/folders/${id}`

let storeId = ''
let designerId = ''
let designerToken = ''
let seq = 0
let calls: Call[] = []
let drive = new Map<string, DriveFile>()
let refused = new Map<string, number>()
let failingUploads: string[] = []

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** A small Drive: folders and files with one parent each, found by name, movable and renamable. `refused` answers 404/403 for a file id. */
function driveMock() {
  calls = []
  let ids = 0
  const sessions = new Map<string, { name: string; parents: string[] }>()
  vi.stubGlobal('fetch', vi.fn(async (input: any, init: RequestInit = {}) => {
    const url = String(input)
    const method = init.method ?? 'GET'
    const c: Call = { url, method, body: init.body }
    calls.push(c)
    if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'at-new', expires_in: 3600 })
    if (url.startsWith('https://www.googleapis.com/drive/v3/about')) return json({ user: { emailAddress: 'o@gmail.com' }, storageQuota: { limit: '100', usage: '1' } })
    if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files') && method === 'POST') {
      const meta = JSON.parse(String(init.body))
      const id = String(++ids)
      sessions.set(id, { name: meta.name, parents: meta.parents })
      return new Response(null, { status: 200, headers: { Location: `${SESSION}${id}` } })
    }
    if (url.startsWith(SESSION) && method === 'PUT') {
      const s = sessions.get(url.slice(SESSION.length))!
      if (failingUploads.some(n => s.name.includes(n))) return json({ error: { message: 'Backend Error' } }, 503)
      const id = `file-${url.slice(SESSION.length)}`
      drive.set(id, { id, name: s.name, parents: s.parents, folder: false })
      return json({ id, webViewLink: fileLink(id) })
    }
    if (url.startsWith(`${FILES}?q=`)) {
      const q = new URL(url).searchParams.get('q') ?? ''
      const name = /name='((?:[^'\\]|\\.)*)'/.exec(q)?.[1].replace(/\\(.)/g, '$1')
      const parent = /'([^']*)' in parents/.exec(q)?.[1]
      const hit = Array.from(drive.values()).find(f => f.folder && f.name === name && f.parents[0] === parent)
      return json({ files: hit ? [{ id: hit.id, name: hit.name }] : [] })
    }
    if (url.startsWith(`${FILES}?fields=id`) && method === 'POST') {
      const meta = JSON.parse(String(init.body))
      const id = `folder-${++ids}`
      drive.set(id, { id, name: meta.name, parents: meta.parents, folder: true })
      return json({ id })
    }
    const match = /\/drive\/v3\/files\/([^/?]+)(\/permissions)?/.exec(url)
    if (match) {
      const id = decodeURIComponent(match[1])
      if (match[2]) return json({ id: 'anyoneWithLink' })
      const status = refused.get(id)
      if (status) return json({ error: { message: status === 404 ? `File not found: ${id}.` : 'The user does not have sufficient permissions for this file.' } }, status)
      const f = drive.get(id)
      if (!f) return json({ error: { message: `File not found: ${id}.` } }, 404)
      if (method === 'GET') return json({ id, name: f.name, parents: f.parents })
      if (method === 'PATCH') {
        const sp = new URL(url).searchParams
        const add = (sp.get('addParents') ?? '').split(',').filter(Boolean)
        const remove = (sp.get('removeParents') ?? '').split(',').filter(Boolean)
        const patch = JSON.parse(String(init.body ?? '{}'))
        f.parents = [...f.parents.filter(p => !remove.includes(p)), ...add]
        if (patch.name) f.name = patch.name
        return json({ id })
      }
      if (method === 'DELETE') { drive.delete(id); return new Response(null, { status: 204 }) }
    }
    return json({ error: { message: `unexpected ${method} ${url}` } }, 500)
  }))
}

const inFolder = (folderId: string) => Array.from(drive.values()).filter(f => !f.folder && f.parents.includes(folderId)).map(f => f.name).sort()
const folderNamed = (name: string, parent?: string) => Array.from(drive.values()).find(f => f.folder && f.name === name && (!parent || f.parents[0] === parent))
const shares = () => calls.filter(c => c.url.includes('/permissions'))
const moves = () => calls.filter(c => c.method === 'PATCH')

async function connect() {
  await prisma.appSetting.createMany({
    data: [
      { key: GOOGLE_KEYS.clientId, value: 'cid' },
      { key: GOOGLE_KEYS.clientSecret, value: 'secret' },
      { key: GOOGLE_KEYS.refreshToken, value: '1//refresh' },
      { key: GOOGLE_KEYS.rootFolderId, value: 'root-1' },
    ],
  })
  primeAccessToken('at-primed', 3600, '1//refresh')
}

type Task = { orderId: string; lineId: string; key: string; number: string; sku: string }

async function makeTask(opts: { status?: string; supplierSku?: string; withTask?: boolean } = {}): Promise<Task> {
  seq += 1
  const orderId = `gid://test/Order/tf-${seq}`
  const number = `#TF${seq}`
  const sku = `TF-SKU-${seq}`
  const order = await prisma.order.create({
    data: {
      id: orderId, projectId: PROJECT, storeId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-05T12:00:00Z'), pipelineStatus: 'PENDING_DESIGN',
      lines: { create: [{ shopifyLineId: 'l1', sku, productTitle: 'Jersey', qty: 1, linePosition: 1, unitPrice: 1, resolvedSupplierId: SUP,
        resolvedSupplierSku: opts.supplierSku ?? null, customized: false, customAttributesJson: '[]' }] },
    },
    include: { lines: true },
  })
  const key = `TF${seq}_1`
  if (opts.withTask !== false) await prisma.designTask.create({ data: { orderId, shopifyLineId: 'l1', taskKey: key, status: opts.status ?? 'DOING' } })
  return { orderId, lineId: order.lines[0].id, key, number, sku }
}

function add(t: Task, fileName: string, opts: { kind?: 'PRINT' | 'MOCKUP'; printArea?: string; source?: 'AUTO' | 'MANUAL' } = {}) {
  return saveArtwork({
    lineId: t.lineId, kind: opts.kind, printArea: opts.printArea ?? fileName.replace(/\.[^.]+$/, ''), fileName,
    mimeType: '', bytes: Buffer.from(`bytes of ${fileName} ${Math.random()}`), uploadedById: designerId, source: opts.source,
  })
}

async function upload(t: Task, fileName: string, opts: Parameters<typeof add>[2] = {}) {
  const saved = await add(t, fileName, opts)
  enqueueDrivePush(saved.id)
  await drainDrivePushes()
  return row(saved.id)
}

const row = (id: string) => prisma.designArtwork.findUniqueOrThrow({ where: { id } })
const taskRow = (key: string) => prisma.designTask.findUniqueOrThrow({ where: { taskKey: key } })
const lineOf = (t: Task) => prisma.orderLine.findUniqueOrThrow({ where: { id: t.lineId } })
const events = async (key: string) => (await prisma.designTaskEvent.findMany({ where: { task: { taskKey: key } }, orderBy: { createdAt: 'asc' } })).map(e => e.message)

async function legacy(t: Task, printArea: string, version: number, fileId: string, opts: { removed?: boolean; folder?: string } = {}) {
  drive.set(fileId, { id: fileId, name: `v${version}-${printArea.toLowerCase()}.png`, parents: [opts.folder ?? 'legacy-folder'], folder: false })
  return prisma.designArtwork.create({
    data: {
      orderId: t.orderId, shopifyLineId: 'l1', printArea, version, fileName: `${printArea.toLowerCase()}.png`, size: 9, mimeType: 'image/png',
      storage: 'DRIVE', driveFileId: fileId, driveWebViewLink: fileLink(fileId), storagePath: null, removedAt: opts.removed ? new Date() : null,
    },
  })
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'TF Store', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'TFSUP' }, create: { id: SUP, name: 'TF Supplier', code: 'TFSUP' }, update: {} })
  await prisma.printTemplate.create({ data: {
    supplierId: SUP, supplierSku: 'TF-JERSEY', name: 'Jersey', widthPx: 100, heightPx: 100,
    areas: JSON.stringify([{ name: 'Front', x: 0, y: 0, w: 50, h: 100 }, { name: 'Back', x: 50, y: 0, w: 50, h: 100 }]),
  } })
  designerId = (await prisma.appUser.upsert({
    where: { email: 'designer@tf.test' }, create: { name: 'Designer', email: 'designer@tf.test', role: 'SUPPORT', permissions: '["design_tasks"]' }, update: {},
  })).id
  designerToken = await signToken({ userId: designerId, email: 'designer@tf.test', name: 'Designer', role: 'SUPPORT', permissions: ['design_tasks'], tv: 0 })
})

beforeEach(async () => {
  await drainDrivePushes()
  resetDrivePushQueue()
  resetTaskFolderState()
  resetDriveCache()
  process.env.NEXT_PUBLIC_APP_URL = BASE
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  await prisma.order.deleteMany({ where: { storeId } })
  await prisma.skuSupplierDesign.deleteMany({ where: { supplierId: SUP } })
  drive = new Map()
  refused = new Map()
  failingUploads = []
  await connect()
  driveMock()
})

afterEach(async () => {
  await drainDrivePushes()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  await prisma.order.deleteMany({ where: { storeId } })
  await prisma.skuSupplierDesign.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.appUser.deleteMany({ where: { email: 'designer@tf.test' } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
  if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl
})

describe('one task = one Drive folder', () => {
  it('creates and shares the folder once, at the first push, and every file of the task lands in it under its part name', async () => {
    const t = await makeTask()
    expect((await loadTask(t.key))!.driveFolder).toBeNull()

    const front = await upload(t, 'front.png')
    const folder = folderNamed(t.key)!
    expect(folder).toBeTruthy()
    expect([folderNamed('TF Store')!.parents, folderNamed('2026-10')!.parents[0], folderNamed(t.number)!.parents[0], folder.parents[0]])
      .toEqual([['root-1'], folderNamed('TF Store')!.id, folderNamed('2026-10')!.id, folderNamed(t.number)!.id])
    expect(await taskRow(t.key)).toMatchObject({ driveFolderId: folder.id, driveFolderUrl: folderLink(folder.id) })
    expect((await loadTask(t.key))!.driveFolder).toEqual({ url: folderLink(folder.id) })

    await upload(t, 'back.psd')
    await upload(t, 'look.jpg', { kind: 'MOCKUP' })
    await upload(t, 'TF_1_Wrap_auto.png', { printArea: 'Wrap', source: 'AUTO' })
    await upload(t, 'x.png', { printArea: 'Tay áo: trái/phải' })

    expect(inFolder(folder.id)).toEqual(['MOCKUP_look.jpg', 'Tay áo_ trái_phải.png', 'Wrap.png', 'back.psd', 'front.png'])
    expect(shares().map(c => c.url)).toEqual([`${FILES}/${folder.id}/permissions?fields=id`])
    expect(JSON.parse(String(shares()[0].body))).toEqual({ role: 'reader', type: 'anyone' })
    expect(Array.from(drive.values()).filter(f => f.folder).map(f => f.name)).toEqual(['TF Store', '2026-10', t.number, t.key])
    expect(moves()).toHaveLength(0)
    expect(await row(front.id)).toMatchObject({ storage: 'DRIVE', drivePlace: 'TASK', kind: 'PRINT' })
    expect(await prisma.designArtwork.count({ where: { orderId: t.orderId, drivePlace: 'TASK' } })).toBe(5)
  })

  it('a line without a task keeps its files where they always went, each shared on its own', async () => {
    const t = await makeTask({ withTask: false })
    const saved = await add(t, 'front.png')
    expect((await pushArtworkToDrive(saved.id)).pushed).toBe(true)
    const folder = folderNamed(t.key)!
    expect(inFolder(folder.id)).toEqual(['v1-front.png'])
    expect(shares().map(c => c.url)).toEqual([`${FILES}/${(await row(saved.id)).driveFileId}/permissions?fields=id`])
    expect((await row(saved.id)).driveFileId).toMatch(/^file-/)
    expect((await row(saved.id)).drivePlace).toBeNull()
  })

  it('a new version of a part pushes the version before it into _old; the folder never shows both', async () => {
    const t = await makeTask()
    const v1 = await upload(t, 'front.png')
    const back = await upload(t, 'back.png')
    const folder = folderNamed(t.key)!
    expect(folderNamed('_old', folder.id)).toBeUndefined()

    const before = calls.length
    const v2 = await upload(t, 'front.png')
    expect(v2).toMatchObject({ printArea: 'front', version: 2, drivePlace: 'TASK' })
    const old = folderNamed('_old', folder.id)!
    expect(inFolder(folder.id)).toEqual(['back.png', 'front.png'])
    expect(inFolder(old.id)).toEqual(['v1_front.png'])
    expect(drive.get(v1.driveFileId!)).toMatchObject({ parents: [old.id], name: 'v1_front.png' })
    expect(drive.get(v2.driveFileId!)).toMatchObject({ parents: [folder.id], name: 'front.png' })
    expect((await row(v1.id)).drivePlace).toBe('OLD')
    expect((await row(back.id)).drivePlace).toBe('TASK')

    const move = moves()[0]
    expect(move.url).toContain(`/files/${v1.driveFileId}?`)
    expect(new URL(move.url).searchParams.get('addParents')).toBe(old.id)
    expect(new URL(move.url).searchParams.get('removeParents')).toBe(folder.id)
    const sinceUpload = calls.slice(before)
    expect(sinceUpload.findIndex(c => c.method === 'PATCH')).toBeLessThan(sinceUpload.findIndex(c => c.method === 'PUT'))
    expect(shares()).toHaveLength(1)

    await upload(t, 'front.png')
    expect(inFolder(old.id)).toEqual(['v1_front.png', 'v2_front.png'])
    expect(Array.from(drive.values()).filter(f => f.folder && f.name === '_old')).toHaveLength(1)
  })

  it('an old version still on the server needs no move: it goes straight into _old when it is pushed', async () => {
    const t = await makeTask()
    await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
    const v1 = await upload(t, 'front.png')
    const v2 = await upload(t, 'front.png')
    expect(calls).toHaveLength(0)
    expect([v1.storage, v2.storage]).toEqual(['LOCAL', 'LOCAL'])

    await connect()
    expect(await pushPendingArtworksToDrive({ limit: 10 })).toMatchObject({ pushed: 2, organized: 0, stuck: 0 })
    const folder = folderNamed(t.key)!
    expect(inFolder(folder.id)).toEqual(['front.png'])
    expect(inFolder(folderNamed('_old', folder.id)!.id)).toEqual(['v1_front.png'])
    expect(moves()).toHaveLength(0)
    expect([(await row(v1.id)).drivePlace, (await row(v2.id)).drivePlace]).toEqual(['OLD', 'TASK'])
  })

  it('a removed file moves to _old, and the version before it is the current file in the folder again', async () => {
    const t = await makeTask()
    const v1 = await upload(t, 'front.png')
    const v2 = await upload(t, 'front.png')
    const mock = await upload(t, 'look.png', { kind: 'MOCKUP' })
    const folder = folderNamed(t.key)!
    const old = folderNamed('_old', folder.id)!

    const del = async (id: string) => {
      const req = new NextRequest(`http://x/api/design-studio/artwork/${id}`, { method: 'DELETE' })
      req.cookies.set(AUTH_COOKIE, designerToken)
      const res = await deleteArtwork(req, { params: { artworkId: id } })
      await drainDrivePushes()
      return res
    }
    const res = await del(v2.id)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ removed: { id: v2.id, printArea: 'front', version: 2, removedAt: expect.any(String) } })
    expect(inFolder(folder.id)).toEqual(['MOCKUP_look.png', 'front.png'])
    expect(inFolder(old.id)).toEqual(['v2_front.png'])
    expect(drive.get(v1.driveFileId!)).toMatchObject({ parents: [folder.id], name: 'front.png' })
    expect([(await row(v1.id)).drivePlace, (await row(v2.id)).drivePlace]).toEqual(['TASK', 'OLD'])

    expect((await del(mock.id)).status).toBe(200)
    expect(inFolder(folder.id)).toEqual(['front.png'])
    expect(inFolder(old.id)).toEqual(['v1_MOCKUP_look.png', 'v2_front.png'])
  })

  it('renaming a part renames every version of it, and the Drive file in the folder follows', async () => {
    const t = await makeTask()
    const v1 = await upload(t, 'front.png')
    const v2 = await upload(t, 'front.png')
    await upload(t, 'back.png')
    const mock = await upload(t, 'front.png', { kind: 'MOCKUP' })
    const folder = folderNamed(t.key)!

    const rename = async (body: unknown, key = t.key) => {
      const req = new NextRequest(`http://x/api/design-studio/tasks/${key}/parts`, { method: 'PATCH', body: JSON.stringify(body) })
      req.cookies.set(AUTH_COOKIE, designerToken)
      const res = await renamePart(req, { params: { key } })
      await drainDrivePushes()
      return res
    }
    const res = await rename({ from: 'front', to: '  Mặt trước ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ renamed: { kind: 'PRINT', from: 'front', to: 'Mặt trước', changed: 2 } })
    expect([(await row(v1.id)).printArea, (await row(v2.id)).printArea, (await row(mock.id)).printArea]).toEqual(['Mặt trước', 'Mặt trước', 'front'])
    expect(inFolder(folder.id)).toEqual(['MOCKUP_front.png', 'Mặt trước.png', 'back.png'])
    expect((await row(v2.id)).drivePlace).toBe('TASK')
    expect(await events(t.key)).toContain('Đổi tên file in "front" → "Mặt trước"')

    const next = await upload(t, 'mặt trước.png', { printArea: 'Mặt trước' })
    expect(next.version).toBe(3)

    expect((await rename({ from: 'back', to: 'MẶT TRƯỚC' })).status).toBe(409)
    expect((await rename({ from: 'nope', to: 'x' })).status).toBe(404)
    expect((await rename({ from: 'back', to: '   ' })).status).toBe(400)
    expect((await rename({ from: 'back' })).status).toBe(400)
    expect((await rename({ kind: 'OTHER', from: 'back', to: 'x' })).status).toBe(400)
    expect((await rename({ from: 'back', to: 'x' }, 'NOPE_1')).status).toBe(404)
    expect(await (await rename({ kind: 'MOCKUP', from: 'front', to: 'Look' })).json()).toEqual({ renamed: { kind: 'MOCKUP', from: 'front', to: 'Look', changed: 1 } })
    expect(inFolder(folder.id)).toContain('MOCKUP_Look.png')
    expect(await (await rename({ from: 'back', to: 'Back' })).json()).toMatchObject({ renamed: { to: 'Back', changed: 1 } })

    await prisma.designTask.update({ where: { taskKey: t.key }, data: { status: 'DONE' } })
    const locked = await rename({ from: 'Back', to: 'Lưng' })
    expect(locked.status).toBe(409)
    expect((await locked.json()).error).toMatch(/Sửa & gửi lại/)
  })

  it('on a template task a file named like an area fills that area; other names are extra files', async () => {
    const t = await makeTask({ supplierSku: 'TF-JERSEY' })
    const { PUT: uploadRoute } = await import('@/app/api/design-studio/tasks/[key]/artwork/route')
    const put = async (fileName: string) => {
      const req = new NextRequest(`http://x/api/design-studio/tasks/${t.key}/artwork?${new URLSearchParams({ fileName })}`, {
        method: 'PUT', headers: { 'content-type': 'image/png' }, body: Buffer.from(`png ${fileName}`),
      })
      req.cookies.set(AUTH_COOKIE, designerToken)
      const res = await uploadRoute(req, { params: { key: t.key } })
      await drainDrivePushes()
      return (await res.json()).artwork
    }
    expect(await put('front.png')).toMatchObject({ printArea: 'Front', version: 1 })
    expect(await put('FRONT.png')).toMatchObject({ printArea: 'Front', version: 2 })
    expect(await put('sleeve.png')).toMatchObject({ printArea: 'sleeve', version: 1 })
    await expect(transitionTask(t.key, { id: designerId, name: 'Designer', role: 'SUPPORT' }, { to: 'REVIEW' })).rejects.toThrow('Chưa có artwork cho: Back')
    expect(await put('Back.png')).toMatchObject({ printArea: 'Back', version: 1 })
    expect((await transitionTask(t.key, { id: designerId, name: 'Designer', role: 'SUPPORT' }, { to: 'REVIEW' })).task.status).toBe('REVIEW')
    const folder = folderNamed(t.key)!
    expect(inFolder(folder.id)).toEqual(['Back.png', 'Front.png', 'sleeve.png'])
    expect(inFolder(folderNamed('_old', folder.id)!.id)).toEqual(['v1_Front.png'])
  })
})

describe('the link handed to the factory', () => {
  it('approval stores the folder only when every print file is in it; the queue turns the earlier links into the folder link later', async () => {
    const t = await makeTask({ status: 'REVIEW' })
    failingUploads = ['back']
    const front = await upload(t, 'front.png')
    const back = await upload(t, 'back.png')
    await upload(t, 'look.png', { kind: 'MOCKUP' })
    const folder = folderNamed(t.key)!
    expect([front.storage, back.storage]).toEqual(['DRIVE', 'LOCAL'])

    const approved = await transitionTask(t.key, leader, { to: 'DONE' })
    expect(approved.order).toMatchObject({ designReady: true, pipelineStatus: 'READY_TO_PRODUCTION' })
    expect((await lineOf(t)).designDriveLink).toBe(artworkUrl(back.id))
    const token = (await row(back.id)).publicToken
    const library = () => prisma.skuSupplierDesign.findUniqueOrThrow({ where: { sku_supplierId: { sku: t.sku, supplierId: SUP } } })
    expect((await library()).designLink).toBe(`${BASE}/api/public/artwork/${token}/back.png | ${fileLink(front.driveFileId!)}`)
    const reuse = await makeTask({ withTask: false })
    await prisma.orderLine.update({ where: { id: reuse.lineId }, data: { designDriveLink: (await library()).designLink } })

    failingUploads = []
    expect(await pushPendingArtworksToDrive({ limit: 10, force: true })).toMatchObject({ pushed: 1, failed: 0 })
    expect(inFolder(folder.id)).toEqual(['MOCKUP_look.png', 'back.png', 'front.png'])
    expect((await lineOf(t)).designDriveLink).toBe(folderLink(folder.id))
    expect((await prisma.order.findUniqueOrThrow({ where: { id: t.orderId } })).designDriveLink).toBe(folderLink(folder.id))
    expect((await library()).designLink).toBe(folderLink(folder.id))
    expect((await lineOf(reuse)).designDriveLink).toBe(folderLink(folder.id))
  })

  it('approving a task whose print files are all in the folder stores the folder link at once, also in the design library', async () => {
    const t = await makeTask({ status: 'REVIEW' })
    await upload(t, 'front.png')
    await upload(t, 'back.png')
    const folder = folderNamed(t.key)!
    await transitionTask(t.key, leader, { to: 'DONE' })
    expect((await lineOf(t)).designDriveLink).toBe(folderLink(folder.id))
    expect((await prisma.skuSupplierDesign.findUniqueOrThrow({ where: { sku_supplierId: { sku: t.sku, supplierId: SUP } } })).designLink).toBe(folderLink(folder.id))

    await transitionTask(t.key, leader, { to: 'DOING' })
    expect((await lineOf(t)).designDriveLink).toBeNull()
    await transitionTask(t.key, leader, { to: 'REVIEW' })
    await transitionTask(t.key, leader, { to: 'DONE' })
    expect((await lineOf(t)).designDriveLink).toBe(folderLink(folder.id))
    expect(await events(t.key)).not.toContain('Design đã có từ ngoài studio — giữ link hiện tại')
  })

  it('without Drive the line keeps the app link of its first print file, as before', async () => {
    await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
    const t = await makeTask({ status: 'REVIEW' })
    await upload(t, 'front.png')
    const back = await upload(t, 'back.png')
    await transitionTask(t.key, leader, { to: 'DONE' })
    expect((await lineOf(t)).designDriveLink).toBe(artworkUrl(back.id))
    expect((await taskRow(t.key)).driveFolderId).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('a task without any print file cannot be approved, whatever mockups it has', async () => {
    const t = await makeTask({ status: 'REVIEW' })
    await upload(t, 'look.png', { kind: 'MOCKUP' })
    await expect(transitionTask(t.key, leader, { to: 'DONE' })).rejects.toThrow(/No artwork uploaded/)
    expect((await lineOf(t)).designDriveLink).toBeNull()
  })
})

describe('"Sắp xếp lại thư mục" for files pushed before task folders', () => {
  it('moves them into the task folder or _old, leaves a file Drive refuses where it is and notes it on the task', async () => {
    const t = await makeTask()
    const v1 = await legacy(t, 'Front', 1, 'legacy-1')
    const v2 = await legacy(t, 'Front', 2, 'legacy-2')
    const gone = await legacy(t, 'Back', 1, 'legacy-gone')
    const forbidden = await legacy(t, 'Sleeve', 1, 'legacy-forbidden')
    const removed = await legacy(t, 'Collar', 1, 'legacy-removed', { removed: true })
    refused.set('legacy-gone', 404)
    refused.set('legacy-forbidden', 403)
    const orphan = await makeTask({ withTask: false })
    const orphanFile = await legacy(orphan, 'Front', 1, 'legacy-orphan')
    await prisma.orderLine.update({ where: { id: t.lineId }, data: { designDriveLink: fileLink('legacy-2') } })

    const summary = await pushPendingArtworksToDrive({ limit: 50, force: true })
    expect(summary).toMatchObject({ pending: 0, pushed: 0, failed: 0, organized: 3, stuck: 2, stopped: null })
    const folder = folderNamed(t.key)!
    const old = folderNamed('_old', folder.id)!
    expect(inFolder(folder.id)).toEqual(['Front.png'])
    expect(inFolder(old.id)).toEqual(['v1_Collar.png', 'v1_Front.png'])
    expect(drive.get('legacy-gone')!.parents).toEqual(['legacy-folder'])
    expect(drive.get('legacy-forbidden')).toMatchObject({ parents: ['legacy-folder'], name: 'v1-sleeve.png' })
    expect(drive.get('legacy-orphan')!.parents).toEqual(['legacy-folder'])
    expect(await Promise.all([v1, v2, gone, forbidden, removed, orphanFile].map(async r => (await row(r.id)).drivePlace))).toEqual(['OLD', 'TASK', 'STUCK', 'STUCK', 'OLD', null])
    expect(await taskRow(t.key)).toMatchObject({ driveFolderId: folder.id, driveFolderUrl: folderLink(folder.id) })
    expect(shares().map(c => c.url)).toEqual([`${FILES}/${folder.id}/permissions?fields=id`])
    const notes = (await events(t.key)).filter(m => m.includes('giữ nguyên chỗ cũ'))
    expect(notes).toHaveLength(2)
    expect(notes[0]).toMatch(/Không chuyển được file (Back|Sleeve) v1 .*\(Drive trả 40[34]\)/)
    // Two print files could not be brought in, so the factory keeps the single-file link.
    expect((await lineOf(t)).designDriveLink).toBe(fileLink('legacy-2'))

    const before = calls.length
    expect(await pushPendingArtworksToDrive({ limit: 50 })).toMatchObject({ organized: 0, stuck: 0 })
    expect(calls.length).toBe(before)

    refused.delete('legacy-gone')
    refused.delete('legacy-forbidden')
    expect(await pushPendingArtworksToDrive({ limit: 50, force: true })).toMatchObject({ organized: 2, stuck: 0 })
    expect(inFolder(folder.id)).toEqual(['Back.png', 'Front.png', 'Sleeve.png'])
    expect((await events(t.key)).filter(m => m.includes('giữ nguyên chỗ cũ'))).toHaveLength(2)
    expect((await lineOf(t)).designDriveLink).toBe(folderLink(folder.id))
  })

  it('a refusal on a forced retry is not noted twice, and a server error is tried again on the next run', async () => {
    const t = await makeTask()
    const gone = await legacy(t, 'Front', 1, 'legacy-gone')
    refused.set('legacy-gone', 404)
    expect(await tidyTaskFolder(t.orderId, 'l1')).toMatchObject({ moved: 0, stuck: 1, failed: 0 })
    expect(await tidyTaskFolder(t.orderId, 'l1')).toMatchObject({ moved: 0, stuck: 0 })
    expect(await tidyTaskFolder(t.orderId, 'l1', { retryStuck: true })).toMatchObject({ stuck: 1 })
    expect((await events(t.key)).filter(m => m.includes('giữ nguyên chỗ cũ'))).toHaveLength(1)

    refused.set('legacy-gone', 500)
    const failed = await tidyTaskFolder(t.orderId, 'l1', { retryStuck: true })
    expect(failed).toMatchObject({ moved: 0, stuck: 0, failed: 1 })
    expect((await row(gone.id)).drivePlace).toBeNull()
    refused.delete('legacy-gone')
    expect(await pushPendingArtworksToDrive({ limit: 5 })).toMatchObject({ organized: 1 })
    expect((await row(gone.id)).drivePlace).toBe('TASK')
  })
})
