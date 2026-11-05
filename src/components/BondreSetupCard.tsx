'use client'
import { useCallback, useEffect, useState } from 'react'
import { useCurrentUser } from '@/components/RoleGate'

type View = { email: string | null; hasPassword: boolean; tokenExpiresAt: string | null }
type BondreSku = { skuName: string; skuCode: string | null; productName: string | null }
type Row = { id: string; sku: string; productName: string | null; variant1Value: string | null; apiSku: string | null; apiShipClass: string | null; suggestion: string | null }
type Banner = { ok: boolean; text: string }

const SHIP_OPTIONS = ['Fast', 'Express', 'USPS']
const button = 'inline-flex items-center gap-xs rounded-lg px-md py-xs text-body-sm font-semibold disabled:opacity-40'
const outline = `${button} border border-outline-variant/40 text-on-surface`

async function send(url: string, method: 'POST' | 'PUT' | 'PATCH', body?: unknown): Promise<{ ok: boolean; error: string; data: any }> {
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
  const [rows, setRows] = useState<Row[] | null>(null)
  const [skus, setSkus] = useState<BondreSku[]>([])

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
    setSkus(data.bondreSkus)
    setRows(data.products)
  }

  async function patchRow(row: Row, patch: { apiSku?: string; apiShipClass?: string }) {
    if (patch.apiSku && !skus.some(s => s.skuName === patch.apiSku)) {
      setBanner({ ok: false, text: `Bondre không có SKU "${patch.apiSku}". Tên phải đúng từng ký tự, kể cả hoa thường.` })
      return
    }
    setBusy(row.id)
    setBanner(null)
    const r = await send(`/api/suppliers/products/${encodeURIComponent(row.id)}`, 'PATCH', patch)
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    setRows(prev => prev?.map(x => x.id === row.id ? { ...x, apiSku: r.data.apiSku ?? null, apiShipClass: r.data.apiShipClass ?? null } : x) ?? null)
  }

  if (loading || !isSuper) return null
  const connected = !!view?.email && !!view.hasPassword
  const matched = rows?.filter(r => r.apiSku).length ?? 0

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
        </div>

        {rows && (
          <div className="border-t border-outline-variant/20 pt-md space-y-sm">
            <p className="text-body-sm text-on-surface">Đã ghép <b>{matched}/{rows.length}</b> SKU. SKU chưa ghép thì đơn không gửi được. Ship để trống là Standard.</p>
            <datalist id="bondre-skus">{skus.map(s => <option key={s.skuName} value={s.skuName}>{s.productName ?? ''}</option>)}</datalist>
            <div className="overflow-x-auto">
              <table className="w-full text-body-sm">
                <thead>
                  <tr className="text-left text-label-sm text-on-surface-variant">
                    <th className="px-sm py-xs font-semibold">SKU trong tool</th>
                    <th className="px-sm py-xs font-semibold">Sản phẩm</th>
                    <th className="px-sm py-xs font-semibold">SKU của Bondre</th>
                    <th className="px-sm py-xs font-semibold">Ship</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className="border-t border-outline-variant/20 align-top">
                      <td className="px-sm py-xs font-mono text-xs">{r.sku}</td>
                      <td className="px-sm py-xs">{r.productName ?? '—'}{r.variant1Value ? ` · ${r.variant1Value}` : ''}</td>
                      <td className="px-sm py-xs">
                        <input key={`${r.id}:${r.apiSku ?? ''}`} list="bondre-skus" defaultValue={r.apiSku ?? ''} placeholder="chưa ghép" aria-label={`SKU Bondre của ${r.sku}`}
                          onBlur={e => { if (e.target.value.trim() !== (r.apiSku ?? '')) void patchRow(r, { apiSku: e.target.value.trim() }) }}
                          className={`w-full min-w-[240px] border rounded px-xs py-[3px] font-mono text-xs ${r.apiSku ? '' : 'border-error/60'}`} />
                        {!r.apiSku && r.suggestion && (
                          <button type="button" className="mt-xs block text-label-sm text-secondary font-semibold text-left" disabled={!!busy} onClick={() => patchRow(r, { apiSku: r.suggestion! })}>
                            Dùng gợi ý: {r.suggestion}
                          </button>
                        )}
                      </td>
                      <td className="px-sm py-xs">
                        <select value={r.apiShipClass ?? ''} aria-label={`Ship của ${r.sku}`} disabled={!!busy} onChange={e => patchRow(r, { apiShipClass: e.target.value })} className="border rounded px-xs py-[3px] text-xs">
                          <option value="">Standard</option>
                          {SHIP_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
