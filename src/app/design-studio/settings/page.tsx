'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { useCurrentUser } from '@/components/RoleGate'
import type { DesignSettings } from '../components/types'
import { requestJson } from '../components/model'
import { Card, ErrorBanner, Icon, Note, btn, input } from '../components/ui'

type KpiRow = { type: string; value: string }

export default function DesignSettingsPage() {
  const { user } = useCurrentUser()
  const canSave = user?.role === 'SUPERADMIN'
  const [slaCustom, setSlaCustom] = useState('')
  const [slaNonCustom, setSlaNonCustom] = useState('')
  const [kpi, setKpi] = useState<KpiRow[]>([])
  const [reasons, setReasons] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  function apply(s: DesignSettings) {
    setSlaCustom(String(s.slaCustomHours))
    setSlaNonCustom(String(s.slaNonCustomHours))
    setKpi(Object.entries(s.kpiByType).map(([type, v]) => ({ type, value: String(v) })))
    setReasons(s.rejectReasons)
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
      body: JSON.stringify({ slaCustomHours, slaNonCustomHours, kpiByType, rejectReasons }),
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
