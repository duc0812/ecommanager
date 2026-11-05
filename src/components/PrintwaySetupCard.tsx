'use client'
import { useCallback, useEffect, useState } from 'react'
import { useCurrentUser } from '@/components/RoleGate'
import { SupplierSkuMapTable } from '@/components/SupplierSkuMap'

type View = { hasToken: boolean }
type Banner = { ok: boolean; text: string }

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

/** The Printway token the tool sends and pays orders with, and which Printway SKU each tool SKU is. */
export default function PrintwaySetupCard() {
  const { user, loading } = useCurrentUser()
  const isSuper = user?.role === 'SUPERADMIN'
  const [view, setView] = useState<View | null>(null)
  const [token, setToken] = useState('')
  const [banner, setBanner] = useState<Banner | null>(null)
  const [busy, setBusy] = useState('')
  const [rows, setRows] = useState<any[] | null>(null)
  const [skus, setSkus] = useState<any[]>([])

  const load = useCallback(async () => {
    const res = await fetch('/api/fulfillment/printway/settings').catch(() => null)
    if (!res?.ok) { setBanner({ ok: false, text: 'Không đọc được cài đặt Printway' }); return }
    setView(await res.json())
  }, [])

  useEffect(() => { if (isSuper) void load() }, [isSuper, load])

  async function save() {
    setBusy('save')
    setBanner(null)
    const r = await send('/api/fulfillment/printway/settings', 'PUT', { token })
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    setView(r.data)
    setToken('')
    setBanner({ ok: true, text: 'Đã lưu token Printway. Từ lúc này đơn Printway ở Duyệt sản xuất đi qua API và tự trả tiền khi bấm gửi.' })
  }

  async function remove() {
    if (!window.confirm('Gỡ token Printway? Đơn Printway sẽ trở lại đường CSV.')) return
    setBusy('remove')
    setBanner(null)
    const r = await send('/api/fulfillment/printway/settings', 'PUT', { token: null })
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    setView(r.data)
    setRows(null)
    setBanner({ ok: true, text: 'Đã gỡ token Printway.' })
  }

  async function test() {
    setBusy('test')
    setBanner(null)
    const r = await send('/api/fulfillment/printway/settings/test', 'POST')
    setBusy('')
    setBanner(r.ok ? { ok: true, text: `Kết nối được: Printway có ${r.data.skuCount} SKU.` } : { ok: false, text: r.error })
  }

  async function loadSkus() {
    setBusy('skus')
    setBanner(null)
    const res = await fetch('/api/fulfillment/printway/sku-map').catch(() => null)
    const data = await res?.json().catch(() => null)
    setBusy('')
    if (!res?.ok) { setBanner({ ok: false, text: data?.error ?? 'Không đọc được danh sách SKU của Printway' }); return }
    setSkus(data.supplierSkus)
    setRows(data.products)
  }

  if (loading || !isSuper) return null
  const connected = !!view?.hasToken

  return (
    <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 mb-lg">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-on-surface-variant">cloud_upload</span>
        <h2 className="text-title-md">Printway (đẩy đơn qua API)</h2>
        {connected && <span className="ml-auto bg-on-tertiary-container/15 text-on-tertiary-container px-sm py-xs rounded-full text-label-sm">✓ Đã lưu token</span>}
      </div>
      <div className="p-lg space-y-md">
        {banner && (
          <div role="status" className={`rounded-lg px-md py-sm text-body-sm border ${banner.ok ? 'bg-secondary/5 border-secondary/30 text-secondary' : 'bg-error-container/40 border-error/30 text-error'}`}>
            {banner.text}
          </div>
        )}
        <p className="text-label-sm text-on-surface-variant">
          Tạo token trên Printway ở Store › Connect APIs, hạn 730 ngày. Lưu xong thì đơn Printway đi qua API thay vì CSV, và mỗi lần gửi tool tạo đơn rồi trả tiền bằng tài khoản Printway.
        </p>
        <label className="block max-w-xl text-label-sm text-on-surface-variant">Token Printway
          <input type="password" autoComplete="new-password" value={token} onChange={e => setToken(e.target.value)}
            placeholder={connected ? 'Đã lưu, để trống nếu không đổi' : ''} className="mt-xs w-full border rounded-lg px-sm py-xs text-body-sm text-on-surface" />
        </label>
        <div className="flex flex-wrap items-center gap-sm">
          <button type="button" className={`${button} bg-secondary text-on-secondary`} disabled={!!busy || !token.trim()} onClick={save}>{busy === 'save' ? 'Đang lưu…' : 'Lưu'}</button>
          <button type="button" className={outline} disabled={!!busy || !connected} onClick={test}>{busy === 'test' ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}</button>
          <button type="button" className={outline} disabled={!!busy || !connected} onClick={loadSkus}>{busy === 'skus' ? 'Đang tải…' : 'Ghép SKU'}</button>
          {connected && <button type="button" className={`${outline} ml-auto text-error`} disabled={!!busy} onClick={remove}>Gỡ token</button>}
        </div>
        {rows && (
          <SupplierSkuMapTable name="Printway" rows={rows} skus={skus} shipHint="Ship để trống là Printway tự chọn."
            onRows={setRows} onError={text => setBanner({ ok: false, text })} />
        )}
      </div>
    </div>
  )
}
