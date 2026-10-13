'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useCurrentUser } from '@/components/RoleGate'

type Quota = { limit: number | null; usage: number; checkedAt: string }

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
  quota: Quota | null
  pendingLocal: number
  lastPushAt: string | null
  hasTestFile: boolean
}

type PushStatus = {
  pending: number; running: boolean; queued: boolean; pushed: number; failed: number; missing: number
  lastError: string | null; stopped: string | null; finishedAt: string | null
  uploadError: { message: string; at: string } | null
}

type Banner = { ok: boolean; text: string }

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

const STOP_TEXT: Record<string, string> = {
  not_connected: 'dừng vì Google Drive chưa kết nối',
  needs_reconnect: 'dừng vì Google Drive cần kết nối lại',
  too_many_failures: 'dừng vì lỗi liên tiếp, sẽ thử lại sau',
}

const MAX_KEY_BYTES = 16 * 1024
const GB = 1024 ** 3
const MB = 1024 ** 2
const PUSH_POLL_MS = 2000

const inputClass = 'w-full bg-surface-container border border-outline-variant/30 rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-secondary focus:border-secondary outline-none transition-all'
const primaryBtn = 'bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50'
const outlineBtn = 'border border-secondary text-secondary px-lg py-sm rounded-lg text-label-md hover:bg-secondary/5 transition-colors disabled:opacity-50 flex items-center gap-xs'
const sectionTitle = 'text-label-md text-primary flex items-center gap-xs'

