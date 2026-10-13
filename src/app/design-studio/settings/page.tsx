'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { useCurrentUser } from '@/components/RoleGate'
import type { DesignSettings, TrelloMode } from '../components/types'
import { requestJson } from '../components/model'
import { Card, ErrorBanner, Icon, Note, btn, input } from '../components/ui'

type KpiRow = { type: string; value: string }
type TokenInfo = { configured: boolean; updatedAt: string | null }

const TRELLO_MODE_OPTIONS: { value: TrelloMode; label: string; short: string; help: string }[] = [
  {
    value: 'BOTH', label: 'Chạy song song', short: 'Trello + Design Studio',
    help: 'Đơn mới thiếu design vẫn tạo thẻ Trello, và "Sync Trello" vẫn đọc file từ thẻ ở cột DONE. Link từ Trello chỉ điền vào dòng chưa ai làm trong Design Studio — không ghi đè dòng đã có file hoặc đã được nhận việc / duyệt.',
  },
  {
    value: 'READ_ONLY', label: 'Chỉ đọc Trello', short: 'không tạo thẻ mới',
    help: 'Không tạo thẻ Trello mới cho đơn mới — mọi đơn mới đi qua Design Tasks. Thẻ đang làm dở vẫn được đọc khi bấm "Sync Trello", để chạy nốt các thẻ cũ.',
  },
  {
    value: 'OFF', label: 'Tắt Trello', short: 'chỉ Design Studio',
    help: 'Không tạo và không đọc thẻ Trello nữa. "Sync Trello" và các công cụ đọc thẻ đều bỏ qua. Chỉ chọn khi không còn thẻ Trello nào đang làm dở.',
  },
]

