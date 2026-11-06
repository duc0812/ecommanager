'use client'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { useCurrentUser } from '@/components/RoleGate'
import { secretStatusLabel } from '@/lib/secret-view'

type StoreRow = {
  id: string
  shop: string
  projectName: string | null
  enabled: boolean
  connected: boolean
  authMode: string | null
  lastError: string | null
  lastErrorAt: string | null
  lastSyncAt: string | null
  orderPrefix: string | null
  ianaTimezone: string | null
  trackingPageUrl: string | null
  payoutStartDate: string | null
  readAllOrders: boolean | null
}
type FreeProject = { id: string; name: string }
type Banner = { ok: boolean; text: string; lines?: string[]; warning?: string }
type Form = {
  shop: string; clientId: string; clientSecret: string; accessToken: string
  projectId: string; projectName: string; startDate: string; payoutStartDate: string; trackingPageUrl: string
}

const EMPTY_FORM: Form = { shop: '', clientId: '', clientSecret: '', accessToken: '', projectId: '', projectName: '', startDate: '', payoutStartDate: '', trackingPageUrl: '' }
const AUTH_LABELS: Record<string, string> = { CLIENT_CREDENTIALS: 'Client credentials', OAUTH: 'OAuth', TOKEN: 'Token dán tay' }
const input = 'mt-xs w-full border border-outline-variant/40 bg-surface-container-lowest rounded-lg px-sm py-xs text-body-sm text-on-surface'
const primaryButton = 'bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-40'
const outlineButton = 'border border-outline-variant/40 text-on-surface px-md py-xs rounded-lg text-label-sm disabled:opacity-40'
const dangerButton = 'flex items-center gap-xs border border-error/30 text-error px-md py-xs rounded-lg text-label-sm hover:bg-error-container/30 disabled:opacity-40'

const usDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
const usDay = (ymd: string) => { const [y, m, d] = ymd.split('-'); return `${m}/${d}/${y}` }

async function send(url: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown): Promise<{ ok: boolean; error: string; data: any }> {
  try {
    const res = await fetch(url, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, error: data.error ?? `Lỗi HTTP ${res.status}`, data }
  } catch {
    return { ok: false, error: 'Mất kết nối tới máy chủ', data: null }
  }
}

function ReadAllOrders({ value, canRecheck }: { value: boolean | null; canRecheck: boolean }) {
  if (value === null) return <p className="text-label-sm text-on-surface-variant">Quyền của app chưa kiểm tra{canRecheck ? ': bấm Kết nối lại.' : '.'}</p>
  if (value) return <p className="text-label-sm text-on-surface-variant">read_all_orders: có</p>
  return (
    <p className="text-label-sm text-error">
      read_all_orders: chưa có
      <span className="block text-on-surface-variant">đơn cũ hơn 60 ngày không đọc được</span>
    </p>
  )
}

const SAMPLE_TRACKING = '1Z999TEST'

// The tracking number is appended to the page link as it is, so the sample shows a wrong ending before it is saved.
function TrackingSample({ value }: { value: string }) {
  const page = value.trim()
  if (!page) return null
  return (
    <span className="mt-xs block text-label-sm text-on-surface-variant">
      Khách sẽ nhận link: <span className="font-mono break-all text-on-surface">{page}{SAMPLE_TRACKING}</span>
    </span>
  )
}

type MerchizeSource = 'store' | 'server' | 'incomplete' | 'none'
type KeysView = {
  shared: boolean
  pgprints: { hasStoreId: boolean; storeIdMasked?: string | null; hasSecretKey: boolean; secretKeyMasked?: string | null; defaultShipClass: string | null; pushEnabled: boolean }
  merchize: { hasApiUrl: boolean; apiUrlHost: string | null; hasToken: boolean; tokenMasked?: string | null; source: MerchizeSource }
  parcelpanel: { hasApiKey: boolean; apiKeyMasked?: string | null }
}
type KeysForm = { storeId: string; secretKey: string; shipClass: string; pushEnabled: boolean; mzUrl: string; mzToken: string; ppKey: string }

