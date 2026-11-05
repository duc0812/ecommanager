import { prisma } from '@/lib/db'
import { LITZZY_SHOP } from '@/lib/shopify-shop'

// Credentials and switches that belong to one store, kept in AppSetting as `store.<storeId>.<key>`.
export const STORE_SETTING_KEYS = [
  'pgprints.storeId', 'pgprints.secretKey', 'pgprints.defaultShipClass', 'pgprints.pushEnabled',
  'merchize.apiUrl', 'merchize.token',
  'parcelpanel.apiKey',
] as const

export type StoreSettingKey = (typeof STORE_SETTING_KEYS)[number]

export function storeSettingRowKey(storeId: string, key: StoreSettingKey): string {
  return `store.${storeId}.${key}`
}

export async function getStoreSetting(storeId: string, key: StoreSettingKey): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: storeSettingRowKey(storeId, key) } })
  return row?.value?.trim() || null
}

export async function getStoreSettings(storeId: string, keys: readonly StoreSettingKey[]): Promise<Partial<Record<StoreSettingKey, string>>> {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: keys.map(key => storeSettingRowKey(storeId, key)) } } })
  const byRow = new Map(rows.map(row => [row.key, row.value.trim()]))
  const out: Partial<Record<StoreSettingKey, string>> = {}
  for (const key of keys) {
    const value = byRow.get(storeSettingRowKey(storeId, key))
    if (value) out[key] = value
  }
  return out
}

/** A blank value or null removes the row. */
export async function setStoreSetting(storeId: string, key: StoreSettingKey, value: string | null): Promise<void> {
  const rowKey = storeSettingRowKey(storeId, key)
  const text = value?.trim()
  if (text) await prisma.appSetting.upsert({ where: { key: rowKey }, create: { key: rowKey, value: text }, update: { value: text } })
  else await prisma.appSetting.deleteMany({ where: { key: rowKey } })
}

/**
 * Litzzy is the first store and keeps using the keys that existed before there were stores (the `pgprints.*` and
 * `parcelpanel_api_key` rows). Every other store has only its own. Decided by the shop, never by a missing store id.
 */
export async function isLitzzyStore(storeId: string): Promise<boolean> {
  const store = await prisma.shopifyStore.findUnique({ where: { id: storeId }, select: { shop: true } })
  return store?.shop === LITZZY_SHOP
}
