import { prisma } from '@/lib/db'
import { assertSafeExternalUrl } from '@/lib/safe-url'
import { maskApiKey } from '@/lib/tracking/parcelpanel-config'

export type StoreConnection = { storeId: string; shop: string; token: string }

export type ConnectedStore = {
  id: string
  shop: string
  orderPrefix: string | null
  ianaTimezone: string | null
  projectId: string | null
  projectName: string | null
  payoutStartDate: string | null
  trackingPageUrl: string | null
}

export type StoreConnectionErrorCode = 'NOT_CONNECTED' | 'DISABLED' | 'MINT_FAILED'

export class StoreConnectionError extends Error {
  storeId: string
  shop: string
  code: StoreConnectionErrorCode
  shopifyError?: string

  constructor(code: StoreConnectionErrorCode, storeId: string, shop: string, message: string) {
    super(message)
    this.name = 'StoreConnectionError'
    this.code = code
    this.storeId = storeId
    this.shop = shop
  }
}

// Whether getStoreConnection can work from this row without asking Shopify first: an access token, or a complete client-credentials pair to mint one with.
export function hasUsableCredential(credential: { authMode: string; clientId: string | null; clientSecret: string | null; accessToken: string | null } | null | undefined): boolean {
  if (!credential) return false
  return Boolean(credential.accessToken || (credential.authMode === 'CLIENT_CREDENTIALS' && credential.clientId && credential.clientSecret))
}

export type CredentialInput = {
  authMode: 'TOKEN' | 'OAUTH' | 'CLIENT_CREDENTIALS'
  clientId?: string | null
  clientSecret?: string | null
  accessToken?: string | null
  tokenExpiresAt?: Date | null
  connectedAt?: Date
}

const REFRESH_WINDOW_MS = 60 * 60 * 1000
const MINT_TIMEOUT_MS = 15_000

declare global {
  // eslint-disable-next-line no-var
  var __storeMintLocks: Map<string, Promise<string>> | undefined
}

// On globalThis so every bundle copy of this module shares one lock table, like job-lock.ts.
function mintLocks(): Map<string, Promise<string>> {
  if (!globalThis.__storeMintLocks) globalThis.__storeMintLocks = new Map()
  return globalThis.__storeMintLocks
}

type StoreWithCredential = NonNullable<Awaited<ReturnType<typeof loadStore>>>
type Credential = NonNullable<StoreWithCredential['credential']>

function loadStore(where: { id: string } | { shop: string }) {
  return prisma.shopifyStore.findUnique({ where, include: { credential: true } })
}

function needsMint(credential: Credential): boolean {
  if (credential.authMode !== 'CLIENT_CREDENTIALS') return false
  if (!credential.accessToken || !credential.tokenExpiresAt) return true
  return credential.tokenExpiresAt.getTime() - Date.now() < REFRESH_WINDOW_MS
}

// Messages of this class are fixed text and safe to show; any other error is reduced to a generic line
// so a library or database message that echoes a secret or token never reaches a caller.
// `shopifyError` is Shopify's own error code (letters and underscores only, e.g. shop_not_permitted), never its description.
export class MintError extends Error {
  status?: number
  shopifyError?: string

  constructor(message: string, detail: { status?: number; shopifyError?: string } = {}) {
    super(message)
    this.status = detail.status
    this.shopifyError = detail.shopifyError
  }
}

export function shopifyErrorCode(body: unknown): string | undefined {
  const code = (body as { error?: unknown } | null)?.error
  return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : undefined
}

