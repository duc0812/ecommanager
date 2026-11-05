import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAccess, requireSuperadmin, type AuthUser } from '@/lib/api-auth'
import { getPgprintsSettings, toSettingsView } from '@/lib/pgprints-settings'
import { merchizeCredentials } from '@/lib/merchize'
import { getParcelPanelApiKey, maskApiKey } from '@/lib/tracking/parcelpanel-config'
import { maskedForSuperadminOnly } from '@/lib/secret-view'
import { LITZZY_SHOP } from '@/lib/shopify-shop'
import { assertSafeExternalUrl } from '@/lib/safe-url'
import { getStoreSettings, setStoreSetting, type StoreSettingKey } from '@/lib/store-settings'

export const dynamic = 'force-dynamic'

type StoreRow = { id: string; shop: string; project: { name: string } | null }
type Write = { key: StoreSettingKey; value: string | null }

const SHARED_MESSAGE = 'Litzzy dùng khoá chung: sửa khoá PGprints ở trang cài đặt xưởng Pgprints và khoá ParcelPanel ở trang Tracking'
const SECTIONS = ['pgprints', 'merchize', 'parcelpanel']

function findStore(id: string): Promise<StoreRow | null> {
  return prisma.shopifyStore.findUnique({ where: { id }, select: { id: true, shop: true, project: { select: { name: true } } } })
}

async function viewOf(store: StoreRow, user: AuthUser) {
  const shared = store.shop === LITZZY_SHOP
  const [pgprints, parcelKey, mzOwn, mzResolved] = await Promise.all([
    getPgprintsSettings(store.id),
    getParcelPanelApiKey(store.id),
    getStoreSettings(store.id, ['merchize.apiUrl', 'merchize.token']),
    merchizeCredentials(store.id),
  ])
  const ownMerchize = !!(mzOwn['merchize.apiUrl'] || mzOwn['merchize.token'])
  let apiUrlHost: string | null = null
  try { apiUrlHost = mzOwn['merchize.apiUrl'] ? new URL(mzOwn['merchize.apiUrl']).host : null } catch { /* a stored URL that no longer parses shows no host */ }
  return {
    storeId: store.id,
    shop: store.shop,
    name: store.project?.name ?? store.shop,
    shared,
    pgprints: maskedForSuperadminOnly(user, toSettingsView(pgprints), ['storeIdMasked', 'secretKeyMasked']),
    merchize: maskedForSuperadminOnly(user, {
      hasApiUrl: !!mzOwn['merchize.apiUrl'],
      apiUrlHost,
      hasToken: !!mzOwn['merchize.token'],
      tokenMasked: maskApiKey(mzOwn['merchize.token']),
      source: ownMerchize ? (mzResolved ? 'store' : 'incomplete') : (mzResolved ? 'server' : 'none'),
    }, ['tokenMasked']),
    parcelpanel: maskedForSuperadminOnly(user, { hasApiKey: !!parcelKey, apiKeyMasked: maskApiKey(parcelKey) }, ['apiKeyMasked']),
  }
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const store = await findStore(params.id)
  if (!store) return NextResponse.json({ error: 'Không tìm thấy store' }, { status: 404 })
  return NextResponse.json(await viewOf(store, auth.user))
}

class BadSettings extends Error {}

function section(body: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const value = body[name]
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadSettings(`${name} không hợp lệ`)
  return value as Record<string, unknown>
}

