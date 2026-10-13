import { prisma } from '@/lib/db'
import { deleteSettings, saveSetting } from '@/lib/token-store'
import { DRIVE_SCOPES, GOOGLE_KEYS, GOOGLE_TOKEN_URL, getGoogleConfig, type DriveQuota } from '@/lib/google-oauth'
import {
  DriveError, ROOT_FOLDER_NAME, driveFolderUrl, findOrCreateFolder, getDriveAbout, primeAccessToken, resetDriveCache,
} from '@/lib/google-drive'

export const MAX_CREDENTIAL_BYTES = 16 * 1024
const MAX_VALUE_LENGTH = 2048

export class CredentialError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
    this.name = 'CredentialError'
  }
}

export type DriveCredential = { clientId: string; clientSecret: string; refreshToken: string }

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * Accepts the Google "authorized user" file (client_id, client_secret, refresh_token), an OAuth client file
 * ({ installed | web: { client_id, client_secret } }) with the refresh token given separately, or the three values typed by hand.
 * `token_uri` in the file is ignored on purpose: the server only ever talks to Google's own token endpoint.
 */
export function parseDriveCredential(input: unknown): DriveCredential {
  const body = record(input)
  if (!body) throw new CredentialError('Nội dung gửi lên không hợp lệ.')

  let clientId = text(body.clientId)
  let clientSecret = text(body.clientSecret)
  let refreshToken = text(body.refreshToken)

  if (body.tokenJson !== undefined) {
    if (typeof body.tokenJson !== 'string') throw new CredentialError('tokenJson phải là nội dung file dạng chữ.')
    if (Buffer.byteLength(body.tokenJson, 'utf8') > MAX_CREDENTIAL_BYTES) {
      throw new CredentialError('File khoá lớn hơn 16 KB — đây không phải file google_drive_token.json.', 413)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body.tokenJson.replace(/^﻿/, ''))
    } catch {
      throw new CredentialError('File khoá không phải JSON hợp lệ. Hãy chọn đúng file google_drive_token.json.')
    }
    const file = record(parsed)
    if (!file) throw new CredentialError('File khoá không đúng định dạng (cần một object JSON).')
    if (file.type === 'service_account') {
      throw new CredentialError('Đây là khoá service account. Tool cần khoá OAuth của tài khoản Google (có refresh_token).')
    }
    const client = record(file.installed) ?? record(file.web) ?? {}
    clientId = text(file.client_id) || text(client.client_id) || clientId
    clientSecret = text(file.client_secret) || text(client.client_secret) || clientSecret
    refreshToken = text(file.refresh_token) || refreshToken
  }

  const missing = [
    !clientId && 'client_id',
    !clientSecret && 'client_secret',
    !refreshToken && 'refresh_token',
  ].filter(Boolean)
  if (missing.length > 0) throw new CredentialError(`Khoá thiếu: ${missing.join(', ')}.`)
  for (const value of [clientId, clientSecret, refreshToken]) {
    if (value.length > MAX_VALUE_LENGTH || /\s/.test(value)) throw new CredentialError('Giá trị trong khoá không hợp lệ (quá dài hoặc có khoảng trắng).')
  }
  return { clientId, clientSecret, refreshToken }
}

const TOKEN_ERRORS: Record<string, string> = {
  invalid_grant: 'Refresh token đã bị thu hồi hoặc hết hạn (invalid_grant). Hãy tạo lại file google_drive_token.json rồi thử lại.',
  invalid_client: 'Client ID hoặc Client Secret không đúng (invalid_client).',
  unauthorized_client: 'OAuth client này không được dùng refresh token này (unauthorized_client). Client ID và refresh token phải thuộc cùng một khoá.',
}

export type ValidatedConnection = {
  accessToken: string
  expiresIn: number
  email: string
  displayName: string
  quota: DriveQuota
  rootFolderId: string
  rootFolderCreated: boolean
}

function driveMessage(err: any): string {
  return err instanceof DriveError ? err.message : `Google Drive: ${err?.message ?? 'lỗi không rõ'}`
}

