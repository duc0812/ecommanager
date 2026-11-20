import { deleteSettings, getSettings, saveSetting } from '@/lib/token-store'
import { maskApiKey } from '@/lib/tracking/parcelpanel-config'

export const LENFUL_KEYS = {
  apiKey: 'lenful.apiKey',
  storeId: 'lenful.storeId',
  shippingMethodCode: 'lenful.shippingMethodCode',
} as const

export type LenfulSettings = {
  apiKey: string | null
  /** The Lenful store orders go to; none = the account's default store. */
  storeId: string | null
  /** Shipping method code from Lenful's Orders › Import list; none = Lenful's default method. */
  shippingMethodCode: string | null
}

export type LenfulSettingsView = { hasApiKey: boolean; apiKeyMasked: string | null; storeId: string | null; shippingMethodCode: string | null }

export type LenfulSettingsPatch = { apiKey?: string | null; storeId?: string | null; shippingMethodCode?: string | null }

export async function getLenfulSettings(): Promise<LenfulSettings> {
  const raw = await getSettings(Object.values(LENFUL_KEYS))
  const clean = (key: string) => raw[key]?.trim() || null
  return { apiKey: clean(LENFUL_KEYS.apiKey), storeId: clean(LENFUL_KEYS.storeId), shippingMethodCode: clean(LENFUL_KEYS.shippingMethodCode) }
}

export const hasLenfulKey = (s: LenfulSettings) => !!s.apiKey

/** The key never leaves the server. */
export function toLenfulSettingsView(s: LenfulSettings): LenfulSettingsView {
  return { hasApiKey: !!s.apiKey, apiKeyMasked: maskApiKey(s.apiKey), storeId: s.storeId, shippingMethodCode: s.shippingMethodCode }
}

async function setOrClear(key: string, value: string | null) {
  const v = value?.trim()
  if (v) await saveSetting(key, v)
  else await deleteSettings([key])
}

/** `undefined` leaves a field untouched. */
export async function saveLenfulSettings(patch: LenfulSettingsPatch): Promise<LenfulSettings> {
  if (patch.apiKey !== undefined) await setOrClear(LENFUL_KEYS.apiKey, patch.apiKey)
  if (patch.storeId !== undefined) await setOrClear(LENFUL_KEYS.storeId, patch.storeId)
  if (patch.shippingMethodCode !== undefined) await setOrClear(LENFUL_KEYS.shippingMethodCode, patch.shippingMethodCode)
  return getLenfulSettings()
}
