import { prisma } from '@/lib/db'

type ShopifyConnection = {
  shop: string
  token: string
  connectedAt: Date
}

type ShopifyAppCredentials = {
  apiKey: string
  apiSecret: string
  shop: string
}

declare global {
  // eslint-disable-next-line no-var
  var __shopifyConnection: ShopifyConnection | null
  // eslint-disable-next-line no-var
  var __shopifyAppCreds: ShopifyAppCredentials | null
  // eslint-disable-next-line no-var
  var __oauthStates: Map<string, string>
}

if (!global.__shopifyConnection) global.__shopifyConnection = null
if (!global.__shopifyAppCreds) global.__shopifyAppCreds = null
if (!global.__oauthStates) global.__oauthStates = new Map()

const CONNECTION_KEYS = [
  'shopify.connection.shop',
  'shopify.connection.token',
  'shopify.connection.connectedAt',
]

const APP_CRED_KEYS = [
  'shopify.app.apiKey',
  'shopify.app.apiSecret',
  'shopify.app.shop',
]

async function settingsFor(keys: string[]) {
  const settings = await prisma.appSetting.findMany({ where: { key: { in: keys } } })
  return Object.fromEntries(settings.map(setting => [setting.key, setting.value]))
}

async function saveSetting(key: string, value: string) {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  })
}

async function deleteSettings(keys: string[]) {
  await prisma.appSetting.deleteMany({ where: { key: { in: keys } } })
}

export async function getShopifyConnection(cookieHeader?: string): Promise<ShopifyConnection | null> {
  if (global.__shopifyConnection) return global.__shopifyConnection

  const fromDb = await settingsFor(CONNECTION_KEYS)
  const dbShop = fromDb['shopify.connection.shop']
  const dbToken = fromDb['shopify.connection.token']
  if (dbShop && dbToken) {
    global.__shopifyConnection = {
      shop: dbShop,
      token: dbToken,
      connectedAt: fromDb['shopify.connection.connectedAt']
        ? new Date(fromDb['shopify.connection.connectedAt'])
        : new Date(),
    }
    return global.__shopifyConnection
  }

  if (cookieHeader) {
    const shop = parseCookie(cookieHeader, 'shopify_shop')
    const token = parseCookie(cookieHeader, 'shopify_token')
    if (shop && token) {
      await setShopifyConnection(shop, token)
      return global.__shopifyConnection
    }
  }

  return null
}

function parseCookie(header: string, name: string): string | null {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return match ? decodeURIComponent(match[1]) : null
}

export async function setShopifyConnection(shop: string, token: string) {
  const connectedAt = new Date()
  global.__shopifyConnection = { shop, token, connectedAt }
  await Promise.all([
    saveSetting('shopify.connection.shop', shop),
    saveSetting('shopify.connection.token', token),
    saveSetting('shopify.connection.connectedAt', connectedAt.toISOString()),
  ])
}

export async function clearShopifyConnection() {
  global.__shopifyConnection = null
  await deleteSettings(CONNECTION_KEYS)
}

export async function setShopifyAppCredentials(apiKey: string, apiSecret: string, shop: string) {
  global.__shopifyAppCreds = { apiKey, apiSecret, shop }
  await Promise.all([
    saveSetting('shopify.app.apiKey', apiKey),
    saveSetting('shopify.app.apiSecret', apiSecret),
    saveSetting('shopify.app.shop', shop),
  ])
}

export async function getShopifyAppCredentials(): Promise<ShopifyAppCredentials | null> {
  if (global.__shopifyAppCreds) return global.__shopifyAppCreds

  const fromDb = await settingsFor(APP_CRED_KEYS)
  const apiKey = fromDb['shopify.app.apiKey']
  const apiSecret = fromDb['shopify.app.apiSecret']
  const shop = fromDb['shopify.app.shop']
  if (!apiKey || !apiSecret || !shop) return null

  global.__shopifyAppCreds = { apiKey, apiSecret, shop }
  return global.__shopifyAppCreds
}

export function saveOAuthState(state: string, shop: string) {
  global.__oauthStates.set(state, shop)
}

export function consumeOAuthState(state: string): string | null {
  const shop = global.__oauthStates.get(state) ?? null
  global.__oauthStates.delete(state)
  return shop
}
