'use client'
import { useEffect, useState } from 'react'

type DriveStatus = {
  configured: boolean
  connected: boolean
  email: string | null
  rootFolderId: string | null
  rootFolderUrl: string | null
  needsReconnect: boolean
  clientIdMasked: string
  hasClientSecret: boolean
  redirectUri: string
}

const REASON_TEXT: Record<string, string> = {
  not_configured: 'chưa lưu Client ID / Client Secret',
  access_denied: 'bạn đã từ chối cấp quyền',
  missing_code: 'Google không trả về mã xác thực',
  no_refresh_token: 'Google không trả về refresh token — hãy gỡ quyền app trong tài khoản Google rồi kết nối lại',
  root_folder: 'đã kết nối nhưng không tạo được thư mục "Design Studio"',
  invalid_client: 'Client ID / Client Secret sai',
  invalid_grant: 'mã xác thực hết hạn, thử lại',
  redirect_uri_mismatch: 'Redirect URI chưa khai báo trong OAuth client',
}

const inputClass = 'w-full bg-surface-container border border-outline-variant/30 rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-secondary focus:border-secondary outline-none transition-all'

export default function GoogleDriveSetupCard() {
  const [status, setStatus] = useState<DriveStatus | null>(null)
  const [loadError, setLoadError] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  async function load() {
    try {
      const res = await fetch('/api/setup/google-drive')
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setStatus(d)
      setLoadError('')
    } catch (e: any) {
      setLoadError(e.message || 'Không tải được trạng thái Google Drive.')
    }
  }

  useEffect(() => {
    load()
    const params = new URLSearchParams(window.location.search)
    const google = params.get('google')
    if (google === 'connected') setResult({ ok: true, text: 'Đã kết nối Google Drive.' })
    else if (google === 'error') {
      const reason = params.get('reason') || 'unknown'
      setResult({ ok: false, text: `Kết nối Google Drive thất bại: ${REASON_TEXT[reason] ?? reason}.` })
    }
  }, [])

  async function save() {
    const payload: Record<string, string> = {}
    if (clientId.trim()) payload.clientId = clientId.trim()
    if (clientSecret.trim()) payload.clientSecret = clientSecret.trim()
    if (!Object.keys(payload).length) { setMsg('Nhập Client ID hoặc Client Secret để lưu.'); return }
    setSaving(true); setMsg('')
    try {
      const res = await fetch('/api/setup/google-drive', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setClientId(''); setClientSecret('')
      setMsg('Đã lưu OAuth client.')
      await load()
    } catch (e: any) {
      setMsg(`Lỗi khi lưu: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  async function disconnect() {
    if (!confirm('Ngắt kết nối Google Drive? Artwork mới sẽ lưu trên server cho tới khi kết nối lại.')) return
    const res = await fetch('/api/setup/google-drive', { method: 'DELETE' }).catch(() => null)
    if (!res?.ok) { setMsg('Không ngắt kết nối được.'); return }
    setResult(null)
    await load()
  }

  const statusLine = !status
    ? (loadError || 'Đang kiểm tra...')
    : status.needsReconnect
      ? `Cần kết nối lại${status.email ? ` (${status.email})` : ''} — token Google đã bị thu hồi hoặc hết hạn.`
      : status.connected
        ? `Đã kết nối: ${status.email || 'tài khoản Google'}`
        : status.configured
          ? 'Đã lưu OAuth client, chưa kết nối tài khoản Google.'
          : 'Chưa cấu hình OAuth client.'

  const statusTone = status?.needsReconnect ? 'text-error' : status?.connected ? 'text-on-tertiary-container' : 'text-on-surface-variant'

  return (
    <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 mb-lg mt-lg">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-on-surface-variant">add_to_drive</span>
        <h2 className="text-title-md">Google Drive (lưu artwork)</h2>
        {status?.connected && !status.needsReconnect && (
          <span className="ml-auto bg-on-tertiary-container/15 text-on-tertiary-container px-sm py-xs rounded-full text-label-sm">✓ Connected</span>
        )}
      </div>

      <div className="p-lg space-y-md">
        {result && (
          <div role="status" className={`rounded-lg px-md py-sm text-body-sm border ${result.ok ? 'bg-secondary/5 border-secondary/30 text-secondary' : 'bg-error/5 border-error/30 text-error'}`}>
            {result.text}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-sm">
          <span className={`material-symbols-outlined text-[18px] ${statusTone}`}>
            {status?.needsReconnect ? 'error' : status?.connected ? 'cloud_done' : 'cloud_off'}
          </span>
          <span className={`text-body-sm ${statusTone}`}>{statusLine}</span>
          {status?.rootFolderUrl && (
            <a href={status.rootFolderUrl} target="_blank" rel="noopener noreferrer" className="text-secondary text-label-sm hover:underline flex items-center gap-xs">
              <span className="material-symbols-outlined text-[16px]">folder_open</span>
              Thư mục Design Studio
            </a>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
          <div className="space-y-xs">
            <label htmlFor="google-client-id" className="block text-label-sm text-on-surface-variant">Client ID</label>
            <input
              id="google-client-id"
              type="text"
              value={clientId}
              onChange={e => setClientId(e.target.value)}
              placeholder={status?.clientIdMasked ? `Đã lưu (${status.clientIdMasked}) — nhập để thay` : 'xxxx.apps.googleusercontent.com'}
              autoComplete="off"
              className={inputClass}
            />
          </div>
          <div className="space-y-xs">
            <label htmlFor="google-client-secret" className="block text-label-sm text-on-surface-variant">Client Secret</label>
            <input
              id="google-client-secret"
              type="password"
              value={clientSecret}
              onChange={e => setClientSecret(e.target.value)}
              placeholder={status?.hasClientSecret ? 'đã lưu' : 'GOCSPX-...'}
              autoComplete="new-password"
              className={inputClass}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-sm">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50"
          >
            {saving ? 'Đang lưu…' : 'Lưu OAuth client'}
          </button>
          {status?.configured ? (
            <a
              href="/api/auth/google"
              className="border border-secondary text-secondary px-lg py-sm rounded-lg text-label-md hover:bg-secondary/5 transition-colors flex items-center gap-xs"
            >
              <span className="material-symbols-outlined text-[18px]">link</span>
              {status.connected ? 'Kết nối lại Google Drive' : 'Kết nối Google Drive'}
            </a>
          ) : (
            <button
              type="button"
              disabled
              title="Lưu Client ID và Client Secret trước"
              className="border border-outline-variant text-on-surface-variant px-lg py-sm rounded-lg text-label-md opacity-50 flex items-center gap-xs"
            >
              <span className="material-symbols-outlined text-[18px]">link</span>
              Kết nối Google Drive
            </button>
          )}
          {status?.connected && (
            <button
              type="button"
              onClick={disconnect}
              className="border border-outline-variant text-error px-lg py-sm rounded-lg text-label-md hover:bg-error/5 transition-colors"
            >
              Ngắt kết nối
            </button>
          )}
          {msg && <span className="text-body-sm text-on-surface-variant">{msg}</span>}
        </div>

        <details className="bg-surface-container rounded-lg border border-outline-variant/20 px-md py-sm">
          <summary className="cursor-pointer text-label-md text-primary">Hướng dẫn tạo OAuth client</summary>
          <ol className="mt-sm text-body-sm text-on-surface-variant space-y-xs ml-md list-decimal">
            <li>Vào <strong>console.cloud.google.com</strong>, tạo (hoặc chọn) một project.</li>
            <li>APIs &amp; Services → Library → bật <strong>Google Drive API</strong>.</li>
            <li>OAuth consent screen: User type <strong>External</strong>, điền tên app + email, thêm scope <code>drive.file</code>, rồi bấm <strong>Publish app</strong> để chuyển sang <strong>In production</strong> (tránh token hết hạn sau 7 ngày).</li>
            <li>Credentials → Create credentials → <strong>OAuth client ID</strong> → loại <strong>Web application</strong>, thêm cả hai Authorized redirect URI:
              <code className="block text-xs bg-surface-container-lowest rounded px-xs py-xs mt-xs break-all">http://localhost:3002/api/auth/google/callback</code>
              <code className="block text-xs bg-surface-container-lowest rounded px-xs py-xs mt-xs break-all">https://pod.thecrafthousellc.com/api/auth/google/callback</code>
              {status?.redirectUri && !['http://localhost:3002/api/auth/google/callback', 'https://pod.thecrafthousellc.com/api/auth/google/callback'].includes(status.redirectUri) && (
                <code className="block text-xs bg-surface-container-lowest rounded px-xs py-xs mt-xs break-all">{status.redirectUri}</code>
              )}
            </li>
            <li>Copy Client ID và Client Secret dán vào form trên, bấm <strong>Lưu OAuth client</strong>, rồi <strong>Kết nối Google Drive</strong>.</li>
          </ol>
        </details>
      </div>
    </div>
  )
}