/** Proves the credential works end to end before anything is stored: token, Drive scope, account, root folder. */
export async function validateDriveCredential(cred: DriveCredential): Promise<ValidatedConnection> {
  let res: Response
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cred.clientId,
        client_secret: cred.clientSecret,
        refresh_token: cred.refreshToken,
        grant_type: 'refresh_token',
      }),
    })
  } catch {
    throw new CredentialError('Không gọi được Google để kiểm tra khoá (lỗi mạng). Thử lại sau.', 502)
  }
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok || typeof data.access_token !== 'string' || !data.access_token) {
    const code = typeof data.error === 'string' ? data.error : ''
    throw new CredentialError(TOKEN_ERRORS[code] ?? `Google từ chối khoá này${code ? ` (${code})` : ''} — HTTP ${res.status}.`, res.status >= 500 ? 502 : 400)
  }

  const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : []
  if (!scopes.some((s: string) => DRIVE_SCOPES.includes(s))) {
    throw new CredentialError(`Khoá này không có quyền Google Drive (cần drive.file hoặc drive${scopes.length ? `; khoá đang có: ${scopes.join(', ')}` : ''}).`)
  }

  const accessToken = data.access_token as string
  let about
  try {
    about = await getDriveAbout(accessToken)
  } catch (err) {
    throw new CredentialError(`Khoá hợp lệ nhưng Google Drive từ chối: ${driveMessage(err)}`, 502)
  }
  let root
  try {
    root = await findOrCreateFolder('root', ROOT_FOLDER_NAME, accessToken)
  } catch (err) {
    throw new CredentialError(`Khoá hợp lệ nhưng không tạo được thư mục "${ROOT_FOLDER_NAME}": ${driveMessage(err)}`, 502)
  }
  return {
    accessToken, expiresIn: Number(data.expires_in) || 3600,
    email: about.email, displayName: about.displayName, quota: about.quota,
    rootFolderId: root.id, rootFolderCreated: root.created,
  }
}

export type ConnectResult = {
  email: string
  displayName: string
  rootFolderId: string
  rootFolderUrl: string
  rootFolderCreated: boolean
  quota: DriveQuota
  warning: string | null
}

export async function connectDriveWithCredential(cred: DriveCredential): Promise<ConnectResult> {
  const before = await getGoogleConfig()
  const checked = await validateDriveCredential(cred)

  await saveSetting(GOOGLE_KEYS.clientId, cred.clientId)
  await saveSetting(GOOGLE_KEYS.clientSecret, cred.clientSecret)
  await saveSetting(GOOGLE_KEYS.refreshToken, cred.refreshToken)
  if (checked.email) await saveSetting(GOOGLE_KEYS.email, checked.email)
  else await deleteSettings([GOOGLE_KEYS.email])
  await saveSetting(GOOGLE_KEYS.rootFolderId, checked.rootFolderId)
  await saveSetting(GOOGLE_KEYS.quota, JSON.stringify(checked.quota))
  await deleteSettings([GOOGLE_KEYS.needsReconnect, GOOGLE_KEYS.testFileId])
  resetDriveCache()
  primeAccessToken(checked.accessToken, checked.expiresIn, cred.refreshToken)

  let warning: string | null = null
  const changed = !!before.refreshToken && (before.clientId !== cred.clientId || (!!before.email && !!checked.email && before.email !== checked.email))
  if (changed) {
    const onDrive = await prisma.designArtwork.count({ where: { storage: 'DRIVE', removedAt: null } })
    if (onDrive > 0) {
      warning = `Khoá mới khác kết nối cũ: ${onDrive} file đã đẩy lên Drive trước đây có thể không xem trước được trong tool (link Drive của chúng vẫn mở được).`
    }
  }
  return {
    email: checked.email, displayName: checked.displayName,
    rootFolderId: checked.rootFolderId, rootFolderUrl: driveFolderUrl(checked.rootFolderId), rootFolderCreated: checked.rootFolderCreated,
    quota: checked.quota, warning,
  }
}
