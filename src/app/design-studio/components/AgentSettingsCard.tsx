'use client'
import { useEffect, useState } from 'react'
import { postJson, putJson, requestJson } from './model'
import { Card, ErrorBanner, Icon, Note, btn, fmtDateTime, input } from './ui'

type AgentConfig = { autoFixOnReject: boolean; maxConcurrent: number; leaseMinutes: number }
type RunnerInfo = { configured: boolean; tokenUpdatedAt: string | null; lastSeenAt: string | null; online: boolean }
type AgentState = {
  agent: AgentConfig
  runner: RunnerInfo
  queue: { queued: number; running: number; needsOwner: number; failed: number }
  rejectedBacklog: number
}

const SETTINGS_URL = '/api/design-agent/settings'
const TOKEN_URL = '/api/design-agent/settings/runner-token'

export default function AgentSettingsCard({ canManage }: { canManage: boolean }) {
  const [state, setState] = useState<AgentState | null>(null)
  const [autoFix, setAutoFix] = useState(false)
  const [maxConcurrent, setMaxConcurrent] = useState('5')
  const [leaseMinutes, setLeaseMinutes] = useState('20')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [copied, setCopied] = useState(false)

  function fill(s: AgentState) {
    setState(s)
    setAutoFix(s.agent.autoFixOnReject)
    setMaxConcurrent(String(s.agent.maxConcurrent))
    setLeaseMinutes(String(s.agent.leaseMinutes))
  }

  async function reload() {
    const r = await requestJson<AgentState>(SETTINGS_URL)
    if (!r.ok) { setError(r.error); return }
    fill(r.data)
  }

  useEffect(() => {
    let alive = true
    void requestJson<AgentState>(SETTINGS_URL).then(r => {
      if (!alive) return
      if (!r.ok) { setError(r.error); return }
      fill(r.data)
    })
    return () => { alive = false }
  }, [])

  async function save() {
    setBusy(true); setError(''); setSaved('')
    const r = await putJson(SETTINGS_URL, { autoFixOnReject: autoFix, maxConcurrent: Number(maxConcurrent), leaseMinutes: Number(leaseMinutes) })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setSaved('Đã lưu cài đặt Agent.')
    await reload()
  }

  async function generate() {
    if (state?.runner.configured && !window.confirm('Tạo token mới sẽ vô hiệu token cũ. Runner đang chạy phải đổi sang token mới. Tiếp tục?')) return
    setBusy(true); setError(''); setCopied(false)
    const r = await requestJson<{ token: string }>(TOKEN_URL, { method: 'POST' })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setToken(r.data.token)
    await reload()
  }

  async function revoke() {
    if (!window.confirm('Thu hồi token? Runner sẽ không gọi được nữa cho đến khi có token mới.')) return
    setBusy(true); setError('')
    const r = await requestJson(TOKEN_URL, { method: 'DELETE' })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setToken('')
    await reload()
  }

  async function copy() {
    try { await navigator.clipboard.writeText(token); setCopied(true) } catch { setError('Không chép được — chọn và chép tay') }
  }

  async function backfill() {
    setBusy(true); setError(''); setSaved('')
    const preview = await postJson<{ count: number }>('/api/design-agent/backfill', {})
    setBusy(false)
    if (!preview.ok) { setError(preview.error); return }
    if (!window.confirm(`Sẽ xếp ${preview.data.count} task đang bị trả lại cho Agent. Tiếp tục?`)) return
    setBusy(true)
    const done = await postJson<{ queued: number }>('/api/design-agent/backfill', { dryRun: false })
    setBusy(false)
    if (!done.ok) { setError(done.error); return }
    setSaved(`Đã xếp ${done.data.queued} task.`)
    await reload()
  }

  const runner = state?.runner
  const right = !runner ? '' : !runner.configured ? 'chưa có token' : runner.online ? 'runner đang chạy' : 'runner offline'
  const dis = !canManage

  return (
    <Card icon="smart_toy" title="Agent" right={right}>
      <label className="flex items-start gap-sm text-body-sm text-on-surface cursor-pointer">
        <input type="checkbox" className="mt-[3px] w-4 h-4 accent-secondary" checked={autoFix} onChange={e => setAutoFix(e.target.checked)} disabled={dis} aria-label="Tự sửa khi bị trả lại" />
        <span className="flex flex-col">
          <b>Tự sửa khi bị trả lại</b>
          <span className="text-label-sm text-on-surface-variant">
            Khi bật, mỗi task bị &quot;Trả lại sửa&quot; hoặc &quot;Mở lại để sửa&quot; tạo một job cho Agent trên máy shop. Agent chỉ đưa task về Chờ duyệt, không bao giờ tự duyệt.
          </span>
        </span>
      </label>

      <div className="flex flex-wrap gap-md">
        <label className="flex flex-col gap-xs text-label-sm text-on-surface-variant">Số job chạy cùng lúc
          <input type="number" min={1} max={10} className={`${input} w-24`} value={maxConcurrent} onChange={e => setMaxConcurrent(e.target.value)} disabled={dis} />
        </label>
        <label className="flex flex-col gap-xs text-label-sm text-on-surface-variant">Phút chờ trước khi coi runner mất kết nối
          <input type="number" min={5} max={120} className={`${input} w-24`} value={leaseMinutes} onChange={e => setLeaseMinutes(e.target.value)} disabled={dis} />
        </label>
      </div>

      {canManage ? (
        <div className="flex items-center gap-sm">
          <button type="button" className={btn} disabled={busy || !state} onClick={() => void save()}><Icon name="save" className="text-[16px]" />Lưu cài đặt Agent</button>
          {saved && <span className="text-label-sm text-on-surface-variant" role="status">{saved}</span>}
        </div>
      ) : (
        <p className="text-label-sm text-on-surface-variant">Chỉ Superadmin đổi được cài đặt Agent.</p>
      )}

      {state && (
        <p className="text-body-sm text-on-surface-variant">
          {`Đang chờ ${state.queue.queued} · Đang chạy ${state.queue.running} · Cần chủ shop ${state.queue.needsOwner} · Lỗi ${state.queue.failed}`}
        </p>
      )}

      <p className="text-body-sm text-on-surface-variant">
        {runner?.lastSeenAt ? `Runner gọi lần cuối: ${fmtDateTime(runner.lastSeenAt)}` : 'Runner chưa gọi lần nào'}
      </p>
      <p className="text-body-sm text-on-surface-variant">
        Runner trên máy shop (<code className="font-mono">tools/design-agent-runner</code>) gọi <code className="font-mono">/api/design-agent/runner/*</code> bằng token này
        qua biến <code className="font-mono">DESIGN_AGENT_TOKEN</code>. Server chỉ lưu mã băm.
      </p>
      {token && (
        <div className="flex flex-col gap-xs">
          <Note tone="warn" icon="visibility">Token chỉ hiện một lần — chép ngay.</Note>
          <div className="flex gap-xs">
            <input className={`${input} flex-1 font-mono`} readOnly value={token} aria-label="Runner token" onFocus={e => e.currentTarget.select()} />
            <button type="button" className={btn} onClick={() => void copy()}><Icon name="content_copy" className="text-[16px]" />{copied ? 'Đã chép' : 'Chép'}</button>
          </div>
        </div>
      )}
      {canManage && (
        <div className="flex gap-xs">
          <button type="button" className={btn} disabled={busy} onClick={() => void generate()}><Icon name="add_moderator" className="text-[16px]" />{runner?.configured ? 'Tạo token mới' : 'Tạo token'}</button>
          {runner?.configured && <button type="button" className={btn} disabled={busy} onClick={() => void revoke()}><Icon name="block" className="text-[16px]" />Thu hồi</button>}
        </div>
      )}

      {state && (
        <div className="flex flex-wrap items-center gap-sm">
          <span className="text-body-sm text-on-surface-variant">{`${state.rejectedBacklog} task đang bị trả lại chưa có job`}</span>
          {canManage && (
            <button type="button" className={btn} disabled={busy || state.rejectedBacklog === 0} onClick={() => void backfill()}>
              <Icon name="playlist_add" className="text-[16px]" />Xếp các task đang bị trả lại
            </button>
          )}
        </div>
      )}
      <ErrorBanner msg={error} onClose={() => setError('')} />
    </Card>
  )
}
