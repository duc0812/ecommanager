import fs from 'fs'

// Resumable Google Drive upload straight from this PC into the task's incoming folder. It only ever creates files:
// there is no delete, trash or move here. The access token comes from the server (cachedDriveToken) and is never logged.

const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,size'
export const CHUNK_SIZE = 8 * 1024 * 1024
const MAX_CHUNK_RETRIES = 5

export class DriveUploadError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'DriveUploadError'; this.status = status }
}

/**
 * Returns `get(force?)`: the cached Drive access token, refetched from the server 60 s before it expires or when forced.
 * @param {{ driveToken: () => Promise<{ ok: boolean, status: number, body: any }> }} client
 * @param {{ now?: () => number }} [opts]
 */
export function cachedDriveToken(client, { now = () => Date.now() } = {}) {
  let cache = null
  return async function get(force = false) {
    if (!force && cache && cache.expiresAt - 60_000 > now()) return cache.token
    const res = await client.driveToken()
    const tok = res.body?.accessToken
    if (!res.ok || typeof tok !== 'string' || !tok) throw new DriveUploadError(`Server không cấp token Drive (HTTP ${res.status}${res.body?.code ? `, ${res.body.code}` : ''})`, res.status)
    const exp = Date.parse(res.body.expiresAt)
    cache = { token: tok, expiresAt: Number.isFinite(exp) ? exp : now() + 10 * 60_000 }
    return tok
  }
}

/**
 * @param {{ accessToken: (force?: boolean) => Promise<string>, fetchImpl?: typeof fetch }} opts
 */
export function createUploader({ accessToken, fetchImpl = fetch }) {
  async function startSession({ name, mimeType, size, parentId }) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken(attempt > 0)
      const res = await fetchImpl(UPLOAD_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': String(size),
        },
        body: JSON.stringify({ name, mimeType, parents: [parentId] }),
      })
      if (res.status === 401 && attempt === 0) { await res.body?.cancel?.().catch(() => {}); continue }
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new DriveUploadError(`Google Drive: ${data?.error?.message || res.statusText || 'lỗi'} (HTTP ${res.status})`, res.status)
      }
      const session = res.headers.get('location')
      if (!session) throw new DriveUploadError('Google Drive không trả về upload session.')
      const url = new URL(session)
      if (url.protocol !== 'https:' || url.hostname !== 'www.googleapis.com') throw new DriveUploadError(`Upload session phải ở www.googleapis.com, nhận ${url.hostname}`)
      return session
    }
    throw new DriveUploadError('Google Drive từ chối token (401).', 401)
  }

  /**
   * @param {{ path: string, name: string, mimeType: string, parentId: string }} file
   * @returns {Promise<{ id: string, size: number }>}
   */
  async function upload({ path: absPath, name, mimeType, parentId }) {
    const size = (await fs.promises.stat(absPath)).size
    const session = await startSession({ name, mimeType, size, parentId })
    const handle = await fs.promises.open(absPath, 'r')
    try {
      let offset = 0
      let failures = 0
      const rounds = Math.ceil(size / CHUNK_SIZE) * 3 + 8
      for (let round = 0; round < rounds; round++) {
        const length = Math.min(CHUNK_SIZE, size - offset)
        const chunk = Buffer.allocUnsafe(length)
        if (length > 0) {
          const { bytesRead } = await handle.read(chunk, 0, length, offset)
          if (bytesRead !== length) throw new DriveUploadError('File thay đổi trong lúc upload')
        }
        let res
        try {
          res = await fetchImpl(session, {
            method: 'PUT', redirect: 'manual',
            headers: { 'Content-Length': String(length), 'Content-Range': length > 0 ? `bytes ${offset}-${offset + length - 1}/${size}` : 'bytes */0' },
            body: length > 0 ? chunk : undefined,
          })
        } catch (e) {
          if (++failures > MAX_CHUNK_RETRIES) throw new DriveUploadError(`Mất kết nối khi upload: ${e instanceof Error ? e.message : e}`)
          offset = await resumeOffset(session, size)
          continue
        }
        if (res.status === 308) {
          await res.body?.cancel?.().catch(() => {})
          const m = /bytes=0-(\d+)/.exec(res.headers.get('range') ?? '')
          offset = m ? Number(m[1]) + 1 : 0
          continue
        }
        if (res.status === 200 || res.status === 201) {
          const file = await res.json()
          if (typeof file?.id !== 'string') throw new DriveUploadError('Google Drive không trả về id file.')
          return { id: file.id, size }
        }
        if (res.status >= 500 && ++failures <= MAX_CHUNK_RETRIES) {
          await res.body?.cancel?.().catch(() => {})
          offset = await resumeOffset(session, size)
          continue
        }
        const data = await res.json().catch(() => null)
        throw new DriveUploadError(`Google Drive: ${data?.error?.message || res.statusText || 'lỗi'} (HTTP ${res.status})`, res.status)
      }
      throw new DriveUploadError('Google Drive không nhận hết file sau nhiều lần gửi.')
    } finally {
      await handle.close()
    }
  }

  async function resumeOffset(session, size) {
    const res = await fetchImpl(session, { method: 'PUT', redirect: 'manual', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` } })
    await res.body?.cancel?.().catch(() => {})
    if (res.status !== 308) return 0
    const m = /bytes=0-(\d+)/.exec(res.headers.get('range') ?? '')
    return m ? Number(m[1]) + 1 : 0
  }

  return { upload }
}
