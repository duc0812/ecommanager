'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'
import type { LibraryFontRow } from '@/lib/artwork-library-types'
import { requestJson } from '../../components/model'
import { ErrorBanner, Icon, Pill, btnPrimary, card, fmtSize } from '../../components/ui'
import { FONT_ACCEPT, uploadFonts } from '../components/upload'
import { fmtDate } from '../components/meta'

export default function LibraryFontsPage() {
  const [fonts, setFonts] = useState<LibraryFontRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [progress, setProgress] = useState<Record<string, number>>({})
  const inputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const r = await requestJson<{ fonts: LibraryFontRow[] }>('/api/design-studio/library/fonts')
    setLoading(false)
    if (!r.ok) { setError(r.error); return }
    setFonts(r.data.fonts)
  }, [])

  useEffect(() => { void load() }, [load])

  async function send(list: FileList | null) {
    const files = Array.from(list ?? [])
    if (files.length === 0) return
    setError(''); setInfo('')
    setProgress(Object.fromEntries(files.map(f => [f.name, 0])))
    const r = await uploadFonts(files, (name, pct) => setProgress(p => ({ ...p, [name]: pct })))
    setProgress({})
    if (r.errors.length) setError(r.errors.join(' · '))
    if (r.done.length) setInfo(`Đã thêm ${r.done.length} font${r.requeued ? ` · đọc lại ${r.requeued} PSD đang thiếu font` : ''}`)
    await load()
  }

  const uploading = Object.keys(progress).length > 0

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl flex flex-col gap-md">
        <div className="flex items-center gap-sm flex-wrap">
          <Link href="/design-studio/library" className="inline-flex items-center gap-xs text-label-md text-secondary hover:underline">
            <Icon name="arrow_back" className="text-[18px]" />Artwork Library
          </Link>
          <span className="text-on-surface-variant">/</span>
          <h1 className="text-headline-sm font-bold text-primary">Fonts</h1>
          <span className="ml-auto flex items-center gap-sm">
            <span className="text-label-sm text-on-surface-variant">.ttf · .otf · .ttc, tối đa 30 MB mỗi file</span>
            <button type="button" className={btnPrimary} disabled={uploading} onClick={() => inputRef.current?.click()}>
              <Icon name="upload" className="text-[18px]" />Tải font
            </button>
            <input ref={inputRef} type="file" accept={FONT_ACCEPT} multiple className="hidden" aria-label="Chọn file font"
              onChange={e => { const l = e.target.files; void send(l).then(() => { if (inputRef.current) inputRef.current.value = '' }) }} />
          </span>
        </div>

        {uploading && (
          <div className={`${card} px-md py-sm flex flex-col gap-xs`} role="status" aria-live="polite">
            {Object.entries(progress).map(([name, pct]) => (
              <div key={name} className="flex items-center gap-sm text-label-sm">
                <span className="w-64 truncate font-mono">{name}</span>
                <div className="flex-1 h-1 rounded-full bg-surface-container overflow-hidden" role="progressbar" aria-label={`Tiến độ ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                  <div className="h-full bg-secondary transition-all" style={{ width: `${pct}%` }} />
                </div>
                <span className="w-10 text-right">{pct}%</span>
              </div>
            ))}
          </div>
        )}
        {info && <span role="status" className="text-label-sm text-on-surface-variant">{info}</span>}
        <ErrorBanner msg={error} onClose={() => setError('')} />

        <div className={`${card} overflow-x-auto`}>
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr className="text-label-sm text-on-surface-variant text-left border-b border-outline-variant/20">
                <th className="px-md py-sm font-medium">Postscript</th>
                <th className="px-sm py-sm font-medium">Family</th>
                <th className="px-sm py-sm font-medium">Style</th>
                <th className="px-sm py-sm font-medium text-right">Dung lượng</th>
                <th className="px-sm py-sm font-medium text-right">Dùng ở</th>
                <th className="px-sm py-sm font-medium">Lưu</th>
                <th className="px-md py-sm font-medium">Ngày tải</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="px-md py-lg text-center text-on-surface-variant">Đang tải…</td></tr>}
              {!loading && fonts.length === 0 && <tr><td colSpan={7} className="px-md py-lg text-center text-on-surface-variant">Chưa có font nào.</td></tr>}
              {fonts.map(f => (
                <tr key={f.id} className="border-b border-outline-variant/20 last:border-b-0">
                  <td className="px-md py-xs font-mono text-on-surface">{f.postscriptName}</td>
                  <td className="px-sm py-xs">{f.family}</td>
                  <td className="px-sm py-xs">{f.style}</td>
                  <td className="px-sm py-xs text-right">{fmtSize(f.size)}</td>
                  <td className="px-sm py-xs text-right">{f.usedBy > 0 ? <b>{f.usedBy} entry</b> : <span className="text-on-surface-variant">0</span>}</td>
                  <td className="px-sm py-xs">{f.storage === 'DRIVE' ? <Pill tone="ok" icon="cloud_done">Drive</Pill> : <Pill tone="idle" icon="dns">Server</Pill>}</td>
                  <td className="px-md py-xs text-on-surface-variant">{fmtDate(f.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
