import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSuperadmin } from '@/lib/api-auth'
import { normalizeShopDomain } from '@/lib/shopify-shop'
import { MintError, mintClientCredentialsToken, saveStoreCredential, type CredentialInput } from '@/lib/store-connections'
import {
  ShopSnapshotError, checkTrackingPageUrl, hasReadAllOrders, isIsoDate, isoDateToUtc, orderPrefixFromName, readShopSnapshot, saveGrantedScopes,
  type ShopSnapshot,
} from '@/lib/store-connect'
import { safeErrorText } from '@/lib/store-jobs'

export const dynamic = 'force-dynamic'

const TEXT_FIELDS = ['clientId', 'clientSecret', 'accessToken', 'projectId', 'projectName', 'startDate', 'payoutStartDate', 'trackingPageUrl'] as const
type Input = { shop: string } & Record<(typeof TEXT_FIELDS)[number], string>

type Existing = NonNullable<Awaited<ReturnType<typeof findStore>>>

// A pasted token, a client-credentials pair, or (for a store that is already saved) whatever it has stored.
type Attempt =
  | { kind: 'CLIENT_CREDENTIALS'; clientId: string; clientSecret: string; stored: boolean }
  | { kind: 'TOKEN'; accessToken: string }
  | { kind: 'STORED'; accessToken: string; canReauthorize: boolean }

const findStore = (shop: string) => prisma.shopifyStore.findUnique({ where: { shop }, include: { credential: true } })

function parseInput(body: unknown): { input: Input } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Body không hợp lệ' }
  const raw = body as Record<string, unknown>
  const shop = typeof raw.shop === 'string' ? normalizeShopDomain(raw.shop) : null
  if (!shop) return { error: 'Shop domain phải có dạng ten-shop.myshopify.com' }
  const input = { shop } as Input
  for (const key of TEXT_FIELDS) {
    const value = raw[key]
    if (value !== undefined && value !== null && typeof value !== 'string') return { error: `${key} phải là chuỗi` }
    input[key] = typeof value === 'string' ? value.trim() : ''
  }
  if (Boolean(input.clientId) !== Boolean(input.clientSecret)) return { error: 'Cần điền cả Client ID và Client Secret' }
  for (const key of ['startDate', 'payoutStartDate'] as const) {
    if (input[key] && !isIsoDate(input[key])) return { error: `${key} phải có dạng YYYY-MM-DD` }
  }
  if (input.trackingPageUrl) {
    const problem = checkTrackingPageUrl(input.trackingPageUrl)
    if (problem) return { error: `Link trang tracking: ${problem}` }
  }
  return { input }
}

function chooseAttempt(input: Input, existing: Existing | null): Attempt | null {
  if (input.accessToken) return { kind: 'TOKEN', accessToken: input.accessToken }
  if (input.clientId && input.clientSecret) return { kind: 'CLIENT_CREDENTIALS', clientId: input.clientId, clientSecret: input.clientSecret, stored: false }
  const stored = existing?.credential
  if (stored?.accessToken && stored.authMode !== 'CLIENT_CREDENTIALS') {
    return { kind: 'STORED', accessToken: stored.accessToken, canReauthorize: Boolean(stored.clientId && stored.clientSecret) }
  }
  if (stored?.clientId && stored.clientSecret) return { kind: 'CLIENT_CREDENTIALS', clientId: stored.clientId, clientSecret: stored.clientSecret, stored: true }
  return null
}

type Save = { existing: Existing | null; input: Input; snapshot: ShopSnapshot | null; orderPrefix: string | null; linkProjectId: string | null; credential: CredentialInput | null }

// A store that exists keeps its row: only what is empty is filled in (project, prefix, payout date, tracking page),
// everything it already has stays. The timezone is the shop's own, so it always follows Shopify.
function saveStore({ existing, input, snapshot, orderPrefix, linkProjectId, credential }: Save) {
  return prisma.$transaction(async tx => {
    let projectId = existing?.projectId ?? null
    if (!projectId) {
      if (linkProjectId) projectId = linkProjectId
      else if (input.projectName) {
        const startDate = input.startDate || input.payoutStartDate
        const project = await tx.project.create({ data: { name: input.projectName, startDate: startDate ? isoDateToUtc(startDate) : isoDateToUtc(new Date().toISOString().slice(0, 10)) } })
        projectId = project.id
      }
    }
    const fill = {
      ...(projectId && !existing?.projectId ? { projectId } : {}),
      ...(orderPrefix && !existing?.orderPrefix ? { orderPrefix } : {}),
      ...(input.payoutStartDate && !existing?.payoutStartDate ? { payoutStartDate: input.payoutStartDate } : {}),
      ...(input.trackingPageUrl && !existing?.trackingPageUrl ? { trackingPageUrl: input.trackingPageUrl } : {}),
      ...(snapshot?.timezone ? { ianaTimezone: snapshot.timezone } : {}),
    }
    const store = existing
      ? await tx.shopifyStore.update({ where: { id: existing.id }, data: { ...fill, ...(snapshot ? { lastError: null, lastErrorAt: null } : {}) } })
      : await tx.shopifyStore.create({ data: { shop: input.shop, ...fill } })
    if (credential) await saveStoreCredential(store.id, credential, tx)
    if (snapshot) await saveGrantedScopes(store.id, snapshot.scopes, tx)
    return store
  })
}

