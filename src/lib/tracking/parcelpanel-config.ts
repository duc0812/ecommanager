import { prisma } from '@/lib/db'
import { getStoreSetting, isLitzzyStoreId } from '@/lib/store-settings'

// ParcelPanel API key is stored in the DB (AppSetting) so it can be entered from
// the tool UI — the .env var is unreliable and easy to mis-edit. DB wins, env is fallback.
export const PARCELPANEL_KEY_SETTING = 'parcelpanel_api_key'

// Mask a key for display: keep first 4 + last 4, hide the middle. Never send the
// full key back to the browser. Short keys (<= 8) are fully bulleted.
export function maskApiKey(key: string | null | undefined): string | null {
  if (!key) return null
  if (key.length <= 8) return '•'.repeat(key.length)
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

// Read the active key: DB setting first, then PARCELPANEL_API_KEY env fallback. That is Litzzy's key, and what the
// settings screen edits. Another store has only a key of its own: with none it gets null, never Litzzy's key
// (ParcelPanel looks an order up by number inside one account, so the wrong account finds nothing or a wrong order).
export async function getParcelPanelApiKey(storeId?: string): Promise<string | null> {
  if (storeId !== undefined && !(await isLitzzyStoreId(storeId))) return getStoreSetting(storeId, 'parcelpanel.apiKey')
  const row = await prisma.appSetting.findUnique({ where: { key: PARCELPANEL_KEY_SETTING } })
  const fromDb = row?.value?.trim()
  if (fromDb) return fromDb
  const fromEnv = process.env.PARCELPANEL_API_KEY?.trim()
  return fromEnv || null
}

// Save (or clear, when passed an empty string) the key in the DB.
export async function setParcelPanelApiKey(key: string): Promise<void> {
  const value = key.trim()
  await prisma.appSetting.upsert({
    where: { key: PARCELPANEL_KEY_SETTING },
    create: { key: PARCELPANEL_KEY_SETTING, value },
    update: { value },
  })
}
