'use client'
import { useCallback, useEffect, useState } from 'react'
import { useCurrentUser } from '@/components/RoleGate'

type View = { username: string | null; hasPassword: boolean; tokenExpiresAt: string | null }
type Banner = { ok: boolean; text: string }
type LineRow = { lineKey: string; reference: string | null; trackingNumber: string | null; status: string | null; written: boolean }

const button = 'inline-flex items-center gap-xs rounded-lg px-md py-xs text-body-sm font-semibold disabled:opacity-40'
const outline = `${button} border border-outline-variant/40 text-on-surface`
const input = 'mt-xs w-full border rounded-lg px-sm py-xs text-body-sm text-on-surface'

async function send(url: string, method: 'POST' | 'PUT', body?: unknown): Promise<{ ok: boolean; error: string; data: any }> {
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

/** The sync answers as NDJSON (heartbeats, then one "done" or "error" line). */
async function readSync(body: unknown): Promise<{ ok: boolean; error: string; data: any }> {
  try {
    const res = await fetch('/api/fulfillment/vnepacket/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}))
      return { ok: false, error: data.error ?? `Lỗi HTTP ${res.status}`, data: null }
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let last: any = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let i
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim()
        buffer = buffer.slice(i + 1)
        if (!line) continue
        try {
          const o = JSON.parse(line)
          if (o.type === 'done' || o.type === 'error') last = o
        } catch {}
      }
    }
    if (!last) return { ok: false, error: 'Mất kết nối giữa chừng — đồng bộ có thể vẫn chạy xong phía máy chủ', data: null }
    if (last.type === 'error') return { ok: false, error: last.error, data: null }
    return { ok: true, error: '', data: last }
  } catch {
    return { ok: false, error: 'Mất kết nối tới máy chủ', data: null }
  }
}

const usDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })

/** The VNEpacket account Gỗ 3D ships our parcels with: the tool reads each line's tracking from it. */
export default function VnepacketSetupCard() {
  const { user, loading } = useCurrentUser()
  const isSuper = user?.role === 'SUPERADMIN'
  const [view, setView] = useState<View | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [reference, setReference] = useState('')
  const [orderNumber, setOrderNumber] = useState('')
  const [banner, setBanner] = useState<Banner | null>(null)
  const [busy, setBusy] = useState('')
  const [lookup, setLookup] = useState<any>(null)
  const [lines, setLines] = useState<LineRow[] | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/fulfillment/vnepacket/settings').catch(() => null)
    if (!res?.ok) { setBanner({ ok: false, text: 'Không đọc được cài đặt VNEpacket' }); return }
    const data: View = await res.json()
    setView(data)
    setUsername(data.username ?? '')
  }, [])

  useEffect(() => { if (isSuper) void load() }, [isSuper, load])

  async function save() {
    setBusy('save')
    setBanner(null)
    const r = await send('/api/fulfillment/vnepacket/settings', 'PUT', { username, password })
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    setView(r.data)
    setPassword('')
    setBanner({ ok: true, text: 'Đã lưu tài khoản VNEpacket. Bấm "Kiểm tra kết nối" để thử đăng nhập.' })
  }

  async function test(withReference: boolean) {
    setBusy(withReference ? 'lookup' : 'test')
    setBanner(null)
    setLookup(null)
    const r = await send('/api/fulfillment/vnepacket/settings/test', 'POST', withReference ? { reference } : {})
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    void load()
    if (!withReference) { setBanner({ ok: true, text: `Đăng nhập được${r.data.fullName ? `: ${r.data.fullName}` : ''}.` }); return }
    setLookup(r.data)
  }

  async function sync() {
    setBusy('sync')
    setBanner(null)
    setLines(null)
    const r = await readSync(orderNumber.trim() ? { orderNumber } : {})
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    const d = r.data
    if (d.skipped) { setBanner({ ok: false, text: `Không chạy: ${d.skipped}` }); return }
    setLines(d.lines ?? [])
    const failed = d.errors?.length ? ` · ${d.errors.length} dòng lỗi: ${d.errors.slice(0, 3).join('; ')}` : ''
    setBanner({ ok: !d.errors?.length, text: `Đã tra ${d.pushes} dòng Gỗ 3D: ${d.found} có trên VNEpacket, ghi ${d.shipments} tracking${failed}` })
  }

  async function remove() {
    if (!window.confirm('Gỡ tài khoản VNEpacket? Tool sẽ ngừng lấy tracking Gỗ 3D.')) return
    setBusy('remove')
    setBanner(null)
    const r = await send('/api/fulfillment/vnepacket/settings', 'PUT', { username: null, password: null })
    setBusy('')
    if (!r.ok) { setBanner({ ok: false, text: r.error }); return }
    setView(r.data)
    setUsername('')
    setBanner({ ok: true, text: 'Đã gỡ tài khoản VNEpacket.' })
  }

  if (loading || !isSuper) return null
  const connected = !!view?.username && !!view.hasPassword
  const t = lookup?.tracking

  return (
    <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 mb-lg">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-on-surface-variant">local_shipping</span>
        <h2 className="text-title-md">Gỗ 3D — tracking qua VNEpacket</h2>
        {connected && <span className="ml-auto bg-on-tertiary-container/15 text-on-tertiary-container px-sm py-xs rounded-full text-label-sm">✓ Đã lưu tài khoản</span>}
      </div>
      <div className="p-lg space-y-md">
        {banner && (
          <div role="status" className={`rounded-lg px-md py-sm text-body-sm border ${banner.ok ? 'bg-secondary/5 border-secondary/30 text-secondary' : 'bg-error-container/40 border-error/30 text-error'}`}>
            {banner.text}
          </div>
        )}
        <p className="text-label-sm text-on-surface-variant">
          Gỗ 3D tạo vận đơn trên VNEpacket. Mỗi ngày (cùng lượt Auto Fulfilled) tool tra từng dòng đã xuất cho Gỗ 3D theo mã dòng (LIT5166_1, rồi mã đơn nếu đơn chỉ có 1 dòng Gỗ 3D) và ghi tracking, trạng thái, hành trình vào Shipment.
          {view?.tokenExpiresAt && <> Token hiện tại hết hạn {usDate(view.tokenExpiresAt)}.</>}
        </p>
        <div className="grid gap-sm md:grid-cols-2 max-w-2xl">
          <label className="text-label-sm text-on-surface-variant">Tên đăng nhập VNEpacket
            <input type="text" autoComplete="off" value={username} onChange={e => setUsername(e.target.value)} className={input} />
          </label>
          <label className="text-label-sm text-on-surface-variant">Mật khẩu VNEpacket
            <input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder={view?.hasPassword ? 'Đã lưu, để trống nếu không đổi' : ''} className={input} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-sm">
          <button type="button" className={`${button} bg-secondary text-on-secondary`} disabled={!!busy || !username.trim()} onClick={save}>{busy === 'save' ? 'Đang lưu…' : 'Lưu'}</button>
          <button type="button" className={outline} disabled={!!busy || !connected} onClick={() => test(false)}>{busy === 'test' ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}</button>
          {connected && <button type="button" className={`${outline} ml-auto text-error`} disabled={!!busy} onClick={remove}>Gỡ tài khoản</button>}
        </div>

        {connected && (
          <div className="grid gap-md md:grid-cols-2">
            <div className="space-y-sm">
              <label className="text-label-sm text-on-surface-variant block">Tra thử 1 mã (mã dòng, mã đơn hoặc mã HPW…)
                <div className="flex gap-sm">
                  <input value={reference} onChange={e => setReference(e.target.value)} placeholder="LIT5166_1" className={input} />
                  <button type="button" className={`${outline} mt-xs whitespace-nowrap`} disabled={!!busy || !reference.trim()} onClick={() => test(true)}>{busy === 'lookup' ? 'Đang tra…' : 'Tra'}</button>
                </div>
              </label>
              {lookup && (
                <div className="rounded-lg border border-outline-variant/30 px-md py-sm text-body-sm space-y-xs">
                  {!lookup.found && <div className="text-error">VNEpacket không có vận đơn &quot;{lookup.reference}&quot;{lookup.message ? `: ${lookup.message}` : ''}</div>}
                  {t && (
                    <>
                      <div><b>{lookup.reference}</b> → {t.trackingNumber ?? 'chưa có tracking'}{t.carrier ? ` (${t.carrier})` : ''} · {t.status ?? '—'}</div>
                      {t.events.map((e: any, i: number) => <div key={i} className="text-label-sm text-on-surface-variant">{e.time} · {e.desc}{e.location ? ` — ${e.location}` : ''}</div>)}
                      {t.eventCount > t.events.length && <div className="text-label-sm text-on-surface-variant">… {t.eventCount - t.events.length} mốc nữa</div>}
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="space-y-sm">
              <label className="text-label-sm text-on-surface-variant block">Đồng bộ ngay (để trống = mọi dòng Gỗ 3D chưa giao)
                <div className="flex gap-sm">
                  <input value={orderNumber} onChange={e => setOrderNumber(e.target.value)} placeholder="LIT5166" className={input} />
                  <button type="button" className={`${outline} mt-xs whitespace-nowrap`} disabled={!!busy} onClick={sync}>{busy === 'sync' ? 'Đang đồng bộ…' : 'Đồng bộ'}</button>
                </div>
              </label>
              {lines && lines.length > 0 && (
                <div className="max-h-64 overflow-auto rounded-lg border border-outline-variant/30">
                  <table className="w-full text-label-sm">
                    <thead><tr className="text-left text-on-surface-variant"><th className="px-sm py-xs">Dòng</th><th className="px-sm py-xs">Mã VNEpacket</th><th className="px-sm py-xs">Tracking</th><th className="px-sm py-xs">Trạng thái</th></tr></thead>
                    <tbody>
                      {lines.map(l => (
                        <tr key={l.lineKey} className="border-t border-outline-variant/20">
                          <td className="px-sm py-xs">{l.lineKey}</td>
                          <td className="px-sm py-xs">{l.reference ?? '—'}</td>
                          <td className="px-sm py-xs">{l.trackingNumber ?? 'không tìm thấy'}{l.trackingNumber && !l.written ? ' (không ghi)' : ''}</td>
                          <td className="px-sm py-xs">{l.status ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
