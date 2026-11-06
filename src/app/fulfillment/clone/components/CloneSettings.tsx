'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { NETWORK_ERROR, PLATFORMS, formatWhen, prefixOf, requestJson, type CloneSettingsView, type CloneStore } from './types'

const SETTINGS_URL = '/api/fulfillment/clone/settings'

type Msg = { ok: boolean; text: string } | null

const msgClass = (m: NonNullable<Msg>) => `text-body-sm ${m.ok ? 'text-on-surface-variant' : 'text-error'}`

// A 200 whose body is not the settings (an empty object, a proxy's HTML page) must not reach the render.
function parseSettings(body: any): CloneSettingsView | null {
  const w = body?.worker
  if (typeof body?.paused !== 'boolean' || !Array.isArray(body.targets) || typeof w !== 'object' || w === null) return null
  return {
    paused: body.paused,
    targets: body.targets.filter((t: unknown): t is string => typeof t === 'string'),
    worker: {
      configured: w.configured === true,
      tokenUpdatedAt: typeof w.tokenUpdatedAt === 'string' ? w.tokenUpdatedAt : null,
      lastSeenAt: typeof w.lastSeenAt === 'string' ? w.lastSeenAt : null,
      online: w.online === true,
    },
  }
}

// The token lives only in this component's state, so closing the block (which unmounts it) or reloading the page drops it.
function SettingsBody({ stores, onPausedChange }: { stores: CloneStore[]; onPausedChange: (paused: boolean) => void }) {
  const [settings, setSettings] = useState<CloneSettingsView | null>(null)
  const [targets, setTargets] = useState<string[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pauseMsg, setPauseMsg] = useState<Msg>(null)
  const [targetsMsg, setTargetsMsg] = useState<Msg>(null)
  const [tokenMsg, setTokenMsg] = useState<Msg>(null)
  const [busy, setBusy] = useState<'pause' | 'targets' | 'token' | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tokenInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    }
  }, [])

  const load = useCallback(async (first: boolean) => {
    try {
      const r = await requestJson(SETTINGS_URL)
      if (!alive.current) return
      if (!r.ok) { setLoadError(r.body.error ?? `Lỗi ${r.status}`); return }
      const parsed = parseSettings(r.body)
      if (!parsed) { setLoadError('Phản hồi cài đặt không hợp lệ. Đóng khối này rồi mở lại.'); return }
      setLoadError(null)
      setSettings(parsed)
      if (first) setTargets(parsed.targets)
    } catch {
      if (alive.current) setLoadError(NETWORK_ERROR)
    }
  }, [])

  useEffect(() => { load(true) }, [load])

  async function send(kind: 'pause' | 'targets' | 'token', body: unknown, fail: (m: Msg) => void): Promise<any | null> {
    setBusy(kind)
    fail(null)
    try {
      const r = await requestJson(SETTINGS_URL, { method: 'POST', body })
      if (!alive.current) return null
      if (!r.ok) { fail({ ok: false, text: r.body.error ?? `Lỗi ${r.status}` }); return null }
      return r.body
    } catch {
      if (alive.current) fail({ ok: false, text: NETWORK_ERROR })
      return null
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  async function togglePause() {
    if (!settings) return
    const saved = await send('pause', { paused: !settings.paused }, setPauseMsg)
    if (!saved) return
    setSettings(s => s && { ...s, paused: saved.paused === true })
    onPausedChange(saved.paused === true)
  }

  const toggleTarget = (value: string) => {
    setTargetsMsg(null)
    setTargets(prev => (prev.includes(value) ? prev.filter(t => t !== value) : [...prev, value]))
  }

  async function saveTargets() {
    const saved = await send('targets', { targets }, setTargetsMsg)
    if (!saved) return
    setTargets(Array.isArray(saved.targets) ? saved.targets : targets)
    setTargetsMsg({ ok: true, text: 'Đã lưu.' })
  }

  async function mintToken() {
    if (!window.confirm('Token cũ sẽ ngừng hoạt động. Tạo token mới?')) return
    const minted = await send('token', { action: 'mint-token' }, setTokenMsg)
    if (!minted || typeof minted.token !== 'string') return
    setToken(minted.token)
    setCopied(false)
    await load(false)
  }

  async function revokeToken() {
    if (!window.confirm('Thu hồi token? Máy xử lý sẽ không kết nối được cho đến khi có token mới.')) return
    const revoked = await send('token', { action: 'revoke-token' }, setTokenMsg)
    if (!revoked) return
    setToken(null)
    await load(false)
  }

  async function copyToken() {
    if (!token) return
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      tokenInput.current?.select()
      setTokenMsg({ ok: false, text: 'Không chép được. Token đã được chọn sẵn, bấm Ctrl+C để chép.' })
    }
  }

  if (!settings) {
    return <p className={`p-lg text-body-sm ${loadError ? 'text-error' : 'text-on-surface-variant'}`}>{loadError ?? 'Đang tải…'}</p>
  }

  const pairStores = stores.map(s => ({ store: s, prefix: prefixOf(s) })).filter((p): p is { store: CloneStore; prefix: string } => p.prefix !== null)
  const worker = settings.worker

  return (
    <div className="flex flex-col gap-xl p-lg">
      {loadError && <p className="text-body-sm text-error">{loadError}</p>}
      <div>
        <div className="flex flex-wrap items-center gap-md">
          <button type="button" role="switch" aria-checked={settings.paused} aria-label="Tạm dừng hàng chờ" disabled={busy === 'pause'} onClick={togglePause}
            className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${settings.paused ? 'bg-error' : 'bg-outline-variant'}`}>
            <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${settings.paused ? 'translate-x-5' : ''}`} />
          </button>
          <div>
            <p className="text-label-md text-primary">Tạm dừng hàng chờ</p>
            <p className="text-body-sm text-on-surface-variant">Khi bật, máy xử lý không nhận thêm job; job đang chạy vẫn chạy nốt.</p>
          </div>
        </div>
        {pauseMsg && <p className={`mt-sm ${msgClass(pauseMsg)}`}>{pauseMsg.text}</p>}
      </div>

      <div>
        <h4 className="text-label-md text-primary">Nền tảng được bật cho từng store</h4>
        {pairStores.length === 0 ? (
          <p className="mt-sm text-body-sm text-on-surface-variant">Chưa có store nào có tiền tố đơn.</p>
        ) : (
          <div className="mt-sm overflow-x-auto">
            <table className="text-left text-body-sm">
              <thead className="text-label-sm uppercase tracking-wider text-on-surface-variant">
                <tr>
                  <th className="py-sm pr-lg font-medium">Store</th>
                  {PLATFORMS.map(p => <th key={p} className="px-md py-sm font-medium">{p}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/20">
                {pairStores.map(({ store, prefix }) => (
                  <tr key={store.id}>
                    <td className="py-sm pr-lg" title={store.shop}>{prefix}</td>
                    {PLATFORMS.map(p => {
                      const value = `${p}:${prefix}`
                      return (
                        <td key={p} className="px-md py-sm">
                          <input type="checkbox" aria-label={value} checked={targets.includes(value)} onChange={() => toggleTarget(value)} />
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-md flex items-center gap-md">
          <button type="button" disabled={busy === 'targets'} onClick={saveTargets} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">Lưu</button>
          {targetsMsg && <p className={msgClass(targetsMsg)}>{targetsMsg.text}</p>}
        </div>
      </div>

      <div>
        <h4 className="text-label-md text-primary">Token máy xử lý</h4>
        <p className="mt-xs text-body-sm text-on-surface-variant">
          {worker.configured ? `Đã có token${worker.tokenUpdatedAt ? `, tạo lúc ${formatWhen(worker.tokenUpdatedAt)}` : ''}.` : 'Chưa có token.'}
        </p>
        <div className="mt-sm flex flex-wrap items-center gap-md">
          <button type="button" disabled={busy === 'token'} onClick={mintToken} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">Tạo token</button>
          {worker.configured && (
            <button type="button" disabled={busy === 'token'} onClick={revokeToken} className="text-label-md text-error hover:underline disabled:opacity-50">Thu hồi token</button>
          )}
        </div>
        {token && (
          <div className="mt-md max-w-xl">
            <div className="flex items-center gap-sm">
              <input ref={tokenInput} readOnly value={token} onFocus={e => e.currentTarget.select()} autoComplete="off" spellCheck={false}
                aria-label="Token máy xử lý" className="min-w-0 flex-1 rounded-lg border border-outline-variant/40 bg-surface px-md py-sm font-mono text-body-sm" />
              <button type="button" onClick={copyToken} className="rounded-lg border border-outline-variant/40 px-md py-sm text-label-md text-secondary">{copied ? 'Đã chép' : 'Chép'}</button>
            </div>
            <p className="mt-xs text-body-sm text-on-surface-variant">Token chỉ hiện một lần. Dán vào máy xử lý bằng script set-token.ps1.</p>
          </div>
        )}
        {tokenMsg && <p className={`mt-sm ${msgClass(tokenMsg)}`}>{tokenMsg.text}</p>}
      </div>
    </div>
  )
}

export function CloneSettings({ stores, onPausedChange }: { stores: CloneStore[]; onPausedChange: (paused: boolean) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)}
        className={`flex w-full items-center gap-sm px-lg py-md text-left ${open ? 'border-b border-outline-variant/20' : ''}`}>
        <span className="material-symbols-outlined text-secondary">tune</span>
        <h3 className="text-headline-sm text-primary">Cài đặt hàng chờ</h3>
        <span className="material-symbols-outlined ml-auto text-on-surface-variant">{open ? 'expand_less' : 'expand_more'}</span>
      </button>
      {open && <SettingsBody stores={stores} onPausedChange={onPausedChange} />}
    </section>
  )
}
