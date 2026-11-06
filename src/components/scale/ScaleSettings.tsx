'use client'
import { useEffect, useState } from 'react'
import { postJson, type ScaleSettingsView } from '@/components/scale/types'

const KEY_SOURCE_LABEL = { creative: 'key riêng của Creative', cs: 'key dùng chung từ Cài đặt CS', env: 'key trong .env của server' }

export function ScaleSettings({ onSaved }: { onSaved: (s: ScaleSettingsView) => void }) {
  const [view, setView] = useState<ScaleSettingsView | null>(null)
  const [form, setForm] = useState({ imageModel: '', fallbackModel: '', visionModel: '', resolution: '', allowFallback: false })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  function apply(s: ScaleSettingsView) {
    setView(s)
    setForm({ imageModel: s.imageModel, fallbackModel: s.fallbackModel, visionModel: s.visionModel ?? '', resolution: s.resolution, allowFallback: s.allowFallback })
  }

  useEffect(() => { fetch('/api/tools/scale/settings').then(r => r.json()).then(apply).catch(() => {}) }, [])

  async function save() {
    setSaving(true)
    setMessage(null)
    try {
      const next = await postJson('/api/tools/scale/settings', { ...form, visionModel: form.visionModel.trim() || null })
      apply(next)
      onSaved(next)
      setMessage('Đã lưu.')
    } catch (err: any) {
      setMessage(err.message)
    } finally {
      setSaving(false)
    }
  }

  const input = 'mt-xs w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm'

  return (
    <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-secondary">tune</span>
        <h3 className="text-headline-sm text-primary">Cài đặt</h3>
      </div>
      {!view ? <p className="p-lg text-body-sm text-on-surface-variant">Đang tải…</p> : (
        <div className="p-lg">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-lg">
            <label className="text-label-sm text-on-surface-variant">Model tạo ảnh (Kie)
              <input value={form.imageModel} onChange={e => setForm({ ...form, imageModel: e.target.value })} className={input} />
            </label>
            <label className="text-label-sm text-on-surface-variant">Độ phân giải
              <input value={form.resolution} onChange={e => setForm({ ...form, resolution: e.target.value })} placeholder="1K, 2K hoặc 4K" className={input} />
            </label>
            <label className="text-label-sm text-on-surface-variant">Model dự phòng
              <input value={form.fallbackModel} onChange={e => setForm({ ...form, fallbackModel: e.target.value })} className={input} />
            </label>
            <label className="flex items-center gap-sm self-end pb-sm text-body-sm text-on-surface-variant">
              <input type="checkbox" checked={form.allowFallback} onChange={e => setForm({ ...form, allowFallback: e.target.checked })} />
              Cho nhân sự bấm &quot;Thử model dự phòng&quot; khi model chính lỗi hoặc từ chối
            </label>
            <label className="text-label-sm text-on-surface-variant">Model đọc ảnh (để trống = theo CS agent, hiện là {view.effectiveVisionModel})
              <input value={form.visionModel} onChange={e => setForm({ ...form, visionModel: e.target.value })} placeholder={view.effectiveVisionModel} className={input} />
            </label>
          </div>
          <div className="mt-lg rounded-lg bg-surface p-md text-body-sm text-on-surface-variant">
            <p>Bước tạo ảnh dùng key Kie {view.imageKeyMasked ? `${view.imageKeyMasked} (${view.imageKeySource ? KEY_SOURCE_LABEL[view.imageKeySource] : 'không rõ nguồn'})` : 'chưa có'}. Đổi key ở trang <a href="/tools/creative" className="text-secondary hover:underline">Creative</a>.</p>
            <p className="mt-xs">Bước đọc thiết kế dùng key Kie của CS agent {view.visionKeyMasked ?? 'chưa có'}.</p>
            <p className="mt-xs">Kie cấp quyền theo từng model trên từng key; key thiếu quyền thì job báo rõ key nào, model nào.</p>
          </div>
          <div className="mt-lg flex items-center gap-md">
            <button type="button" disabled={saving} onClick={save} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">Lưu</button>
            {message && <p className="text-body-sm text-on-surface-variant">{message}</p>}
          </div>
        </div>
      )}
    </section>
  )
}
