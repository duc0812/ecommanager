'use client'
import { useCallback, useEffect, useState } from 'react'
import { useCurrentUser } from '@/components/RoleGate'
import { SupplierSkuMapTable } from '@/components/SupplierSkuMap'

type View = { email: string | null; hasPassword: boolean; tokenExpiresAt: string | null }
type Banner = { ok: boolean; text: string }

const SHIP_OPTIONS = [{ value: '', label: 'Standard' }, ...['Fast', 'Express', 'USPS'].map(v => ({ value: v, label: v }))]
const button = 'inline-flex items-center gap-xs rounded-lg px-md py-xs text-body-sm font-semibold disabled:opacity-40'
const outline = `${button} border border-outline-variant/40 text-on-surface`

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

const usDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })

/** The Bondre account the tool sends orders with, and which Bondre SKU each tool SKU is. */
export default function BondreSetupCard() {
  const { user, loading } = useCurrentUser()
  const isSuper = user?.role === 'SUPERADMIN'
  const [view, setView] = useState<View | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [banner, setBanner] = useState<Banner | null>(null)
  const [busy, setBusy] = useState('')
  const [rows, setRows] = useState<any[] | null>(null)
  const [skus, setSkus] = useState<any[]>([])

  const load = useCallback(async () => {
    const res = await fetch('/api/fulfillment/bondre/settings').catch(() => null)
    if (!res?.ok) { setBanner({ ok: false, text: 'Không đọc được cài đặt Bondre' }); return }
    const data: View = await res.json()
    setView(data)
    setEmail(data.email ?? '')
  }, [])

  useEffect(() => { if (isSuper) void load() }, [isSuper, load])

  async function save() {
    setBusy('save')
    setBanner(null)
    const r = await send('/api/fulfillment/bondre/settings', 'PUT', { email, password })
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    setView(r.data)
    setPassword('')
    setBanner({ ok: true, text: 'Đã lưu tài khoản Bondre. Từ lúc này đơn Bondre ở Duyệt sản xuất đi qua API.' })
  }

  async function test() {
    setBusy('test')
    setBanner(null)
    const r = await send('/api/fulfillment/bondre/settings/test', 'POST')
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    const a = r.data.account
    setBanner({ ok: true, text: `Kết nối được: ${a.businessName ?? 'không rõ tên'}, số dư khả dụng ${a.availableAmount ?? '—'}.` })
    void load()
  }

  async function loadSkus() {
    setBusy('skus')
    setBanner(null)
    const res = await fetch('/api/fulfillment/bondre/sku-map').catch(() => null)
    const data = await res?.json().catch(() => null)
    setBusy('')
    if (!res?.ok) { setBanner({ ok: false, text: data?.error ?? 'Không đọc được danh sách SKU của Bondre' }); return }
    setSkus(data.supplierSkus)
    setRows(data.products)
  }

  async function remove() {
    if (!window.confirm('Gỡ tài khoản Bondre? Đơn Bondre sẽ trở lại đường CSV.')) return
    setBusy('remove')
    setBanner(null)
    const r = await send('/api/fulfillment/bondre/settings', 'PUT', { email: null, password: null })
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    setView(r.data)
    setEmail('')
    setRows(null)
    setBanner({ ok: true, text: 'Đã gỡ tài khoản Bondre.' })
  }

  if (loading || !isSuper) return null
  const connected = !!view?.email && !!view.hasPassword

  return (
    <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 mb-lg">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-on-surface-variant">cloud_upload</span>
        <h2 className="text-title-md">Bondre (đẩy đơn qua API)</h2>
        {connected && <span className="ml-auto bg-on-tertiary-container/15 text-on-tertiary-container px-sm py-xs rounded-full text-label-sm">✓ Đã lưu tài khoản</span>}
      </div>
      <div className="p-lg space-y-md">
        {banner && (
          <div role="status" className={`rounded-lg px-md py-sm text-body-sm border ${banner.ok ? 'bg-secondary/5 border-secondary/30 text-secondary' : 'bg-error-container/40 border-error/30 text-error'}`}>
            {banner.text}
          </div>
        )}
        <p className="text-label-sm text-on-surface-variant">
          Bondre không có API key, tool đăng nhập bằng tài khoản web của xưởng để lấy token và tự lấy lại khi hết hạn. Lưu xong thì đơn Bondre đi qua API thay vì CSV.
          {view?.tokenExpiresAt && <> Token hiện tại hết hạn {usDate(view.tokenExpiresAt)}.</>}
        </p>
        <div className="grid gap-sm md:grid-cols-2 max-w-2xl">
          <label className="text-label-sm text-on-surface-variant">Email đăng nhập Bondre
            <input type="email" autoComplete="off" value={email} onChange={e => setEmail(e.target.value)} className="mt-xs w-full border rounded-lg px-sm py-xs text-body-sm text-on-surface" />
          </label>
          <label className="text-label-sm text-on-surface-variant">Mật khẩu Bondre
            <input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder={view?.hasPassword ? 'Đã lưu, để trống nếu không đổi' : ''} className="mt-xs w-full border rounded-lg px-sm py-xs text-body-sm text-on-surface" />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-sm">
          <button type="button" className={`${button} bg-secondary text-on-secondary`} disabled={!!busy || !email.trim()} onClick={save}>{busy === 'save' ? 'Đang lưu…' : 'Lưu'}</button>
          <button type="button" className={outline} disabled={!!busy || !connected} onClick={test}>{busy === 'test' ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}</button>
          <button type="button" className={outline} disabled={!!busy || !connected} onClick={loadSkus}>{busy === 'skus' ? 'Đang tải…' : 'Ghép SKU'}</button>
          {connected && <button type="button" className={`${outline} ml-auto text-error`} disabled={!!busy} onClick={remove}>Gỡ tài khoản</button>}
        </div>

        {rows && (
          <SupplierSkuMapTable name="Bondre" rows={rows} skus={skus} shipOptions={SHIP_OPTIONS} shipHint="Ship để trống là Standard."
            onRows={setRows} onError={text => setBanner({ ok: false, text })} />
        )}
      </div>
    </div>
  )
}
