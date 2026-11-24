'use client'
import { useCallback, useEffect, useState } from 'react'
import { useCurrentUser } from '@/components/RoleGate'
import { SupplierSkuMapTable } from '@/components/SupplierSkuMap'

const API = '/api/fulfillment/toaddit'
const field = 'mt-xs w-full border rounded-lg px-sm py-xs text-body-sm'
const button = 'rounded-lg border border-outline-variant/40 px-md py-sm text-label-md disabled:opacity-40'
type View = { hasCredentials: boolean; hasAppKey: boolean; hasAppSecret: boolean; environment: 'production' | 'sandbox'; shippingMethod: '1' | '2'; payOnCreate: boolean }

export default function ToadditSetupCard() {
  const { user } = useCurrentUser()
  const [view, setView] = useState<View | null>(null)
  const [appKey, setAppKey] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [environment, setEnvironment] = useState<'production' | 'sandbox'>('production')
  const [shippingMethod, setShippingMethod] = useState('1')
  const [payOnCreate, setPayOnCreate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [catalog, setCatalog] = useState<any>(null)
  const superadmin = user?.role === 'SUPERADMIN'

  const adopt = useCallback((data: View) => {
    setView(data); setEnvironment(data.environment); setShippingMethod(data.shippingMethod); setPayOnCreate(data.payOnCreate)
  }, [])
  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/settings`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Không đọc được cài đặt Toaddit')
      adopt(data)
    } catch (e: any) { setError(e.message) }
  }, [adopt])
  useEffect(() => { load() }, [load])

  async function act(path: string, method: 'PUT' | 'POST' | 'GET', body?: unknown) {
    setBusy(true); setMessage(''); setError('')
    try {
      const res = await fetch(`${API}${path}`, { method, ...(method !== 'GET' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Không xử lý được yêu cầu Toaddit')
      if (path === '/settings') { adopt(data); setAppKey(''); setAppSecret(''); setCatalog(null); setMessage('Đã lưu cài đặt Toaddit.') }
      if (path === '/settings/test') setMessage(`Kết nối thành công: ${data.templates} SKU mẫu, ${data.activeTemplates} đang hoạt động. Không tạo đơn.`)
      if (path === '/catalog' && method === 'POST') { setSupplierId(data.supplierId); setCatalog(null); setMessage(`Đã nhập ${data.imported} SKU mẫu và giá; bỏ qua ${data.skipped} mẫu không dùng được hoặc thiếu giá.`) }
      if (path === '/catalog' && method === 'GET') { setCatalog(data); if (!data.templates.length) setMessage('Chưa có mẫu thiết kế trên Toaddit. Hoàn tất và lưu mẫu tại Toaddit trước, sau đó tải lại.') }
    } catch (e: any) { setError(e.message) }
    finally { setBusy(false) }
  }

  if (user && !['SUPERADMIN', 'ADMIN'].includes(user.role)) return null
  return <section className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-lg space-y-md">
    <div className="flex items-center justify-between gap-md">
      <h2 className="text-headline-sm">Toaddit — Fulfill qua API</h2>
      <span className="text-label-sm text-on-surface-variant">{view?.hasCredentials ? `Đã cấu hình · ${view.environment}` : 'Chưa cấu hình'}</span>
    </div>
    <p className="text-body-sm text-on-surface-variant">Xin App Key và App Secret từ Toaddit cho đúng môi trường. Tài khoản dùng chung cho các store trong tool. Toaddit nhận đơn theo mẫu đã lưu bên Toaddit; tên cá nhân hoá và thiết kế phải hoàn tất trong mẫu trước khi gửi.</p>
    {error && <p role="alert" className="text-error text-body-sm">{error}</p>}
    {message && <p role="status" className="text-secondary text-body-sm">{message}</p>}
    <div className="grid md:grid-cols-2 gap-md">
      <label className="text-label-sm">App Key Toaddit
        <input type="password" autoComplete="new-password" disabled={!superadmin || busy} value={appKey} onChange={e => setAppKey(e.target.value)} placeholder={view?.hasAppKey ? 'Để trống để giữ App Key' : 'Dán App Key'} className={field} />
      </label>
      <label className="text-label-sm">App Secret Toaddit
        <input type="password" autoComplete="new-password" disabled={!superadmin || busy} value={appSecret} onChange={e => setAppSecret(e.target.value)} placeholder={view?.hasAppSecret ? 'Để trống để giữ App Secret' : 'Dán App Secret'} className={field} />
      </label>
      <label className="text-label-sm">Môi trường Toaddit
        <select value={environment} disabled={!superadmin || busy} onChange={e => setEnvironment(e.target.value as 'production' | 'sandbox')} className={field}>
          <option value="production">Production — đơn sản xuất thật</option><option value="sandbox">Sandbox — chỉ kiểm tra kết nối</option>
        </select>
      </label>
      <label className="text-label-sm">Ship mặc định
        <select value={shippingMethod} disabled={!superadmin || busy} onChange={e => setShippingMethod(e.target.value)} className={field}>
          <option value="1">1 — Standard</option><option value="2">2 — Express</option>
        </select>
      </label>
    </div>
    <label className="flex items-start gap-sm text-body-sm"><input type="checkbox" checked={payOnCreate} disabled={!superadmin || busy} onChange={e => setPayOnCreate(e.target.checked)} />Trừ tiền số dư Toaddit ngay khi xác nhận gửi. Bỏ chọn để tạo đơn chưa thanh toán và trả tiền trên Toaddit.</label>
    <div className="flex flex-wrap gap-sm">
      {superadmin && <button className={button} disabled={busy || !view} onClick={() => act('/settings', 'PUT', { appKey, appSecret, environment, shippingMethod, payOnCreate })}>Lưu cài đặt Toaddit</button>}
      <button className={button} disabled={busy || !view?.hasCredentials} onClick={() => act('/settings/test', 'POST')}>Kiểm tra kết nối Toaddit</button>
      <button className={`${button} bg-secondary text-on-secondary`} disabled={busy || !view?.hasCredentials || view.environment === 'sandbox'} onClick={() => act('/catalog', 'POST')}>Đồng bộ mẫu/SKU và giá</button>
      <button className={button} disabled={busy || !view?.hasCredentials || view.environment === 'sandbox'} onClick={() => act('/catalog', 'GET')}>Ghép SKU Toaddit</button>
      {superadmin && view?.hasCredentials && <button className={`${button} text-error`} disabled={busy} onClick={() => {
        if (window.confirm('Gỡ App Key/App Secret Toaddit? Các lần gửi đang mở cần đúng bộ khoá để đối chiếu.')) act('/settings', 'PUT', { appKey: null, appSecret: null })
      }}>Gỡ khoá Toaddit</button>}
      {supplierId && <a className={button} href={`/fulfillment/suppliers/${supplierId}`}>Xem SKU Toaddit</a>}
      <a className={button} href="https://www.toaddit.com" target="_blank" rel="noreferrer">Mở Toaddit</a>
    </div>
    {catalog && view?.environment === 'production' && <SupplierSkuMapTable name="Toaddit (ID mẫu)" rows={catalog.products} skus={catalog.supplierSkus}
      shipHint="1 = Standard, 2 = Express; để trống dùng mặc định ở trên."
      shipOptions={[{ value: '', label: 'Mặc định' }, { value: '1', label: 'Standard' }, { value: '2', label: 'Express' }]}
      onRows={products => setCatalog((old: any) => ({ ...old, products }))} onError={setError} />}
    <p className="text-label-sm text-on-surface-variant">Sau khi ghép sản phẩm bán với SKU xưởng ở Product Mapping, gửi tại Duyệt sản xuất. Có thể chọn mẫu riêng từng dòng trong bản xem trước mà không đổi ghép SKU chung. Phí ship chưa được nhập tự động; cấu hình bảng ship ở trang xưởng. Đơn wholesale cần xử lý trên Toaddit.</p>
  </section>
}
