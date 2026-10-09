'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import { useCurrentUser } from '@/components/RoleGate'
import type { LibraryFontRow, LibraryProductDetail, LibrarySlot } from '@/lib/artwork-library-types'
import { productUrl, requestJson } from '../../components/model'
import { ErrorBanner, Icon, Note, Pill, card } from '../../components/ui'
import type { ProductDetail } from '../components/types'
import MappingCard from '../components/MappingCard'
import SlotCard from '../components/SlotCard'
import { LIBRARY_META, isBusy } from '../components/meta'
import { shopLabel } from '../components/profile-form'

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

function libraryUrl(key: string) {
  return `/api/design-studio/library/products/${encodeURIComponent(key)}`
}

function ProductSummary({ product, library }: { product: ProductDetail | null; library: LibraryProductDetail }) {
  const meta = LIBRARY_META[library.status]
  const variants = product?.summary.variants ?? []
  const optionNames = Array.from(new Set(variants.flatMap(v => Object.keys(v.options))))
  return (
    <section aria-label="Tóm tắt sản phẩm" className={`${card} p-md flex flex-col gap-md`}>
      <div className="flex gap-md min-w-0">
        {library.imageUrl
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={library.imageUrl} alt={library.title} className="w-20 h-20 rounded-lg object-cover border border-outline-variant/20 shrink-0" />
          : <span className="w-20 h-20 rounded-lg bg-surface-container grid place-items-center shrink-0"><Icon name="image" className="text-[28px] text-on-surface-variant" /></span>}
        <div className="flex flex-col gap-xs min-w-0 flex-1">
          <div className="flex items-center gap-sm flex-wrap">
            <b className="text-body-md text-on-surface">{library.title}</b>
            <Pill tone={meta.tone} icon={meta.icon}>{meta.label}</Pill>
          </div>
          <div className="flex flex-wrap gap-x-md gap-y-xs text-label-sm text-on-surface-variant">
            <span className="inline-flex items-center gap-xs"><Icon name="storefront" className="text-[16px]" />{library.storeName} ({shopLabel(library.shop)})</span>
            <span className="inline-flex items-center gap-xs font-mono"><Icon name="tag" className="text-[16px]" />{library.shopifyProductId.replace('gid://shopify/Product/', '')}</span>
            <span className="inline-flex items-center gap-xs"><Icon name="receipt_long" className="text-[16px]" /><b className="text-on-surface">{product?.summary.orderCount ?? library.orderCount}</b> đơn</span>
            <span className="inline-flex items-center gap-xs"><Icon name="brush" className="text-[16px]" /><b className="text-on-surface">{library.openTasks}</b> task mở</span>
            {product?.summary.lastOrderAt && <span className="inline-flex items-center gap-xs"><Icon name="event" className="text-[16px]" />đơn gần nhất {new Date(product.summary.lastOrderAt).toLocaleDateString('en-US')}</span>}
          </div>
          {library.observedFields.length > 0 && (
            <span className="text-label-sm text-on-surface-variant">Trường khách nhập: <span className="text-on-surface">{library.observedFields.join(', ')}</span></span>
          )}
        </div>
      </div>
      {variants.length > 0 && (
        <div className="overflow-x-auto max-h-64 overflow-y-auto border-t border-outline-variant/20">
          <table className="w-full border-collapse text-body-sm">
            <caption className="sr-only">Biến thể và SKU xưởng</caption>
            <thead>
              <tr className="text-label-sm text-on-surface-variant text-left border-b border-outline-variant/20">
                <th className="py-xs pr-sm font-medium">Biến thể</th>
                {optionNames.map(n => <th key={n} className="py-xs pr-sm font-medium">{n}</th>)}
                <th className="py-xs pr-sm font-medium">Xưởng</th>
                <th className="py-xs font-medium">SKU xưởng</th>
              </tr>
            </thead>
            <tbody>
              {variants.map(v => (
                <tr key={v.shopifyVariantId} className="border-b border-outline-variant/20 last:border-b-0">
                  <td className="py-xs pr-sm text-on-surface">{v.variantTitle ?? v.shopifyVariantId}</td>
                  {optionNames.map(n => <td key={n} className="py-xs pr-sm text-on-surface-variant">{v.options[n] ?? '—'}</td>)}
                  <td className="py-xs pr-sm text-on-surface-variant">{v.supplierName ?? (v.supplierId ? '?' : <span className="text-error">chưa map</span>)}</td>
                  <td className="py-xs font-mono text-on-surface">{v.supplierSku ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export default function ProductPage() {
  const params = useParams<{ key: string }>()
  const key = decodeURIComponent(params.key)
  const { user } = useCurrentUser()
  const canAdmin = user?.role === 'SUPERADMIN' || user?.role === 'ADMIN'
  const [product, setProduct] = useState<ProductDetail | null>(null)
  const [library, setLibrary] = useState<LibraryProductDetail | null>(null)
  const [fonts, setFonts] = useState<LibraryFontRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadLibrary = useCallback(async () => {
    const r = await requestJson<LibraryProductDetail>(libraryUrl(key))
    if (!r.ok) { setError(r.error); return }
    setLibrary(r.data)
  }, [key])

  const load = useCallback(async () => {
    const [p, l, f] = await Promise.all([
      requestJson<ProductDetail>(productUrl(key)),
      requestJson<LibraryProductDetail>(libraryUrl(key)),
      requestJson<{ fonts: LibraryFontRow[] }>('/api/design-studio/library/fonts'),
    ])
    setLoading(false)
    if (!l.ok) { setError(l.error); return null }
    setLibrary(l.data)
    if (p.ok) setProduct(p.data)
    if (f.ok) setFonts(f.data.fonts)
    setError(p.ok ? '' : `Không tải được mapping: ${p.error}`)
    return p.ok ? p.data : null
  }, [key])

  useEffect(() => { void load() }, [load])

  const entries = library ? [...library.slots.map(s => s.entry), ...library.stale.map(s => s.entry)] : []
  const polling = entries.some(e => isBusy(e?.status))
  useEffect(() => {
    if (!polling) return
    const t = setInterval(() => { void loadLibrary() }, POLL_MS)
    return () => clearInterval(t)
  }, [polling, loadLibrary])

  const usedFonts = Array.from(new Set(entries.flatMap(e => e?.fields.map(f => f.font) ?? []).filter(Boolean))).sort().join('|')
  useLibraryFonts(fonts, usedFonts)

  const slotProduct = library ? { key: library.key, storeId: library.storeId, shopifyProductId: library.shopifyProductId, observedFields: library.observedFields } : null
  const staleSlots: LibrarySlot[] = library?.stale.map(s => ({
    key: `stale:${s.entry.id}`, title: s.entry.optionLabel ?? 'Mọi biến thể', options: [], optionKey: s.entry.optionKey, optionLabel: s.entry.optionLabel,
    splitOption: null, splitChoices: [], supplier: s.supplier, supplierSkus: [], variants: '', lineCount: 0, template: s.template,
    status: s.entry.status, entry: s.entry, inherited: false,
  })) ?? []
  const refreshAll = () => { void load() }

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl flex flex-col gap-md">
        <div className="flex items-center gap-sm flex-wrap">
          <Link href="/design-studio/products" className="inline-flex items-center gap-xs text-label-md text-secondary hover:underline">
            <Icon name="arrow_back" className="text-[18px]" />Sản phẩm
          </Link>
          <span className="text-on-surface-variant">/</span>
          <h1 className="text-headline-sm font-bold text-primary truncate">{library?.title || 'Sản phẩm'}</h1>
          <Link href="/design-studio/products/fonts" className="ml-auto inline-flex items-center gap-xs text-label-md text-secondary hover:underline">
            <Icon name="font_download" className="text-[18px]" />Fonts
          </Link>
        </div>
        <ErrorBanner msg={error} onClose={() => setError('')} />
        {loading && <p className="text-body-sm text-on-surface-variant">Đang tải…</p>}

        {library && slotProduct && (
          <>
            <ProductSummary product={product} library={library} />

            {product && <MappingCard key={product.key} detail={product} canEdit={canAdmin} onSaved={load} />}

            <div className="flex items-center gap-sm flex-wrap mt-sm">
              <Icon name="photo_library" className="text-[22px] text-secondary" />
              <h2 className="text-body-lg font-bold text-on-surface">Artwork theo option</h2>
              <span className="text-label-sm text-on-surface-variant">mỗi slot = xưởng × template × giá trị option · 1 PSD gốc mỗi slot</span>
            </div>

            {library.legacyMasterUrl && (
              <Note tone="idle" icon="history">
                Link master cũ (chỉ xem):{' '}
                <a href={library.legacyMasterUrl} target="_blank" rel="noreferrer" className="underline break-all">{library.legacyMasterUrl}</a>
              </Note>
            )}
            {library.unmapped > 0 && (
              <Note tone="warn" icon="account_tree">
                {library.unmapped} dòng đơn chưa mapping xưởng — chọn xưởng ở thẻ Mapping phía trên hoặc <Link href="/fulfillment/mapping" className="underline font-semibold">mở Product Mapping</Link>
              </Note>
            )}
            {library.slots.length === 0 && library.unmapped === 0 && (
              <Note tone="idle" icon="info">Sản phẩm không có dòng đơn nào trong 90 ngày gần nhất.</Note>
            )}

            {library.slots.map(s => (
              <SlotCard key={s.key} slot={s} product={slotProduct} fonts={fonts} canAdmin={canAdmin} onChanged={refreshAll} />
            ))}

            {staleSlots.length > 0 && (
              <>
                <h2 className="text-body-md font-semibold text-on-surface mt-sm flex items-center gap-xs"><Icon name="history" className="text-[18px]" />Không còn dùng (vẫn hợp lệ)</h2>
                {staleSlots.map(s => (
                  <SlotCard key={s.key} slot={s} stale product={slotProduct} fonts={fonts} canAdmin={canAdmin} onChanged={refreshAll} />
                ))}
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}
