import { prisma } from '@/lib/db'
import { deleteSettings, getSettings, saveSetting } from '@/lib/token-store'
import { maskApiKey } from '@/lib/tracking/parcelpanel-config'
import { LITZZY_SHOP } from '@/lib/shopify-shop'
import { isLitzzyStore, storeSettingRowKey } from '@/lib/store-settings'
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

type FieldKeys = Record<keyof PgprintsSettings, string>

function settingsOf(raw: Record<string, string | undefined>, keys: FieldKeys): PgprintsSettings {
  const clean = (key: string) => raw[key]?.trim() || null
  return {
    storeId: clean(keys.storeId),
    secretKey: clean(keys.secretKey),
    defaultShipClass: clean(keys.defaultShipClass),
    pushEnabled: raw[keys.pushEnabled] === 'true',
  }
}

// A store other than Litzzy keeps the same four settings under its own prefix.
function ownKeys(storeId: string): FieldKeys {
  return {
    storeId: storeSettingRowKey(storeId, PGPRINTS_KEYS.storeId),
    secretKey: storeSettingRowKey(storeId, PGPRINTS_KEYS.secretKey),
    defaultShipClass: storeSettingRowKey(storeId, PGPRINTS_KEYS.defaultShipClass),
    pushEnabled: storeSettingRowKey(storeId, PGPRINTS_KEYS.pushEnabled),
  }
}

/**
 * The PGprints account of one store. Litzzy uses the account saved before there were stores; any other store uses only
 * its own, and with none saved the result has no key, so nothing can be sent for it under another store's account.
 * Without a `storeId` this is that first account, for the settings screens that edit it; a caller that holds an order
 * must pass the order's store.
 */
export async function getPgprintsSettings(storeId?: string): Promise<PgprintsSettings> {
  if (storeId === undefined || await isLitzzyStore(storeId)) {
    return settingsOf(await getSettings(Object.values(PGPRINTS_KEYS)), PGPRINTS_KEYS)
  }
  const keys = ownKeys(storeId)
  return settingsOf(await getSettings(Object.values(keys)), keys)
}

export type PgprintsKeyHolder = { storeId: string; settings: PgprintsSettings }

/** Every store that has a PGprints secret key, read in one query: who may sign the tracking webhook. */
export async function pgprintsKeyHolders(): Promise<PgprintsKeyHolder[]> {
  const stores = await prisma.shopifyStore.findMany({ select: { id: true, shop: true } })
  const keysOf = (store: { id: string; shop: string }): FieldKeys => (store.shop === LITZZY_SHOP ? PGPRINTS_KEYS : ownKeys(store.id))
  const raw = await getSettings(stores.flatMap(store => Object.values(keysOf(store))))
  const holders: PgprintsKeyHolder[] = []
  for (const store of stores) {
    const settings = settingsOf(raw, keysOf(store))
    if (settings.secretKey) holders.push({ storeId: store.id, settings })
  }
  return holders
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
