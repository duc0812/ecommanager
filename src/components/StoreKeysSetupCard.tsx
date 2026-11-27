'use client'
import { useCallback, useEffect, useState } from 'react'
import { useCurrentUser } from '@/components/RoleGate'
import { secretStatusLabel } from '@/lib/secret-view'

export type StoreKeysSupplier = 'merchize' | 'pgprints' | 'parcelpanel'

type StoreRow = { id: string; shop: string; projectName: string | null }
type MerchizeSource = 'store' | 'server' | 'incomplete' | 'none'
type KeysView = {
  shared: boolean
  pgprints: { hasStoreId: boolean; storeIdMasked?: string | null; hasSecretKey: boolean; secretKeyMasked?: string | null; defaultShipClass: string | null; pushEnabled: boolean }
  merchize: { hasApiUrl: boolean; apiUrlHost: string | null; hasToken: boolean; tokenMasked?: string | null; source: MerchizeSource }
  parcelpanel: { hasApiKey: boolean; apiKeyMasked?: string | null }
}
type Banner = { ok: boolean; text: string }
type Status = { text: string; bad: boolean }

const input = 'mt-xs w-full border border-outline-variant/40 bg-surface-container-lowest rounded-lg px-sm py-xs text-body-sm text-on-surface'
const primaryButton = 'bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-40'
const outlineButton = 'border border-outline-variant/40 text-on-surface px-md py-xs rounded-lg text-label-sm disabled:opacity-40'
const TRACKING_WEBHOOK_PATH = '/api/public/pgprints/tracking'

const INFO: Record<StoreKeysSupplier, { title: string; icon: string; hint: string }> = {
  merchize: {
    title: 'Merchize (đẩy đơn qua API)',
    icon: 'cloud_upload',
    hint: 'Mỗi store gửi đơn Merchize bằng khoá riêng của store: URL bo-api và token lấy trong tài khoản Merchize của store đó. Store chưa có khoá riêng thì dùng khoá chung của server (MERCHIZE_API_URL / MERCHIZE_API_TOKEN trong .env của server).',
  },
  pgprints: {
    title: 'PGprints theo store',
    icon: 'cloud_upload',
    hint: 'Store ID và Secret key PGprints của từng store. Litzzy dùng khoá chung, sửa ở trang cài đặt xưởng Pgprints. Hệ thống không bao giờ dùng khoá của store khác thay thế.',
  },
  parcelpanel: {
    title: 'ParcelPanel theo store',
    icon: 'pin_drop',
    hint: 'API key ParcelPanel của từng store để sync tracking. Litzzy dùng khoá chung, sửa ở trang Tracking.',
  },
}

const MERCHIZE_SOURCE: Record<MerchizeSource, Status> = {
  store: { text: 'Dùng khoá Merchize riêng của store', bad: false },
  server: { text: 'Chưa có khoá riêng: đang dùng khoá Merchize của server', bad: false },
  incomplete: { text: 'Mới có URL hoặc token: store này chưa gửi được Merchize', bad: true },
  none: { text: 'Store và server đều chưa có khoá Merchize: chưa gửi được', bad: true },
}

async function send(url: string, body: unknown): Promise<{ ok: boolean; error: string; data: any }> {
  try {
    const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, error: data.error ?? `Lỗi HTTP ${res.status}`, data }
  } catch {
    return { ok: false, error: 'Mất kết nối tới máy chủ', data: null }
  }
}

function statusOf(supplier: StoreKeysSupplier, view: KeysView): Status {
  if (supplier === 'merchize') {
    const mz = view.merchize
    const base = MERCHIZE_SOURCE[mz.source]
    const host = mz.hasApiUrl && mz.apiUrlHost ? ` · ${mz.apiUrlHost}` : ''
    const token = mz.hasToken ? ` · token ${secretStatusLabel(true, mz.tokenMasked)}` : ''
    return { text: `${base.text}${host}${token}`, bad: base.bad }
  }
  if (supplier === 'pgprints') {
    const pg = view.pgprints
    const keys = `Store ID ${secretStatusLabel(pg.hasStoreId, pg.storeIdMasked)} · Secret key ${secretStatusLabel(pg.hasSecretKey, pg.secretKeyMasked)}`
    if (view.shared) return { text: `Dùng khoá chung: ${keys}`, bad: false }
    if (!pg.hasStoreId || !pg.hasSecretKey) return { text: 'Chưa có khoá PGprints: đơn của store này không gửi được sang PGprints', bad: true }
    return { text: `${keys} · ${pg.pushEnabled ? 'Đang bật gửi đơn' : 'Đang tắt gửi đơn'}`, bad: false }
  }
  const pp = view.parcelpanel
  if (view.shared) return { text: `Dùng khoá chung: ${secretStatusLabel(pp.hasApiKey, pp.apiKeyMasked)}`, bad: false }
  return pp.hasApiKey
    ? { text: `API key ${secretStatusLabel(true, pp.apiKeyMasked)}`, bad: false }
    : { text: 'Chưa có khoá ParcelPanel: sync tracking ParcelPanel bỏ qua store này', bad: true }
}

