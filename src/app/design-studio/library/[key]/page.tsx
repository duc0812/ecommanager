'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import { useCurrentUser } from '@/components/RoleGate'
import type { LibraryFontRow, LibraryProductDetail, LibrarySlot } from '@/lib/artwork-library-types'
import { productPageUrl, requestJson } from '../../components/model'
import { ErrorBanner, Icon, Note, Pill, card } from '../../components/ui'
import { shopLabel } from '../../products/components/profile-form'
import SlotCard from '../components/SlotCard'
import { LIBRARY_META, isBusy } from '../components/meta'

const POLL_MS = 5000

function useLibraryFonts(fonts: LibraryFontRow[], wantedKey: string) {
  const loaded = useRef(new Set<string>())
  useEffect(() => {
    if (typeof window === 'undefined' || !('FontFace' in window)) return
    const want = new Set(wantedKey.toLowerCase().split('|'))
    for (const f of fonts) {
      const key = f.postscriptName.toLowerCase()
      if (!want.has(key) || loaded.current.has(`${key}:${f.fileId}`)) continue
      loaded.current.add(`${key}:${f.fileId}`)
      const face = new FontFace(f.postscriptName, `url(/api/design-studio/library/files/${encodeURIComponent(f.fileId)})`)
      face.load().then(ff => document.fonts.add(ff)).catch(() => {})
    }
  }, [fonts, wantedKey])
}

export default function LibraryProductPage() {
  const params = useParams<{ key: string }>()
  const key = decodeURIComponent(params.key)
  const { user } = useCurrentUser()
  const canAdmin = user?.role === 'SUPERADMIN' || user?.role === 'ADMIN'
  const [detail, setDetail] = useState<LibraryProductDetail | null>(null)
  const [fonts, setFonts] = useState<LibraryFontRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const [p, f] = await Promise.all([
      requestJson<LibraryProductDetail>(`/api/design-studio/library/products/${encodeURIComponent(key)}`),
      requestJson<{ fonts: LibraryFontRow[] }>('/api/design-studio/library/fonts'),
    ])
    setLoading(false)
    if (!p.ok) { setError(p.error); return }
    setDetail(p.data)
    if (f.ok) setFonts(f.data.fonts)
  }, [key])

  useEffect(() => { void load() }, [load])

  const entries = detail ? [...detail.slots.map(s => s.entry), ...detail.stale.map(s => s.entry)] : []
  const polling = entries.some(e => isBusy(e?.status))
  useEffect(() => {
    if (!polling) return
    const t = setInterval(() => { void load() }, POLL_MS)
    return () => clearInterval(t)
  }, [polling, load])

  const usedFonts = Array.from(new Set(entries.flatMap(e => e?.fields.map(f => f.font) ?? []).filter(Boolean))).sort().join('|')
  useLibraryFonts(fonts, usedFonts)

  const meta = detail ? LIBRARY_META[detail.status] : null
  const product = detail ? { storeId: detail.storeId, shopifyProductId: detail.shopifyProductId, observedFields: detail.observedFields } : null
  const staleSlots: LibrarySlot[] = detail?.stale.map(s => ({
    key: `stale:${s.template.id}`, supplier: s.supplier, supplierSkus: [], variants: '', lineCount: 0, template: s.template, status: s.entry.status, entry: s.entry,
  })) ?? []

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl flex flex-col gap-md">
        <div className="flex items-center gap-sm flex-wrap">
          <Link href="/design-studio/library" className="inline-flex items-center gap-xs text-label-md text-secondary hover:underline">
            <Icon name="arrow_back" className="text-[18px]" />Artwork Library
          </Link>
          <span className="text-on-surface-variant">/</span>
          <h1 className="text-headline-sm font-bold text-primary truncate">{detail?.title || 'Sản phẩm'}</h1>
        </div>
        <ErrorBanner msg={error} onClose={() => setError('')} />
        {loading && <p className="text-body-sm text-on-surface-variant">Đang tải…</p>}

        {detail && meta && product && (
          <>
            <div className={`${card} px-md py-sm flex items-center gap-md flex-wrap`}>
              {detail.imageUrl
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={detail.imageUrl} alt="" className="w-14 h-14 rounded object-cover border border-outline-variant/20" />
                : <span className="w-14 h-14 rounded bg-surface-container grid place-items-center"><Icon name="image" className="text-[22px] text-on-surface-variant" /></span>}
              <div className="flex flex-col gap-[2px] min-w-0">
                <span className="text-body-sm font-semibold text-on-surface">{detail.title}</span>
                <span className="text-label-sm text-on-surface-variant">
                  {shopLabel(detail.shop)} · <span className="font-mono">{detail.shopifyProductId.replace('gid://shopify/Product/', '')}</span> · {detail.orderCount} đơn · {detail.openTasks} task mở
                </span>
                {detail.observedFields.length > 0 && (
                  <span className="text-label-sm text-on-surface-variant">Trường khách nhập: {detail.observedFields.join(', ')}</span>
                )}
              </div>
              <Pill tone={meta.tone} icon={meta.icon}>{meta.label}</Pill>
              <Link href={productPageUrl(detail.key)} className="ml-auto inline-flex items-center gap-xs text-label-md text-secondary hover:underline">
                <Icon name="inventory_2" className="text-[18px]" />Hồ sơ sản phẩm
              </Link>
            </div>

            {detail.unmapped > 0 && (
              <Note tone="warn" icon="account_tree">
                {detail.unmapped} dòng đơn chưa mapping xưởng — <Link href="/fulfillment/mapping" className="underline font-semibold">mở Product Mapping</Link>
              </Note>
            )}
            {detail.slots.length === 0 && detail.unmapped === 0 && (
              <Note tone="idle" icon="info">Sản phẩm không có dòng đơn nào trong 90 ngày gần nhất.</Note>
            )}

            {detail.slots.map(s => (
              <SlotCard key={s.key} slot={s} product={product} fonts={fonts} canAdmin={canAdmin} onChanged={() => void load()} />
            ))}

            {staleSlots.length > 0 && (
              <>
                <h2 className="text-body-md font-semibold text-on-surface mt-sm flex items-center gap-xs"><Icon name="history" className="text-[18px]" />Không còn dùng (vẫn hợp lệ)</h2>
                {staleSlots.map(s => (
                  <SlotCard key={s.key} slot={s} stale product={product} fonts={fonts} canAdmin={canAdmin} onChanged={() => void load()} />
                ))}
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}
