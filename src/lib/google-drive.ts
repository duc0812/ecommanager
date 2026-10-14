import { saveSetting } from '@/lib/token-store'
import { GOOGLE_KEYS, GOOGLE_TOKEN_URL, getGoogleConfig, type DriveQuota } from '@/lib/google-oauth'

const FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const ABOUT_URL = 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName),storageQuota(limit,usage)'
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable'
const SESSION_HOST = 'www.googleapis.com'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const REFRESH_MARGIN_MS = 60_000
export const ROOT_FOLDER_NAME = 'Design Studio'
export const DRIVE_FILE_FIELDS = 'id,name,mimeType,size,webViewLink'

export class DriveError extends Error {
  constructor(message: string, public status = 0) {
    super(message)
    this.name = 'DriveError'
  }
}

export class DriveAuthError extends DriveError {
  constructor(message: string) {
    super(message, 401)
    this.name = 'DriveAuthError'
  }
}

type TokenCache = { token: string; expiresAt: number; refreshToken: string }

declare global {
  // eslint-disable-next-line no-var
  var __driveTokenCache: TokenCache | null | undefined
  // eslint-disable-next-line no-var
  var __driveFolderCache: Map<string, string> | undefined
  // eslint-disable-next-line no-var
  var __driveFolderInflight: Map<string, Promise<string>> | undefined
}

function folderCache() {
  if (!global.__driveFolderCache) global.__driveFolderCache = new Map()
  return global.__driveFolderCache
}

function folderInflight() {
  if (!global.__driveFolderInflight) global.__driveFolderInflight = new Map()
  return global.__driveFolderInflight
}

export function resetDriveCache() {
  global.__driveTokenCache = null
  folderCache().clear()
  folderInflight().clear()
}

function cachedFolder(pathKey: string, create: () => Promise<string>): Promise<string> {
  const cached = folderCache().get(pathKey)
  if (cached) return Promise.resolve(cached)
  const inflight = folderInflight()
  const pending = inflight.get(pathKey)
  if (pending) return pending
  const promise: Promise<string> = create()
    .then(id => { folderCache().set(pathKey, id); return id })
    .finally(() => { if (inflight.get(pathKey) === promise) inflight.delete(pathKey) })
  inflight.set(pathKey, promise)
  return promise
}

export function primeAccessToken(token: string, expiresInSec: number, refreshToken: string) {
  global.__driveTokenCache = { token, expiresAt: Date.now() + expiresInSec * 1000, refreshToken }
}

export async function isDriveConnected(): Promise<boolean> {
  const cfg = await getGoogleConfig()
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.refreshToken)
}

export async function getAccessToken(): Promise<string> {
  const cfg = await getGoogleConfig()
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    throw new DriveAuthError('Google Drive chưa được kết nối.')
  }
  const cached = global.__driveTokenCache
  if (cached && cached.refreshToken === cfg.refreshToken && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return cached.token
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok || typeof data.access_token !== 'string') {
    global.__driveTokenCache = null
    if (data.error === 'invalid_grant') {
      await saveSetting(GOOGLE_KEYS.needsReconnect, '1')
      throw new DriveAuthError('Google Drive cần kết nối lại (refresh token bị thu hồi hoặc hết hạn).')
    }
    throw new DriveError(`Không làm mới được token Google (HTTP ${res.status}${data.error ? `: ${data.error}` : ''}).`, res.status)
  }
  primeAccessToken(data.access_token, Number(data.expires_in) || 3600, cfg.refreshToken)
  return data.access_token
}

async function driveError(res: Response): Promise<DriveError> {
  const data: any = await res.json().catch(() => null)
  const message = data?.error?.message || data?.error_description || res.statusText || 'unknown error'
  return new DriveError(`Google Drive: ${message} (HTTP ${res.status})`, res.status)
}

