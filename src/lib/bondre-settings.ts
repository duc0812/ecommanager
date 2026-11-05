import { deleteSettings, getSettings, saveSetting } from '@/lib/token-store'
import { BondreError, issueToken, type BondreSession } from '@/lib/bondre'

export const BONDRE_KEYS = {
  email: 'bondre.email',
  password: 'bondre.password',
  token: 'bondre.token',
  tokenExpiresAt: 'bondre.tokenExpiresAt',
} as const

// A token still has to work for the calls that follow it.
const TOKEN_MARGIN_MS = 60 * 60 * 1000

export type BondreSettings = { email: string | null; password: string | null; token: string | null; tokenExpiresAt: string | null }
export type BondreSettingsView = { email: string | null; hasPassword: boolean; tokenExpiresAt: string | null }
export type BondreSettingsPatch = { email?: string | null; password?: string | null }

export async function getBondreSettings(): Promise<BondreSettings> {
  const raw = await getSettings(Object.values(BONDRE_KEYS))
  const clean = (key: string) => raw[key]?.trim() || null
  return {
    email: clean(BONDRE_KEYS.email), password: clean(BONDRE_KEYS.password),
    token: clean(BONDRE_KEYS.token), tokenExpiresAt: clean(BONDRE_KEYS.tokenExpiresAt),
  }
}

export function hasBondreAccount(s: BondreSettings): boolean {
  return !!s.email && !!s.password
}

/** The password and token never leave the server. */
export function toBondreSettingsView(s: BondreSettings): BondreSettingsView {
  return { email: s.email, hasPassword: !!s.password, tokenExpiresAt: s.tokenExpiresAt }
}

async function setOrClear(key: string, value: string | null) {
  const v = value?.trim()
  if (v) await saveSetting(key, v)
  else await deleteSettings([key])
}

/** `undefined` leaves a field untouched. Any change drops the token, which belongs to the old login. */
export async function saveBondreSettings(patch: BondreSettingsPatch): Promise<BondreSettings> {
  if (patch.email !== undefined) await setOrClear(BONDRE_KEYS.email, patch.email)
  if (patch.password !== undefined) await setOrClear(BONDRE_KEYS.password, patch.password)
  if (patch.email !== undefined || patch.password !== undefined) await deleteSettings([BONDRE_KEYS.token, BONDRE_KEYS.tokenExpiresAt])
  return getBondreSettings()
}

function stillGood(expiresAt: string | null): boolean {
  if (!expiresAt) return true
  const ms = new Date(expiresAt).getTime()
  return Number.isNaN(ms) || ms - Date.now() > TOKEN_MARGIN_MS
}

/** Logs in only when it has to: the token is kept in the DB and reused until it is about to expire or Bondre refuses it. */
export function bondreSession(s: BondreSettings): BondreSession {
  let current = s.token && stillGood(s.tokenExpiresAt) ? s.token : null
  const renew = async () => {
    if (!s.email || !s.password) throw new BondreError('Chưa lưu tài khoản Bondre', 0)
    const issued = await issueToken(s.email, s.password)
    await saveSetting(BONDRE_KEYS.token, issued.token)
    await setOrClear(BONDRE_KEYS.tokenExpiresAt, issued.expireTime)
    current = issued.token
    return issued.token
  }
  return { token: async () => current ?? renew(), renew }
}
