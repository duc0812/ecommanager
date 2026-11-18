import { deleteSettings, getSettings, saveSetting } from '@/lib/token-store'
import { maskApiKey } from '@/lib/tracking/parcelpanel-config'
import { CatkissfishError, issueToken, type CatkissfishSession } from '@/lib/catkissfish'
import { CKF_DEFAULT_US_SHIPPING } from '@/lib/catkissfish-shipping'

export const CATKISSFISH_KEYS = {
  clientId: 'catkissfish.clientId',
  clientSecret: 'catkissfish.clientSecret',
  accessToken: 'catkissfish.accessToken',
  tokenExpiresAt: 'catkissfish.tokenExpiresAt',
  shippingId: 'catkissfish.shippingId',
  shippingIdIntl: 'catkissfish.shippingIdIntl',
} as const

// A token still has to work for the calls that follow it.
const TOKEN_MARGIN_MS = 10 * 60 * 1000

export type CatkissfishSettings = {
  clientId: string | null; clientSecret: string | null; accessToken: string | null; tokenExpiresAt: string | null
  /** Carrier of US orders. */
  shippingId: string
  /** Carrier of every other order; none until someone picks one. */
  shippingIdIntl: string | null
}

export type CatkissfishSettingsView = {
  hasClientId: boolean; clientIdMasked: string | null; hasClientSecret: boolean
  tokenExpiresAt: string | null; shippingId: string; shippingIdIntl: string | null
}

export type CatkissfishSettingsPatch = { clientId?: string | null; clientSecret?: string | null; shippingId?: string | null; shippingIdIntl?: string | null }

export async function getCatkissfishSettings(): Promise<CatkissfishSettings> {
  const raw = await getSettings(Object.values(CATKISSFISH_KEYS))
  const clean = (key: string) => raw[key]?.trim() || null
  return {
    clientId: clean(CATKISSFISH_KEYS.clientId), clientSecret: clean(CATKISSFISH_KEYS.clientSecret),
    accessToken: clean(CATKISSFISH_KEYS.accessToken), tokenExpiresAt: clean(CATKISSFISH_KEYS.tokenExpiresAt),
    shippingId: clean(CATKISSFISH_KEYS.shippingId) ?? CKF_DEFAULT_US_SHIPPING, shippingIdIntl: clean(CATKISSFISH_KEYS.shippingIdIntl),
  }
}

export function hasCatkissfishAccount(s: CatkissfishSettings): boolean {
  return !!s.clientId && !!s.clientSecret
}

/** The secret and the token never leave the server. */
export function toCatkissfishSettingsView(s: CatkissfishSettings): CatkissfishSettingsView {
  return {
    hasClientId: !!s.clientId, clientIdMasked: maskApiKey(s.clientId), hasClientSecret: !!s.clientSecret,
    tokenExpiresAt: s.tokenExpiresAt, shippingId: s.shippingId, shippingIdIntl: s.shippingIdIntl,
  }
}

async function setOrClear(key: string, value: string | null) {
  const v = value?.trim()
  if (v) await saveSetting(key, v)
  else await deleteSettings([key])
}

/** `undefined` leaves a field untouched. A changed key drops the token, which belongs to the old key. */
export async function saveCatkissfishSettings(patch: CatkissfishSettingsPatch): Promise<CatkissfishSettings> {
  if (patch.clientId !== undefined) await setOrClear(CATKISSFISH_KEYS.clientId, patch.clientId)
  if (patch.clientSecret !== undefined) await setOrClear(CATKISSFISH_KEYS.clientSecret, patch.clientSecret)
  if (patch.shippingId !== undefined) await setOrClear(CATKISSFISH_KEYS.shippingId, patch.shippingId)
  if (patch.shippingIdIntl !== undefined) await setOrClear(CATKISSFISH_KEYS.shippingIdIntl, patch.shippingIdIntl)
  if (patch.clientId !== undefined || patch.clientSecret !== undefined) await deleteSettings([CATKISSFISH_KEYS.accessToken, CATKISSFISH_KEYS.tokenExpiresAt])
  return getCatkissfishSettings()
}

function stillGood(expiresAt: string | null): boolean {
  const ms = expiresAt ? new Date(expiresAt).getTime() : NaN
  return !Number.isNaN(ms) && ms - Date.now() > TOKEN_MARGIN_MS
}

/** Asks for a token only when it has to: the last one is kept in the DB until it is about to expire or CatKissFish refuses it. */
export function catkissfishSession(s: CatkissfishSettings): CatkissfishSession {
  let current = s.accessToken && stillGood(s.tokenExpiresAt) ? s.accessToken : null
  const renew = async () => {
    if (!s.clientId || !s.clientSecret) throw new CatkissfishError('Chưa lưu client_id / client_secret CatKissFish', 0)
    const issued = await issueToken(s.clientId, s.clientSecret)
    await saveSetting(CATKISSFISH_KEYS.accessToken, issued.token)
    await saveSetting(CATKISSFISH_KEYS.tokenExpiresAt, issued.expiresAt)
    current = issued.token
    return issued.token
  }
  return { token: async () => current ?? renew(), renew }
}
