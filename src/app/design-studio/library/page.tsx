'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import type { LibraryProductStatus } from '@/lib/artwork-fields'
import type { LibraryChip, LibraryListRow } from '@/lib/artwork-library-types'
import { requestJson } from '../components/model'
import { ErrorBanner, Icon, Pill, card, input, TEXT_TONE } from '../components/ui'
import { shopLabel } from '../products/components/profile-form'
import { LIBRARY_FILTERS, LIBRARY_META, libraryPageUrl } from './components/meta'

function Chip({ c }: { c: LibraryChip }) {
  const meta = LIBRARY_META[c.status]
  const what = c.templateName ?? `${c.supplierSkus.join(', ') || '?'} — chưa có template`
  return (
    <span title={meta.label} className="inline-flex items-center gap-xs rounded-md border border-outline-variant/30 bg-surface-container-lowest px-xs text-label-sm whitespace-nowrap">
      <span className="text-on-surface">{c.supplierName} · {what}</span>
      <span className={`material-symbols-outlined text-[14px] ${TEXT_TONE[meta.tone]}`} aria-hidden="true">{c.status === 'READY' ? 'check' : meta.icon}</span>
    </span>
  )
}

export default function ArtworkLibraryPage() {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [status, setStatus] = useState<LibraryProductStatus | ''>('')
  const [rows, setRows] = useState<LibraryListRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    let alive = true
    setLoading(true)
    const params = new URLSearchParams()
    if (debouncedQ) params.set('q', debouncedQ)
    if (status) params.set('status', status)
    requestJson<{ products: LibraryListRow[] }>(`/api/design-studio/library/products?${params.toString()}`).then(r => {
      if (!alive) return
      setLoading(false)
      if (!r.ok) { setError(r.error); return }
      setError('')
      setRows(r.data.products)
    })
    return () => { alive = false }
  }, [debouncedQ, status])

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl flex flex-col gap-md">
        <div className="flex items-center gap-sm flex-wrap">
          <Icon name="photo_library" className="text-[28px] text-secondary" />
          <h1 className="text-headline-sm font-bold text-primary">Design Studio · Artwork Library</h1>
          <Link href="/design-studio/library/fonts" className="inline-flex items-center gap-xs text-label-md text-secondary hover:underline">
            <Icon name="font_download" className="text-[18px]" />Fonts
          </Link>
          <label className="ml-auto flex items-center gap-xs text-label-sm text-on-surface-variant">
            <Icon name="search" className="text-[18px]" />
            <span className="sr-only">Tìm sản phẩm</span>
            <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Tên sản phẩm hoặc product ID" className={`${input} w-72`} />
          </label>
        </div>

        <div className="flex items-center gap-xs flex-wrap" role="group" aria-label="Lọc theo trạng thái">
          {LIBRARY_FILTERS.map(f => {
            const on = status === f.value
            return (
              <button key={f.value || 'ALL'} type="button" aria-pressed={on} onClick={() => setStatus(f.value)}
                className={`rounded-full px-sm py-[2px] text-label-sm border ${on ? 'bg-secondary text-on-secondary border-transparent font-semibold' : 'bg-surface-container-lowest border-outline-variant/40 text-on-surface-variant hover:bg-surface-container-low'}`}>
                {f.label}
              </button>
            )
          })}
          <span className="ml-auto text-label-sm text-on-surface-variant">{loading ? 'Đang tải…' : `${rows.length} sản phẩm · 90 ngày gần nhất`}</span>
        </div>

        <ErrorBanner msg={error} onClose={() => setError('')} />

        <div className={`${card} overflow-x-auto`}>
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr className="text-label-sm text-on-surface-variant text-left border-b border-outline-variant/20">
                <th className="px-md py-sm font-medium w-14"><span className="sr-only">Ảnh</span></th>
                <th className="px-sm py-sm font-medium">Sản phẩm</th>
                <th className="px-sm py-sm font-medium">Store</th>
                <th className="px-sm py-sm font-medium">Xưởng · template</th>
                <th className="px-sm py-sm font-medium text-right">Task mở</th>
                <th className="px-sm py-sm font-medium">Trạng thái</th>
                <th className="px-md py-sm font-medium w-8"><span className="sr-only">Mở</span></th>
              </tr>
            </thead>
            <tbody>
              {!loading && rows.length === 0 && !error && (
                <tr><td colSpan={7} className="px-md py-lg text-center text-on-surface-variant">Không có sản phẩm nào khớp.</td></tr>
              )}
              {rows.map(r => {
                const meta = LIBRARY_META[r.status]
                const href = libraryPageUrl(r.key)
                return (
                  <tr key={r.key} onClick={() => router.push(href)} className="border-b border-outline-variant/20 last:border-b-0 hover:bg-surface-container-low cursor-pointer align-top">
                    <td className="px-md py-xs">
                      {r.imageUrl
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={r.imageUrl} alt="" className="w-10 h-10 rounded object-cover border border-outline-variant/20" />
                        : <span className="w-10 h-10 rounded bg-surface-container grid place-items-center"><Icon name="image" className="text-[18px] text-on-surface-variant" /></span>}
                    </td>
                    <td className="px-sm py-xs">
                      <Link href={href} onClick={e => e.stopPropagation()} className="font-semibold text-on-surface hover:text-secondary hover:underline">{r.title}</Link>
                      <div className="text-label-sm text-on-surface-variant font-mono">{r.shopifyProductId.replace('gid://shopify/Product/', '')}</div>
                    </td>
                    <td className="px-sm py-xs text-on-surface-variant">{shopLabel(r.shop)}</td>
                    <td className="px-sm py-xs">
                      <div className="flex flex-wrap gap-xs">
                        {r.chips.map((c, i) => <Chip key={i} c={c} />)}
                        {r.unmapped > 0 && <span className="text-label-sm text-amber-900">{r.unmapped} dòng chưa mapping</span>}
                        {r.staleCount > 0 && <span className="text-label-sm text-on-surface-variant">+{r.staleCount} không còn dùng</span>}
                        {r.chips.length === 0 && r.unmapped === 0 && r.staleCount === 0 && <span className="text-label-sm text-on-surface-variant">—</span>}
                      </div>
                    </td>
                    <td className="px-sm py-xs text-right">{r.openTasks > 0 ? <b className="text-on-surface">{r.openTasks}</b> : <span className="text-on-surface-variant">0</span>}</td>
                    <td className="px-sm py-xs"><Pill tone={meta.tone} icon={meta.icon}>{meta.label}</Pill></td>
                    <td className="px-md py-xs text-on-surface-variant"><Icon name="chevron_right" className="text-[18px]" /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
