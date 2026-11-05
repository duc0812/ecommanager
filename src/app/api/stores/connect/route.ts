import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSuperadmin } from '@/lib/api-auth'
import { normalizeShopDomain } from '@/lib/shopify-shop'
import { orderPrefixOf } from '@/lib/order-prefix'
import {
  MintError, StoreConnectionError, discardRejectedToken, getStoreConnection, hasUsableCredential, mintClientCredentialsToken, saveStoreCredential,
  type CredentialInput,
} from '@/lib/store-connections'
import {
  ShopSnapshotError, checkTrackingPageUrl, hasReadAllOrders, isIsoDate, isoDateToUtc, readShopSnapshot, saveGrantedScopes,
  type ShopSnapshot,
} from '@/lib/store-connect'
import { safeErrorText } from '@/lib/store-jobs'

export const dynamic = 'force-dynamic'

const TEXT_FIELDS = ['clientId', 'clientSecret', 'accessToken', 'projectId', 'projectName', 'startDate', 'payoutStartDate', 'trackingPageUrl'] as const
type Input = { shop: string } & Record<(typeof TEXT_FIELDS)[number], string>

type Existing = NonNullable<Awaited<ReturnType<typeof findStore>>>

// A pasted token, a client-credentials pair, or (for a store that is already saved) its own credential.
type Attempt =
  | { kind: 'CLIENT_CREDENTIALS'; clientId: string; clientSecret: string }
  | { kind: 'TOKEN'; accessToken: string }
  | { kind: 'STORED' }

type Checked = { snapshot: ShopSnapshot; response?: undefined } | { response: NextResponse }

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
  if (input.clientId && input.clientSecret) return { kind: 'CLIENT_CREDENTIALS', clientId: input.clientId, clientSecret: input.clientSecret }
  return existing?.credential ? { kind: 'STORED' } : null
}

type Save = { existing: Existing | null; input: Input; snapshot: ShopSnapshot | null; orderPrefix: string | null; linkProjectId: string | null; credential: CredentialInput | null }

// A store that exists keeps its row: only what is empty is filled in (project, prefix, payout date, tracking page),
// everything it already has stays (lastError too: only the job that failed clears it). The timezone is the shop's own, so it always follows Shopify.
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
      ? await tx.shopifyStore.update({ where: { id: existing.id }, data: fill })
      : await tx.shopifyStore.create({ data: { shop: input.shop, ...fill } })
    if (credential) await saveStoreCredential(store.id, credential, tx)
    if (snapshot) await saveGrantedScopes(store.id, snapshot.scopes, tx)
    return store
  })
}

