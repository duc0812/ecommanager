import { deleteSettings, getSettings, saveSetting } from '@/lib/token-store'
import { getCsSecrets } from '@/lib/cs/settings'
import { maskApiKey } from '@/lib/tracking/parcelpanel-config'

export const KIE_KEY_SETTING = 'creative.kieApiKey'
export const REPLICATE_TOKEN_KEY = 'creative.replicateApiToken'

export type KieSource = 'creative' | 'cs' | 'env'
export type CreativeSecrets = { kieApiKey: string | null; replicateToken: string | null; kieSource: KieSource | null }

export async function getCreativeSecrets(): Promise<CreativeSecrets> {
  const [cs, raw] = await Promise.all([getCsSecrets(), getSettings([KIE_KEY_SETTING, REPLICATE_TOKEN_KEY])])
  const own = raw[KIE_KEY_SETTING]?.trim() || null
  const env = process.env.KIE_API_KEY?.trim() || null
  let kieApiKey: string | null = null
  let kieSource: KieSource | null = null
  if (own) { kieApiKey = own; kieSource = 'creative' }
  else if (cs.kieApiKey) { kieApiKey = cs.kieApiKey; kieSource = cs.kieApiKey === env ? 'env' : 'cs' }
  const replicateToken = raw[REPLICATE_TOKEN_KEY]?.trim() || process.env.REPLICATE_API_TOKEN?.trim() || null
  return { kieApiKey, replicateToken, kieSource }
}

export async function saveCreativeSecrets(p: { kieApiKey?: string; replicateToken?: string; clearKieApiKey?: boolean }) {
  if (p.clearKieApiKey) await deleteSettings([KIE_KEY_SETTING])
  else if (p.kieApiKey?.trim()) await saveSetting(KIE_KEY_SETTING, p.kieApiKey.trim())
  if (p.replicateToken?.trim()) await saveSetting(REPLICATE_TOKEN_KEY, p.replicateToken.trim())
}

export async function saveReplicateToken(token: string) {
  await saveCreativeSecrets({ replicateToken: token })
}

export async function creativeSettingsView() {
  const s = await getCreativeSecrets()
  return {
    hasKie: !!s.kieApiKey,
    kieMasked: maskApiKey(s.kieApiKey),
    kieSource: s.kieSource,
    hasReplicate: !!s.replicateToken,
    replicateMasked: maskApiKey(s.replicateToken),
  }
}