function KeysForm({ supplier, store, view, onSaved }: { supplier: StoreKeysSupplier; store: StoreRow; view: KeysView; onSaved: (v: KeysView) => void }) {
  const [mzUrl, setMzUrl] = useState('')
  const [mzToken, setMzToken] = useState('')
  const [pgStoreId, setPgStoreId] = useState('')
  const [pgSecret, setPgSecret] = useState('')
  const [pgShipClass, setPgShipClass] = useState(view.pgprints.defaultShipClass ?? '')
  const [pgPush, setPgPush] = useState(view.pgprints.pushEnabled)
  const [ppKey, setPpKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Banner | null>(null)

  async function submit(body: Record<string, unknown>, done: string) {
    setBusy(true)
    setMessage(null)
    const r = await send(`/api/stores/${store.id}/settings`, body)
    setBusy(false)
    if (!r.ok) { setMessage({ ok: false, text: r.error }); return }
    setMzUrl(''); setMzToken(''); setPgStoreId(''); setPgSecret(''); setPpKey('')
    setPgShipClass(r.data.pgprints?.defaultShipClass ?? '')
    setPgPush(!!r.data.pgprints?.pushEnabled)
    onSaved(r.data)
    setMessage({ ok: true, text: done })
  }

  function save() {
    let section: Record<string, unknown> = {}
    if (supplier === 'merchize') {
      if (mzUrl.trim()) section.apiUrl = mzUrl.trim()
      if (mzToken.trim()) section.token = mzToken.trim()
    } else if (supplier === 'pgprints') {
      if (pgStoreId.trim()) section.storeId = pgStoreId.trim()
      if (pgSecret.trim()) section.secretKey = pgSecret.trim()
      if (pgShipClass.trim() !== (view.pgprints.defaultShipClass ?? '')) section.defaultShipClass = pgShipClass.trim()
      if (pgPush !== view.pgprints.pushEnabled) section.pushEnabled = pgPush
    } else if (ppKey.trim()) {
      section = { apiKey: ppKey.trim() }
    }
    if (Object.keys(section).length === 0) { setMessage({ ok: false, text: 'Chưa nhập gì mới để lưu' }); return }
    void submit({ [supplier]: section }, `Đã lưu khoá của ${store.shop}.`)
  }

  function clear() {
    const name = supplier === 'merchize' ? 'Merchize' : supplier === 'pgprints' ? 'PGprints' : 'ParcelPanel'
    if (!window.confirm(`Xoá khoá ${name} của store ${store.shop}?`)) return
    const body = supplier === 'merchize'
      ? { merchize: { apiUrl: null, token: null } }
      : supplier === 'pgprints'
        ? { pgprints: { storeId: null, secretKey: null, pushEnabled: false } }
        : { parcelpanel: { apiKey: null } }
    void submit(body, `Đã xoá khoá ${name} của ${store.shop}.`)
  }

  const canClear = supplier === 'merchize'
    ? view.merchize.hasApiUrl || view.merchize.hasToken
    : supplier === 'pgprints'
      ? view.pgprints.hasStoreId || view.pgprints.hasSecretKey
      : view.parcelpanel.hasApiKey

  return (
    <div className="space-y-sm max-w-xl">
      {message && (
        <div role="status" className={`rounded-lg px-md py-sm text-body-sm border ${message.ok ? 'bg-secondary/5 border-secondary/30 text-secondary' : 'bg-error-container/40 border-error/30 text-error'}`}>{message.text}</div>
      )}
      {supplier === 'merchize' && (
        <>
          <label className="block text-label-sm text-on-surface-variant">URL API Merchize mới
            <input type="url" autoComplete="off" value={mzUrl} onChange={e => setMzUrl(e.target.value)} placeholder="https://….merchize.com/…/bo-api" className={input} />
          </label>
          <label className="block text-label-sm text-on-surface-variant">Token mới (để trống: giữ nguyên)
            <input type="password" autoComplete="new-password" value={mzToken} onChange={e => setMzToken(e.target.value)} className={input} />
          </label>
        </>
      )}
      {supplier === 'pgprints' && (
        <>
          <label className="block text-label-sm text-on-surface-variant">Store ID mới
            <input type="text" autoComplete="off" value={pgStoreId} onChange={e => setPgStoreId(e.target.value)} className={input} />
          </label>
          <label className="block text-label-sm text-on-surface-variant">Secret key mới (để trống: giữ nguyên)
            <input type="password" autoComplete="new-password" value={pgSecret} onChange={e => setPgSecret(e.target.value)} className={input} />
          </label>
          <label className="block text-label-sm text-on-surface-variant">Ship class mặc định
            <input type="text" autoComplete="off" value={pgShipClass} onChange={e => setPgShipClass(e.target.value)} className={input} />
          </label>
          <label className="flex items-center gap-sm text-label-sm text-on-surface-variant">
            <input type="checkbox" checked={pgPush} onChange={e => setPgPush(e.target.checked)} />
            Bật gửi đơn sang PGprints
          </label>
        </>
      )}
      {supplier === 'parcelpanel' && (
        <label className="block text-label-sm text-on-surface-variant">API key mới
          <input type="password" autoComplete="new-password" value={ppKey} onChange={e => setPpKey(e.target.value)} className={input} />
        </label>
      )}
      <div className="flex flex-wrap items-center gap-sm">
        <button type="button" className={primaryButton} disabled={busy} onClick={save}>{busy ? 'Đang lưu…' : 'Lưu khoá'}</button>
        {canClear && (
          <button type="button" className={outlineButton} disabled={busy} onClick={clear}>
            {supplier === 'merchize' ? 'Xoá khoá Merchize (dùng khoá server)' : 'Xoá khoá'}
          </button>
        )}
      </div>
    </div>
  )
}

/** One supplier's keys for every connected store, on the Fulfill block of Setup. Saves through /api/stores/[id]/settings. */
export default function StoreKeysSetupCard({ supplier }: { supplier: StoreKeysSupplier }) {
  const { user, loading } = useCurrentUser()
  const isSuper = user?.role === 'SUPERADMIN'
  const [stores, setStores] = useState<StoreRow[] | null>(null)
  const [views, setViews] = useState<Record<string, KeysView | 'error'>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch('/api/auth/status', { cache: 'no-store' }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => null) : null
    if (!data) { setLoadError(true); setStores([]); return }
    const list: StoreRow[] = Array.isArray(data.stores) ? data.stores.map((s: any) => ({ id: s.id, shop: s.shop, projectName: s.projectName ?? null })) : []
    setLoadError(false)
    setStores(list)
    const entries = await Promise.all(list.map(async s => {
      const r = await fetch(`/api/stores/${s.id}/settings`, { cache: 'no-store' }).catch(() => null)
      const v = r?.ok ? await r.json().catch(() => null) : null
      return [s.id, v ?? 'error'] as const
    }))
    setViews(Object.fromEntries(entries))
  }, [])

  useEffect(() => { if (isSuper) void load() }, [isSuper, load])

  if (loading || !isSuper) return null
  const info = INFO[supplier]
  const webhookUrl = typeof window !== 'undefined' ? `${window.location.origin}${TRACKING_WEBHOOK_PATH}` : TRACKING_WEBHOOK_PATH

  async function copyWebhook() {
    try {
      await navigator.clipboard.writeText(webhookUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch { /* the field stays selectable for a manual copy */ }
  }

  return (
    <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 mb-lg">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-on-surface-variant">{info.icon}</span>
        <h2 className="text-title-md">{info.title}</h2>
      </div>
      <div className="p-lg space-y-md">
        <p className="text-label-sm text-on-surface-variant">{info.hint}</p>
        {supplier === 'pgprints' && (
          <div className="max-w-xl">
            <p className="text-label-sm text-on-surface-variant">Webhook tracking: đăng ký địa chỉ này trong tài khoản PGprints của store</p>
            <div className="flex items-center gap-xs">
              <input type="text" readOnly value={webhookUrl} onFocus={e => e.currentTarget.select()} aria-label="Địa chỉ webhook tracking PGprints" className={`${input} font-mono`} />
              <button type="button" className={`${outlineButton} mt-xs shrink-0`} onClick={copyWebhook}>{copied ? 'Đã chép' : 'Chép'}</button>
            </div>
          </div>
        )}
        {stores === null ? (
          <p className="text-label-sm text-on-surface-variant">Đang tải các store…</p>
        ) : loadError ? (
          <p className="text-label-sm text-error">Không tải được danh sách store</p>
        ) : stores.length === 0 ? (
          <p className="text-label-sm text-on-surface-variant">Chưa kết nối store nào. Thêm store ở tab Store.</p>
        ) : (
          <div className="divide-y divide-outline-variant/20 border border-outline-variant/20 rounded-lg">
            {stores.map(s => {
              const view = views[s.id]
              const status = view && view !== 'error' ? statusOf(supplier, view) : null
              const editable = !!view && view !== 'error' && !(view.shared && supplier !== 'merchize')
              return (
                <div key={s.id} className="px-md py-sm">
                  <div className="flex flex-wrap items-center gap-md">
                    <div className="min-w-0 flex-1">
                      <p className="text-label-md text-primary">{s.projectName ?? s.shop}</p>
                      <p className="text-label-sm text-on-surface-variant font-mono">{s.shop}</p>
                      {view === undefined && <p className="text-label-sm text-on-surface-variant">Đang tải khoá…</p>}
                      {view === 'error' && <p className="text-label-sm text-error">Không tải được khoá của store</p>}
                      {status && <p className={`text-label-sm ${status.bad ? 'text-error' : 'text-on-surface-variant'}`}>{status.text}</p>}
                    </div>
                    {editable && (
                      <button type="button" className={outlineButton} aria-expanded={open === s.id} onClick={() => setOpen(o => (o === s.id ? null : s.id))}>
                        {open === s.id ? 'Đóng' : 'Sửa khoá'}
                      </button>
                    )}
                  </div>
                  {editable && open === s.id && (
                    <div className="mt-sm border-t border-outline-variant/20 pt-sm">
                      <KeysForm supplier={supplier} store={s} view={view as KeysView} onSaved={v => setViews(prev => ({ ...prev, [s.id]: v }))} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
