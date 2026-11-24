'use client'
import { useCallback, useEffect, useState } from 'react'
import { useCurrentUser } from '@/components/RoleGate'

const API = '/api/fulfillment/printposs'
const field = 'mt-xs w-full border rounded-lg px-sm py-xs text-body-sm'
const button = 'rounded-lg border border-outline-variant/40 px-md py-sm text-label-md disabled:opacity-40'
type Store = { id: number; name: string }

export default function PrintpossSetupCard() {
  const { user } = useCurrentUser()
  const [view, setView] = useState<{ hasToken: boolean; storeId: string | null } | null>(null)
  const [token, setToken] = useState('')
  const [storeId, setStoreId] = useState('')
  const [stores, setStores] = useState<Store[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const superadmin = user?.role === 'SUPERADMIN'

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/settings`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Không đọc được cài đặt Printposs')
      setView(data); setStoreId(data.storeId ?? '')
    } catch (e: any) { setError(e.message) }
  }, [])
  useEffect(() => { load() }, [load])

  async function act(path: string, method: 'PUT' | 'POST', body?: unknown) {
    setBusy(true); setMessage(''); setError('')
    try {
      const res = await fetch(`${API}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Không xử lý được yêu cầu Printposs')
      if (path === '/settings') { setView(data); setToken(''); setMessage('Đã lưu cài đặt Printposs.'); setStoreId(data.storeId ?? '') }
      if (path === '/settings/test') { setStores(data.stores); setMessage(`Kết nối thành công: ${data.stores.length} store, ${data.activeVariants} biến thể đang bán.`) }
      if (path === '/catalog') { setSupplierId(data.supplierId); setMessage(`Đã đồng bộ ${data.imported} SKU và giá gốc; bỏ qua ${data.inactive} biến thể ngừng bán.`) }
    } catch (e: any) { setError(e.message) }
    finally { setBusy(false) }
  }

  if (user && !['SUPERADMIN', 'ADMIN'].includes(user.role)) return null
  return (
    <section className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-lg space-y-md">
      <div className="flex items-center justify-between gap-md">
        <h2 className="text-headline-sm">Printposs — Fulfill qua API</h2>
        <span className="text-label-sm text-on-surface-variant">{view?.hasToken ? 'Đã lưu token' : 'Chưa cấu hình'}</span>
      </div>
      <p className="text-body-sm text-on-surface-variant">
        Lấy token tại Printposs › Account settings › API Token › Add Key. Tài khoản này dùng chung cho các store trong tool.
        Đồng bộ catalog để thêm xưởng Printposs, SKU, Product Variant ID và giá gốc; sau đó ghép sản phẩm bán với SKU xưởng ở Product Mapping.
      </p>
      {error && <p role="alert" className="text-error text-body-sm">{error}</p>}
      {message && <p role="status" className="text-secondary text-body-sm">{message}</p>}
      <div className="grid md:grid-cols-2 gap-md">
        <label className="text-label-sm">API Token
          <input type="password" autoComplete="new-password" disabled={!superadmin || busy} value={token} onChange={e => setToken(e.target.value)}
            placeholder={view?.hasToken ? 'Để trống để giữ token hiện tại' : 'Dán token Printposs'} className={field} />
        </label>
        <label className="text-label-sm">Store ID bên Printposs (tuỳ chọn)
          <input inputMode="numeric" disabled={!superadmin || busy} value={storeId} onChange={e => setStoreId(e.target.value)} placeholder="Để trống nếu không gắn store" className={field} />
        </label>
      </div>
      {stores.length > 0 && <p className="text-body-sm">Store Printposs: {stores.map(s => `${s.name} (ID ${s.id})`).join(' · ')}</p>}
      <div className="flex flex-wrap gap-sm">
        {superadmin && <button className={button} disabled={busy || !view} onClick={() => act('/settings', 'PUT', { token, storeId })}>Lưu cài đặt</button>}
        <button className={button} disabled={busy || !view?.hasToken} onClick={() => act('/settings/test', 'POST')}>Kiểm tra kết nối</button>
        <button className={`${button} bg-secondary text-on-secondary`} disabled={busy || !view?.hasToken} onClick={() => act('/catalog', 'POST')}>Đồng bộ catalog và giá</button>
        {superadmin && view?.hasToken && <button className={`${button} text-error`} disabled={busy} onClick={() => {
          if (window.confirm('Gỡ token Printposs khỏi tool?')) act('/settings', 'PUT', { token: null })
        }}>Gỡ token</button>}
        {supplierId && <a className={button} href={`/fulfillment/suppliers/${supplierId}`}>Xem SKU Printposs</a>}
        <a className={button} href="/fulfillment/mapping">Product Mapping</a>
      </div>
      <p className="text-label-sm text-on-surface-variant">
        Dòng đã duyệt gửi ở Duyệt sản xuất qua bản xem trước. Mỗi item cần một file in hoàn chỉnh và ảnh mockup.
        Trạng thái, thanh toán và tracking được đọc lại từ Printposs. Phí vận chuyển chưa có trong catalog; cấu hình ở trang xưởng.
        Huỷ đơn thực hiện với Printposs vì API hiện chưa có endpoint huỷ.
      </p>
    </section>
  )
}