async function driveFetch(url: string, init: RequestInit = {}, accessToken?: string): Promise<Response> {
  const send = async () => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${accessToken ?? await getAccessToken()}`)
    return fetch(url, { ...init, headers })
  }
  let res = await send()
  if (res.status === 401 && !accessToken) {
    global.__driveTokenCache = null
    res = await send()
  }
  if (!res.ok) throw await driveError(res)
  return res
}

export function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export async function findOrCreateFolder(parentId: string, name: string, accessToken?: string): Promise<{ id: string; created: boolean }> {
  const q = `mimeType='${FOLDER_MIME}' and name='${escapeDriveQuery(name)}' and '${escapeDriveQuery(parentId)}' in parents and trashed=false`
  const search = new URLSearchParams({ q, fields: 'files(id,name)', pageSize: '1', spaces: 'drive' })
  const found: any = await (await driveFetch(`${FILES_URL}?${search}`, {}, accessToken)).json()
  const existing = found?.files?.[0]?.id
  if (typeof existing === 'string' && existing) return { id: existing, created: false }

  const created: any = await (await driveFetch(`${FILES_URL}?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  }, accessToken)).json()
  if (typeof created?.id !== 'string') throw new DriveError('Google Drive không trả về id thư mục.')
  return { id: created.id, created: true }
}

export async function ensureFolder(parentId: string, name: string): Promise<string> {
  return (await findOrCreateFolder(parentId, name)).id
}

export type DriveAbout = { email: string; displayName: string; quota: DriveQuota }

/** `limit` is absent on accounts with unlimited storage. */
export async function getDriveAbout(accessToken?: string): Promise<DriveAbout> {
  const data: any = await (await driveFetch(ABOUT_URL, {}, accessToken)).json()
  const limit = Number(data?.storageQuota?.limit)
  const usage = Number(data?.storageQuota?.usage)
  return {
    email: typeof data?.user?.emailAddress === 'string' ? data.user.emailAddress : '',
    displayName: typeof data?.user?.displayName === 'string' ? data.user.displayName : '',
    quota: {
      limit: Number.isFinite(limit) && limit > 0 ? limit : null,
      usage: Number.isFinite(usage) && usage > 0 ? usage : 0,
      checkedAt: new Date().toISOString(),
    },
  }
}

export async function refreshDriveQuota(): Promise<DriveQuota> {
  const { quota } = await getDriveAbout()
  await saveSetting(GOOGLE_KEYS.quota, JSON.stringify(quota))
  return quota
}

export async function ensureRootFolder(): Promise<string> {
  const cfg = await getGoogleConfig()
  if (cfg.rootFolderId) return cfg.rootFolderId
  return cachedFolder(`root:${cfg.refreshToken}`, async () => {
    const id = await ensureFolder('root', ROOT_FOLDER_NAME)
    await saveSetting(GOOGLE_KEYS.rootFolderId, id)
    return id
  })
}

function segment(value: string) {
  const v = value.trim()
  return v || '_'
}

export async function folderForPath(names: string[]): Promise<string> {
  const root = await ensureRootFolder()
  let parent = root
  let pathKey = root
  for (const raw of names) {
    const name = segment(raw)
    pathKey = `${pathKey}/${name}`
    const parentId = parent
    parent = await cachedFolder(pathKey, () => ensureFolder(parentId, name))
  }
  return parent
}

/** A named folder directly under a folder the app already knows, found or created once per process. */
export function childFolder(parentId: string, name: string): Promise<string> {
  return cachedFolder(`${parentId}/${segment(name)}`, () => ensureFolder(parentId, segment(name)))
}

export async function folderForTask(input: { storeName: string; placedAt: Date; orderNumber: string; taskKey: string }): Promise<string> {
  return folderForPath([input.storeName, input.placedAt.toISOString().slice(0, 7), input.orderNumber, input.taskKey])
}

