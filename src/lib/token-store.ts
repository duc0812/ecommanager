import { prisma } from '@/lib/db'

type OAuthState = { shop: string; createdAt: number }

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

declare global {
  // eslint-disable-next-line no-var
  var __oauthStates: Map<string, OAuthState>
}

if (!global.__oauthStates) global.__oauthStates = new Map()

export async function getSettings(keys: string[]): Promise<Record<string, string>> {
  const settings = await prisma.appSetting.findMany({ where: { key: { in: keys } } })
  return Object.fromEntries(settings.map(setting => [setting.key, setting.value]))
}

export async function saveSetting(key: string, value: string) {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  })
}

export async function deleteSettings(keys: string[]) {
  await prisma.appSetting.deleteMany({ where: { key: { in: keys } } })
}

function pruneOAuthStates(now: number) {
  global.__oauthStates.forEach((value, key) => {
    if (now - value.createdAt > OAUTH_STATE_TTL_MS) global.__oauthStates.delete(key)
  })
}

export function saveOAuthState(state: string, shop: string) {
  const now = Date.now()
  pruneOAuthStates(now)
  global.__oauthStates.set(state, { shop, createdAt: now })
}

export function consumeOAuthState(state: string): string | null {
  if (!state) return null
  const entry = global.__oauthStates.get(state) ?? null
  global.__oauthStates.delete(state)
  if (!entry || Date.now() - entry.createdAt > OAUTH_STATE_TTL_MS) return null
  return entry.shop
}
