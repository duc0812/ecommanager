'use client'
import { useCallback, useEffect, useState } from 'react'
import { useCurrentUser } from '@/components/RoleGate'
import { SupplierSkuMapTable } from '@/components/SupplierSkuMap'

type View = {
  hasApiKey: boolean; apiKeyMasked: string | null; storeId: string | null; shippingMethodCode: string | null
  skus: { sku: string; lenfulSku: string | null }[]; unpaidOrders: number
}
type Store = { id: string; name: string | null; platform: string | null; isDefault: boolean; status: string | null }
type Check = {
  stores: Store[]; wallet: number | null; problems: string[]
  skus: { lenfulSku: string; product: string | null; type: string | null; listPrice: number | null; positions: string[]; error: string | null }[]
}
type Banner = { ok: boolean; text: string }

const URL = '/api/fulfillment/lenful/settings'
const button = 'inline-flex items-center gap-xs rounded-lg px-md py-xs text-body-sm font-semibold disabled:opacity-40'
const outline = `${button} border border-outline-variant/40 text-on-surface`
const field = 'mt-xs w-full border rounded-lg px-sm py-xs text-body-sm text-on-surface'
const usd = (n: number | null) => n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)

async function send(url: string, method: 'POST' | 'PUT', body?: unknown): Promise<{ ok: boolean; error: string; data: any }> {
  try {
    const res = await fetch(url, {
      method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, error: data.error ?? `Lỗi HTTP ${res.status}`, data }
  } catch {
    return { ok: false, error: 'Mất kết nối tới máy chủ', data: null }
  }
}

/** The Lenful seller API key the tool sends orders with. Saving it moves Lenful lines from CSV to the API. */
export default function LenfulSetupCard() {
  const { user, loading } = useCurrentUser()
  const isSuper = user?.role === 'SUPERADMIN'
  const [view, setView] = useState<View | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [storeId, setStoreId] = useState('')
  const [method, setMethod] = useState('')
  const [check, setCheck] = useState<Check | null>(null)
  const [banner, setBanner] = useState<Banner | null>(null)
  const [busy, setBusy] = useState('')
  const [rows, setRows] = useState<any[] | null>(null)
  const [skus, setSkus] = useState<any[]>([])
  const [query, setQuery] = useState('')

  const show = useCallback((data: View) => {
    setView(data)
    setStoreId(data.storeId ?? '')
    setMethod(data.shippingMethodCode ?? '')
  }, [])

  const load = useCallback(async () => {
    const res = await fetch(URL).catch(() => null)
    if (!res?.ok) { setBanner({ ok: false, text: 'Không đọc được cài đặt Lenful' }); return }
    show(await res.json())
  }, [show])

  useEffect(() => { if (isSuper) void load() }, [isSuper, load])

  async function save() {
    setBusy('save')
    setBanner(null)
    const r = await send(URL, 'PUT', { apiKey, storeId, shippingMethodCode: method })
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    show(r.data)
    setApiKey('')
    setBanner({ ok: true, text: 'Đã lưu. Bấm "Kiểm tra kết nối" để thử key, rồi "Ghép SKU".' })
  }

  async function test() {
    setBusy('test')
    setBanner(null)
    setCheck(null)
    const r = await send(`${URL}/test`, 'POST')
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    const c = r.data as Check
    setCheck(c)
    const bad = c.skus.filter(s => s.error)
    const notes = [...c.problems, ...bad.map(s => `${s.lenfulSku}: ${s.error}`)]
    setBanner(notes.length > 0
      ? { ok: false, text: `Key đúng, nhưng: ${notes.join('; ')}` }
      : { ok: true, text: `Kết nối được Lenful (${c.stores.length} store, ví ${usd(c.wallet)}). Không có đơn nào được tạo.` })
    void load()
  }

  async function loadSkus() {
    setBusy('skus')
    setBanner(null)
    const q = query.trim()
    const res = await fetch(`/api/fulfillment/lenful/sku-map${q ? `?q=${encodeURIComponent(q)}` : ''}`).catch(() => null)
    const data = await res?.json().catch(() => null)
    setBusy('')
    if (!res?.ok) { setBanner({ ok: false, text: data?.error ?? 'Không đọc được catalog Lenful' }); return }
    setSkus(data.supplierSkus)
    setRows(data.products)
    if (data.supplierSkus.length === 0) setBanner({ ok: false, text: `Tìm "${data.queries.join('", "')}" trong catalog Lenful không ra SKU nào — gõ tên sản phẩm Lenful rồi tìm lại` })
  }

  async function remove() {
    if (!window.confirm('Gỡ API key Lenful? Dòng Lenful sẽ trở lại đường CSV.')) return
    setBusy('remove')
    setBanner(null)
    const r = await send(URL, 'PUT', { apiKey: null })
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    show(r.data)
    setCheck(null)
    setRows(null)
    setBanner({ ok: true, text: 'Đã gỡ API key Lenful.' })
  }

  if (loading || !isSuper) return null
  const connected = !!view?.hasApiKey
  const stores = check?.stores ?? []

  return (
    <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 mb-lg">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-on-surface-variant">cloud_upload</span>
        <h2 className="text-title-md">Lenful (đẩy đơn qua API)</h2>
        {connected && <span className="ml-auto bg-on-tertiary-container/15 text-on-tertiary-container px-sm py-xs rounded-full text-label-sm">✓ Đã lưu key</span>}
      </div>
      <div className="p-lg space-y-md">
        {banner && (
          <div role="status" className={`rounded-lg px-md py-sm text-body-sm border ${banner.ok ? 'bg-secondary/5 border-secondary/30 text-secondary' : 'bg-error-container/40 border-error/30 text-error'}`}>
            {banner.text}
          </div>
        )}
        {!!view?.unpaidOrders && (
          <div role="status" className="rounded-lg px-md py-sm text-body-sm border bg-error-container/40 border-error/30 text-error">
            {view.unpaidOrders} đơn đang &quot;Chưa thanh toán&quot; trên Lenful vì ví không đủ. Lenful tự trừ khi nạp tiền vào ví.
          </div>
        )}
        <p className="text-label-sm text-on-surface-variant">
          Tạo key ở Lenful: Settings › API keys (chủ tài khoản tạo), chọn quyền orders:read, orders:write, orders:cancel, products:read, stores:read, tracking:read, wallet:read.
          Key chỉ hiện một lần. Lưu xong, dòng Lenful ở Duyệt sản xuất đi qua API thay vì CSV, và mỗi lần gửi Lenful tự trừ tiền ví.
        </p>
        <div className="grid gap-sm md:grid-cols-3 max-w-3xl">
          <label className="text-label-sm text-on-surface-variant md:col-span-3">API key
            <input type="password" autoComplete="new-password" value={apiKey} onChange={e => setApiKey(e.target.value)}
              placeholder={view?.apiKeyMasked ? `Đã lưu ${view.apiKeyMasked}, để trống nếu không đổi` : 'lf_live_…'} className={field} />
          </label>
          <label className="text-label-sm text-on-surface-variant md:col-span-2">Store Lenful nhận đơn
            {stores.length > 0 ? (
              <select value={storeId} onChange={e => setStoreId(e.target.value)} className={field}>
                <option value="">Store mặc định của tài khoản</option>
                {stores.map(s => <option key={s.id} value={s.id}>{s.name ?? s.id}{s.isDefault ? ' (mặc định)' : ''} · {s.platform ?? '—'}</option>)}
              </select>
            ) : (
              <input value={storeId} onChange={e => setStoreId(e.target.value)} placeholder="Để trống = store mặc định; bấm Kiểm tra kết nối để chọn" className={field} />
            )}
          </label>
          <label className="text-label-sm text-on-surface-variant">Mã cách ship
            <input inputMode="numeric" value={method} onChange={e => setMethod(e.target.value)} placeholder="Để trống = Lenful mặc định" className={field} />
          </label>
        </div>
        <p className="text-label-sm text-on-surface-variant">Mã cách ship là số trong Lenful Orders › Import. Cột Ship của từng SKU ở Ghép SKU ghi đè mã này.</p>
        <div className="flex flex-wrap items-center gap-sm">
          <button type="button" className={`${button} bg-secondary text-on-secondary`} disabled={!!busy || (!connected && !apiKey.trim())} onClick={save}>{busy === 'save' ? 'Đang lưu…' : 'Lưu'}</button>
          <button type="button" className={outline} disabled={!!busy || !connected} onClick={test}>{busy === 'test' ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}</button>
          <button type="button" className={outline} disabled={!!busy || !connected} onClick={loadSkus}>{busy === 'skus' ? 'Đang tìm…' : 'Ghép SKU'}</button>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm trong catalog (tuỳ chọn)" aria-label="Tìm trong catalog Lenful"
            className="border rounded-lg px-sm py-xs text-body-sm text-on-surface w-[220px]" />
          {connected && <button type="button" className={`${outline} ml-auto text-error`} disabled={!!busy} onClick={remove}>Gỡ key</button>}
        </div>
        {!rows && !!view?.skus.length && (
          <ul className="text-label-sm text-on-surface-variant space-y-xs">
            {view.skus.map(s => <li key={s.sku}><span className="font-mono">{s.sku}</span> → {s.lenfulSku ? <span className="font-mono">{s.lenfulSku}</span> : <span className="text-error">chưa ghép SKU Lenful</span>}</li>)}
          </ul>
        )}
        {check && check.skus.filter(s => !s.error).map(s => (
          <p key={s.lenfulSku} className="text-label-sm text-on-surface-variant">
            <span className="font-mono">{s.lenfulSku}</span>: <b>{s.product ?? '—'}</b> ({s.type ?? '—'}), giá {usd(s.listPrice)}, vị trí in {s.positions.join(', ') || 'không có'}.
          </p>
        ))}
        {rows && (
          <SupplierSkuMapTable name="Lenful" rows={rows} skus={skus} shipHint="Ship để trống là mã cách ship ở trên."
            onRows={setRows} onError={text => setBanner({ ok: false, text })} />
        )}
      </div>
    </div>
  )
}
