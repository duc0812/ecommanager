import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAccess, requireSuperadmin, type AuthUser } from '@/lib/api-auth'
import { getPgprintsSettings, pushSwitchAfter, toSettingsView } from '@/lib/pgprints-settings'
import { resolveMerchize } from '@/lib/merchize'
import { getParcelPanelApiKey, maskApiKey } from '@/lib/tracking/parcelpanel-config'
import { maskedForSuperadminOnly } from '@/lib/secret-view'
import { isLitzzyStore } from '@/lib/shopify-shop'
import { assertSafeExternalUrl } from '@/lib/safe-url'
import { getStoreSettings, setStoreSetting, type StoreSettingKey } from '@/lib/store-settings'

export const dynamic = 'force-dynamic'

type StoreRow = { id: string; shop: string; project: { name: string } | null }
type Write = { key: StoreSettingKey; value: string | null }

const SHARED_MESSAGE = 'Litzzy dùng khoá chung: sửa khoá PGprints ở trang cài đặt xưởng Pgprints và khoá ParcelPanel ở trang Tracking'
const FIELDS = {
  pgprints: ['storeId', 'secretKey', 'defaultShipClass', 'pushEnabled'],
  merchize: ['apiUrl', 'token'],
  parcelpanel: ['apiKey'],
} as const
type Section = keyof typeof FIELDS

function findStore(id: string): Promise<StoreRow | null> {
  return prisma.shopifyStore.findUnique({ where: { id }, select: { id: true, shop: true, project: { select: { name: true } } } })
}

async function viewOf(store: StoreRow, user: AuthUser) {
  const [pgprints, parcelKey, mzOwn, mzResolved] = await Promise.all([
    getPgprintsSettings(store.id),
    getParcelPanelApiKey(store.id),
    getStoreSettings(store.id, ['merchize.apiUrl', 'merchize.token']),
    resolveMerchize(store.id),
  ])
  let apiUrlHost: string | null = null
  try { apiUrlHost = mzOwn['merchize.apiUrl'] ? new URL(mzOwn['merchize.apiUrl']).host : null } catch { /* a stored URL that no longer parses shows no host */ }
  const source = mzResolved.creds ? mzResolved.source : (mzOwn['merchize.apiUrl'] || mzOwn['merchize.token']) ? 'incomplete' : 'none'
  return {
    storeId: store.id,
    shop: store.shop,
    name: store.project?.name ?? store.shop,
    shared: isLitzzyStore(store),
    pgprints: maskedForSuperadminOnly(user, toSettingsView(pgprints), ['storeIdMasked', 'secretKeyMasked']),
    merchize: maskedForSuperadminOnly(user, {
      hasApiUrl: !!mzOwn['merchize.apiUrl'],
      apiUrlHost,
      hasToken: !!mzOwn['merchize.token'],
      tokenMasked: maskApiKey(mzOwn['merchize.token']),
      source,
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

function section(body: Record<string, unknown>, name: Section): Record<string, unknown> | undefined {
  const value = body[name]
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadSettings(`${name} không hợp lệ`)
  const stray = Object.keys(value).find(field => !(FIELDS[name] as readonly string[]).includes(field))
  if (stray) throw new BadSettings(`Không có trường "${name}.${stray}". Các trường của ${name}: ${FIELDS[name].join(', ')}`)
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
  const shared = isLitzzyStore(store)

  const writes: Write[] = []
  try {
    const unknown = Object.keys(body).find(key => !Object.keys(FIELDS).includes(key))
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

    const written = (key: StoreSettingKey) => writes.find(w => w.key === key)
    if (!shared) {
      const rule = pushSwitchAfter(await getPgprintsSettings(store.id), {
        storeId: written('pgprints.storeId')?.value,
        secretKey: written('pgprints.secretKey')?.value,
        pushEnabled: written('pgprints.pushEnabled') ? written('pgprints.pushEnabled')!.value === 'true' : undefined,
      })
      if ('error' in rule) throw new BadSettings(rule.error)
      if (rule.pushEnabled !== undefined) {
        const at = writes.findIndex(w => w.key === 'pgprints.pushEnabled')
        if (at >= 0) writes.splice(at, 1)
        writes.push({ key: 'pgprints.pushEnabled', value: rule.pushEnabled ? 'true' : 'false' })
      }
    }
    const own = await getStoreSettings(store.id, ['merchize.apiUrl', 'merchize.token'])
    const after = (key: StoreSettingKey) => (written(key) ? written(key)!.value : own[key as 'merchize.apiUrl' | 'merchize.token'] ?? null)
    if (!!after('merchize.apiUrl') !== !!after('merchize.token')) {
      throw new BadSettings('Nhập cả URL API và token Merchize của store, hoặc xoá cả hai để dùng khoá của server')
    }
  } catch (e) {
    if (e instanceof BadSettings) return NextResponse.json({ error: e.message }, { status: 400 })
    throw e
  }

  // One transaction: a failure part way must not leave half a Merchize pair or a switch on without its key.
  await prisma.$transaction(async tx => {
    for (const write of writes) await setStoreSetting(store.id, write.key, write.value, tx)
  })
  return NextResponse.json(await viewOf(store, auth.user))
}