export async function mintClientCredentialsToken(shop: string, clientId: string, clientSecret: string): Promise<{ token: string; expiresAt: Date }> {
  let url: URL
  try {
    url = assertSafeExternalUrl(`https://${shop}/admin/oauth/access_token`)
  } catch (e) {
    throw new MintError(e instanceof Error ? e.message : 'Địa chỉ shop không hợp lệ')
  }
  let res: Response
  try {
    res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    })
  } catch {
    throw new MintError('không kết nối được tới Shopify')
  }
  const json = await res.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown } | null
  if (!res.ok) throw new MintError(`Shopify từ chối cấp token (HTTP ${res.status})`, { status: res.status, shopifyError: shopifyErrorCode(json) })
  const token = typeof json?.access_token === 'string' ? json.access_token : ''
  const expiresIn = Number(json?.expires_in)
  if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new MintError('Shopify trả về token không hợp lệ')
  return { token, expiresAt: new Date(Date.now() + expiresIn * 1000) }
}

const MINT_ATTEMPTS = 3

async function mintAndSave(store: StoreWithCredential): Promise<string> {
  const fail = (reason: string, shopifyError?: string) => {
    const error = new StoreConnectionError('MINT_FAILED', store.id, store.shop, `Không lấy được token mới cho ${store.shop}: ${reason}`)
    error.shopifyError = shopifyError
    return error
  }
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
    const fresh = await prisma.shopifyStoreCredential.findUnique({ where: { storeId: store.id } })
    if (!fresh) throw new StoreConnectionError('NOT_CONNECTED', store.id, store.shop, `Store ${store.shop} chưa có thông tin kết nối`)
    if (fresh.authMode !== 'CLIENT_CREDENTIALS') {
      if (fresh.accessToken) return fresh.accessToken
      throw new StoreConnectionError('NOT_CONNECTED', store.id, store.shop, `Store ${store.shop} chưa có token`)
    }
    if (!needsMint(fresh) && fresh.accessToken) return fresh.accessToken
    if (!fresh.clientId || !fresh.clientSecret) {
      throw new StoreConnectionError('NOT_CONNECTED', store.id, store.shop, `Store ${store.shop} thiếu Client ID hoặc Client Secret`)
    }
    let minted: { token: string; expiresAt: Date }
    try {
      minted = await mintClientCredentialsToken(store.shop, fresh.clientId, fresh.clientSecret)
    } catch (e) {
      throw fail(e instanceof MintError ? e.message : 'lỗi không rõ', e instanceof MintError ? e.shopifyError : undefined)
    }
    let saved: { count: number }
    try {
      // Compare-and-set: the credential may have been replaced while the request was in flight.
      saved = await prisma.shopifyStoreCredential.updateMany({
        where: { storeId: store.id, authMode: 'CLIENT_CREDENTIALS', clientId: fresh.clientId, clientSecret: fresh.clientSecret, updatedAt: fresh.updatedAt },
        data: { accessToken: minted.token, tokenExpiresAt: minted.expiresAt },
      })
    } catch {
      throw fail('không lưu được token')
    }
    if (saved.count > 0) return minted.token
  }
  throw fail('thông tin kết nối liên tục bị thay đổi')
}

// Concurrent callers for one store share a single in-flight mint; the credential is re-read inside it
// so a caller that arrives just after a mint finished reuses that token instead of minting again.
function mintOnce(store: StoreWithCredential): Promise<string> {
  const locks = mintLocks()
  const running = locks.get(store.id)
  if (running) return running
  const promise = mintAndSave(store).finally(() => locks.delete(store.id))
  locks.set(store.id, promise)
  return promise
}

async function connectionFor(store: StoreWithCredential | null, fallbackId: string, fallbackShop: string, opts: ConnectionOptions = {}): Promise<StoreConnection> {
  if (!store) throw new StoreConnectionError('NOT_CONNECTED', fallbackId, fallbackShop, 'Store không tồn tại')
  if (!store.enabled && !opts.allowDisabled) throw new StoreConnectionError('DISABLED', store.id, store.shop, `Store ${store.shop} đang tắt`)
  const credential = store.credential
  if (!credential) throw new StoreConnectionError('NOT_CONNECTED', store.id, store.shop, `Store ${store.shop} chưa kết nối`)
  const token = needsMint(credential) ? await mintOnce(store) : credential.accessToken
  if (!token) throw new StoreConnectionError('NOT_CONNECTED', store.id, store.shop, `Store ${store.shop} chưa có token`)
  return { storeId: store.id, shop: store.shop, token }
}