// `undefined` leaves a field alone and `null` clears it. A blank secret means "keep the stored one": the form never
// receives the stored secret, so it cannot send it back. A blank plain field clears it.
function field(into: Write[], from: Record<string, unknown> | undefined, name: string, key: StoreSettingKey, label: string, max: number, opts: { secret?: boolean } = {}) {
  const value = from?.[name]
  if (value === undefined) return
  if (value === null) { into.push({ key, value: null }); return }
  if (typeof value !== 'string') throw new BadSettings(`${label} phải là chuỗi`)
  const text = value.trim()
  if (text.length > max) throw new BadSettings(`${label} quá dài`)
  if (text === '' && opts.secret) return
  into.push({ key, value: text || null })
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Body không hợp lệ' }, { status: 400 })
  const store = await findStore(params.id)
  if (!store) return NextResponse.json({ error: 'Không tìm thấy store' }, { status: 404 })
  const shared = store.shop === LITZZY_SHOP

  const writes: Write[] = []
  try {
    const unknown = Object.keys(body).find(key => !SECTIONS.includes(key))
    if (unknown) throw new BadSettings(`Không có mục cài đặt "${unknown}"`)
    const pg = section(body, 'pgprints')
    const mz = section(body, 'merchize')
    const pp = section(body, 'parcelpanel')
    if (shared && (pg || pp)) throw new BadSettings(SHARED_MESSAGE)

    field(writes, pg, 'storeId', 'pgprints.storeId', 'Store ID PGprints', 200)
    field(writes, pg, 'secretKey', 'pgprints.secretKey', 'Secret key PGprints', 500, { secret: true })
    field(writes, pg, 'defaultShipClass', 'pgprints.defaultShipClass', 'Ship class mặc định', 200)
    if (pg?.pushEnabled !== undefined) {
      if (typeof pg.pushEnabled !== 'boolean') throw new BadSettings('pushEnabled phải là true/false')
      writes.push({ key: 'pgprints.pushEnabled', value: pg.pushEnabled ? 'true' : 'false' })
    }
    field(writes, mz, 'apiUrl', 'merchize.apiUrl', 'URL API Merchize', 500)
    field(writes, mz, 'token', 'merchize.token', 'Token Merchize', 1000, { secret: true })
    field(writes, pp, 'apiKey', 'parcelpanel.apiKey', 'ParcelPanel API key', 500, { secret: true })

    const url = writes.find(w => w.key === 'merchize.apiUrl')?.value
    if (url) {
      try { assertSafeExternalUrl(url, { allowedHosts: ['merchize.com'] }) } catch (e: any) { throw new BadSettings(`URL API Merchize: ${e.message}`) }
    }

    const next = (key: StoreSettingKey, current: string | null | undefined) => {
      const write = writes.find(w => w.key === key)
      return write ? write.value : current ?? null
    }
    if (!shared) {
      const own = await getStoreSettings(store.id, ['pgprints.storeId', 'pgprints.secretKey', 'pgprints.pushEnabled', 'merchize.apiUrl', 'merchize.token'])
      const pgReady = !!next('pgprints.storeId', own['pgprints.storeId']) && !!next('pgprints.secretKey', own['pgprints.secretKey'])
      const enabling = writes.find(w => w.key === 'pgprints.pushEnabled')?.value === 'true'
      const enabled = enabling || (!writes.some(w => w.key === 'pgprints.pushEnabled') && own['pgprints.pushEnabled'] === 'true')
      if (enabled && !pgReady) {
        if (enabling) throw new BadSettings('Nhập Store ID và Secret key trước khi bật gửi đơn')
        writes.push({ key: 'pgprints.pushEnabled', value: 'false' })
      }
    }
    const own = await getStoreSettings(store.id, ['merchize.apiUrl', 'merchize.token'])
    const hasUrl = !!next('merchize.apiUrl', own['merchize.apiUrl'])
    const hasToken = !!next('merchize.token', own['merchize.token'])
    if (hasUrl !== hasToken) throw new BadSettings('Nhập cả URL API và token Merchize của store, hoặc xoá cả hai để dùng khoá của server')
  } catch (e) {
    if (e instanceof BadSettings) return NextResponse.json({ error: e.message }, { status: 400 })
    throw e
  }

  for (const write of writes) await setStoreSetting(store.id, write.key, write.value)
  return NextResponse.json(await viewOf(store, auth.user))
}
