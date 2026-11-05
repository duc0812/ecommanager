import { deleteSettings, getSettings, saveSetting } from '@/lib/token-store'

export const PRINTWAY_KEYS = { token: 'printway.token' } as const

export type PrintwaySettings = { token: string | null }
export type PrintwaySettingsView = { hasToken: boolean }

export async function getPrintwaySettings(): Promise<PrintwaySettings> {
  const raw = await getSettings(Object.values(PRINTWAY_KEYS))
  return { token: raw[PRINTWAY_KEYS.token]?.trim() || null }
}

/** The token never leaves the server. */
export function toPrintwaySettingsView(s: PrintwaySettings): PrintwaySettingsView {
  return { hasToken: !!s.token }
}

export async function savePrintwayToken(token: string | null): Promise<PrintwaySettings> {
  const v = token?.trim()
  if (v) await saveSetting(PRINTWAY_KEYS.token, v)
  else await deleteSettings([PRINTWAY_KEYS.token])
  return getPrintwaySettings()
}