// `allowDisabled` is for the Setup page, which re-checks a store that is switched off.
export type ConnectionOptions = { allowDisabled?: boolean }

export async function getStoreConnection(storeId: string, opts: ConnectionOptions = {}): Promise<StoreConnection> {
  return connectionFor(await loadStore({ id: storeId }), storeId, '', opts)
}

export async function getStoreConnectionByShop(shop: string): Promise<StoreConnection> {
  const store = await loadStore({ shop })
  return connectionFor(store, store?.id ?? '', shop)
}

export type StoreConnectionResult =
  | { conn: StoreConnection; error?: undefined }
  | { conn: null; error: StoreConnectionError }

// Turns a StoreConnectionError into a value so a caller can answer its own way; any other error still throws.
export async function tryStoreConnection(get: () => Promise<StoreConnection>): Promise<StoreConnectionResult> {
  try {
    return { conn: await get() }
  } catch (e) {
    if (e instanceof StoreConnectionError) return { conn: null, error: e }
    throw e
  }
}

export async function listConnectedStores(): Promise<ConnectedStore[]> {
  const stores = await prisma.shopifyStore.findMany({
    where: { enabled: true, credential: { isNot: null } },
    include: { project: { select: { name: true } } },
    orderBy: { connectedAt: 'asc' },
  })
  return stores.map(s => ({
    id: s.id,
    shop: s.shop,
    orderPrefix: s.orderPrefix,
    ianaTimezone: s.ianaTimezone,
    projectId: s.projectId,
    projectName: s.project?.name ?? null,
    payoutStartDate: s.payoutStartDate,
    trackingPageUrl: s.trackingPageUrl,
  }))
}

// The store a read shows when it was not told which one: the first connected store (the oldest connection).
export async function defaultConnectedStoreId(): Promise<string | null> {
  return (await listConnectedStores())[0]?.id ?? null
}

// A minted token that Shopify refused is forgotten, so the next getStoreConnection mints a new one. It only touches
// the credential while it still holds that token: a credential replaced meanwhile is left as it is.
export async function discardRejectedToken(storeId: string, token: string): Promise<void> {
  await prisma.shopifyStoreCredential.updateMany({
    where: { storeId, authMode: 'CLIENT_CREDENTIALS', accessToken: token },
    data: { accessToken: null, tokenExpiresAt: null },
  })
}

// `db` lets a caller write the credential inside its own transaction.
export async function saveStoreCredential(storeId: string, input: CredentialInput, db: Pick<typeof prisma, 'shopifyStoreCredential'> = prisma): Promise<void> {
  const data = {
    authMode: input.authMode,
    clientId: input.clientId ?? null,
    clientSecret: input.clientSecret ?? null,
    accessToken: input.accessToken ?? null,
    tokenExpiresAt: input.tokenExpiresAt ?? null,
    ...(input.connectedAt ? { connectedAt: input.connectedAt } : {}),
  }
  await db.shopifyStoreCredential.upsert({
    where: { storeId },
    create: { storeId, ...data },
    update: data,
  })
}

export const PUBLIC_STORE_SELECT = { id: true, shop: true, orderPrefix: true, enabled: true, project: { select: { name: true } } } as const

// The shape the store filter reads (GET /api/stores) and PATCH /api/stores/[id] answers; `enabled` only where the list names disabled stores too.
export function publicStoreView(s: { id: string; shop: string; orderPrefix: string | null; enabled: boolean; project: { name: string } | null }, withEnabled: boolean) {
  return { id: s.id, shop: s.shop, name: s.project?.name ?? s.shop, orderPrefix: s.orderPrefix, ...(withEnabled ? { enabled: s.enabled } : {}) }
}

export function maskCredential(value: string | null): string | null {
  return maskApiKey(value)
}
