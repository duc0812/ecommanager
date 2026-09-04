import { prisma } from '@/lib/db'

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

// Read the active key: DB setting first, then PARCELPANEL_API_KEY env fallback.
export async function getParcelPanelApiKey(): Promise<string | null> {
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
