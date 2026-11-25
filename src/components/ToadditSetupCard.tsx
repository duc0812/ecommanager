'use client'
import { useCallback, useEffect, useState } from 'react'
import { useCurrentUser } from '@/components/RoleGate'
import { SupplierSkuMapTable } from '@/components/SupplierSkuMap'

const API = '/api/fulfillment/toaddit'
const field = 'mt-xs w-full border rounded-lg px-sm py-xs text-body-sm'
const button = 'rounded-lg border border-outline-variant/40 px-md py-sm text-label-md disabled:opacity-40'
type View = { protocol: 'ros-v1'; hasCredentials: boolean; hasApiKey: boolean; shippingMethod: '1' | '2' | '3' }
export default function ToadditSetupCard() {
  const { user } = useCurrentUser()
  const [view, setView] = useState<View | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [shippingMethod, setShippingMethod] = useState('1')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [catalog, setCatalog] = useState<any>(null)
  const superadmin = user?.role === 'SUPERADMIN'
  const adopt = useCallback((data: View) => { setView(data); setShippingMethod(data.shippingMethod) }, [])
  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/settings`), data = await res.json()
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
      if (!res.ok) throw new Error(data.error || 'Không xử lý được yêu cầu Toaddit ROS')
      if (path === '/settings') { adopt(data); setApiKey(''); setCatalog(null); setMessage('Đã lưu cài đặt Toaddit ROS.') }
      if (path === '/settings/test') setMessage(`Kết nối thành công: ${data.activeVariants}/${data.variants} sản phẩm/size đang bán. Không tạo đơn.`)
      if (path === '/catalog' && method === 'POST') { setSupplierId(data.supplierId); setCatalog(null); setMessage(`Đã nhập ${data.imported} sản phẩm/size và giá; bỏ qua ${data.skipped} mục ngừng bán hoặc thiếu giá.`) }
      if (path === '/catalog' && method === 'GET') { setCatalog(data); if (!data.variants.length) setMessage('Catalog ROS của tài khoản chưa có sản phẩm. Kiểm tra với Toaddit.') }
    } catch (e: any) { setError(e.message) }
    finally { setBusy(false) }
  }
  if (user && !['SUPERADMIN', 'ADMIN'].includes(user.role)) return null
  return <section className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-lg space-y-md">
    <div className="flex items-center justify-between gap-md">
      <h2 className="text-headline-sm">Toaddit ROS — Fulfill qua API</h2>
      <span className="text-label-sm text-on-surface-variant">{view?.hasCredentials ? 'Đã cấu hình' : 'Chưa cấu hình'}</span>
    </div>
    <p className="text-body-sm text-on-surface-variant">Dùng API key của tài khoản ROS, dùng chung cho các store trong tool. Chọn mã sản phẩm và size của xưởng; file in và mockup đã duyệt được gửi kèm từng đơn.</p>
    {error && <p role="alert" className="text-error text-body-sm">{error}</p>}
    {message && <p role="status" className="text-secondary text-body-sm">{message}</p>}
    <div className="grid md:grid-cols-2 gap-md">
      <label className="text-label-sm">API key Toaddit ROS
        <input type="password" autoComplete="new-password" disabled={!superadmin || busy} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={view?.hasApiKey ? 'Để trống để giữ API key' : 'Dán API key của tài khoản ROS'} className={field} />
      </label>
      <label className="text-label-sm">Ship mặc định
        <select value={shippingMethod} disabled={!superadmin || busy} onChange={e => setShippingMethod(e.target.value)} className={field}>
          <option value="1">1 — Standard</option><option value="2">2 — Expedited Standard</option><option value="3">3 — Business Express</option>
        </select>
      </label>
    </div>
    <div className="flex flex-wrap gap-sm">
      {superadmin && <button className={button} disabled={busy || !view} onClick={() => act('/settings', 'PUT', { apiKey, shippingMethod })}>Lưu cài đặt Toaddit</button>}
      <button className={button} disabled={busy || !view?.hasCredentials} onClick={() => act('/settings/test', 'POST')}>Kiểm tra kết nối</button>
      <button className={`${button} bg-secondary text-on-secondary`} disabled={busy || !view?.hasCredentials} onClick={() => act('/catalog', 'POST')}>Đồng bộ sản phẩm, size và giá</button>
      <button className={button} disabled={busy || !view?.hasCredentials} onClick={() => act('/catalog', 'GET')}>Ghép sản phẩm và size</button>
      {superadmin && view?.hasCredentials && <button className={`${button} text-error`} disabled={busy} onClick={() => {
        if (window.confirm('Gỡ API key ROS? Cần giữ đúng key để đối chiếu các đơn đã gửi.')) act('/settings', 'PUT', { apiKey: null })
      }}>Gỡ API key</button>}
      {supplierId && <a className={button} href={`/fulfillment/suppliers/${supplierId}`}>Xem SKU Toaddit</a>}
      <a className={button} href="https://ros.toaddit.com" target="_blank" rel="noreferrer">Mở tài khoản ROS</a>
    </div>
    {catalog && <SupplierSkuMapTable name="Toaddit ROS" selectOnly rows={catalog.products} skus={catalog.supplierSkus}
      shipHint="1 = Standard, 2 = Expedited Standard, 3 = Business Express; để trống dùng mặc định."
      shipOptions={[{ value: '', label: 'Mặc định' }, { value: '1', label: 'Standard' }, { value: '2', label: 'Expedited Standard' }, { value: '3', label: 'Business Express' }]}
      onRows={products => setCatalog((old: any) => ({ ...old, products }))} onError={setError} />}
    <p className="text-label-sm text-on-surface-variant">Gửi đơn tại Duyệt sản xuất sau khi kiểm tra sản phẩm, size, địa chỉ, file in và mockup. Phí ship cấu hình ở trang xưởng; kiểm tra chi phí cuối cùng trong tài khoản ROS.</p>
  </section>
}
