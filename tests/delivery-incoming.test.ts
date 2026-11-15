import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { prisma } from '@/lib/db'
import { cleanupIncoming } from '@/lib/delivery/incoming'
import { agentFixture } from './helpers/design-agent-fixture'
import { fakeDrive } from './helpers/delivery-fake-drive'

const fx = agentFixture('DLI')
const NOW = new Date('2026-11-15T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600000).toISOString()
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString()

beforeAll(async () => {
  await fx.cleanup()
  await fx.seed()
})
afterAll(async () => {
  await fx.cleanup()
})
beforeEach(() => {
  delete (globalThis as any).__deliveryIncomingCleanupAt
})

describe('cleanupIncoming', () => {
  it('deletes only the 8-day-old file and keeps the folder that still has a fresh file', async () => {
    const drive = fakeDrive()
    const folder = await drive.incomingFolder('T-1')
    drive.addFile({ id: 'old', parent: folder, size: 1, createdTime: daysAgo(8) })
    drive.addFile({ id: 'fresh', parent: folder, size: 1, createdTime: daysAgo(1) })
    const r = await cleanupIncoming(drive, NOW)
    expect(r).toEqual({ deletedFiles: 1, removedFolders: 0, kept: 0 })
    expect(drive.files.has('old')).toBe(false)
    expect(drive.files.has('fresh')).toBe(true)
    expect(drive.files.has(folder)).toBe(true)
  })

  it('removes an empty folder, and one emptied by the same pass', async () => {
    const drive = fakeDrive()
    const empty = await drive.incomingFolder('T-empty')
    const emptied = await drive.incomingFolder('T-emptied')
    drive.files.get(empty)!.createdTime = daysAgo(2)
    drive.files.get(emptied)!.createdTime = daysAgo(2)
    drive.addFile({ id: 'old2', parent: emptied, size: 1, createdTime: daysAgo(9) })
    const r = await cleanupIncoming(drive, NOW)
    expect(r).toEqual({ deletedFiles: 1, removedFolders: 2, kept: 0 })
    expect(drive.files.has(empty)).toBe(false)
    expect(drive.files.has(emptied)).toBe(false)
  })

  it('a second call within the hour makes no Drive calls; force overrides', async () => {
    const drive = fakeDrive()
    await drive.incomingFolder('T-2')
    await cleanupIncoming(drive, NOW)
    drive.calls.length = 0
    const again = await cleanupIncoming(drive, new Date(NOW.getTime() + 30 * 60000))
    expect(again).toEqual({ deletedFiles: 0, removedFolders: 0, kept: 0 })
    expect(drive.calls).toEqual([])
    await cleanupIncoming(drive, new Date(NOW.getTime() + 30 * 60000), { force: true })
    expect(drive.calls.length).toBeGreaterThan(0)
  })

  it('never deletes an old file a DesignArtwork row points at, live or removed', async () => {
    const o = await fx.order(1, {})
    const drive = fakeDrive()
    const folder = await drive.incomingFolder('T-3')
    drive.addFile({ id: 'dli-live', parent: folder, size: 1, createdTime: daysAgo(20) })
    drive.addFile({ id: 'dli-removed', parent: folder, size: 1, createdTime: daysAgo(20) })
    drive.addFile({ id: 'dli-orphan', parent: folder, size: 1, createdTime: daysAgo(20) })
    const base = { orderId: o.orderId, shopifyLineId: 'l1', kind: 'PRINT', fileName: 'a.png', storage: 'DRIVE', size: 1, mimeType: 'image/png' }
    await prisma.designArtwork.create({ data: { ...base, printArea: 'Front', version: 1, driveFileId: 'dli-live' } })
    await prisma.designArtwork.create({ data: { ...base, printArea: 'Back', version: 1, driveFileId: 'dli-removed', removedAt: new Date() } })
    const r = await cleanupIncoming(drive, NOW)
    expect(r).toEqual({ deletedFiles: 1, removedFolders: 0, kept: 2 })
    expect(drive.files.has('dli-live')).toBe(true)
    expect(drive.files.has('dli-removed')).toBe(true)
    expect(drive.files.has('dli-orphan')).toBe(false)
    expect(drive.calls.filter(c => c.startsWith('deleteFile:'))).toEqual(['deleteFile:dli-orphan'])
  })

  it('only lists and deletes inside _incoming, and leaves non-folder children alone', async () => {
    const drive = fakeDrive()
    drive.addFile({ id: 'stray', parent: 'incoming-root', size: 1, createdTime: daysAgo(30) })
    drive.addFile({ id: 'elsewhere', parent: 'task-folder', size: 1, createdTime: daysAgo(30) })
    const folder = await drive.incomingFolder('T-4')
    drive.files.get(folder)!.createdTime = daysAgo(2)
    drive.addFile({ id: 'inside', parent: folder, size: 1, createdTime: daysAgo(30) })
    await cleanupIncoming(drive, NOW)
    expect(drive.files.has('stray')).toBe(true)
    expect(drive.files.has('elsewhere')).toBe(true)
    expect(drive.files.has('inside')).toBe(false)
    expect(drive.calls.filter(c => c.startsWith('listChildren:')).every(c => c === 'listChildren:incoming-root' || c === `listChildren:${folder}`)).toBe(true)
    expect(drive.calls.filter(c => c.startsWith('deleteFile:'))).toEqual(['deleteFile:inside', `deleteFile:${folder}`])
  })

  it('empty folder: 2 hours old stays, 2 days old goes, unparsable createdTime stays', async () => {
    const drive = fakeDrive()
    const young = await drive.incomingFolder('T-young')
    const aged = await drive.incomingFolder('T-aged')
    const odd = await drive.incomingFolder('T-odd')
    drive.files.get(young)!.createdTime = hoursAgo(2)
    drive.files.get(aged)!.createdTime = daysAgo(2)
    drive.files.get(odd)!.createdTime = 'not-a-date'
    const r = await cleanupIncoming(drive, NOW)
    expect(r).toEqual({ deletedFiles: 0, removedFolders: 1, kept: 0 })
    expect(drive.files.has(young)).toBe(true)
    expect(drive.files.has(aged)).toBe(false)
    expect(drive.files.has(odd)).toBe(true)
  })

  it('never deletes a folder or shortcut-folder child of a task folder, counts it kept, and keeps the parent', async () => {
    const drive = fakeDrive()
    const folder = await drive.incomingFolder('T-5')
    drive.files.get(folder)!.createdTime = daysAgo(30)
    drive.addFile({ id: 'sub', parent: folder, size: 0, mimeType: 'application/vnd.google-apps.folder', createdTime: daysAgo(30) })
    drive.addFile({ id: 'oldfile', parent: folder, size: 1, createdTime: daysAgo(30) })
    const r = await cleanupIncoming(drive, NOW)
    expect(r).toEqual({ deletedFiles: 1, removedFolders: 0, kept: 1 })
    expect(drive.files.has('sub')).toBe(true)
    expect(drive.files.has(folder)).toBe(true)
  })

  it('keeps a file with an unparsable createdTime', async () => {
    const drive = fakeDrive()
    const folder = await drive.incomingFolder('T-6')
    drive.addFile({ id: 'weird', parent: folder, size: 1, createdTime: '' })
    const r = await cleanupIncoming(drive, NOW)
    expect(r.deletedFiles).toBe(0)
    expect(drive.files.has('weird')).toBe(true)
  })

  it('a Drive failure does not set the throttle, so the next call retries', async () => {
    const drive = fakeDrive()
    await drive.incomingFolder('T-7')
    const boom = { ...drive, listChildren: async () => { throw new Error('drive down') } }
    await expect(cleanupIncoming(boom as any, NOW)).rejects.toThrow('drive down')
    drive.calls.length = 0
    await cleanupIncoming(drive, NOW)
    expect(drive.calls.length).toBeGreaterThan(0)
  })
})
