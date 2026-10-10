import { deleteSettings, getSettings, saveSetting } from '@/lib/token-store'
import { maskApiKey } from '@/lib/tracking/parcelpanel-config'
import type { PgprintsCredentials } from '@/lib/pgprints'

export const PGPRINTS_KEYS = {
  storeId: 'pgprints.storeId',
  secretKey: 'pgprints.secretKey',
  defaultShipClass: 'pgprints.defaultShipClass',
  pushEnabled: 'pgprints.pushEnabled',
} as const

export type PgprintsSettings = {
  storeId: string | null
  secretKey: string | null
  defaultShipClass: string | null
  pushEnabled: boolean
}

export type PgprintsSettingsView = {
  hasStoreId: boolean
  storeIdMasked: string | null
  hasSecretKey: boolean
  secretKeyMasked: string | null
  defaultShipClass: string | null
  pushEnabled: boolean
}

export async function getPgprintsSettings(): Promise<PgprintsSettings> {
  const raw = await getSettings(Object.values(PGPRINTS_KEYS))
  const clean = (key: string) => raw[key]?.trim() || null
  return {
    storeId: clean(PGPRINTS_KEYS.storeId),
    secretKey: clean(PGPRINTS_KEYS.secretKey),
    defaultShipClass: clean(PGPRINTS_KEYS.defaultShipClass),
    pushEnabled: raw[PGPRINTS_KEYS.pushEnabled] === 'true',
  }
}

export function credentialsOf(s: PgprintsSettings): PgprintsCredentials | null {
  return s.storeId && s.secretKey ? { storeId: s.storeId, secretKey: s.secretKey } : null
}

export function toSettingsView(s: PgprintsSettings): PgprintsSettingsView {
  return {
    hasStoreId: !!s.storeId,
    storeIdMasked: maskApiKey(s.storeId),
    hasSecretKey: !!s.secretKey,
    secretKeyMasked: s.secretKey ? '••••••••••••' : null,
    defaultShipClass: s.defaultShipClass,
    pushEnabled: s.pushEnabled,
  }
}

export type PgprintsSettingsPatch = {
  storeId?: string | null
  secretKey?: string | null
  defaultShipClass?: string | null
  pushEnabled?: boolean
}

async function setOrClear(key: string, value: string | null) {
  const v = value?.trim()
  if (v) await saveSetting(key, v)
  else await deleteSettings([key])
}

/** `undefined` leaves a field untouched; `null` or an empty string clears it. An empty secretKey is treated as "unchanged" by the route. */
export async function savePgprintsSettings(patch: PgprintsSettingsPatch): Promise<PgprintsSettings> {
  if (patch.storeId !== undefined) await setOrClear(PGPRINTS_KEYS.storeId, patch.storeId)
  if (patch.secretKey !== undefined) await setOrClear(PGPRINTS_KEYS.secretKey, patch.secretKey)
  if (patch.defaultShipClass !== undefined) await setOrClear(PGPRINTS_KEYS.defaultShipClass, patch.defaultShipClass)
  if (patch.pushEnabled !== undefined) await saveSetting(PGPRINTS_KEYS.pushEnabled, patch.pushEnabled ? 'true' : 'false')
  return getPgprintsSettings()
}
