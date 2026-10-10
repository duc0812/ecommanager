'use client'
import { useCallback, useEffect, useState, type FormEvent } from 'react'

type SettingsView = {
  hasStoreId: boolean
  storeIdMasked: string | null
  hasSecretKey: boolean
  secretKeyMasked: string | null
  defaultShipClass: string | null
  pushEnabled: boolean
  webhookUrl: string | null
  webhookPath: string
  publicUrlError: string | null
}

type Balance = { availableAmount: number; pendingAmount: number; paidAmount: number; upcomingAmount: number }

const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
const field = 'w-full border border-outline-variant/40 rounded-lg px-sm py-xs text-body-sm bg-surface-container-lowest'
const label = 'text-label-sm text-on-surface-variant block mb-xs'

export default function PgprintsSettingsCard() {
  const [view, setView] = useState<SettingsView | null>(null)
  const [storeId, setStoreId] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [shipClass, setShipClass] = useState('')
  const [pushEnabled, setPushEnabled] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [balance, setBalance] = useState<Balance | null>(null)
  const [copied, setCopied] = useState(false)

  const apply = useCallback((v: SettingsView) => {
    setView(v)
    setShipClass(v.defaultShipClass ?? '')
    setPushEnabled(v.pushEnabled)
    setStoreId('')
    setSecretKey('')
  }, [])

  useEffect(() => {
    fetch('/api/fulfillment/pgprints/settings')
      .then(async r => (r.ok ? apply(await r.json()) : setMessage({ tone: 'bad', text: 'Không tải được cài đặt PGprints' })))
      .catch(() => setMessage({ tone: 'bad', text: 'Không tải được cài đặt PGprints' }))
  }, [apply])

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true); setMessage(null)
    const body: Record<string, unknown> = { defaultShipClass: shipClass, pushEnabled }
    if (storeId.trim()) body.storeId = storeId.trim()
    if (secretKey.trim()) body.secretKey = secretKey.trim()
    const r = await fetch('/api/fulfillment/pgprints/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await r.json().catch(() => null)
    setSaving(false)
    if (!r.ok) {
      setMessage({ tone: 'bad', text: r.status === 403 ? 'Chỉ Super Admin được sửa cài đặt PGprints' : (data?.error ?? 'Không lưu được') })
      return
    }
    apply(data)
    setMessage({ tone: 'ok', text: 'Đã lưu cài đặt PGprints' })
  }

  async function testConnection() {
    setTesting(true); setMessage(null); setBalance(null)
    const r = await fetch('/api/fulfillment/pgprints/settings/test', { method: 'POST' })
    const data = await r.json().catch(() => null)
    setTesting(false)
    if (!r.ok) { setMessage({ tone: 'bad', text: data?.error ?? 'Kết nối thất bại' }); return }
    setBalance(data.balance)
    setMessage({ tone: 'ok', text: 'Kết nối PGprints thành công' })
  }

  async function copyWebhook() {
    if (!view?.webhookUrl) return
    try {
      await navigator.clipboard.writeText(view.webhookUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setMessage({ tone: 'bad', text: 'Không chép được — hãy bôi đen và chép tay' })
    }
  }

  return (
    <section className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 mb-lg">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-secondary">api</span>
        <div className="flex-1">
          <div className="text-title-md font-semibold">Kết nối API PGprints</div>
          <div className="text-label-sm text-on-surface-variant mt-xs">Gửi đơn thủ công từng đơn — không có gì tự đẩy sang xưởng.</div>
        </div>
        <span className={`rounded-md px-xs text-label-sm font-semibold ${view?.pushEnabled ? 'bg-tertiary/15 text-tertiary' : 'bg-surface-container text-on-surface-variant'}`}>
          {view?.pushEnabled ? 'Đang bật gửi đơn' : 'Đang tắt gửi đơn'}
        </span>
      </div>

      <form onSubmit={save} className="px-lg py-md flex flex-col gap-md">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-md">
          <div>
            <label className={label} htmlFor="pg-store-id">Store ID</label>
            <input id="pg-store-id" className={`${field} font-mono`} autoComplete="off" value={storeId} onChange={e => setStoreId(e.target.value)}
              placeholder={view?.hasStoreId ? `${view.storeIdMasked} — để trống là giữ nguyên` : 'Lấy ở PGprints → Manage Keys'} />
          </div>
          <div>
            <label className={label} htmlFor="pg-secret-key">Secret key</label>
            <input id="pg-secret-key" type="password" className={`${field} font-mono`} autoComplete="new-password" value={secretKey} onChange={e => setSecretKey(e.target.value)}
              placeholder={view?.hasSecretKey ? 'Đã lưu — để trống là giữ nguyên' : 'Chưa có secret key'} />
            <span className="text-[11px] text-on-surface-variant">Secret key không bao giờ hiển thị lại sau khi lưu.</span>
          </div>
          <div>
            <label className={label} htmlFor="pg-ship-class">Ship class mặc định</label>
            <input id="pg-ship-class" className={field} value={shipClass} onChange={e => setShipClass(e.target.value)} placeholder="vd: US Economy" />
            <span className="text-[11px] text-on-surface-variant">Dùng khi SKU chưa có ship class riêng.</span>
          </div>
        </div>

        <label className="flex items-start gap-sm text-body-sm cursor-pointer">
          <input type="checkbox" className="mt-[3px]" checked={pushEnabled} onChange={e => setPushEnabled(e.target.checked)} />
          <span>
            <b>Cho phép gửi đơn sang PGprints</b>
            <span className="block text-label-sm text-on-surface-variant">Khi tắt, nút &quot;Gửi PGprints&quot; chỉ xem trước được. PGprints không có môi trường thử — mỗi đơn gửi đi là đơn thật, bị tính tiền.</span>
          </span>
        </label>

        <div className="flex items-center gap-sm flex-wrap">
          <button type="submit" disabled={saving} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">
            {saving ? 'Đang lưu…' : 'Lưu cài đặt'}
          </button>
          <button type="button" onClick={testConnection} disabled={testing || !view?.hasStoreId || !view?.hasSecretKey}
            title={!view?.hasStoreId || !view?.hasSecretKey ? 'Lưu Store ID và Secret key trước' : undefined}
            className="inline-flex items-center gap-xs border border-secondary text-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">
            <span className="material-symbols-outlined text-[18px]">wifi_tethering</span>{testing ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}
          </button>
          {message && (
            <span role="status" className={`text-label-sm ${message.tone === 'ok' ? 'text-tertiary' : 'text-error'}`}>{message.text}</span>
          )}
        </div>

        {balance && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-md">
            {[
              { label: 'Số dư khả dụng', value: balance.availableAmount },
              { label: 'Đang giữ', value: balance.pendingAmount },
              { label: 'Sắp trừ', value: balance.upcomingAmount },
              { label: 'Đã trả', value: balance.paidAmount },
            ].map(b => (
              <div key={b.label} className="rounded-lg border border-outline-variant/20 p-sm">
                <div className="text-label-sm text-on-surface-variant">{b.label}</div>
                <div className="text-body-md font-semibold">{usd(b.value)}</div>
              </div>
            ))}
          </div>
        )}

        <div className="rounded-lg bg-surface-container-low border border-outline-variant/20 p-sm flex flex-col gap-xs">
          <div className="text-label-sm font-semibold text-on-surface">Webhook nhận tracking</div>
          {view?.webhookUrl ? (
            <div className="flex items-center gap-sm flex-wrap">
              <code className="flex-1 min-w-[240px] font-mono text-xs break-all">{view.webhookUrl}</code>
              <button type="button" onClick={copyWebhook} className="inline-flex items-center gap-xs border border-outline-variant/40 rounded-lg px-md py-xs text-label-sm">
                <span className="material-symbols-outlined text-[16px]">content_copy</span>{copied ? 'Đã chép' : 'Chép URL'}
              </button>
            </div>
          ) : (
            <div className="text-label-sm text-error">
              {view?.publicUrlError ?? 'Chưa xác định được địa chỉ public của app.'} Đường dẫn webhook: <code className="font-mono">{view?.webhookPath}</code>
            </div>
          )}
          <div className="text-[11px] text-on-surface-variant">
            Dán URL này vào ô Tracking Sync Url bên PGprints. PGprints gửi kèm header <code className="font-mono">X-Store-Secret</code> bằng đúng Secret key ở trên.
          </div>
        </div>
      </form>
    </section>
  )
}