function WorkerTokenCard({ canManage }: { canManage: boolean }) {
  const [info, setInfo] = useState<TokenInfo | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    void requestJson<TokenInfo>('/api/design-studio/settings/worker-token').then(r => {
      if (!alive) return
      if (r.ok) setInfo(r.data)
      else setError(r.error)
    })
    return () => { alive = false }
  }, [])

  async function generate() {
    if (info?.configured && !window.confirm('Tạo token mới sẽ vô hiệu token cũ. Worker đang chạy phải đổi sang token mới. Tiếp tục?')) return
    setBusy(true); setError(''); setCopied(false)
    const r = await requestJson<TokenInfo & { token: string }>('/api/design-studio/settings/worker-token', { method: 'POST' })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setToken(r.data.token)
    setInfo({ configured: r.data.configured, updatedAt: r.data.updatedAt })
  }

  async function revoke() {
    if (!window.confirm('Thu hồi token? Worker sẽ không gọi được nữa cho đến khi có token mới.')) return
    setBusy(true); setError('')
    const r = await requestJson<TokenInfo>('/api/design-studio/settings/worker-token', { method: 'DELETE' })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setToken('')
    setInfo(r.data)
  }

  async function copy() {
    try { await navigator.clipboard.writeText(token); setCopied(true) } catch { setError('Không chép được — chọn và chép tay') }
  }

  return (
    <Card icon="key" title="Artwork worker token" right={info ? (info.configured ? `đang dùng · tạo ${info.updatedAt ? new Date(info.updatedAt).toLocaleDateString('en-US') : ''}` : 'chưa có') : ''}>
      <p className="text-body-sm text-on-surface-variant">
        Worker đọc PSD (<code className="font-mono">tools/artwork-worker</code>) chạy trên máy designer, gọi <code className="font-mono">/api/design-studio/worker/*</code> bằng token này
        qua biến môi trường <code className="font-mono">DESIGN_WORKER_TOKEN</code>. Server chỉ lưu mã băm.
      </p>
      {token && (
        <div className="flex flex-col gap-xs">
          <Note tone="warn" icon="visibility">Token chỉ hiện một lần — chép ngay.</Note>
          <div className="flex gap-xs">
            <input className={`${input} flex-1 font-mono`} readOnly value={token} aria-label="Worker token" onFocus={e => e.currentTarget.select()} />
            <button type="button" className={btn} onClick={() => void copy()}><Icon name="content_copy" className="text-[16px]" />{copied ? 'Đã chép' : 'Chép'}</button>
          </div>
        </div>
      )}
      {canManage ? (
        <div className="flex gap-xs">
          <button type="button" className={btn} disabled={busy} onClick={() => void generate()}><Icon name="add_moderator" className="text-[16px]" />{info?.configured ? 'Tạo token mới' : 'Tạo token'}</button>
          {info?.configured && <button type="button" className={btn} disabled={busy} onClick={() => void revoke()}><Icon name="block" className="text-[16px]" />Thu hồi</button>}
        </div>
      ) : (
        <p className="text-label-sm text-on-surface-variant">Chỉ Superadmin tạo hoặc thu hồi token.</p>
      )}
      <ErrorBanner msg={error} onClose={() => setError('')} />
    </Card>
  )
}

export default function DesignSettingsPage() {
  const { user } = useCurrentUser()
  const canSave = user?.role === 'SUPERADMIN'
  const [slaCustom, setSlaCustom] = useState('')
  const [slaNonCustom, setSlaNonCustom] = useState('')
  const [kpi, setKpi] = useState<KpiRow[]>([])
  const [reasons, setReasons] = useState<string[]>([])
  const [designerCanApprove, setDesignerCanApprove] = useState(true)
  const [trelloMode, setTrelloMode] = useState<TrelloMode>('BOTH')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  function apply(s: DesignSettings) {
    setSlaCustom(String(s.slaCustomHours))
    setSlaNonCustom(String(s.slaNonCustomHours))
    setKpi(Object.entries(s.kpiByType).map(([type, v]) => ({ type, value: String(v) })))
    setReasons(s.rejectReasons)
    setDesignerCanApprove(s.designerCanApprove !== false)
    setTrelloMode(s.trelloMode ?? 'BOTH')
  }

  useEffect(() => {
    let alive = true
    void requestJson<DesignSettings>('/api/design-studio/settings').then(r => {
      if (!alive) return
      setLoading(false)
      if (!r.ok) { setError(r.error); return }
      apply(r.data)
    })
    return () => { alive = false }
  }, [])

  async function save() {
    setSaved('')
    const slaCustomHours = Number(slaCustom), slaNonCustomHours = Number(slaNonCustom)
    if (!(slaCustomHours > 0) || !(slaNonCustomHours > 0)) { setError('SLA phải lớn hơn 0 giờ.'); return }
    const kpiByType: Record<string, number> = {}
    for (const row of kpi) {
      const type = row.type.trim(), value = Number(row.value)
      if (!type || !(value > 0)) { setError('Mỗi loại sản phẩm cần tên và điểm KPI lớn hơn 0.'); return }
      if (type in kpiByType) { setError(`Loại sản phẩm "${type}" bị trùng.`); return }
      kpiByType[type] = value
    }
    const rejectReasons = reasons.map(r => r.trim()).filter(Boolean)
    if (rejectReasons.length === 0) { setError('Cần ít nhất một lý do trả lại.'); return }
    setSaving(true)
    const r = await requestJson<DesignSettings>('/api/design-studio/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slaCustomHours, slaNonCustomHours, kpiByType, rejectReasons, designerCanApprove, trelloMode }),
    })
    setSaving(false)
    if (!r.ok) { setError(r.error); return }
    setError('')
    apply(r.data)
    setSaved('Đã lưu cài đặt.')
  }

  const dis = !canSave

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <div className="flex items-center gap-sm mb-lg">
          <Icon name="settings" className="text-[28px] text-secondary" />
          <h1 className="text-headline-sm font-bold text-primary">Design Studio · Settings</h1>
        </div>

        <ErrorBanner msg={error} onClose={() => setError('')} />
        {user && !canSave && (
          <div className="mt-md"><Note tone="idle" icon="lock">Chỉ Superadmin mới sửa được cài đặt. Bạn đang xem ở chế độ chỉ đọc.</Note></div>
        )}
        {loading && <p className="mt-md text-body-sm text-on-surface-variant">Đang tải…</p>}

        {!loading && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-md mt-md">
            <div className="flex flex-col gap-md min-w-0">
              <Card icon="schedule" title="SLA (giờ)">
                <div className="grid grid-cols-2 gap-sm">
                  <label className="flex flex-col gap-[2px] text-label-sm text-on-surface-variant">
                    Đơn custom
                    <input className={input} type="number" min={1} value={slaCustom} onChange={e => setSlaCustom(e.target.value)} disabled={dis} aria-label="SLA đơn custom (giờ)" />
                  </label>
                  <label className="flex flex-col gap-[2px] text-label-sm text-on-surface-variant">
                    Đơn không custom
                    <input className={input} type="number" min={1} value={slaNonCustom} onChange={e => setSlaNonCustom(e.target.value)} disabled={dis} aria-label="SLA đơn không custom (giờ)" />
                  </label>
                </div>
              </Card>

              <Card icon="verified" title="Duyệt design" right={designerCanApprove ? 'designer được duyệt' : 'chỉ leader duyệt'}>
                <label className="flex items-start gap-sm text-body-sm text-on-surface cursor-pointer">
                  <input type="checkbox" className="mt-[3px] w-4 h-4 accent-secondary" checked={designerCanApprove} onChange={e => setDesignerCanApprove(e.target.checked)} disabled={dis} aria-label="Designer được duyệt design" />
                  <span className="flex flex-col">
                    <b>Designer được duyệt design</b>
                    <span className="text-label-sm text-on-surface-variant">
                      Khi bật, ai có quyền Design Tasks cũng bấm được &quot;Duyệt design&quot; và &quot;Trả lại sửa&quot; cho mẫu đang chờ duyệt, kể cả file in tự động.
                      Khi tắt, chỉ leader (Admin / Super Admin) duyệt. Mẫu vẫn phải qua bước &quot;Gửi duyệt&quot; trước khi duyệt.
                    </span>
                  </span>
                </label>
              </Card>

              <Card icon="view_kanban" title="Trello" right={TRELLO_MODE_OPTIONS.find(o => o.value === trelloMode)?.short}>
                <div role="radiogroup" aria-label="Chế độ Trello" className="flex flex-col gap-sm">
                  {TRELLO_MODE_OPTIONS.map(o => (
                    <label key={o.value} className="flex items-start gap-sm text-body-sm text-on-surface cursor-pointer">
                      <input type="radio" name="trello-mode" className="mt-[3px] w-4 h-4 accent-secondary" value={o.value} checked={trelloMode === o.value}
                        onChange={() => setTrelloMode(o.value)} disabled={dis} />
                      <span className="flex flex-col">
                        <b>{o.label}</b>
                        <span className="text-label-sm text-on-surface-variant">{o.help}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </Card>

              <Card icon="undo" title="Lý do trả lại" right={`${reasons.length} lý do`}>
                {reasons.map((r, i) => (
                  <div key={i} className="flex items-center gap-xs">
                    <input className={`${input} flex-1`} value={r} onChange={e => setReasons(list => list.map((x, j) => (j === i ? e.target.value : x)))} disabled={dis} aria-label={`Lý do trả lại ${i + 1}`} />
                    {canSave && (
                      <button type="button" className={btn} aria-label={`Xoá lý do ${i + 1}`} onClick={() => setReasons(list => list.filter((_, j) => j !== i))}>
                        <Icon name="delete" className="text-[16px]" />
                      </button>
                    )}
                  </div>
                ))}
                {canSave && (
                  <button type="button" className={`${btn} self-start`} onClick={() => setReasons(list => [...list, ''])}>
                    <Icon name="add" className="text-[16px]" />Thêm lý do
                  </button>
                )}
              </Card>
            </div>

            <Card icon="stars" title="KPI theo loại sản phẩm" right="điểm / task">
              {kpi.map((row, i) => (
                <div key={i} className="flex items-center gap-xs">
                  <input className={`${input} flex-1`} value={row.type} onChange={e => setKpi(list => list.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))} disabled={dis} aria-label={`Loại sản phẩm ${i + 1}`} placeholder="Loại (vd hoodie)" />
                  <input className={`${input} w-24`} type="number" min={0} step="0.05" value={row.value} onChange={e => setKpi(list => list.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} disabled={dis} aria-label={`Điểm KPI ${row.type || i + 1}`} />
                  {canSave && (
                    <button type="button" className={btn} aria-label={`Xoá loại ${row.type || i + 1}`} onClick={() => setKpi(list => list.filter((_, j) => j !== i))}>
                      <Icon name="delete" className="text-[16px]" />
                    </button>
                  )}
                </div>
              ))}
              {canSave && (
                <button type="button" className={`${btn} self-start`} onClick={() => setKpi(list => [...list, { type: '', value: '' }])}>
                  <Icon name="add" className="text-[16px]" />Thêm loại
                </button>
              )}
              <p className="text-label-sm text-on-surface-variant">Dòng &quot;default&quot; áp dụng cho loại không có trong danh sách.</p>
            </Card>
          </div>
        )}

        {!loading && (
          <div className="mt-md max-w-3xl"><WorkerTokenCard canManage={canSave} /></div>
        )}

        {canSave && !loading && (
          <div className="flex items-center gap-sm mt-lg">
            <button type="button" className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-40" onClick={() => void save()} disabled={saving}>
              {saving ? 'Đang lưu…' : 'Lưu cài đặt'}
            </button>
            {saved && <span role="status" className="text-label-sm text-on-tertiary-container">{saved}</span>}
          </div>
        )}
      </main>
    </div>
  )
}
