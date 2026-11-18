import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const streamFile = vi.hoisted(() => vi.fn())
vi.mock('@/lib/google-drive', async original => ({ ...(await original<typeof import('@/lib/google-drive')>()), streamFile }))
vi.mock('@/lib/public-artwork', () => ({
  findPublicArtwork: async () => ({ id: 'a1', fileName: 'print.png', mimeType: 'image/png', storage: 'DRIVE', storagePath: '', driveFileId: 'drive-1', size: 3 }),
}))

import { DriveError } from '@/lib/google-drive'
import { GET } from '@/app/api/public/artwork/[token]/[fileName]/route'

const open = () => GET(new NextRequest('http://x/api/public/artwork/t/print.png'), { params: { token: 't', fileName: 'print.png' } })
const file = (headers: Record<string, string> = { 'content-length': '3' }) => new Response('abc', { headers })

beforeEach(() => {
  streamFile.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('public artwork stored on Drive', () => {
  it('serves the file with its size, so a supplier sees a complete download', async () => {
    streamFile.mockResolvedValue(file())
    const res = await open()
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Length')).toBe('3')
    expect(await res.text()).toBe('abc')
  })

  it('leaves the size out when Drive sent the file compressed', async () => {
    streamFile.mockResolvedValue(file({ 'content-length': '2', 'content-encoding': 'gzip' }))
    expect((await open()).headers.get('Content-Length')).toBeNull()
  })

  it('gets past a passing Drive failure', async () => {
    streamFile.mockRejectedValueOnce(new DriveError('Google Drive: invalid credentials', 401)).mockResolvedValue(file())
    expect((await open()).status).toBe(200)
    expect(streamFile).toHaveBeenCalledTimes(2)
  })

  it('answers "try again" and not "not found" when Drive keeps failing', async () => {
    streamFile.mockRejectedValue(new DriveError('Google Drive: backend error', 500))
    const res = await open()
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('30')
    expect(streamFile).toHaveBeenCalledTimes(3)
  })

  it('answers not found at once when the file is gone from Drive', async () => {
    streamFile.mockRejectedValue(new DriveError('Google Drive: File not found', 404))
    expect((await open()).status).toBe(404)
    expect(streamFile).toHaveBeenCalledTimes(1)
  })
})
