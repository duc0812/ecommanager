import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { prisma } from '@/lib/db'
import { cleanupIncoming } from '@/lib/delivery/incoming'
import { agentFixture } from './helpers/design-agent-fixture'
import { fakeDrive } from './helpers/delivery-fake-drive'

const fx = agentFixture('DLI')
const NOW = new Date('2026-11-15T12:00:00Z')
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
    drive.addFile({ id: 'inside', parent: folder, size: 1, createdTime: daysAgo(30) })
    await cleanupIncoming(drive, NOW)
    expect(drive.files.has('stray')).toBe(true)
    expect(drive.files.has('elsewhere')).toBe(true)
    expect(drive.files.has('inside')).toBe(false)
    expect(drive.calls.filter(c => c.startsWith('listChildren:')).every(c => c === 'listChildren:incoming-root' || c === `listChildren:${folder}`)).toBe(true)
    expect(drive.calls.filter(c => c.startsWith('deleteFile:'))).toEqual(['deleteFile:inside', `deleteFile:${folder}`])
  })
})
