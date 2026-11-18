'use client'
import { useCallback, useEffect, useState } from 'react'
import { useCurrentUser } from '@/components/RoleGate'
import { CKF_AUTO_SHIPPING, CKF_SHIPPING } from '@/lib/catkissfish-shipping'

type View = {
  hasClientId: boolean; clientIdMasked: string | null; hasClientSecret: boolean; tokenExpiresAt: string | null
  shippingId: string; shippingIdIntl: string | null
  skus: { sku: string; styleCode: string | null }[]; unpaidOrders: number
}
type Style = { styleCode: string; name: string | null; colors: string[]; sizes: string[]; areas: string[]; error: string | null }
type Banner = { ok: boolean; text: string }

const URL = '/api/fulfillment/catkissfish/settings'
const button = 'inline-flex items-center gap-xs rounded-lg px-md py-xs text-body-sm font-semibold disabled:opacity-40'
const outline = `${button} border border-outline-variant/40 text-on-surface`
const field = 'mt-xs w-full border rounded-lg px-sm py-xs text-body-sm text-on-surface'

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

/** The CatKissFish developer key the tool sends scarf orders with. Saving it moves CatKissFish lines from CSV to the API. */
export default function CatkissfishSetupCard() {
  const { user, loading } = useCurrentUser()
  const isSuper = user?.role === 'SUPERADMIN'
  const [view, setView] = useState<View | null>(null)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [shippingId, setShippingId] = useState('')
  const [shippingIdIntl, setShippingIdIntl] = useState('')
  const [styles, setStyles] = useState<Style[] | null>(null)
  const [banner, setBanner] = useState<Banner | null>(null)
  const [busy, setBusy] = useState('')

  const show = useCallback((data: View) => {
    setView(data)
    setShippingId(data.shippingId)
    setShippingIdIntl(data.shippingIdIntl ?? '')
  }, [])

  const load = useCallback(async () => {
    const res = await fetch(URL).catch(() => null)
    if (!res?.ok) { setBanner({ ok: false, text: 'Không đọc được cài đặt CatKissFish' }); return }
    show(await res.json())
  }, [show])

  useEffect(() => { if (isSuper) void load() }, [isSuper, load])

  async function save() {
    setBusy('save')
    setBanner(null)
    const r = await send(URL, 'PUT', { clientId, clientSecret, shippingId, shippingIdIntl })
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    show(r.data)
    setClientId('')
    setClientSecret('')
    setBanner({ ok: true, text: 'Đã lưu. Bấm "Kiểm tra kết nối" để thử khoá.' })
  }

  async function test() {
    setBusy('test')
    setBanner(null)
    setStyles(null)
    const r = await send(`${URL}/test`, 'POST')
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    setStyles(r.data.styles)
    const bad = (r.data.styles as Style[]).filter(s => s.error)
    setBanner(bad.length > 0
      ? { ok: false, text: `Khoá đúng, nhưng chưa đọc được ${bad.length} style: ${bad.map(s => `${s.styleCode} (${s.error})`).join('; ')}` }
      : { ok: true, text: 'Kết nối được CatKissFish. Không có đơn nào được tạo.' })
    void load()
  }

  async function remove() {
    if (!window.confirm('Gỡ khoá CatKissFish? Dòng CatKissFish sẽ trở lại đường CSV.')) return
    setBusy('remove')
    setBanner(null)
    const r = await send(URL, 'PUT', { clientId: null, clientSecret: null })
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    show(r.data)
    setStyles(null)
    setBanner({ ok: true, text: 'Đã gỡ khoá CatKissFish.' })
  }

  if (loading || !isSuper) return null
  const connected = !!view?.hasClientId && !!view.hasClientSecret
  const canSave = connected || (!!clientId.trim() && !!clientSecret.trim())

  return (
    <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 mb-lg">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-on-surface-variant">cloud_upload</span>
        <h2 className="text-title-md">CatKissFish (đẩy đơn qua API)</h2>
        {connected && <span className="ml-auto bg-on-tertiary-container/15 text-on-tertiary-container px-sm py-xs rounded-full text-label-sm">✓ Đã lưu khoá</span>}
      </div>
      <div className="p-lg space-y-md">
        {banner && (
          <div role="status" className={`rounded-lg px-md py-sm text-body-sm border ${banner.ok ? 'bg-secondary/5 border-secondary/30 text-secondary' : 'bg-error-container/40 border-error/30 text-error'}`}>
            {banner.text}
          </div>
        )}
        {!!view?.unpaidOrders && (
          <div role="status" className="rounded-lg px-md py-sm text-body-sm border bg-error-container/40 border-error/30 text-error">
            {view.unpaidOrders} đơn đang &quot;Chưa thanh toán&quot; trên CatKissFish. Tool không tự trả tiền, các đơn này chưa vào sản xuất cho tới khi trả trên catkissfish.com.
          </div>
        )}
        <p className="text-label-sm text-on-surface-variant">
          Lấy client_id và client_secret ở catkissfish.com: Settings › Personal center › Apply for developer account. Lưu xong, dòng CatKissFish ở Duyệt sản xuất đi qua API thay vì CSV.
        </p>
        <div className="grid gap-sm md:grid-cols-2 max-w-2xl">
          <label className="text-label-sm text-on-surface-variant">client_id
            <input autoComplete="off" value={clientId} onChange={e => setClientId(e.target.value)} placeholder={view?.clientIdMasked ? `Đã lưu ${view.clientIdMasked}, để trống nếu không đổi` : ''} className={field} />
          </label>
          <label className="text-label-sm text-on-surface-variant">client_secret
            <input type="password" autoComplete="new-password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} placeholder={view?.hasClientSecret ? 'Đã lưu, để trống nếu không đổi' : ''} className={field} />
          </label>
          <label className="text-label-sm text-on-surface-variant">Cách ship đơn Mỹ
            <select value={shippingId} onChange={e => setShippingId(e.target.value)} className={field}>
              <option value={CKF_AUTO_SHIPPING}>CatKissFish tự chọn</option>
              {CKF_SHIPPING.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="text-label-sm text-on-surface-variant">Cách ship đơn ngoài Mỹ
            <select value={shippingIdIntl} onChange={e => setShippingIdIntl(e.target.value)} className={field}>
              <option value="">Chưa chọn (đơn ngoài Mỹ chưa gửi được)</option>
              <option value={CKF_AUTO_SHIPPING}>CatKissFish tự chọn</option>
              {CKF_SHIPPING.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-sm">
          <button type="button" className={`${button} bg-secondary text-on-secondary`} disabled={!!busy || !canSave} onClick={save}>{busy === 'save' ? 'Đang lưu…' : 'Lưu'}</button>
          <button type="button" className={outline} disabled={!!busy || !connected} onClick={test}>{busy === 'test' ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}</button>
          {connected && <button type="button" className={`${outline} ml-auto text-error`} disabled={!!busy} onClick={remove}>Gỡ khoá</button>}
        </div>
        {!!view?.skus.length && (
          <ul className="text-label-sm text-on-surface-variant space-y-xs">
            {view.skus.map(s => <li key={s.sku}><span className="font-mono">{s.sku}</span> → {s.styleCode ? <span className="font-mono">{s.styleCode}</span> : <span className="text-error">chưa có style code</span>}</li>)}
          </ul>
        )}
        {styles && styles.filter(s => !s.error).map(s => (
          <p key={s.styleCode} className="text-label-sm text-on-surface-variant">
            <b>{s.name ?? s.styleCode}</b>: màu {s.colors.join(', ') || 'không ghi'}; size {s.sizes.join(', ') || 'không ghi'}; vùng in {s.areas.join(', ') || 'theo file tải lên'}.
          </p>
        ))}
      </div>
    </div>
  )
}
