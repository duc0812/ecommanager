'use client'
import { useCallback, useEffect, useState } from 'react'
import { useCurrentUser } from '@/components/RoleGate'

type Channel = { supplierCode: string; enabled: boolean; spreadsheetId: string; tabPattern: string; storeShop: string; url: string }
type Status = { configured: boolean; connected: boolean; email: string; needsReconnect: boolean; csvLocked: boolean; channels: Channel[] }

const REASON_TEXT: Record<string, string> = {
  access_denied: 'bạn đã từ chối trên màn hình Google',
  no_sheets_scope: 'chưa tick quyền Google Sheets trên màn hình Google',
  no_refresh_token: 'Google không trả về khoá lâu dài, hãy thử kết nối lại',
  not_configured: 'chưa có Client ID và Client Secret ở phần Google Drive bên trên',
  token_exchange: 'không đổi được mã xác thực với Google',
}

async function send(method: 'PUT' | 'DELETE', body?: unknown): Promise<{ ok: boolean; error: string }> {
  try {
    const res = await fetch('/api/setup/google-sheets', {
      method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, error: data.error ?? `Lỗi HTTP ${res.status}` }
  } catch {
    return { ok: false, error: 'Mất kết nối tới máy chủ' }
  }
}

/** The Google account the tool writes supplier sheets with, and which suppliers take orders that way. */
export default function GoogleSheetsSetupCard() {
  const { user, loading } = useCurrentUser()
  const isSuper = user?.role === 'SUPERADMIN'
  const [status, setStatus] = useState<Status | null>(null)
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    const res = await fetch('/api/setup/google-sheets').catch(() => null)
    if (res?.ok) setStatus(await res.json())
    else setBanner({ ok: false, text: 'Không đọc được trạng thái Google Sheets' })
  }, [])

  useEffect(() => {
    if (!isSuper) return
    void load()
    const params = new URLSearchParams(window.location.search)
    const result = params.get('sheets')
    if (result === 'connected') setBanner({ ok: true, text: 'Đã kết nối Google Sheets.' })
    else if (result === 'error') {
      const reason = params.get('reason') || 'unknown'
      setBanner({ ok: false, text: `Kết nối Google Sheets thất bại: ${REASON_TEXT[reason] ?? reason}.` })
    }
  }, [isSuper, load])

  async function toggle(c: Channel) {
    if (!c.enabled && !window.confirm(`Bật ghi sheet cho ${c.supplierCode}? Từ lúc này xưởng này không xuất CSV được nữa, đơn gửi ở Duyệt sản xuất.`)) return
    setBusy(c.supplierCode)
    setBanner(null)
    const r = await send('PUT', { supplierCode: c.supplierCode, enabled: !c.enabled })
    setBusy('')
    setBanner(r.ok ? { ok: true, text: `${c.supplierCode}: đã ${c.enabled ? 'tắt' : 'bật'} kênh ghi sheet.` } : { ok: false, text: r.error })
    void load()
  }

  async function toggleCsv(locked: boolean) {
    if (!locked && !window.confirm('Mở khoá xuất CSV? Nhân sự sẽ tải được CSV cho các xưởng chưa có API hoặc sheet. Merchize và xưởng đang bật sheet vẫn không xuất được.')) return
    setBusy('csv')
    setBanner(null)
    const r = await send('PUT', { csvLocked: !locked })
    setBusy('')
    setBanner(r.ok ? { ok: true, text: locked ? 'Đã khoá xuất CSV.' : 'Đã mở khoá xuất CSV.' } : { ok: false, text: r.error })
    void load()
  }

  async function disconnect() {
    if (!window.confirm('Ngắt kết nối Google Sheets? Kết nối Google Drive không bị ảnh hưởng.')) return
    setBusy('disconnect')
    setBanner(null)
    const r = await send('DELETE')
    setBusy('')
    setBanner(r.ok ? { ok: true, text: 'Đã ngắt kết nối Google Sheets.' } : { ok: false, text: r.error })
    void load()
  }

  if (loading || !isSuper) return null
  const healthy = !!status?.connected && !status.needsReconnect
  const button = 'inline-flex items-center gap-xs rounded-lg px-md py-xs text-body-sm font-semibold disabled:opacity-40'

  return (
    <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 mb-lg">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-on-surface-variant">table_view</span>
        <h2 className="text-title-md">Google Sheets (đẩy đơn sang xưởng)</h2>
        {healthy && <span className="ml-auto bg-on-tertiary-container/15 text-on-tertiary-container px-sm py-xs rounded-full text-label-sm">✓ Đã kết nối</span>}
      </div>
      <div className="p-lg space-y-md">
        {banner && (
          <div role="status" className={`rounded-lg px-md py-sm text-body-sm border ${banner.ok ? 'bg-secondary/5 border-secondary/30 text-secondary' : 'bg-error-container/40 border-error/30 text-on-error-container'}`}>
            {banner.text}
          </div>
        )}
        <div className="space-y-sm">
          <div className="text-body-sm text-on-surface">
            {!status ? 'Đang kiểm tra...' : status.needsReconnect ? <span className="text-error font-semibold">Cần kết nối lại: quyền đã hết hạn hoặc bị thu hồi.</span>
              : status.connected ? <>Tài khoản: <b className="break-all">{status.email || 'không rõ email'}</b></>
                : 'Chưa kết nối. Đăng nhập bằng tài khoản Google có quyền edit sheet của xưởng.'}
          </div>
          <p className="text-label-sm text-on-surface-variant">Kết nối riêng với Google Drive. Quyền này áp dụng cho mọi sheet của tài khoản đó, vì vậy hãy dùng tài khoản vận hành.</p>
          <div className="flex flex-wrap items-center gap-sm">
            {status?.configured === false
              ? <span className="text-body-sm text-on-surface-variant">Cần có Client ID và Client Secret ở phần Google Drive trước.</span>
              : <a href="/api/auth/google?target=sheets" className={`${button} bg-secondary text-on-secondary`}>{status?.connected ? 'Kết nối lại' : 'Kết nối Google Sheets'}</a>}
            {status?.connected && (
              <button type="button" onClick={disconnect} disabled={!!busy} className={`${button} border border-outline-variant/40 text-on-surface`}>Ngắt kết nối</button>
            )}
          </div>
        </div>
        {status && (
          <div className="flex flex-wrap items-center gap-sm text-body-sm border-t border-outline-variant/20 pt-md">
            <b className="text-on-surface">Xuất CSV</b>
            <span className="text-label-sm text-on-surface-variant">Áp dụng cho mọi xưởng, cả trang CSV Export và nút Lưu chờ CSV</span>
            <span className={`px-sm py-xs rounded-full text-label-sm ${status.csvLocked ? 'bg-error-container/40 text-on-error-container' : 'bg-surface-container text-on-surface-variant'}`}>{status.csvLocked ? 'Đang khoá' : 'Đang mở'}</span>
            <button type="button" onClick={() => toggleCsv(!status.csvLocked)} disabled={!!busy} className={`${button} ml-auto border border-outline-variant/40 text-on-surface`}>
              {status.csvLocked ? 'Mở khoá' : 'Khoá'}
            </button>
          </div>
        )}
        {status && status.channels.length > 0 && (
          <div className="space-y-sm border-t border-outline-variant/20 pt-md">
            <h3 className="text-label-sm text-on-surface-variant">Xưởng ghi đơn vào sheet</h3>
            {status.channels.map(c => (
              <div key={c.supplierCode} className="flex flex-wrap items-center gap-sm text-body-sm">
                <b className="text-on-surface">{c.supplierCode}</b>
                <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-secondary hover:underline">Mở sheet ↗</a>
                <span className="text-label-sm text-on-surface-variant">tab {c.tabPattern} · store {c.storeShop}</span>
                <span className={`px-sm py-xs rounded-full text-label-sm ${c.enabled ? 'bg-on-tertiary-container/15 text-on-tertiary-container' : 'bg-surface-container text-on-surface-variant'}`}>{c.enabled ? 'Đang bật' : 'Đang tắt'}</span>
                <button type="button" onClick={() => toggle(c)} disabled={!!busy || (!c.enabled && !healthy)} title={!c.enabled && !healthy ? 'Kết nối Google Sheets trước' : undefined}
                  className={`${button} ml-auto border border-outline-variant/40 text-on-surface`}>
                  {busy === c.supplierCode ? 'Đang kiểm tra...' : c.enabled ? 'Tắt' : 'Bật'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
