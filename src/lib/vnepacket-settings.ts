import { deleteSettings, getSettings, saveSetting } from '@/lib/token-store'
import { VnepacketError, login, type VnepacketSession } from '@/lib/vnepacket'

export const VNEPACKET_KEYS = {
  username: 'vnepacket.username',
  password: 'vnepacket.password',
  token: 'vnepacket.token',
  tokenExpiresAt: 'vnepacket.tokenExpiresAt',
} as const

const TOKEN_MARGIN_MS = 10 * 60 * 1000

export type VnepacketSettings = { username: string | null; password: string | null; token: string | null; tokenExpiresAt: string | null }
export type VnepacketSettingsView = { username: string | null; hasPassword: boolean; tokenExpiresAt: string | null }
export type VnepacketSettingsPatch = { username?: string | null; password?: string | null }

export async function getVnepacketSettings(): Promise<VnepacketSettings> {
  const raw = await getSettings(Object.values(VNEPACKET_KEYS))
  const clean = (key: string) => raw[key]?.trim() || null
  return {
    username: clean(VNEPACKET_KEYS.username), password: clean(VNEPACKET_KEYS.password),
    token: clean(VNEPACKET_KEYS.token), tokenExpiresAt: clean(VNEPACKET_KEYS.tokenExpiresAt),
  }
}

export function hasVnepacketAccount(s: VnepacketSettings): boolean {
  return !!s.username && !!s.password
}

/** The password and token never leave the server. */
export function toVnepacketSettingsView(s: VnepacketSettings): VnepacketSettingsView {
  return { username: s.username, hasPassword: !!s.password, tokenExpiresAt: s.tokenExpiresAt }
}

async function setOrClear(key: string, value: string | null) {
  const v = value?.trim()
  if (v) await saveSetting(key, v)
  else await deleteSettings([key])
}

/** `undefined` leaves a field untouched. Any change drops the token, which belongs to the old login. */
export async function saveVnepacketSettings(patch: VnepacketSettingsPatch): Promise<VnepacketSettings> {
  if (patch.username !== undefined) await setOrClear(VNEPACKET_KEYS.username, patch.username)
  if (patch.password !== undefined) await setOrClear(VNEPACKET_KEYS.password, patch.password)
  if (patch.username !== undefined || patch.password !== undefined) await deleteSettings([VNEPACKET_KEYS.token, VNEPACKET_KEYS.tokenExpiresAt])
  return getVnepacketSettings()
}

function stillGood(expiresAt: string | null): boolean {
  if (!expiresAt) return true
  const ms = new Date(expiresAt).getTime()
  return Number.isNaN(ms) || ms - Date.now() > TOKEN_MARGIN_MS
}

/** Logs in only when it has to: the token is kept in the DB and reused until it is about to expire or VNEpacket refuses it. */
export function vnepacketSession(s: VnepacketSettings): VnepacketSession & { fullName: () => string | null } {
  let current = s.token && stillGood(s.tokenExpiresAt) ? s.token : null
  let name: string | null = null
  const renew = async () => {
    if (!s.username || !s.password) throw new VnepacketError('Chưa lưu tài khoản VNEpacket', 0)
    const issued = await login(s.username, s.password)
    await saveSetting(VNEPACKET_KEYS.token, issued.token)
    await setOrClear(VNEPACKET_KEYS.tokenExpiresAt, issued.expiresAt)
    current = issued.token
    name = issued.fullName
    return issued.token
  }
  return { token: async () => current ?? renew(), renew, fullName: () => name }
}