export async function startResumableUpload(input: { name: string; mimeType: string; size: number; parentId: string }): Promise<string> {
  const res = await driveFetch(`${UPLOAD_URL}&fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': input.mimeType,
      'X-Upload-Content-Length': String(input.size),
    },
    body: JSON.stringify({ name: input.name, mimeType: input.mimeType, parents: [input.parentId] }),
  })
  const location = res.headers.get('location')
  if (!location) throw new DriveError('Google Drive không trả về upload session.')
  return location
}

export type UploadChunkResult = { done: true; file: any } | { done: false; nextStart: number }

function assertSessionUrl(sessionUrl: string) {
  let url: URL
  try { url = new URL(sessionUrl) } catch { throw new DriveError('Upload session URL không hợp lệ.') }
  if (url.protocol !== 'https:' || url.hostname !== SESSION_HOST) {
    throw new DriveError(`Upload session phải ở ${SESSION_HOST}.`)
  }
}

export async function uploadChunk(sessionUrl: string, chunk: Buffer, start: number, total: number): Promise<UploadChunkResult> {
  assertSessionUrl(sessionUrl)
  const end = start + chunk.length - 1
  const res = await fetch(sessionUrl, {
    method: 'PUT',
    redirect: 'manual',
    headers: {
      'Content-Length': String(chunk.length),
      'Content-Range': `bytes ${start}-${end}/${total}`,
    },
    body: chunk as unknown as BodyInit,
  })
  if (res.status === 308) {
    await res.body?.cancel()
    const match = /bytes=0-(\d+)/.exec(res.headers.get('range') ?? '')
    return { done: false, nextStart: match ? Number(match[1]) + 1 : 0 }
  }
  if (res.status === 200 || res.status === 201) return { done: true, file: await res.json() }
  throw await driveError(res)
}

export async function getFile(id: string, fields = DRIVE_FILE_FIELDS): Promise<any> {
  const res = await driveFetch(`${FILES_URL}/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`)
  return res.json()
}

export type FilePlacement = { parents: string[]; name: string }

export async function getFilePlacement(id: string): Promise<FilePlacement> {
  const data: any = await getFile(id, 'id,name,parents')
  return {
    parents: Array.isArray(data?.parents) ? data.parents.filter((p: unknown): p is string => typeof p === 'string') : [],
    name: typeof data?.name === 'string' ? data.name : '',
  }
}

/** Moves and/or renames a file. Under the `drive.file` scope this only works on files this app created: anything else answers 404 or 403. */
export async function updateFilePlacement(id: string, change: { addParents?: string[]; removeParents?: string[]; name?: string }): Promise<void> {
  const query = new URLSearchParams({ fields: 'id' })
  if (change.addParents?.length) query.set('addParents', change.addParents.join(','))
  if (change.removeParents?.length) query.set('removeParents', change.removeParents.join(','))
  await driveFetch(`${FILES_URL}/${encodeURIComponent(id)}?${query}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(change.name ? { name: change.name } : {}),
  })
}

/** Puts a file into one folder under one name. Returns false when it already was there. */
export async function placeFile(id: string, folderId: string, name: string): Promise<boolean> {
  const now = await getFilePlacement(id)
  const inFolder = now.parents.includes(folderId)
  const others = now.parents.filter(p => p !== folderId)
  if (inFolder && others.length === 0 && now.name === name) return false
  await updateFilePlacement(id, {
    addParents: inFolder ? [] : [folderId], removeParents: others, name: now.name === name ? undefined : name,
  })
  return true
}

export async function streamFile(id: string): Promise<Response> {
  return driveFetch(`${FILES_URL}/${encodeURIComponent(id)}?alt=media`)
}

/** Google's own small rendering of an image file (a few dozen KB), or null when Drive has not made one yet. */
export async function streamThumbnail(id: string, sizePx = 480): Promise<Response | null> {
  const meta = await getFile(id, 'thumbnailLink')
  const link = typeof meta?.thumbnailLink === 'string' ? meta.thumbnailLink : null
  if (!link || !/^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(link)) return null
  const sized = /=s\d+$/.test(link) ? link.replace(/=s\d+$/, `=s${sizePx}`) : link
  const res = await fetch(sized, { headers: { Authorization: `Bearer ${await getAccessToken()}` } })
  if (!res.ok || !res.body) { await res.body?.cancel(); return null }
  return res
}

export async function shareAnyoneReader(id: string): Promise<any> {
  const res = await driveFetch(`${FILES_URL}/${encodeURIComponent(id)}/permissions?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  })
  return res.json()
}

export async function deleteFile(id: string): Promise<void> {
  try {
    await driveFetch(`${FILES_URL}/${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch (err) {
    if (err instanceof DriveError && err.status === 404) return
    throw err
  }
}

export function driveFileViewUrl(id: string) {
  return `https://drive.google.com/file/d/${encodeURIComponent(id)}/view?usp=drivesdk`
}

export function driveFolderUrl(id: string) {
  return `https://drive.google.com/drive/folders/${id}`
}
