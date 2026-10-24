import { getSettings, saveSetting } from '@/lib/token-store'
import { getCsSecrets } from '@/lib/cs/settings'
import { maskApiKey } from '@/lib/tracking/parcelpanel-config'

export const REPLICATE_TOKEN_KEY = 'creative.replicateApiToken'

export type CreativeSecrets = { kieApiKey: string | null; replicateToken: string | null }

export async function getCreativeSecrets(): Promise<CreativeSecrets> {
  const [cs, raw] = await Promise.all([getCsSecrets(), getSettings([REPLICATE_TOKEN_KEY])])
  const replicate = raw[REPLICATE_TOKEN_KEY]?.trim() || process.env.REPLICATE_API_TOKEN?.trim() || null
  return { kieApiKey: cs.kieApiKey, replicateToken: replicate }
}

export async function saveReplicateToken(token: string) {
  const value = token.trim()
  if (!value) return
  await saveSetting(REPLICATE_TOKEN_KEY, value)
}

export async function creativeSettingsView() {
  const s = await getCreativeSecrets()
  return {
    hasKie: !!s.kieApiKey,
    kieMasked: maskApiKey(s.kieApiKey),
    hasReplicate: !!s.replicateToken,
    replicateMasked: maskApiKey(s.replicateToken),
  }
}