async function connectStore(body: unknown, secrets: string[]): Promise<NextResponse> {
  // Nothing Shopify says is relayed except its error code (letters and underscores): a body can echo what was sent.
  const fail = (status: number, message: string) => NextResponse.json({ error: message }, { status })
  const needsOauth = (storeId: string, shop: string) =>
    NextResponse.json({ status: 'NEEDS_OAUTH', storeId, oauthUrl: `/api/auth/shopify?shop=${encodeURIComponent(shop)}` })

  const parsed = parseInput(body)
  if ('error' in parsed) return fail(400, parsed.error)
  const { input } = parsed

  const existing = await findStore(input.shop)
  const stored = existing?.credential
  for (const value of [stored?.clientId, stored?.clientSecret, stored?.accessToken]) if (value) secrets.push(value)
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

  // The store's own credential, through the path every sync takes: a fresh token is reused and a stale one is minted
  // once with compare-and-set, so this never writes the credential and never overwrites one replaced meanwhile.
  const checkStored = async (store: Existing): Promise<Checked> => {
    const credential = store.credential!
    for (let round = 0; ; round++) {
      let token: string
      try {
        token = (await getStoreConnection(store.id, { allowDisabled: true })).token
      } catch (e) {
        if (!(e instanceof StoreConnectionError)) throw e
        if (e.shopifyError === 'shop_not_permitted') return { response: needsOauth(store.id, input.shop) }
        return { response: fail(e.code === 'MINT_FAILED' && !e.shopifyError ? 502 : 400, e.message) }
      }
      secrets.push(token)
      try {
        return { snapshot: await readShopSnapshot(input.shop, token) }
      } catch (e) {
        if (!(e instanceof ShopSnapshotError)) throw e
        if (e.kind !== 'TOKEN_REJECTED') return { response: fail(e.kind === 'UNREACHABLE' ? 502 : 400, e.message) }
        if (credential.authMode === 'CLIENT_CREDENTIALS') {
          if (round > 0) return { response: fail(400, e.message) }
          await discardRejectedToken(store.id, token)
          continue
        }
        if (credential.clientId && credential.clientSecret) return { response: needsOauth(store.id, input.shop) }
        return { response: fail(400, e.message) }
      }
    }
  }

  let snapshot: ShopSnapshot
  let credential: CredentialInput | null = null
  if (attempt.kind === 'STORED') {
    const checked = await checkStored(existing!)
    if (checked.response) return checked.response
    snapshot = checked.snapshot
  } else {
    let token: string
    if (attempt.kind === 'CLIENT_CREDENTIALS') {
      try {
        const minted = await mintClientCredentialsToken(input.shop, attempt.clientId, attempt.clientSecret)
        token = minted.token
        credential = { authMode: 'CLIENT_CREDENTIALS', clientId: attempt.clientId, clientSecret: attempt.clientSecret, accessToken: token, tokenExpiresAt: minted.expiresAt, connectedAt: new Date() }
      } catch (e) {
        if (!(e instanceof MintError)) throw e
        if (e.shopifyError === 'shop_not_permitted') {
          // A store that can already connect keeps what it has until the new app is proven: nothing is written for a pair that cannot mint.
          if (hasUsableCredential(stored)) {
            return fail(409, `App của Client ID vừa nhập chưa được cài trên store ${input.shop} (Shopify trả về shop_not_permitted), nên chưa đổi được. Kết nối hiện tại vẫn được giữ nguyên. Muốn chuyển sang app khác, hãy bấm "Ngắt kết nối" trên thẻ store này rồi kết nối lại với app mới.`)
          }
          const pending = await saveStore({
            existing, input, snapshot: null, orderPrefix: null, linkProjectId,
            credential: { authMode: 'OAUTH', clientId: attempt.clientId, clientSecret: attempt.clientSecret, accessToken: null },
          })
          return needsOauth(pending.id, input.shop)
        }
        if (e.status && e.status < 500) return fail(400, `Shopify từ chối Client ID hoặc Client Secret (${e.shopifyError ?? `HTTP ${e.status}`}). Kiểm tra lại hai giá trị này.`)
        return fail(502, e.message)
      }
    } else {
      token = attempt.accessToken
      credential = { authMode: 'TOKEN', accessToken: token, connectedAt: new Date() }
    }
    secrets.push(token)
    try {
      snapshot = await readShopSnapshot(input.shop, token)
    } catch (e) {
      if (!(e instanceof ShopSnapshotError)) throw e
      return fail(e.kind === 'UNREACHABLE' ? 502 : 400, e.message)
    }
  }

  let orderPrefix = existing?.orderPrefix ?? null
  let warning: string | undefined
  const newest = snapshot.latestOrderName
  const detected = orderPrefixOf(newest)
  if (!orderPrefix && newest) {
    if (!detected) {
      if (/^#?[A-Za-z]/.test(newest.trim())) {
        return fail(409, `Đơn mới nhất của store là ${newest}: giữa tiền tố và số đơn có ký tự ngăn cách. Tool nhận ra đơn của store theo dạng "<TIỀN TỐ><số>" (ví dụ REMI1010), nên tiền tố không được kèm dấu gạch hay khoảng trắng. Vào Shopify Admin → Settings → General → Order ID, bỏ ký tự ngăn cách khỏi Prefix, tạo một đơn mới rồi kết nối lại.`)
      }
      return fail(409, `Đơn mới nhất của store là ${newest}, tên đơn chưa có tiền tố nên không phân biệt được với store khác. Vào Shopify Admin → Settings → General → Order ID, đặt prefix riêng cho store (ví dụ REMI), tạo một đơn mới rồi kết nối lại.`)
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
  } else if (orderPrefix && detected && detected !== orderPrefix.toUpperCase()) {
    warning = `Đơn mới nhất của store là ${newest}, tiền tố ${detected}, khác tiền tố đang lưu ${orderPrefix}. Tool vẫn giữ ${orderPrefix}; nếu đã đổi prefix trong Shopify thì đơn mới sẽ không khớp store này.`
  }

  const store = await saveStore({ existing, input, snapshot, orderPrefix, linkProjectId, credential })
  return NextResponse.json({
    status: 'CONNECTED',
    storeId: store.id,
    shopName: snapshot.shopName,
    timezone: store.ianaTimezone,
    orderPrefix: store.orderPrefix,
    scopes: snapshot.scopes,
    readAllOrders: hasReadAllOrders(snapshot.scopes),
    ...(warning ? { warning } : {}),
  })
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  // Grows while the request runs: what the store already has stored and every token it mints are added, so an error log never carries them.
  const secrets = ['clientId', 'clientSecret', 'accessToken']
    .map(key => (body as Record<string, unknown> | null)?.[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim())
  try {
    return await connectStore(body, secrets)
  } catch (e) {
    console.error('[stores/connect]', safeErrorText(e, secrets))
    return NextResponse.json({ error: 'Không lưu được kết nối store. Thử lại, hoặc xem log máy chủ.' }, { status: 500 })
  }
}