function fmtStorage(bytes: number) {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`
  return `${Math.max(0, Math.round(bytes / 1024))} KB`
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

async function call<T = any>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, init)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data?.error || `HTTP ${res.status}` }
    return { ok: true, data }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Lỗi mạng' }
  }
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(new Error('Không đọc được file'))
    reader.readAsText(file)
  })
}

export default function GoogleDriveSetupCard() {
  const { user, loading: userLoading } = useCurrentUser()
  const [status, setStatus] = useState<DriveStatus | null>(null)
  const [loadError, setLoadError] = useState('')
  const [banner, setBanner] = useState<Banner | null>(null)
  const [busy, setBusy] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [pasted, setPasted] = useState('')
  const [manual, setManual] = useState({ clientId: '', clientSecret: '', refreshToken: '' })
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [oauthMsg, setOauthMsg] = useState('')
  const [test, setTest] = useState<{ link: string; name: string } | null>(null)
  const [testError, setTestError] = useState('')
  const [push, setPush] = useState<PushStatus | null>(null)
  const [pushError, setPushError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isSuper = user?.role === 'SUPERADMIN'

  const load = useCallback(async () => {
    const r = await call<DriveStatus>('/api/setup/google-drive')
    if (!r.ok) { setLoadError(r.error || 'Không tải được trạng thái Google Drive.'); return }
    setStatus(r.data)
    setLoadError('')
  }, [])

  const pollPush = useCallback(async () => {
    if (pushTimer.current) { clearTimeout(pushTimer.current); pushTimer.current = null }
    const r = await call<PushStatus>('/api/setup/google-drive/push-local')
    if (!r.ok) { setPushError(r.error); return }
    setPush(r.data)
    if (r.data.running || r.data.queued) pushTimer.current = setTimeout(pollPush, PUSH_POLL_MS)
    else load()
  }, [load])

  useEffect(() => {
    if (!isSuper) return
    load()
    pollPush()
    const params = new URLSearchParams(window.location.search)
    const google = params.get('google')
    if (google === 'connected') setBanner({ ok: true, text: 'Đã kết nối Google Drive.' })
    else if (google === 'error') {
      const reason = params.get('reason') || 'unknown'
      setBanner({ ok: false, text: `Kết nối Google Drive thất bại: ${REASON_TEXT[reason] ?? reason}.` })
    }
    return () => { if (pushTimer.current) clearTimeout(pushTimer.current) }
  }, [isSuper, load, pollPush])

  async function connectWith(payload: Record<string, string>, label: string) {
    setBusy(label); setBanner(null)
    const r = await call<{ email: string; displayName: string; quota: Quota; rootFolderCreated: boolean; warning: string | null }>(
      '/api/setup/google-drive/connect-token',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    )
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    const d = r.data
    const quota = d.quota.limit ? `${fmtStorage(d.quota.usage)} / ${fmtStorage(d.quota.limit)}` : `${fmtStorage(d.quota.usage)} đã dùng`
    setBanner({
      ok: true,
      text: `Đã kết nối ${d.email || d.displayName || 'tài khoản Google'} · dung lượng ${quota} · thư mục "Design Studio" ${d.rootFolderCreated ? 'vừa được tạo' : 'đã có sẵn'}.${d.warning ? ` ${d.warning}` : ''}`,
    })
    setPasted(''); setManual({ clientId: '', clientSecret: '', refreshToken: '' }); setTest(null); setTestError('')
    await load()
    pollPush()
  }

  async function connectFile(file: File | undefined | null) {
    if (!file) return
    if (file.size > MAX_KEY_BYTES) { setBanner({ ok: false, text: 'File lớn hơn 16 KB — đây không phải file google_drive_token.json.' }); return }
    let text = ''
    try { text = await readText(file) } catch (e: any) { setBanner({ ok: false, text: e?.message ?? 'Không đọc được file' }); return }
    await connectWith({ tokenJson: text }, 'file')
  }

  async function saveOauthClient() {
    const payload: Record<string, string> = {}
    if (clientId.trim()) payload.clientId = clientId.trim()
    if (clientSecret.trim()) payload.clientSecret = clientSecret.trim()
    if (!Object.keys(payload).length) { setOauthMsg('Nhập Client ID hoặc Client Secret để lưu.'); return }
    setBusy('oauth'); setOauthMsg('')
    const r = await call('/api/setup/google-drive', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    setBusy('')
    if (!r.ok) { setOauthMsg(`Lỗi khi lưu: ${r.error}`); return }
    setClientId(''); setClientSecret('')
    setOauthMsg('Đã lưu OAuth client.')
    await load()
  }

  async function disconnect() {
    if (!confirm('Ngắt kết nối Google Drive? Artwork mới sẽ lưu trên server cho tới khi kết nối lại.')) return
    const r = await call('/api/setup/google-drive', { method: 'DELETE' })
    if (!r.ok) { setBanner({ ok: false, text: 'Không ngắt kết nối được.' }); return }
    setBanner(null); setTest(null); setTestError('')
    await load()
  }

  async function createTest() {
    setBusy('test'); setTestError(''); setTest(null)
    const r = await call<{ link: string; name: string }>('/api/setup/google-drive/test', { method: 'POST' })
    setBusy('')
    if (!r.ok) { setTestError(r.error); return }
    setTest({ link: r.data.link, name: r.data.name })
    load()
  }

  async function deleteTest() {
    setBusy('test-delete'); setTestError('')
    const r = await call('/api/setup/google-drive/test', { method: 'DELETE' })
    setBusy('')
    if (!r.ok) { setTestError(r.error); return }
    setTest(null)
    load()
  }

  async function pushAll() {
    setBusy('push'); setPushError('')
    const r = await call<PushStatus>('/api/setup/google-drive/push-local', { method: 'POST' })
    setBusy('')
    if (!r.ok) { setPushError(r.error); return }
    setPush(r.data)
    pushTimer.current = setTimeout(pollPush, PUSH_POLL_MS)
  }

  if (userLoading || !isSuper) return null

  const connected = !!status?.connected
  const healthy = connected && !status?.needsReconnect
  const stateLabel = !status ? (loadError || 'Đang kiểm tra...') : status.needsReconnect ? 'Cần kết nối lại' : connected ? 'Đã kết nối' : 'Chưa kết nối'
  const stateTone = status?.needsReconnect ? 'text-error' : healthy ? 'text-on-tertiary-container' : 'text-on-surface-variant'
  const quota = status?.quota ?? null
  const percent = quota?.limit ? Math.min(100, Math.round((quota.usage / quota.limit) * 1000) / 10) : null
  const pushActive = !!push && (push.running || push.queued)
  const pushLine = !push
    ? ''
    : pushActive
      ? `Đang đẩy… đã đẩy ${push.pushed} · lỗi ${push.failed} · còn ${push.pending} file trên server`
      : push.finishedAt
        ? `Lượt gần nhất (${fmtTime(push.finishedAt)}): đã đẩy ${push.pushed} · lỗi ${push.failed}${push.missing ? ` · ${push.missing} file không còn trên server` : ''} · còn ${push.pending} file trên server${push.stopped ? ` · ${STOP_TEXT[push.stopped] ?? push.stopped}` : ''}`
        : ''
  const lastPushError = push?.lastError ?? push?.uploadError?.message ?? ''

  return (
    <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 mb-lg mt-lg">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-on-surface-variant">add_to_drive</span>
        <h2 className="text-title-md">Google Drive (lưu artwork)</h2>
        {healthy && <span className="ml-auto bg-on-tertiary-container/15 text-on-tertiary-container px-sm py-xs rounded-full text-label-sm">✓ Đã kết nối</span>}
      </div>

      <div className="p-lg space-y-lg">
        {banner && (
          <div role="status" className={`rounded-lg px-md py-sm text-body-sm border ${banner.ok ? 'bg-secondary/5 border-secondary/30 text-secondary' : 'bg-error/5 border-error/30 text-error'}`}>
            {banner.text}
          </div>
        )}

        <div className="space-y-sm">
          <div className="flex flex-wrap items-center gap-sm">
            <span className={`material-symbols-outlined text-[18px] ${stateTone}`}>{status?.needsReconnect ? 'error' : healthy ? 'cloud_done' : 'cloud_off'}</span>
            <span className={`text-body-sm font-semibold ${stateTone}`}>{stateLabel}</span>
            {status?.needsReconnect && <span className="text-body-sm text-error">Khoá Google đã bị thu hồi hoặc hết hạn — kết nối lại bằng một trong hai cách bên dưới.</span>}
            {status && !connected && <span className="text-body-sm text-on-surface-variant">Artwork đang lưu trên server.</span>}
          </div>

          {connected && status && (
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-lg gap-y-sm text-body-sm">
              <div>
                <dt className="text-label-sm text-on-surface-variant">Tài khoản</dt>
                <dd className="text-on-surface break-all">{status.email || 'không rõ email'}</dd>
              </div>
              <div>
                <dt className="text-label-sm text-on-surface-variant">Thư mục gốc</dt>
                <dd>
                  {status.rootFolderUrl
                    ? <a href={status.rootFolderUrl} target="_blank" rel="noopener noreferrer" className="text-secondary hover:underline inline-flex items-center gap-xs">
                        <span className="material-symbols-outlined text-[16px]">folder_open</span>Design Studio
                      </a>
                    : <span className="text-on-surface-variant">chưa có</span>}
                </dd>
              </div>
              <div>
                <dt className="text-label-sm text-on-surface-variant">Dung lượng</dt>
                <dd className="text-on-surface">
                  {quota
                    ? <>
                        {quota.limit ? `${fmtStorage(quota.usage)} / ${fmtStorage(quota.limit)} (${percent}%)` : `${fmtStorage(quota.usage)} đã dùng (không giới hạn)`}
                        {percent !== null && (
                          <div className="mt-xs h-2 rounded-full bg-surface-container overflow-hidden" role="progressbar" aria-label="Dung lượng Google Drive đã dùng"
                            aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                            <div className={`h-full ${percent > 90 ? 'bg-error' : 'bg-secondary'}`} style={{ width: `${percent}%` }} />
                          </div>
                        )}
                        <div className="text-label-sm text-on-surface-variant mt-xs">Cập nhật {fmtTime(quota.checkedAt)}</div>
                      </>
                    : <span className="text-on-surface-variant">chưa có số liệu</span>}
                </dd>
              </div>
              <div>
                <dt className="text-label-sm text-on-surface-variant">Lần đẩy thành công gần nhất</dt>
                <dd className="text-on-surface">{status.lastPushAt ? fmtTime(status.lastPushAt) : 'chưa có'}</dd>
                <dt className="text-label-sm text-on-surface-variant mt-sm">File còn trên server chờ đẩy</dt>
                <dd className={status.pendingLocal > 0 ? 'text-on-surface font-semibold' : 'text-on-surface'}>{push?.pending ?? status.pendingLocal}</dd>
              </div>
            </dl>
          )}

          {connected && (
            <div className="space-y-sm">
              <div className="flex flex-wrap items-center gap-sm">
                <button type="button" onClick={createTest} disabled={busy === 'test' || !healthy} className={outlineBtn}>
                  <span className="material-symbols-outlined text-[18px]">science</span>{busy === 'test' ? 'Đang tạo…' : 'Tạo file thử'}
                </button>
                <button type="button" onClick={pushAll} disabled={busy === 'push' || pushActive || !healthy} className={outlineBtn}>
                  <span className="material-symbols-outlined text-[18px]">cloud_upload</span>Đẩy tất cả file còn trên server lên Drive
                </button>
                <button type="button" onClick={disconnect} className="border border-outline-variant text-error px-lg py-sm rounded-lg text-label-md hover:bg-error/5 transition-colors">
                  Ngắt kết nối
                </button>
              </div>
              {test && (
                <div className="rounded-lg border border-secondary/30 bg-secondary/5 px-md py-sm text-body-sm space-y-xs">
                  <div>Đã tạo <strong>{test.name}</strong> trong thư mục Design Studio. Mở link này trong cửa sổ ẩn danh — xem được ảnh nghĩa là xưởng cũng mở được:</div>
                  <a href={test.link} target="_blank" rel="noopener noreferrer" className="text-secondary hover:underline break-all">{test.link}</a>
                  <div>
                    <button type="button" onClick={deleteTest} disabled={busy === 'test-delete'} className="text-error text-label-sm hover:underline disabled:opacity-50">
                      {busy === 'test-delete' ? 'Đang xoá…' : 'Xoá file thử'}
                    </button>
                  </div>
                </div>
              )}
              {!test && status?.hasTestFile && (
                <button type="button" onClick={deleteTest} disabled={busy === 'test-delete'} className="text-error text-label-sm hover:underline disabled:opacity-50">
                  {busy === 'test-delete' ? 'Đang xoá…' : 'Xoá file thử còn trên Drive'}
                </button>
              )}
              {testError && <div role="alert" className="rounded-lg px-md py-sm text-body-sm border bg-error/5 border-error/30 text-error">{testError}</div>}
              {pushLine && <div role="status" className="text-body-sm text-on-surface-variant">{pushLine}</div>}
              {lastPushError && <div className="text-body-sm text-error">Lỗi gần nhất: {lastPushError}</div>}
              {pushError && <div role="alert" className="text-body-sm text-error">{pushError}</div>}
            </div>
          )}
        </div>

        <div className="space-y-sm border-t border-outline-variant/20 pt-md">
          <h3 className={sectionTitle}><span className="material-symbols-outlined text-[18px]">key</span>Kết nối bằng khoá có sẵn</h3>
          <p className="text-body-sm text-on-surface-variant">Dùng file <code>google_drive_token.json</code> đã có. Trình duyệt chỉ đọc nội dung để kiểm tra với Google; file không được lưu lại.</p>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label="Chọn file google_drive_token.json"
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; void connectFile(f) }} />
          <div role="button" tabIndex={0} aria-label="Chọn hoặc kéo thả file google_drive_token.json"
            onClick={() => fileInput.current?.click()}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.current?.click() } }}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); void connectFile(e.dataTransfer.files?.[0]) }}
            className={`rounded-lg border-2 border-dashed px-lg py-lg text-center cursor-pointer transition-colors ${dragOver ? 'border-secondary bg-secondary/10 text-secondary' : 'border-outline-variant text-on-surface-variant hover:border-secondary'}`}>
            <span className="material-symbols-outlined text-[28px] block">upload_file</span>
            <span className="text-label-md block mt-xs">{busy === 'file' ? 'Đang kiểm tra với Google…' : 'Chọn file google_drive_token.json'}</span>
            <span className="text-label-sm block">hoặc kéo thả file vào đây</span>
          </div>

          <details className="bg-surface-container rounded-lg border border-outline-variant/20 px-md py-sm">
            <summary className="cursor-pointer text-label-md text-primary">Dán nội dung file</summary>
            <div className="mt-sm space-y-sm">
              <label htmlFor="google-token-json" className="block text-label-sm text-on-surface-variant">Nội dung google_drive_token.json</label>
              <textarea id="google-token-json" value={pasted} onChange={e => setPasted(e.target.value)} rows={5} spellCheck={false} autoComplete="off"
                placeholder={'{ "client_id": "…", "client_secret": "…", "refresh_token": "…" }'} className={`${inputClass} font-mono text-body-sm`} />
              <button type="button" onClick={() => connectWith({ tokenJson: pasted }, 'paste')} disabled={busy === 'paste' || !pasted.trim()} className={primaryBtn}>
                {busy === 'paste' ? 'Đang kiểm tra…' : 'Kiểm tra và kết nối'}
              </button>
            </div>
          </details>

          <details className="bg-surface-container rounded-lg border border-outline-variant/20 px-md py-sm">
            <summary className="cursor-pointer text-label-md text-primary">Nhập tay 3 giá trị</summary>
            <div className="mt-sm grid grid-cols-1 md:grid-cols-3 gap-md">
              <div className="space-y-xs">
                <label htmlFor="google-manual-client-id" className="block text-label-sm text-on-surface-variant">client_id</label>
                <input id="google-manual-client-id" type="text" autoComplete="off" value={manual.clientId} onChange={e => setManual(m => ({ ...m, clientId: e.target.value }))} className={inputClass} />
              </div>
              <div className="space-y-xs">
                <label htmlFor="google-manual-client-secret" className="block text-label-sm text-on-surface-variant">client_secret</label>
                <input id="google-manual-client-secret" type="password" autoComplete="new-password" value={manual.clientSecret} onChange={e => setManual(m => ({ ...m, clientSecret: e.target.value }))} className={inputClass} />
              </div>
              <div className="space-y-xs">
                <label htmlFor="google-manual-refresh-token" className="block text-label-sm text-on-surface-variant">refresh_token</label>
                <input id="google-manual-refresh-token" type="password" autoComplete="new-password" value={manual.refreshToken} onChange={e => setManual(m => ({ ...m, refreshToken: e.target.value }))} className={inputClass} />
              </div>
            </div>
            <button type="button" onClick={() => connectWith(manual, 'manual')}
              disabled={busy === 'manual' || !manual.clientId.trim() || !manual.clientSecret.trim() || !manual.refreshToken.trim()} className={`${primaryBtn} mt-sm`}>
              {busy === 'manual' ? 'Đang kiểm tra…' : 'Kiểm tra và kết nối'}
            </button>
          </details>
        </div>

        <div className="space-y-sm border-t border-outline-variant/20 pt-md">
          <h3 className={sectionTitle}><span className="material-symbols-outlined text-[18px]">login</span>Kết nối bằng đăng nhập Google</h3>
          <p className="text-body-sm text-on-surface-variant">Cần OAuth client loại Web application. Khoá loại Desktop (installed) không dùng được cách này — hãy dùng file khoá ở trên.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
            <div className="space-y-xs">
              <label htmlFor="google-client-id" className="block text-label-sm text-on-surface-variant">Client ID</label>
              <input id="google-client-id" type="text" value={clientId} onChange={e => setClientId(e.target.value)} autoComplete="off"
                placeholder={status?.clientIdMasked ? `Đã lưu (${status.clientIdMasked}) — nhập để thay` : 'xxxx.apps.googleusercontent.com'} className={inputClass} />
            </div>
            <div className="space-y-xs">
              <label htmlFor="google-client-secret" className="block text-label-sm text-on-surface-variant">Client Secret</label>
              <input id="google-client-secret" type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} autoComplete="new-password"
                placeholder={status?.hasClientSecret ? 'đã lưu' : 'GOCSPX-...'} className={inputClass} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-sm">
            <button type="button" onClick={saveOauthClient} disabled={busy === 'oauth'} className={primaryBtn}>
              {busy === 'oauth' ? 'Đang lưu…' : 'Lưu OAuth client'}
            </button>
            {status?.configured ? (
              <a href="/api/auth/google" className={outlineBtn}>
                <span className="material-symbols-outlined text-[18px]">link</span>
                {connected ? 'Kết nối lại Google Drive' : 'Kết nối Google Drive'}
              </a>
            ) : (
              <button type="button" disabled title="Lưu Client ID và Client Secret trước"
                className="border border-outline-variant text-on-surface-variant px-lg py-sm rounded-lg text-label-md opacity-50 flex items-center gap-xs">
                <span className="material-symbols-outlined text-[18px]">link</span>
                Kết nối Google Drive
              </button>
            )}
            {oauthMsg && <span className="text-body-sm text-on-surface-variant">{oauthMsg}</span>}
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
    </div>
  )
}
