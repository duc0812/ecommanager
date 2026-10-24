import { kieClient } from '@/lib/creative/kie'
import { replicateClient } from '@/lib/creative/replicate'
import { getCreativeSecrets } from '@/lib/creative/settings'
import type { Providers } from '@/lib/creative/jobs'

export async function loadProviders(): Promise<Providers> {
  const s = await getCreativeSecrets()
  return {
    ...(s.kieApiKey ? { kie: kieClient(s.kieApiKey) } : {}),
    ...(s.replicateToken ? { replicate: replicateClient(s.replicateToken) } : {}),
  }
}