async function connectStore(body: unknown): Promise<NextResponse> {
  // Nothing Shopify says is relayed except its error code (letters and underscores): a body can echo what was sent.
  const fail = (status: number, message: string) => NextResponse.json({ error: message }, { status })
  const needsOauth = (storeId: string, shop: string) =>
    NextResponse.json({ status: 'NEEDS_OAUTH', storeId, oauthUrl: `/api/auth/shopify?shop=${encodeURIComponent(shop)}` })

  const parsed = parseInput(body)
  if ('error' in parsed) return fail(400, parsed.error)
  const { input } = parsed

  const existing = await findStore(input.shop)
  const attempt = chooseAttempt(input, existing)
  if (!attempt) return fail(400, 'Điền Client ID và Client Secret, hoặc dán access token.')

  // Only a store that has no project yet takes one; a free project is checked before Shopify is called.
  let linkProjectId: string | null = null
  if (!existing?.projectId && input.projectId) {
    const project = await prisma.project.findUnique({ where: { id: input.projectId }, include: { shopifyStore: { select: { id: true } } } })
    if (!project) return fail(400, 'Không tìm thấy project này')
    if (project.archivedAt) return fail(400, 'Project này đã được lưu trữ')
    if (project.shopifyStore) return fail(409, 'Project này đã gắn với một store khác')
    linkProjectId = project.id
  }

  let token: string
  let tokenExpiresAt: Date | null = null
  if (attempt.kind === 'CLIENT_CREDENTIALS') {
    try {
      const minted = await mintClientCredentialsToken(input.shop, attempt.clientId, attempt.clientSecret)
      token = minted.token
      tokenExpiresAt = minted.expiresAt
    } catch (e) {
      if (!(e instanceof MintError)) throw e
      if (e.shopifyError === 'shop_not_permitted') {
        if (attempt.stored) return needsOauth(existing!.id, input.shop)
        // The app cannot mint for this shop: keep the pair for the OAuth flow, and any token the store already works with.
        const keep = existing?.credential && existing.credential.authMode !== 'CLIENT_CREDENTIALS' ? existing.credential.accessToken : null
        const store = await saveStore({
          existing, input, snapshot: null, orderPrefix: null, linkProjectId,
          credential: { authMode: 'OAUTH', clientId: attempt.clientId, clientSecret: attempt.clientSecret, accessToken: keep },
        })
        return needsOauth(store.id, input.shop)
      }
      if (e.status && e.status < 500) return fail(400, `Shopify từ chối Client ID hoặc Client Secret (${e.shopifyError ?? `HTTP ${e.status}`}). Kiểm tra lại hai giá trị này.`)
      return fail(502, e.message)
    }
  } else {
    token = attempt.accessToken
  }

  let snapshot: ShopSnapshot
  try {
    snapshot = await readShopSnapshot(input.shop, token)
  } catch (e) {
    if (!(e instanceof ShopSnapshotError)) throw e
    if (e.kind === 'TOKEN_REJECTED' && attempt.kind === 'STORED' && attempt.canReauthorize) return needsOauth(existing!.id, input.shop)
    return fail(e.kind === 'UNREACHABLE' ? 502 : 400, e.message)
  }

  let orderPrefix = existing?.orderPrefix ?? null
  if (!orderPrefix && snapshot.latestOrderName) {
    const detected = orderPrefixFromName(snapshot.latestOrderName)
    if (!detected) {
      return fail(409, `Đơn mới nhất của store là ${snapshot.latestOrderName}, tên đơn chưa có tiền tố nên không phân biệt được với store khác. Vào Shopify Admin → Settings → General → Order ID, đặt prefix riêng cho store (ví dụ REMI), tạo một đơn mới rồi kết nối lại.`)
    }
    const used = await prisma.shopifyStore.findMany({
      where: { orderPrefix: { not: null }, ...(existing ? { id: { not: existing.id } } : {}) },
      select: { shop: true, orderPrefix: true },
    })
    const owner = used.find(s => s.orderPrefix!.toUpperCase() === detected)
    if (owner) {
      return fail(409, `Tiền tố đơn ${detected} đã được store ${owner.shop} dùng. Hai store không được dùng chung tiền tố: đổi prefix trong Shopify Admin → Settings → General → Order ID, tạo một đơn mới rồi kết nối lại.`)
    }
    orderPrefix = detected
  }

  const credential: CredentialInput | null =
    attempt.kind === 'CLIENT_CREDENTIALS'
      ? { authMode: 'CLIENT_CREDENTIALS', clientId: attempt.clientId, clientSecret: attempt.clientSecret, accessToken: token, tokenExpiresAt, ...(attempt.stored ? {} : { connectedAt: new Date() }) }
      : attempt.kind === 'TOKEN'
        ? { authMode: 'TOKEN', accessToken: token, connectedAt: new Date() }
        : null
  const store = await saveStore({ existing, input, snapshot, orderPrefix, linkProjectId, credential })
  return NextResponse.json({
    status: 'CONNECTED',
    storeId: store.id,
    shopName: snapshot.shopName,
    timezone: store.ianaTimezone,
    orderPrefix: store.orderPrefix,
    scopes: snapshot.scopes,
    readAllOrders: hasReadAllOrders(snapshot.scopes),
  })
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  const secrets = ['clientId', 'clientSecret', 'accessToken']
    .map(key => (body as Record<string, unknown> | null)?.[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim())
  try {
    return await connectStore(body)
  } catch (e) {
    console.error('[stores/connect]', safeErrorText(e, secrets))
    return NextResponse.json({ error: 'Không lưu được kết nối store. Thử lại, hoặc xem log máy chủ.' }, { status: 500 })
  }
}