const TRACKING_WEBHOOK_PATH = '/api/public/pgprints/tracking'
const EMPTY_KEYS: KeysForm = { storeId: '', secretKey: '', shipClass: '', pushEnabled: false, mzUrl: '', mzToken: '', ppKey: '' }
const MERCHIZE_SOURCE: Record<MerchizeSource, { text: string; bad: boolean }> = {
  store: { text: 'Dùng khoá Merchize riêng của store', bad: false },
  server: { text: 'Chưa có khoá riêng: đang dùng khoá Merchize của server', bad: false },
  incomplete: { text: 'Mới có URL hoặc token: store này chưa gửi được Merchize', bad: true },
  none: { text: 'Store và server đều chưa có khoá Merchize: chưa gửi được', bad: true },
}

/** The PGprints, Merchize and ParcelPanel keys of one store. Litzzy keeps the shared PGprints and ParcelPanel keys, edited where they always were. */
function StoreKeysPanel({ store }: { store: StoreRow }) {
  const [view, setView] = useState<KeysView | null>(null)
  const [form, setForm] = useState<KeysForm>(EMPTY_KEYS)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const apply = useCallback((v: KeysView) => {
    setView(v)
    setForm({ ...EMPTY_KEYS, shipClass: v.pgprints.defaultShipClass ?? '', pushEnabled: v.pgprints.pushEnabled })
  }, [])

  useEffect(() => {
    fetch(`/api/stores/${store.id}/settings`, { cache: 'no-store' })
      .then(async r => (r.ok ? apply(await r.json()) : setMessage({ ok: false, text: 'Không tải được khoá của store' })))
      .catch(() => setMessage({ ok: false, text: 'Không tải được khoá của store' }))
  }, [store.id, apply])

  async function submit(body: Record<string, unknown>, done: string) {
    setBusy(true)
    setMessage(null)
    const r = await send(`/api/stores/${store.id}/settings`, 'PUT', body)
    setBusy(false)
    if (!r.ok) { setMessage({ ok: false, text: r.error }); return }
    apply(r.data)
    setMessage({ ok: true, text: done })
  }

  function save() {
    if (!view) return
    const pgprints: Record<string, unknown> = {}
    if (!view.shared) {
      if (form.storeId.trim()) pgprints.storeId = form.storeId.trim()
      if (form.secretKey.trim()) pgprints.secretKey = form.secretKey.trim()
      if (form.shipClass.trim() !== (view.pgprints.defaultShipClass ?? '')) pgprints.defaultShipClass = form.shipClass.trim()
      if (form.pushEnabled !== view.pgprints.pushEnabled) pgprints.pushEnabled = form.pushEnabled
    }
    const merchize: Record<string, unknown> = {}
    if (form.mzUrl.trim()) merchize.apiUrl = form.mzUrl.trim()
    if (form.mzToken.trim()) merchize.token = form.mzToken.trim()
    const parcelpanel: Record<string, unknown> = {}
    if (!view.shared && form.ppKey.trim()) parcelpanel.apiKey = form.ppKey.trim()
    const body = {
      ...(Object.keys(pgprints).length ? { pgprints } : {}),
      ...(Object.keys(merchize).length ? { merchize } : {}),
      ...(Object.keys(parcelpanel).length ? { parcelpanel } : {}),
    }
    if (Object.keys(body).length === 0) { setMessage({ ok: false, text: 'Chưa nhập gì mới để lưu' }); return }
    void submit(body, `Đã lưu khoá của ${store.shop}.`)
  }

  function clear(name: string, body: Record<string, unknown>) {
    if (!window.confirm(`Xoá khoá ${name} của store ${store.shop}?`)) return
    void submit(body, `Đã xoá khoá ${name} của ${store.shop}.`)
  }

  if (!view) return <p className="text-label-sm text-on-surface-variant">{message?.text ?? 'Đang tải khoá của store…'}</p>

  const webhookUrl = `${window.location.origin}${TRACKING_WEBHOOK_PATH}`
  async function copyWebhook() {
    try {
      await navigator.clipboard.writeText(webhookUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setMessage({ ok: false, text: 'Không chép được, hãy bôi đen và chép tay' })
    }
  }

  const pg = view.pgprints
  const hasPgprints = pg.hasStoreId && pg.hasSecretKey
  const merchize = MERCHIZE_SOURCE[view.merchize.source]
  const set = (patch: Partial<KeysForm>) => setForm(f => ({ ...f, ...patch }))

  return (
    <div className="space-y-md">
      {message && (
        <div role="status" className={`rounded-lg px-md py-sm text-body-sm border ${message.ok ? 'bg-secondary/5 border-secondary/30 text-secondary' : 'bg-error-container/40 border-error/30 text-error'}`}>{message.text}</div>
      )}
      <div className="grid gap-md md:grid-cols-3">
        <div className="space-y-xs">
          <h4 className="text-label-md text-primary">PGprints</h4>
          <div>
            <p className="text-label-sm text-on-surface-variant">Webhook tracking: đăng ký địa chỉ này trong tài khoản PGprints của store</p>
            <div className="flex items-center gap-xs">
              <input type="text" readOnly value={webhookUrl} onFocus={e => e.currentTarget.select()} aria-label="Địa chỉ webhook tracking PGprints" className={`${input} font-mono`} />
              <button type="button" className={`${outlineButton} mt-xs shrink-0`} onClick={copyWebhook}>{copied ? 'Đã chép' : 'Chép'}</button>
            </div>
          </div>
          {view.shared ? (
            <p className="text-label-sm text-on-surface-variant">
              Dùng khoá chung: Store ID {secretStatusLabel(pg.hasStoreId, pg.storeIdMasked)}, Secret key {secretStatusLabel(pg.hasSecretKey, pg.secretKeyMasked)}.
              Sửa ở trang cài đặt xưởng Pgprints.
            </p>
          ) : (
            <>
              <p className={`text-label-sm ${hasPgprints ? 'text-on-surface-variant' : 'text-error'}`}>
                {hasPgprints
                  ? `Store ID ${secretStatusLabel(pg.hasStoreId, pg.storeIdMasked)} · Secret key ${secretStatusLabel(pg.hasSecretKey, pg.secretKeyMasked)}`
                  : 'Chưa có khoá PGprints: đơn của store này không gửi được sang PGprints. Hệ thống không bao giờ dùng khoá của store khác thay thế.'}
              </p>
              <label className="block text-label-sm text-on-surface-variant">Store ID mới
                <input type="text" autoComplete="off" value={form.storeId} onChange={e => set({ storeId: e.target.value })} className={input} />
              </label>
              <label className="block text-label-sm text-on-surface-variant">Secret key mới (để trống: giữ nguyên)
                <input type="password" autoComplete="new-password" value={form.secretKey} onChange={e => set({ secretKey: e.target.value })} className={input} />
              </label>
              <label className="block text-label-sm text-on-surface-variant">Ship class mặc định
                <input type="text" autoComplete="off" value={form.shipClass} onChange={e => set({ shipClass: e.target.value })} className={input} />
              </label>
              <label className="flex items-center gap-sm text-label-sm text-on-surface-variant">
                <input type="checkbox" checked={form.pushEnabled} onChange={e => set({ pushEnabled: e.target.checked })} />
                Bật gửi đơn sang PGprints
              </label>
              {(pg.hasStoreId || pg.hasSecretKey) && (
                <button type="button" className={outlineButton} disabled={busy} onClick={() => clear('PGprints', { pgprints: { storeId: null, secretKey: null, pushEnabled: false } })}>Xoá khoá PGprints</button>
              )}
            </>
          )}
        </div>

        <div className="space-y-xs">
          <h4 className="text-label-md text-primary">Merchize</h4>
          <p className={`text-label-sm ${merchize.bad ? 'text-error' : 'text-on-surface-variant'}`}>
            {merchize.text}
            {view.merchize.hasApiUrl && view.merchize.apiUrlHost ? ` · ${view.merchize.apiUrlHost}` : ''}
            {view.merchize.hasToken ? ` · token ${secretStatusLabel(true, view.merchize.tokenMasked)}` : ''}
          </p>
          <label className="block text-label-sm text-on-surface-variant">URL API Merchize mới
            <input type="url" autoComplete="off" value={form.mzUrl} onChange={e => set({ mzUrl: e.target.value })} placeholder="https://….merchize.com/…/bo-api" className={input} />
          </label>
          <label className="block text-label-sm text-on-surface-variant">Token mới (để trống: giữ nguyên)
            <input type="password" autoComplete="new-password" value={form.mzToken} onChange={e => set({ mzToken: e.target.value })} className={input} />
          </label>
          {(view.merchize.hasApiUrl || view.merchize.hasToken) && (
            <button type="button" className={outlineButton} disabled={busy} onClick={() => clear('Merchize', { merchize: { apiUrl: null, token: null } })}>Xoá khoá Merchize (dùng khoá server)</button>
          )}
        </div>

        <div className="space-y-xs">
          <h4 className="text-label-md text-primary">ParcelPanel</h4>
          {view.shared ? (
            <p className="text-label-sm text-on-surface-variant">
              Dùng khoá chung: {secretStatusLabel(view.parcelpanel.hasApiKey, view.parcelpanel.apiKeyMasked)}. Sửa ở trang Tracking.
            </p>
          ) : (
            <>
              <p className={`text-label-sm ${view.parcelpanel.hasApiKey ? 'text-on-surface-variant' : 'text-error'}`}>
                {view.parcelpanel.hasApiKey
                  ? `API key ${secretStatusLabel(true, view.parcelpanel.apiKeyMasked)}`
                  : 'Chưa có khoá ParcelPanel: sync tracking ParcelPanel bỏ qua store này.'}
              </p>
              <label className="block text-label-sm text-on-surface-variant">API key mới
                <input type="password" autoComplete="new-password" value={form.ppKey} onChange={e => set({ ppKey: e.target.value })} className={input} />
              </label>
              {view.parcelpanel.hasApiKey && (
                <button type="button" className={outlineButton} disabled={busy} onClick={() => clear('ParcelPanel', { parcelpanel: { apiKey: null } })}>Xoá khoá ParcelPanel</button>
              )}
            </>
          )}
        </div>
      </div>
      <button type="button" className={primaryButton} disabled={busy} onClick={save}>{busy ? 'Đang lưu…' : 'Lưu khoá'}</button>
    </div>
  )
}

/** Every store the tool is connected to, and for a Super Admin the form that adds one and the switches that change one. */
export default function StoreConnectionsCard() {
  const { user } = useCurrentUser()
  const isSuper = user?.role === 'SUPERADMIN'
  const [stores, setStores] = useState<StoreRow[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [freeProjects, setFreeProjects] = useState<FreeProject[]>([])
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [edits, setEdits] = useState<Record<string, { trackingPageUrl: string; payoutStartDate: string }>>({})
  const [busy, setBusy] = useState('')
  const [banner, setBanner] = useState<Banner | null>(null)
  const [keysOpen, setKeysOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/auth/status', { cache: 'no-store' }).catch(() => null)
    if (!res?.ok) { setLoadFailed(true); setStores([]); return }
    const data = await res.json().catch(() => ({}))
    setLoadFailed(false)
    setStores(Array.isArray(data.stores) ? data.stores : [])
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!isSuper) return
    fetch('/api/projects').then(r => r.json()).then(list => {
      if (Array.isArray(list)) setFreeProjects(list.filter((p: any) => !p.shopifyStore && !p.archivedAt).map((p: any) => ({ id: p.id, name: p.name })))
    }).catch(() => {})
  }, [isSuper, stores])

  const setField = (key: keyof Form, value: string) => setForm(f => ({ ...f, [key]: value }))
  const editOf = (s: StoreRow) => edits[s.id] ?? { trackingPageUrl: s.trackingPageUrl ?? '', payoutStartDate: s.payoutStartDate ?? '' }

  function showConnected(data: any) {
    if (data.status === 'NEEDS_OAUTH') {
      setBanner({ ok: true, text: 'Shopify không cho app này tự lấy token cho shop. Đang chuyển sang trang cấp quyền của Shopify…' })
      window.location.href = data.oauthUrl
      return
    }
    setBanner({
      ok: true,
      text: `Đã kết nối ${data.shopName}.`,
      lines: [
        `Múi giờ: ${data.timezone ?? 'không rõ'}`,
        data.orderPrefix ? `Tiền tố đơn: ${data.orderPrefix}` : 'Tiền tố đơn: chưa có. Store chưa có đơn nào nên sync đơn bị từ chối cho tới khi có tiền tố: sau khi có đơn đầu tiên, bấm Kết nối lại.',
        data.readAllOrders ? 'read_all_orders: có' : 'read_all_orders: chưa có, đơn cũ hơn 60 ngày không đọc được',
      ],
      warning: typeof data.warning === 'string' ? data.warning : undefined,
    })
    void load()
  }

  async function submit() {
    setBusy('add')
    setBanner(null)
    const body = Object.fromEntries(Object.entries(form).filter(([key, value]) => value.trim() && !(key === 'projectName' && form.projectId)))
    const r = await send('/api/stores/connect', 'POST', body)
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    setForm(EMPTY_FORM)
    setOpen(false)
    showConnected(r.data)
  }

  async function reconnect(s: StoreRow) {
    if (!s.connected) {
      setBanner(null)
      setForm({ ...EMPTY_FORM, shop: s.shop })
      setOpen(true)
      return
    }
    setBusy(`re:${s.id}`)
    setBanner(null)
    const r = await send('/api/stores/connect', 'POST', { shop: s.shop })
    setBusy('')
    if (!r.ok) {
      setBanner({ ok: false, text: `${r.error} Điền lại Client ID và Client Secret, hoặc dán token mới, ở form Thêm store.` })
      setForm({ ...EMPTY_FORM, shop: s.shop })
      setOpen(true)
      return
    }
    showConnected(r.data)
  }

  async function patchStore(s: StoreRow, body: Record<string, unknown>, done: string, savedSettings = false) {
    setBusy(`set:${s.id}`)
    setBanner(null)
    const r = await send(`/api/stores/${s.id}`, 'PATCH', body)
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    setBanner({ ok: true, text: done })
    if (savedSettings) setEdits(prev => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== s.id)))
    void load()
  }

  async function disconnect(s: StoreRow) {
    const name = s.projectName && s.projectName !== s.shop ? `${s.projectName} (${s.shop})` : s.shop
    if (!window.confirm(`Ngắt kết nối store ${name}? Mọi lần sync của store này sẽ dừng cho tới khi kết nối lại. Store, tiền tố, project và cài đặt vẫn được giữ.`)) return
    setBusy(`off:${s.id}`)
    setBanner(null)
    const r = await send(`/api/auth/status?storeId=${encodeURIComponent(s.id)}`, 'DELETE')
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    setBanner({ ok: true, text: `Đã ngắt kết nối ${s.shop}. Bấm Kết nối lại để nhập thông tin kết nối mới.` })
    void load()
  }

  function toggle(s: StoreRow) {
    if (s.enabled && !window.confirm(`Tắt store ${s.shop}? Mọi việc chạy với Shopify (đồng bộ tự động, nút Sync Now, Auto Fulfilled) bỏ qua store này cho tới khi bật lại, và đơn của store không được ghi vào sheet xưởng. Đơn đã có của store vẫn hiện trong danh sách đơn và báo cáo.`)) return
    void patchStore(s, { enabled: !s.enabled }, s.enabled ? `Đã tắt ${s.shop}.` : `Đã bật ${s.shop}.`)
  }

  function saveSettings(s: StoreRow) {
    const edit = editOf(s)
    void patchStore(s, { trackingPageUrl: edit.trackingPageUrl.trim() || null, payoutStartDate: edit.payoutStartDate || null }, `Đã lưu cài đặt của ${s.shop}.`, true)
  }

  const ordered = [...(stores ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled))
  const canSubmit = form.shop.trim() && (form.accessToken.trim() || (form.clientId.trim() && form.clientSecret.trim()))
  const heads = ['Store', 'Shop domain', 'Kết nối', 'Lần sync cuối', 'Lỗi sync gần nhất', ...(isSuper ? ['Thao tác'] : [])]

  return (
    <div className="col-span-12 bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-secondary">storefront</span>
        <h3 className="text-headline-sm text-primary">Các store đang kết nối</h3>
        {stores && (
          <span className="bg-surface-container-high px-sm py-xs rounded text-label-sm text-on-surface-variant">{stores.length} store</span>
        )}
        {isSuper && (
          <button type="button" className={`${primaryButton} ml-auto flex items-center gap-xs`} onClick={() => { if (open) setForm(EMPTY_FORM); setOpen(o => !o); setBanner(null) }}>
            <span className="material-symbols-outlined text-[18px]">{open ? 'close' : 'add'}</span>
            {open ? 'Đóng form' : 'Thêm store'}
          </button>
        )}
      </div>

      {banner && (
        <div role="status" className={`mx-lg mt-md rounded-lg px-md py-sm text-body-sm border ${banner.ok ? 'bg-secondary/5 border-secondary/30 text-secondary' : 'bg-error-container/40 border-error/30 text-error'}`}>
          {banner.text}
          {banner.lines && <ul className="mt-xs list-disc pl-lg text-on-surface-variant">{banner.lines.map(line => <li key={line}>{line}</li>)}</ul>}
          {banner.warning && <p className="mt-xs text-error">{banner.warning}</p>}
        </div>
      )}

      {isSuper && open && (
        <div className="p-lg space-y-md border-b border-outline-variant/20 bg-surface-container-low/50">
          <label className="block text-label-sm text-on-surface-variant max-w-xl">Shop domain
            <input type="text" autoComplete="off" value={form.shop} onChange={e => setField('shop', e.target.value)} placeholder="ten-shop.myshopify.com" className={input} />
          </label>
          <div className="grid gap-sm md:grid-cols-2 max-w-3xl">
            <label className="text-label-sm text-on-surface-variant">Client ID
              <input type="text" autoComplete="off" value={form.clientId} onChange={e => setField('clientId', e.target.value)} className={input} />
            </label>
            <label className="text-label-sm text-on-surface-variant">Client Secret
              <input type="password" autoComplete="new-password" value={form.clientSecret} onChange={e => setField('clientSecret', e.target.value)} className={input} />
            </label>
          </div>
          <p className="text-label-sm text-on-surface-variant max-w-3xl">
            Tool thử client credentials trước và tự lấy token mới trước khi hết hạn. Nếu Shopify không cho app này lấy token cho shop (shop_not_permitted) thì chuyển sang cấp quyền OAuth.
          </p>
          <label className="block text-label-sm text-on-surface-variant max-w-xl">Hoặc dán access token (store còn dùng app kiểu cũ)
            <input type="password" autoComplete="new-password" value={form.accessToken} onChange={e => setField('accessToken', e.target.value)} className={input} />
          </label>
          <div className="grid gap-sm md:grid-cols-2 max-w-3xl">
            <label className="text-label-sm text-on-surface-variant">Project
              <select value={form.projectId} onChange={e => setField('projectId', e.target.value)} className={input}>
                <option value="">Tạo project mới</option>
                {freeProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            {!form.projectId && (
              <label className="text-label-sm text-on-surface-variant">Tên project mới
                <input type="text" autoComplete="off" value={form.projectName} onChange={e => setField('projectName', e.target.value)} className={input} />
              </label>
            )}
            {!form.projectId && (
              <label className="text-label-sm text-on-surface-variant">Ngày bắt đầu project (để trống: lấy ngày bắt đầu payout)
                <input type="date" value={form.startDate} onChange={e => setField('startDate', e.target.value)} className={input} />
              </label>
            )}
            <label className="text-label-sm text-on-surface-variant">Ngày bắt đầu payout
              <input type="date" value={form.payoutStartDate} onChange={e => setField('payoutStartDate', e.target.value)} className={input} />
            </label>
          </div>
          <label className="block text-label-sm text-on-surface-variant max-w-3xl">Link trang tracking của khách (https)
            <input type="url" autoComplete="off" value={form.trackingPageUrl} onChange={e => setField('trackingPageUrl', e.target.value)} placeholder="https://ten-shop.com/apps/track?nums=" className={input} />
            <TrackingSample value={form.trackingPageUrl} />
          </label>
          <div className="flex items-center gap-sm">
            <button type="button" className={primaryButton} disabled={!!busy || !canSubmit} onClick={submit}>{busy === 'add' ? 'Đang kết nối…' : 'Kết nối store'}</button>
            <button type="button" className={outlineButton} disabled={!!busy} onClick={() => { setForm(EMPTY_FORM); setOpen(false) }}>Huỷ</button>
          </div>
        </div>
      )}

      {stores === null ? (
        <div className="flex items-center gap-sm px-lg py-lg text-on-surface-variant text-body-sm">
          <span className="material-symbols-outlined text-[16px] animate-spin">sync</span>
          Đang kiểm tra...
        </div>
      ) : loadFailed ? (
        <div className="px-lg py-xl text-center text-error text-body-sm">Không đọc được danh sách store.</div>
      ) : stores.length === 0 ? (
        <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">Chưa có store nào.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-outline-variant/20 bg-surface-container-low">
                {heads.map(h => <th key={h} className="text-left px-lg py-md text-label-md text-on-surface-variant">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {ordered.map(s => {
                const edit = editOf(s)
                const dirty = edit.trackingPageUrl.trim() !== (s.trackingPageUrl ?? '') || edit.payoutStartDate !== (s.payoutStartDate ?? '')
                return (
                  <Fragment key={s.id}>
                    <tr className={`border-b border-outline-variant/10 hover:bg-surface-container-low/50 transition-colors ${s.enabled ? '' : 'opacity-60'}`}>
                      <td className="px-lg py-md text-label-md text-primary">
                        {s.projectName ?? s.shop}
                        {!s.enabled && (
                          <span className="ml-sm rounded-full bg-surface-container-high px-sm py-xs text-label-sm font-normal text-on-surface-variant">Đã tắt</span>
                        )}
                        <p className="text-label-sm font-normal text-on-surface-variant">
                          {s.orderPrefix ? `Tiền tố ${s.orderPrefix}` : <span className="text-error">Chưa có tiền tố đơn</span>}
                          {s.ianaTimezone ? ` · ${s.ianaTimezone}` : ''}
                          {!isSuper && s.payoutStartDate ? ` · payout từ ${usDay(s.payoutStartDate)}` : ''}
                        </p>
                      </td>
                      <td className="px-lg py-md text-body-sm font-mono text-on-surface-variant">{s.shop}</td>
                      <td className="px-lg py-md">
                        <span className={`px-sm py-xs rounded-full text-label-sm ${s.connected ? 'bg-on-tertiary-container/15 text-on-tertiary-container' : 'bg-error-container text-on-error-container'}`}>
                          {s.connected ? 'Có' : 'Không'}
                        </span>
                        {s.authMode && <span className="ml-sm text-label-sm text-on-surface-variant">{AUTH_LABELS[s.authMode] ?? s.authMode}</span>}
                        {s.connected && <ReadAllOrders value={s.readAllOrders} canRecheck={isSuper} />}
                      </td>
                      <td className="px-lg py-md text-body-sm text-on-surface-variant">{s.lastSyncAt ? usDate(s.lastSyncAt) : '—'}</td>
                      <td className="px-lg py-md text-body-sm">
                        {s.lastError ? (
                          <span className="text-error">
                            {s.lastError}
                            {s.lastErrorAt && <span className="ml-xs text-label-sm text-on-surface-variant">({usDate(s.lastErrorAt)})</span>}
                          </span>
                        ) : (
                          <span className="text-on-surface-variant">—</span>
                        )}
                      </td>
                      {isSuper && (
                        <td className="px-lg py-md">
                          <div className="flex items-center gap-md">
                            <button
                              type="button" role="switch" aria-checked={s.enabled} aria-label={`${s.enabled ? 'Tắt' : 'Bật'} ${s.shop}`}
                              disabled={!!busy} onClick={() => toggle(s)}
                              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${s.enabled ? 'bg-secondary' : 'bg-surface-container-highest'}`}
                            >
                              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${s.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                            </button>
                            <button type="button" className={outlineButton} disabled={!!busy} onClick={() => reconnect(s)}>
                              {busy === `re:${s.id}` ? 'Đang kết nối…' : 'Kết nối lại'}
                            </button>
                            <button type="button" className={outlineButton} aria-expanded={keysOpen === s.id} onClick={() => setKeysOpen(o => (o === s.id ? null : s.id))}>
                              {keysOpen === s.id ? 'Đóng khoá nhà cung cấp' : 'Khoá nhà cung cấp'}
                            </button>
                            {s.connected && (
                              <button type="button" className={dangerButton} disabled={!!busy} onClick={() => disconnect(s)}>
                                <span className="material-symbols-outlined text-[16px]">link_off</span>
                                {busy === `off:${s.id}` ? 'Đang ngắt…' : 'Ngắt kết nối'}
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                    {isSuper && (
                      <tr className="border-b border-outline-variant/10 bg-surface-container-low/30">
                        <td colSpan={heads.length} className="px-lg py-sm">
                          <div className="flex flex-wrap items-end gap-md">
                            <label className="text-label-sm text-on-surface-variant w-full md:w-80">Link trang tracking của khách
                              <input
                                type="url" autoComplete="off" value={edit.trackingPageUrl} placeholder="https://ten-shop.com/apps/track?nums="
                                onChange={e => setEdits(prev => ({ ...prev, [s.id]: { ...edit, trackingPageUrl: e.target.value } }))} className={input}
                              />
                              <TrackingSample value={edit.trackingPageUrl} />
                            </label>
                            <label className="text-label-sm text-on-surface-variant">Ngày bắt đầu payout{s.payoutStartDate ? ` (${usDay(s.payoutStartDate)})` : ''}
                              <input
                                type="date" value={edit.payoutStartDate}
                                onChange={e => setEdits(prev => ({ ...prev, [s.id]: { ...edit, payoutStartDate: e.target.value } }))} className={input}
                              />
                            </label>
                            <button type="button" className={outlineButton} disabled={!!busy || !dirty} onClick={() => saveSettings(s)}>Lưu cài đặt</button>
                          </div>
                          {keysOpen === s.id && <div className="mt-md border-t border-outline-variant/20 pt-md"><StoreKeysPanel store={s} /></div>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
